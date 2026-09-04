import { DeleteMessageCommand, Message, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import axios from 'axios';
import 'dotenv/config';

type LogFields = Record<string, unknown>;

// Structured single-line JSON logs, easy to parse/filter in log aggregators (Fluentd).
const log = (level: 'info' | 'warn' | 'error', message: string, fields: LogFields = {}): void => {
    const line = JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...fields });
    (level === 'error' ? console.error : console.log)(line);
};

const errorFields = (error: unknown): LogFields => ({
    error: error instanceof Error ? error.message : 'Unknown error',
    stack: error instanceof Error ? error.stack : undefined,
    // Surface the upstream response so HTTP failures (4xx/5xx) are diagnosable from logs alone.
    ...(axios.isAxiosError(error) && error.response
        ? { responseStatus: error.response.status, responseBody: error.response.data }
        : {}),
});

const sqsClient = new SQSClient({ region: process.env.AWS_REGION || 'us-east-1' });
const QUEUE_URL = process.env.QUEUE_URL;

interface RouteConfig {
    url: string;
    token?: string;
}

interface MetaWebhookPayload {
    entry?: Array<{
        changes?: Array<{
            value?: {
                metadata?: {
                    display_phone_number?: string;
                };
            };
        }>;
    }>;
}

// Load routing configuration; multiple destinations per phone are supported
// by repeating the phone number across PHONE_ROUTES entries.
const loadRoutes = (): Record<string, RouteConfig[]> => {
    const destinos: Record<string, RouteConfig[]> = {};

    if (process.env.PHONE_ROUTES) {
        const routes = process.env.PHONE_ROUTES.split('|');
        routes.forEach(route => {
            const parts = route.split('::');
            const phone = parts[0];
            const url = parts[1];
            const token = parts[2]?.trim();

            if (phone && url) {
                const key = phone.trim();
                const destino: RouteConfig = { url: url.trim(), token };
                destinos[key] = destinos[key] ? [...destinos[key], destino] : [destino];
            }
        });
    }

    return destinos;
};

// Collect every phone number referenced across all entries/changes, so
// statuses, messages and any other webhook types are all routed correctly.
const extractPhoneNumbers = (payload: MetaWebhookPayload): string[] => {
    const phones = new Set<string>();

    for (const entry of payload.entry ?? []) {
        for (const change of entry.changes ?? []) {
            const phone = change.value?.metadata?.display_phone_number;
            if (phone) {
                phones.add(phone);
            }
        }
    }

    return [...phones];
};

const forwardToDestino = async (destino: RouteConfig, payload: MetaWebhookPayload): Promise<void> => {
    log('info', 'Forwarding message', { url: destino.url });

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
    };

    if (destino.token) {
        headers['Authorization'] = `Bearer ${destino.token}`;
    }

    await axios.post(destino.url, payload, { headers });
};

// Deduplicate destinations by URL, since the same target may be reachable
// through more than one matched phone number.
const collectDestinos = (phoneNumbers: string[], routes: Record<string, RouteConfig[]>): RouteConfig[] => {
    const byUrl = new Map<string, RouteConfig>();

    for (const phoneNumber of phoneNumbers) {
        for (const destino of routes[phoneNumber] ?? []) {
            byUrl.set(destino.url, destino);
        }
    }

    return [...byUrl.values()];
};

const processMessage = async (message: Message, routes: Record<string, RouteConfig[]>): Promise<boolean> => {
    const messageId = message.MessageId;

    try {
        if (!message.Body) {
            log('error', 'Message body is empty', { messageId });
            return false;
        }

        const payload: MetaWebhookPayload = JSON.parse(message.Body);

        log('info', 'Processing message', { messageId });

        const phoneNumbers = extractPhoneNumbers(payload);

        if (phoneNumbers.length === 0) {
            log('error', 'Phone number not found in payload', { messageId });
            return false;
        }

        log('info', 'Phone numbers found', { messageId, phoneNumbers });

        const destinos = collectDestinos(phoneNumbers, routes);

        if (destinos.length === 0) {
            log('error', 'No route configured for phones', { messageId, phoneNumbers });
            return false;
        }

        const results = await Promise.allSettled(destinos.map(destino => forwardToDestino(destino, payload)));

        results.forEach((result, index) => {
            if (result.status === 'rejected') {
                log('error', 'Failed to forward to destination', { messageId, url: destinos[index].url, ...errorFields(result.reason) });
            }
        });

        // At-least-one delivery is enough to consider the message handled;
        // the fully-failed destinations above are logged for follow-up.
        const delivered = results.some(result => result.status === 'fulfilled');

        if (!delivered) {
            log('error', 'All destinations failed', { messageId });
            return false;
        }

        log('info', 'Successfully forwarded message', { messageId });
        return true;
    } catch (error) {
        log('error', 'Failed to process message', { messageId, ...errorFields(error) });
        return false;
    }
};

const deleteMessage = async (messageId: string | undefined, receiptHandle: string): Promise<void> => {
    try {
        await sqsClient.send(new DeleteMessageCommand({
            QueueUrl: QUEUE_URL,
            ReceiptHandle: receiptHandle
        }));
        log('info', 'Message deleted from queue', { messageId });
    } catch (error) {
        log('error', 'Failed to delete message', { messageId, ...errorFields(error) });
    }
};

const pollOnce = async (routes: Record<string, RouteConfig[]>): Promise<void> => {
    const command = new ReceiveMessageCommand({
        QueueUrl: QUEUE_URL,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 20,
        MessageAttributeNames: ['All']
    });

    const response = await sqsClient.send(command);

    if (!response.Messages || response.Messages.length === 0) {
        return;
    }

    log('info', 'Received messages', { count: response.Messages.length });

    for (const message of response.Messages) {
        const success = await processMessage(message, routes);

        if (success && message.ReceiptHandle) {
            await deleteMessage(message.MessageId, message.ReceiptHandle);
        }
    }
};

const pollQueue = async (): Promise<void> => {
    const routes = loadRoutes();

    log('info', 'Polling queue', { queueUrl: QUEUE_URL, phones: Object.keys(routes) });

    while (true) {
        try {
            await pollOnce(routes);
        } catch (error) {
            log('error', 'Failed to poll queue', errorFields(error));

            // Wait before retrying on error
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
};

// Validate configuration
if (!QUEUE_URL) {
    log('error', 'QUEUE_URL environment variable is required');
    process.exit(1);
}

log('info', 'Starting SQS consumer', { queueUrl: QUEUE_URL, awsRegion: process.env.AWS_REGION || 'us-east-1' });

try {
    await pollQueue();
} catch (error) {
    log('error', 'Fatal error', errorFields(error));
    process.exit(1);
}
