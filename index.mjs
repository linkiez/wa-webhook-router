const express = require('express');
const axios = require('axios');
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

    if (mode === 'subscribe' && tokensAutorizados.includes(token)) {
        console.log('Webhook verificado');
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

app.post('/webhooks/router', async (req, res) => {
    try {
        const payload = req.body;

        const phoneNumber = payload?.entry?.[0]?.changes?.[0]?.value?.metadata?.display_phone_number;

        if (!phoneNumber) {
            return res.status(400).send('Número de telefone não encontrado no payload');
        }

        // Defina os destinos com base no número
        const destinos = {
            '+55 19 3461-1720': {
                url: 'https://chat.jcmmetais.com.br/webhooks/whatsapp/+551934611720',
            },
            '+55 19 9974-1871': {
                url: 'https://chat.jcmmetais.com.br/webhooks/whatsapp/+551999741871',
            },
        };

        const destino = destinos[phoneNumber];

        if (!destino) {
            return res.status(400).send('Número não reconhecido');
        }

        // Redirecionar para a URL correta
        await axios.post(destino.url, payload, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${destino.token}`,
            },
        });

        res.sendStatus(200);
    } catch (error) {
        console.error('Erro ao redirecionar webhook:', error);
        res.status(500).send('Erro interno no roteador');
    }
});

app.listen(3000, () => {
    console.log('Roteador de Webhooks rodando na porta 3000');
});
