# WhatsApp Webhook Router (SQS Consumer)

A lightweight Node.js/TypeScript service that polls AWS SQS queue for WhatsApp webhook events and routes them to different endpoints based on the phone number.

## Overview

This router polls messages from an AWS SQS queue (populated by a Lambda function receiving webhooks from Meta) and forwards them to the appropriate destination URL based on the phone number associated with the event.

## Features

- **TypeScript**: Fully typed for better development experience
- **SQS polling**: Long-polling AWS SQS queue for webhook events
- **Phone-based routing**: Routes messages to different endpoints based on receiving phone number
- **Automatic message deletion**: Removes successfully processed messages from queue
- **Error handling**: Comprehensive error handling with automatic retry
- **Environment-based configuration**: Routes managed through environment variables

## Installation

```bash
npm install
```

## Configuration

### Environment Variables

Create a `.env` file or set the following environment variables:

```env
QUEUE_URL=https://sqs.us-east-1.amazonaws.com/523566111264/Chatwoot-Meta-Queue
AWS_REGION=us-east-1
DESTINATION_HOST=http://localhost:3001
PHONE_ROUTES=5511999999999::/webhooks/meta::token123|5511888888888::/webhooks/whatsapp
```

### AWS Credentials

The application uses the AWS SDK which supports multiple authentication methods (in order of precedence):

1. **Environment Variables** (if running locally without AWS CLI):
   ```bash
   export AWS_ACCESS_KEY_ID=your-access-key-id
   export AWS_SECRET_ACCESS_KEY=your-secret-access-key
   ```

2. **AWS CLI Credentials** (recommended for local development):
   ```bash
   aws configure
   # Enter your credentials when prompted
   ```

3. **IAM Role** (when running on AWS services like EC2, ECS, Lambda)

#### Configuration Options

- `QUEUE_URL`: AWS SQS queue URL (required)
- `AWS_REGION`: AWS region for SQS client (default: us-east-1)
- `DESTINATION_HOST`: Base URL for destination endpoints (optional if using full URLs in routes)
- `PHONE_ROUTES`: Phone number to path/URL mappings
  - Format: `phone::path|phone::path::token`
  - Token is optional - if provided, adds `Authorization: Bearer {token}` header
  - Paths will be appended to DESTINATION_HOST, or use full URLs starting with http/https

## Installation

```bash
yarn install
```

## Build

```bash
yarn build
```

## Usage

### Development

Run with hot reload:

```bash
yarn dev
```

### Production

Build and start:

```bash
yarn build
yarn start
```

The consumer will continuously poll the SQS queue and forward messages to configured endpoints.

## Architecture

```
Meta WhatsApp → Lambda Function → SQS Queue → This Consumer → Your Endpoints
```

1. Meta sends webhooks to Lambda Function URL
2. Lambda validates and puts message in SQS queue
3. This consumer polls SQS queue
4. Routes messages to appropriate endpoint based on phone number
5. Deletes successfully processed messages from queue

## Docker Deployment

### Step 1: Create AWS Credentials

Run the included script to create an IAM user with SQS read-only access:

```bash
./create-sqs-credentials.sh
```

This will:
- Create an IAM user with minimal permissions (SQS read-only)
- Generate access credentials
- Save credentials to `.env.credentials`

### Step 2: Configure Environment

```bash
# Copy generated credentials
cp .env.credentials .env

# Edit and add routing configuration
nano .env
```

Add your routing configuration:
```env
DESTINATION_HOST=http://your-app:3000
PHONE_ROUTES=5511999999999::/webhooks/meta|5511888888888::/webhooks/whatsapp
```

### Step 3: Build and Run

```bash
# Build Docker image
docker build -t wa-webhook-router .

# Run with docker-compose
docker-compose up -d

# View logs
docker-compose logs -f

# Stop
docker-compose down
```

### Manual Docker Run

```bash
docker run -d \
  --name wa-webhook-router \
  --env-file .env \
  --restart unless-stopped \
  wa-webhook-router
```

## Response Handling

- Successfully processed messages are deleted from the queue
- Failed messages remain in queue for retry (based on SQS redrive policy)
- Logs all processing steps for debugging

## License

MIT
