#!/bin/bash

# AWS SQS Queue Consumer - IAM User Setup Script
# This script creates an IAM user with read-only access to a specific SQS queue

set -e

# Configuration
USER_NAME="${IAM_USER_NAME:-sqs-consumer-user}"
QUEUE_NAME="${QUEUE_NAME:-Chatwoot-Meta-Queue.fifo}"
REGION="${AWS_REGION:-us-east-1}"
POLICY_NAME="${USER_NAME}-sqs-readonly-policy"

echo "=== Creating IAM User for SQS Queue Consumer ==="
echo "User: $USER_NAME"
echo "Queue: $QUEUE_NAME"
echo "Region: $REGION"
echo ""

# Step 1: Get Queue ARN
echo "Step 1: Getting Queue ARN..."
QUEUE_URL=$(aws sqs get-queue-url --queue-name "$QUEUE_NAME" --region "$REGION" 2>/dev/null | jq -r '.QueueUrl')

if [ -z "$QUEUE_URL" ] || [ "$QUEUE_URL" = "null" ]; then
    echo "Error: Queue '$QUEUE_NAME' not found in region $REGION"
    exit 1
fi

QUEUE_ARN=$(aws sqs get-queue-attributes \
    --queue-url "$QUEUE_URL" \
    --attribute-names QueueArn \
    --region "$REGION" \
    | jq -r '.Attributes.QueueArn')

echo "Queue URL: $QUEUE_URL"
echo "Queue ARN: $QUEUE_ARN"

# Step 2: Check if user exists
echo ""
echo "Step 2: Checking if IAM user exists..."
USER_EXISTS=$(aws iam get-user --user-name "$USER_NAME" 2>/dev/null || echo "")

if [ -n "$USER_EXISTS" ]; then
    echo "User '$USER_NAME' already exists"
    READ -p "Do you want to recreate the access keys? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Skipping user creation"
        exit 0
    fi
else
    echo "Creating IAM user: $USER_NAME"
    aws iam create-user --user-name "$USER_NAME" > /dev/null
    echo "User created successfully"
fi

# Step 3: Create and attach policy
echo ""
echo "Step 3: Creating SQS read-only policy..."

# Create policy document
cat > /tmp/sqs-readonly-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes",
        "sqs:GetQueueUrl"
      ],
      "Resource": "$QUEUE_ARN"
    }
  ]
}
EOF

# Delete existing policy if it exists
EXISTING_POLICIES=$(aws iam list-user-policies --user-name "$USER_NAME" 2>/dev/null | jq -r '.PolicyNames[]')
if echo "$EXISTING_POLICIES" | grep -q "$POLICY_NAME"; then
    echo "Deleting existing inline policy..."
    aws iam delete-user-policy --user-name "$USER_NAME" --policy-name "$POLICY_NAME"
fi

# Attach inline policy
echo "Attaching SQS read-only policy to user..."
aws iam put-user-policy \
    --user-name "$USER_NAME" \
    --policy-name "$POLICY_NAME" \
    --policy-document file:///tmp/sqs-readonly-policy.json

echo "Policy attached successfully"

# Step 4: Delete old access keys
echo ""
echo "Step 4: Managing access keys..."
OLD_KEYS=$(aws iam list-access-keys --user-name "$USER_NAME" | jq -r '.AccessKeyMetadata[].AccessKeyId')

if [ -n "$OLD_KEYS" ]; then
    echo "Deleting old access keys..."
    for key in $OLD_KEYS; do
        aws iam delete-access-key --user-name "$USER_NAME" --access-key-id "$key"
        echo "Deleted: $key"
    done
fi

# Step 5: Create new access key
echo ""
echo "Step 5: Creating new access key..."
ACCESS_KEY_OUTPUT=$(aws iam create-access-key --user-name "$USER_NAME")

ACCESS_KEY_ID=$(echo "$ACCESS_KEY_OUTPUT" | jq -r '.AccessKey.AccessKeyId')
SECRET_ACCESS_KEY=$(echo "$ACCESS_KEY_OUTPUT" | jq -r '.AccessKey.SecretAccessKey')

# Step 6: Generate .env file
echo ""
echo "Step 6: Generating .env file..."

cat > .env.credentials <<EOF
# AWS Credentials for SQS Consumer
# Generated on $(date)
# User: $USER_NAME
# Queue: $QUEUE_NAME

AWS_ACCESS_KEY_ID=$ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY=$SECRET_ACCESS_KEY
AWS_REGION=$REGION
QUEUE_URL=$QUEUE_URL

# Add your routing configuration below
# DESTINATION_HOST=http://localhost:3001
# PHONE_ROUTES=5511999999999::/webhooks/meta|5511888888888::/webhooks/whatsapp
EOF

echo ""
echo "=== Setup Complete ==="
echo ""
echo "IAM User: $USER_NAME"
echo "Access Key ID: $ACCESS_KEY_ID"
echo "Secret Access Key: $SECRET_ACCESS_KEY (saved to .env.credentials)"
echo ""
echo "Queue URL: $QUEUE_URL"
echo "Queue ARN: $QUEUE_ARN"
echo ""
echo "Credentials saved to: .env.credentials"
echo ""
echo "IMPORTANT: Copy .env.credentials to .env and add your routing configuration:"
echo "  cp .env.credentials .env"
echo "  nano .env  # Add DESTINATION_HOST and PHONE_ROUTES"
echo ""
echo "For Docker deployment, use these environment variables in your docker-compose.yml"
echo ""

# Cleanup
rm -f /tmp/sqs-readonly-policy.json

# Display example docker-compose snippet
cat <<'DOCKER'
Example docker-compose.yml:

version: '3.8'
services:
  wa-webhook-router:
    image: wa-webhook-router:latest
    environment:
      - AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID}
      - AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY}
      - AWS_REGION=${AWS_REGION}
      - QUEUE_URL=${QUEUE_URL}
      - DESTINATION_HOST=http://your-app:3000
      - PHONE_ROUTES=5511999999999::/webhooks/meta
    restart: unless-stopped
DOCKER
