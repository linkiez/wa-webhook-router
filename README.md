# WhatsApp Webhook Router

A lightweight Express.js service that routes WhatsApp webhook events to different endpoints based on the phone number receiving the message.

## Overview

This router acts as a middleware between Meta's WhatsApp Business API and your application endpoints. It receives webhook events from Meta and forwards them to the appropriate destination URL based on the phone number associated with the event.

## Features

- **Phone-based routing**: Automatically routes webhook events to different endpoints based on the receiving phone number
- **Token verification**: Validates webhook subscriptions using authorized tokens
- **Environment-based configuration**: Tokens managed through environment variables
- **Error handling**: Comprehensive error handling and logging

## Installation

```bash
npm install
```

## Configuration

### Environment Variables

Create a `.env` file or set the following environment variables:

```env
AUTHORIZED_TOKENS=token1,token2,token3
DESTINATION_HOST=https://your-domain.com
PHONE_ROUTES=+55 19 3461-1720::/webhooks/whatsapp/+551934611720::secret_token|+55 19 9974-1871::/webhooks/whatsapp/+551999741871
```

- `AUTHORIZED_TOKENS`: Comma-separated list of tokens authorized for webhook verification
- `DESTINATION_HOST`: Base URL for destination endpoints (optional if using full URLs in routes)
- `PHONE_ROUTES`: Phone number to path/URL mappings.
  - Format: `phone::path|phone::path::token`
  - Token is optional - if provided, adds `Authorization: Bearer {token}` header
  - Paths will be appended to DESTINATION_HOST, or use full URLs starting with http/https

## Usage

### Start the server

```bash
node index.mjs
```

The server runs on port 3000 by default.

### Webhook Endpoints

#### GET /webhooks/router

Webhook verification endpoint for Meta's subscription confirmation.

**Query Parameters:**

- `hub.mode`: Should be "subscribe"
- `hub.verify_token`: Must match one of the authorized tokens
- `hub.challenge`: Challenge string to echo back

#### POST /webhooks/router

Receives webhook events from Meta and routes them to the appropriate destination.

**Behavior:**

1. Extracts phone number from webhook payload
2. Looks up destination URL based on phone number
3. Forwards complete payload to destination endpoint

## Docker Support

```bash
docker build -t wa-webhook-router .
docker run -p 3000:3000 \
  -e AUTHORIZED_TOKENS=token1,token2,token3 \
  -e DESTINATION_HOST=https://your-domain.com \
  -e PHONE_ROUTES="+55 19 3461-1720::/webhooks/whatsapp/+551934611720::secret_token|+55 19 9974-1871::/webhooks/whatsapp/+551999741871" \
  wa-webhook-router
```

## Response Codes

- `200`: Success
- `400`: Missing phone number or unrecognized number
- `403`: Invalid verification token
- `500`: Internal server error

## License

MIT
