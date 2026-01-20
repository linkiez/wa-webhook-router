import { DeleteMessageCommand, Message, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import axios from 'axios';
import 'dotenv/config';
import FormData from 'form-data';

const sqsClient = new SQSClient({ region: process.env.AWS_REGION || 'us-east-1' });
const QUEUE_URL = process.env.QUEUE_URL;
const WHATSAPP_API_TOKEN = process.env.WHATSAPP_API_TOKEN || '';

interface RouteConfig {
    url: string;
    token?: string;
}

interface WhatsAppDocument {
    filename: string;
    mime_type: string;
    sha256: string;
    id: string;
}

interface WhatsAppMessage {
    type?: string;
    document?: WhatsAppDocument;
    image?: { id: string; mime_type: string; sha256: string };
    video?: { id: string; mime_type: string; sha256: string };
    audio?: { id: string; mime_type: string; sha256: string };
}

interface MetaWebhookPayload {
    entry?: Array<{
        id?: string;
        changes?: Array<{
            value?: {
                metadata?: {
                    display_phone_number?: string;
                    phone_number_id?: string;
                };
                messages?: WhatsAppMessage[];
            };
        }>;
    }>;
}

// Load routing configuration
const loadRoutes = (): Record<string, RouteConfig> => {
    const destinos: Record<string, RouteConfig> = {};
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

                destinos[phone.trim()] = {
                    url,
                    token: token?.trim()
                };
            }
        });
    }

    return destinos;
};

// Download media from WhatsApp Cloud API
const downloadWhatsAppMedia = async (mediaId: string): Promise<Buffer | null> => {
    try {
        if (!WHATSAPP_API_TOKEN) {
            console.log('[Media Download] ERROR: WHATSAPP_API_TOKEN not configured');
            return null;
        }

        // Step 1: Get media URL from WhatsApp API
        const mediaInfoResponse = await axios.get(
            `https://graph.facebook.com/v18.0/${mediaId}`,
            {
                headers: {
                    'Authorization': `Bearer ${WHATSAPP_API_TOKEN}`
                }
            }
        );

        const mediaUrl = mediaInfoResponse.data?.url;
        if (!mediaUrl) {
            console.log('[Media Download] ERROR: Media URL not found in response');
            return null;
        }

        console.log('[Media Download] Downloading from URL:', mediaUrl);

        // Step 2: Download actual file
        const fileResponse = await axios.get(mediaUrl, {
            headers: {
                'Authorization': `Bearer ${WHATSAPP_API_TOKEN}`
            },
            responseType: 'arraybuffer'
        });

        console.log('[Media Download] Successfully downloaded media, size:', fileResponse.data.length, 'bytes');
        return Buffer.from(fileResponse.data);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error('[Media Download] ERROR: Failed to download media:', errorMessage);
        if (axios.isAxiosError(error)) {
            console.error('[Media Download] Response:', error.response?.data);
            console.error('[Media Download] Status:', error.response?.status);
        }
        return null;
    }
};

const processMessage = async (message: Message, routes: Record<string, RouteConfig>): Promise<boolean> => {
    try {
        if (!message.Body) {
            console.log('[SQS Consumer] ERROR: Message body is empty');
            return false;
        }

        const payload: MetaWebhookPayload = JSON.parse(message.Body);

        console.log('[SQS Consumer] Processing message:', message.MessageId);

        const phoneNumber = payload?.entry?.[0]?.changes?.[0]?.value?.metadata?.display_phone_number;

        if (!phoneNumber) {
            console.log('[SQS Consumer] ERROR: Phone number not found in payload:', JSON.stringify(payload));
            return false;
        }

        console.log('[SQS Consumer] Phone number:', phoneNumber);

        const destino = routes[phoneNumber];

        if (!destino) {
            console.log('[SQS Consumer] ERROR: No route configured for phone:', phoneNumber);
            return false;
        }

        console.log('[SQS Consumer] Forwarding to:', destino.url);

        // Check if payload contains a document that needs to be downloaded
        const messages = payload?.entry?.[0]?.changes?.[0]?.value?.messages;
        const firstMessage = messages?.[0];

        if (firstMessage?.type === 'document' && firstMessage.document) {
            const doc = firstMessage.document;
            console.log('[SQS Consumer] Document detected:', doc.filename, 'ID:', doc.id);

            // Download the document
            const fileBuffer = await downloadWhatsAppMedia(doc.id);

            if (fileBuffer) {
                // Send as multipart/form-data with the file attached
                const formData = new FormData();
                formData.append('file', fileBuffer, {
                    filename: doc.filename,
                    contentType: doc.mime_type
                });
                formData.append('payload', JSON.stringify(payload));

                const headers: Record<string, string> = {
                    ...formData.getHeaders()
                };

                if (destino.token) {
                    headers['Authorization'] = `Bearer ${destino.token}`;
                }

                console.log('[SQS Consumer] Forwarding with document attachment:', doc.filename);
                await axios.post(destino.url, formData, { headers });
            } else {
                // Fallback: send without file if download failed
                console.log('[SQS Consumer] WARNING: Failed to download document, sending webhook without file');
                const headers: Record<string, string> = {
                    'Content-Type': 'application/json',
                };

                if (destino.token) {
                    headers['Authorization'] = `Bearer ${destino.token}`;
                }

                await axios.post(destino.url, payload, { headers });
            }
        } else {
            // Normal webhook without document
            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
            };

            if (destino.token) {
                headers['Authorization'] = `Bearer ${destino.token}`;
            }

            await axios.post(destino.url, payload, { headers });
        }

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

const pollQueue = async (): Promise<void> => {
    const routes = loadRoutes();

    console.log('[SQS Consumer] Polling queue:', QUEUE_URL);
    console.log('[SQS Consumer] Available routes:', Object.keys(routes));

    while (true) {
        try {
            const command = new ReceiveMessageCommand({
                QueueUrl: QUEUE_URL,
                MaxNumberOfMessages: 10,
                WaitTimeSeconds: 20,
                MessageAttributeNames: ['All']
            });

            const response = await sqsClient.send(command);

            if (response.Messages && response.Messages.length > 0) {
                console.log(`[SQS Consumer] Received ${response.Messages.length} message(s)`);

                for (const message of response.Messages) {
                    const success = await processMessage(message, routes);

                    if (success && message.ReceiptHandle) {
                        await deleteMessage(message.ReceiptHandle);
                    }
                }
            } else {
                console.log('[SQS Consumer] No messages received');
            }
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

pollQueue().catch(error => {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[SQS Consumer] FATAL ERROR:', errorMessage);
    process.exit(1);
});
