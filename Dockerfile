# ─── Stage 1: Build admin UI ───────────────────────────────────
FROM --platform=$BUILDPLATFORM node:22-alpine AS builder

WORKDIR /app

COPY admin/package.json admin/package-lock.json ./admin/
RUN cd admin && npm ci

COPY admin/ ./admin/
RUN cd admin && npm run build

# ─── Stage 2: Production runtime ──────────────────────────────
FROM node:22-alpine

WORKDIR /app

# Install PM2 globally for multi-process orchestration
RUN npm install -g pm2

# Install production dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application code
COPY server.js ecosystem.config.cjs ./
COPY src/ ./src/
COPY engines/ ./engines/

# Copy built admin UI from builder stage
COPY --from=builder /app/admin/dist ./admin/dist

# Copy Docker entrypoint
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Create persistent directories with correct ownership
RUN mkdir -p data logs && chown -R 1000:1000 /app

USER 1000

EXPOSE 5563

ENTRYPOINT ["/docker-entrypoint.sh"]
