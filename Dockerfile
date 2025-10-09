# Stage 1: Build
FROM node:24-slim AS builder

WORKDIR /app

COPY package*.json ./

RUN npm install --only=production

# Stage 2: Runtime
FROM gcr.io/distroless/nodejs24-debian12:nonroot

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY index.mjs ./
COPY package.json ./

EXPOSE 3000

CMD ["index.mjs"]
