FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npm run build

# Production dependencies stage
FROM node:20-alpine AS prod-deps

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install production dependencies only
RUN npm ci --only=production

# Final stage - Use Debian base to have procps (pgrep)
FROM node:20-slim

# Install procps for pgrep command used in healthcheck
RUN apt-get update && \
    apt-get install -y --no-install-recommends procps && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Keep /nodejs/bin/node available for healthchecks (works with distroless-style paths)
RUN mkdir -p /nodejs/bin && ln -sf /usr/local/bin/node /nodejs/bin/node

WORKDIR /app

# Copy package files and production node_modules from prod-deps stage
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/package.json ./package.json

# Copy built application
COPY --from=builder /app/dist ./dist

# Create non-root user
RUN groupadd -r nodejs && useradd -r -g nodejs nodejs && \
    chown -R nodejs:nodejs /app

USER nodejs

# Start the application
CMD ["node", "dist/index.js"]
