FROM node:20-alpine AS builder

WORKDIR /app

# Enable Corepack for Yarn 4
RUN corepack enable

# Copy package files
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn ./.yarn

# Install dependencies
RUN yarn install --immutable

# Copy source code
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN yarn build

# Production dependencies stage
FROM node:20-alpine AS prod-deps

WORKDIR /app

# Enable Corepack
RUN corepack enable

# Copy package files
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn ./.yarn

# Install production dependencies only
RUN yarn workspaces focus --production && yarn cache clean

# Final stage
FROM gcr.io/distroless/nodejs24-debian12:nonroot

WORKDIR /app

# Copy package files and production node_modules from prod-deps stage
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/package.json ./package.json

# Copy built application
COPY --from=builder /app/dist ./dist

# Start the application
CMD ["dist/index.js"]
