import { DeleteMessageCommand, Message, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import axios from 'axios';
import 'dotenv/config';

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
    const destinoHost = process.env.DESTINATION_HOST || '';

    if (process.env.PHONE_ROUTES) {
        const routes = process.env.PHONE_ROUTES.split('|');
        routes.forEach(route => {
            const parts = route.split('::');
            const phone = parts[0];
            const path = parts[1];
            const token = parts[2];

            if (phone && path) {
                let url: string;
                if (path.startsWith('http://') || path.startsWith('https://')) {
                    url = path;
                } else {
                    const normalizedHost = destinoHost.endsWith('/') ? destinoHost.slice(0, -1) : destinoHost;
                    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
                    url = `${normalizedHost}${normalizedPath}`;
                }

                const key = phone.trim();
                const destino: RouteConfig = { url, token: token?.trim() };
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
    console.log('[SQS Consumer] Forwarding to:', destino.url);

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
    try {
        if (!message.Body) {
            console.log('[SQS Consumer] ERROR: Message body is empty');
            return false;
        }

        const payload: MetaWebhookPayload = JSON.parse(message.Body);

        console.log('[SQS Consumer] Processing message:', message.MessageId);

        const phoneNumbers = extractPhoneNumbers(payload);

        if (phoneNumbers.length === 0) {
            console.log('[SQS Consumer] ERROR: Phone number not found in payload');
            return false;
        }

        console.log('[SQS Consumer] Phone numbers:', phoneNumbers.join(', '));

        const destinos = collectDestinos(phoneNumbers, routes);

        if (destinos.length === 0) {
            console.log('[SQS Consumer] ERROR: No route configured for phones:', phoneNumbers.join(', '));
            return false;
        }

        await Promise.all(destinos.map(destino => forwardToDestino(destino, payload)));

        console.log('[SQS Consumer] Successfully forwarded message');
        return true;
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const errorStack = error instanceof Error ? error.stack : '';
        console.error('[SQS Consumer] ERROR: Failed to process message:', errorMessage);
        console.error('[SQS Consumer] Stack:', errorStack);
        return false;
    }
};

const deleteMessage = async (receiptHandle: string): Promise<void> => {
    try {
        await sqsClient.send(new DeleteMessageCommand({
            QueueUrl: QUEUE_URL,
            ReceiptHandle: receiptHandle
        }));
        console.log('[SQS Consumer] Message deleted from queue');
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error('[SQS Consumer] ERROR: Failed to delete message:', errorMessage);
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
        console.log('[SQS Consumer] No messages received');
        return;
    }

    console.log(`[SQS Consumer] Received ${response.Messages.length} message(s)`);

    for (const message of response.Messages) {
        const success = await processMessage(message, routes);

        if (success && message.ReceiptHandle) {
            await deleteMessage(message.ReceiptHandle);
        }
    }
};

const pollQueue = async (): Promise<void> => {
    const routes = loadRoutes();

    console.log('[SQS Consumer] Polling queue:', QUEUE_URL);
    console.log('[SQS Consumer] Available routes:', Object.keys(routes));

    while (true) {
        try {
            await pollOnce(routes);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            const errorStack = error instanceof Error ? error.stack : '';
            console.error('[SQS Consumer] ERROR: Failed to poll queue:', errorMessage);
            console.error('[SQS Consumer] Stack:', errorStack);

            // Wait before retrying on error
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
};

// Validate configuration
if (!QUEUE_URL) {
    console.error('[SQS Consumer] FATAL: QUEUE_URL environment variable is required');
    process.exit(1);
}

console.log('[SQS Consumer] Starting...');
console.log('[SQS Consumer] Queue URL:', QUEUE_URL);
console.log('[SQS Consumer] AWS Region:', process.env.AWS_REGION || 'us-east-1');

try {
    await pollQueue();
} catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[SQS Consumer] FATAL ERROR:', errorMessage);
    process.exit(1);
}
