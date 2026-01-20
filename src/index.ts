import { DeleteMessageCommand, Message, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Storage } from '@google-cloud/storage';
import axios from 'axios';
import 'dotenv/config';

const sqsClient = new SQSClient({ region: process.env.AWS_REGION || 'us-east-1' });
const QUEUE_URL = process.env.QUEUE_URL;
const WHATSAPP_API_TOKEN = process.env.WHATSAPP_API_TOKEN || '';

// Google Cloud Storage configuration
const GCS_BUCKET = process.env.GCS_BUCKET || 'chatwoot-whatsapp-media';
const GCS_CREDENTIALS_PATH = process.env.GCS_CREDENTIALS_PATH || '/app/gcs-credentials.json';
let storage: Storage | null = null;

// Initialize GCS only if credentials exist
try {
    storage = new Storage({ keyFilename: GCS_CREDENTIALS_PATH });
    console.log('[GCS] Initialized with bucket:', GCS_BUCKET);
} catch (error) {
    console.log('[GCS] WARNING: Failed to initialize Google Cloud Storage:', error instanceof Error ? error.message : 'Unknown error');
    console.log('[GCS] Documents will be sent without modification');
}

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

// Upload file to Google Cloud Storage and return public URL
const uploadToGCS = async (fileBuffer: Buffer, filename: string, mimeType: string): Promise<string | null> => {
    try {
        if (!storage) {
            console.log('[GCS Upload] ERROR: Storage not initialized');
            return null;
        }

        const bucket = storage.bucket(GCS_BUCKET);
        
        // Generate unique filename with timestamp
        const timestamp = Date.now();
        const sanitizedFilename = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
        const gcsFilename = `whatsapp-documents/${timestamp}-${sanitizedFilename}`;
        
        const file = bucket.file(gcsFilename);
        
        console.log('[GCS Upload] Uploading to:', gcsFilename);
        
        // Upload file
        await file.save(fileBuffer, {
            metadata: {
                contentType: mimeType,
                metadata: {
                    source: 'whatsapp-webhook-router',
                    originalFilename: filename
                }
            },
            public: true, // Make file publicly accessible
        });
        
        // Get public URL
        const publicUrl = `https://storage.googleapis.com/${GCS_BUCKET}/${gcsFilename}`;
        
        console.log('[GCS Upload] Successfully uploaded, URL:', publicUrl);
        return publicUrl;
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error('[GCS Upload] ERROR: Failed to upload file:', errorMessage);
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

            if (fileBuffer && storage) {
                // Upload to Google Cloud Storage
                const gcsUrl = await uploadToGCS(fileBuffer, doc.filename, doc.mime_type);
                
                if (gcsUrl) {
                    // Modify webhook payload to replace WhatsApp URL with GCS URL
                    const modifiedPayload = JSON.parse(JSON.stringify(payload)); // Deep clone
                    if (modifiedPayload.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.document) {
                        modifiedPayload.entry[0].changes[0].value.messages[0].document.url = gcsUrl;
                        console.log('[SQS Consumer] Replaced document URL with GCS URL:', gcsUrl);
                    }
                    
                    // Send modified webhook with GCS URL
                    const headers: Record<string, string> = {
                        'Content-Type': 'application/json',
                    };
                    
                    if (destino.token) {
                        headers['Authorization'] = `Bearer ${destino.token}`;
                    }
                    
                    console.log('[SQS Consumer] Forwarding with GCS document URL');
                    await axios.post(destino.url, modifiedPayload, { headers });
                } else {
                    // GCS upload failed, send original webhook
                    console.log('[SQS Consumer] WARNING: Failed to upload to GCS, sending original webhook');
                    const headers: Record<string, string> = {
                        'Content-Type': 'application/json',
                    };
                    
                    if (destino.token) {
                        headers['Authorization'] = `Bearer ${destino.token}`;
                    }
                    
                    await axios.post(destino.url, payload, { headers });
                }
            } else {
                // Download failed or GCS not configured, send original webhook
                console.log('[SQS Consumer] WARNING: Failed to download document or GCS not configured, sending original webhook');
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
