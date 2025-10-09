import axios from 'axios';
import express from 'express';

const app = express();

app.use(express.json());

// Tokens autorizados para verificação de webhook
const tokensAutorizados = process.env.AUTHORIZED_TOKENS 
    ? process.env.AUTHORIZED_TOKENS.split(',').map(token => token.trim())
    : [];

app.get('/webhooks/router', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    console.log('[GET /webhooks/router] Verification request:', { mode, token: token ? '***' : undefined });

    if (mode === 'subscribe' && tokensAutorizados.includes(token) && challenge) {
        console.log('[GET /webhooks/router] Webhook verified successfully');
        res.status(200).send(challenge);
    } else {
        console.log('[GET /webhooks/router] Verification failed - invalid token, mode, or missing challenge');
        res.sendStatus(403);
    }
});

app.post('/webhooks/router', async (req, res) => {
    try {
        console.log('[POST /webhooks/router] Received webhook payload');

        const payload = req.body;

        const phoneNumber = payload?.entry?.[0]?.changes?.[0]?.value?.metadata?.display_phone_number;

        console.log('[POST /webhooks/router] Extracted phone number:', phoneNumber);

        if (!phoneNumber) {
            console.log('[POST /webhooks/router] ERROR: Phone number not found in payload');
            return res.status(400).send('Número de telefone não encontrado no payload');
        }

        // Carrega destinos da variável de ambiente
        const destinos = {};
        const destinoHost = process.env.DESTINATION_HOST || '';
        
        if (process.env.PHONE_ROUTES) {
            const routes = process.env.PHONE_ROUTES.split('|');
            routes.forEach(route => {
                const parts = route.split('::');
                const phone = parts[0];
                const path = parts[1];
                const token = parts[2]; // Optional token
                
                if (phone && path) {
                    let url;
                    if (path.startsWith('http://') || path.startsWith('https://')) {
                        url = path;
                    } else {
                        // Ensure proper URL concatenation with slash
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

        console.log('[POST /webhooks/router] Available routes:', Object.keys(destinos));

        const destino = destinos[phoneNumber];

        if (!destino) {
            console.log('[POST /webhooks/router] ERROR: Phone number not recognized:', phoneNumber);
            return res.status(400).send('Número não reconhecido');
        }

        console.log('[POST /webhooks/router] Forwarding to:', destino.url);

        // Redirecionar para a URL correta
        const headers = {
            'Content-Type': 'application/json',
        };
        
        // Only add Authorization header if token is provided
        if (destino.token) {
            headers['Authorization'] = `Bearer ${destino.token}`;
        }
        
        await axios.post(destino.url, payload, { headers });

        console.log('[POST /webhooks/router] Successfully forwarded webhook');
        res.sendStatus(200);
    } catch (error) {
        console.error('[POST /webhooks/router] ERROR: Failed to forward webhook:', error.message);
        console.error('[POST /webhooks/router] Stack:', error.stack);
        res.status(500).send('Erro interno no roteador');
    }
});

if (process.env.NODE_ENV !== 'test') {
    app.listen(3000, () => {
        console.log('[SERVER] Webhook router running on port 3000');
        console.log('[SERVER] Authorized tokens:', tokensAutorizados.length > 0 ? `${tokensAutorizados.length} token(s) configured` : 'NONE - verification will fail!');
        console.log('[SERVER] Destination host:', process.env.DESTINATION_HOST || 'NOT SET');
        
        // Validate configuration on startup
        if (process.env.PHONE_ROUTES) {
            const routes = process.env.PHONE_ROUTES.split('|');
            console.log('[SERVER] Phone routes configured:', routes.length);
            
            routes.forEach((route, index) => {
                const parts = route.split('::');
                if (parts.length < 2) {
                    console.warn(`[SERVER] WARNING: Route ${index + 1} is malformed (missing ::): ${route}`);
                } else if (!parts[0] || !parts[1]) {
                    console.warn(`[SERVER] WARNING: Route ${index + 1} has empty phone or path: ${route}`);
                }
            });
        } else {
            console.warn('[SERVER] WARNING: No PHONE_ROUTES configured - all requests will be rejected!');
        }
    });
}

export default app;
