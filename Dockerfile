# ─── Stage 1: Build admin UI ───────────────────────────────────
FROM --platform=$BUILDPLATFORM node:26-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS builder

WORKDIR /app

COPY admin/package.json admin/package-lock.json ./admin/
RUN cd admin && npm ci

COPY admin/ ./admin/
COPY shared/ ./shared/
RUN cd admin && npm run build

# ─── Stage 2: Production runtime ──────────────────────────────
FROM node:26-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797

WORKDIR /app

# Install the container process manager from its dedicated dependency lock
COPY docker/pm2/package.json docker/pm2/package-lock.json /opt/pm2/
RUN npm ci --omit=dev --prefix /opt/pm2
ENV PATH="/opt/pm2/node_modules/.bin:${PATH}"
# PM2 otherwise calls version.pm2.io daily with TLS verification disabled
ENV PM2_DISABLE_VERSION_CHECK=1

# zip/unzip are used by src/backup-service.js for archive create/restore
RUN apk add --no-cache zip unzip

# Install production dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application code
COPY server.js ecosystem.config.cjs ./
# Seed config (safe dry-run defaults); operator config.json stays excluded
COPY config.example.json ./
COPY src/ ./src/
COPY shared/ ./shared/
COPY engines/ ./engines/
# Ordered gateway-then-engines stop, run by docker-entrypoint.sh on SIGTERM
COPY scripts/pm2-stack.js ./scripts/pm2-stack.js

# Copy built admin UI from builder stage
COPY --from=builder /app/admin/dist ./admin/dist

# Copy Docker entrypoint
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Create persistent directories with correct ownership
RUN mkdir -p data logs && chown -R 1000:1000 /app

USER 1000

EXPOSE 5570

ENTRYPOINT ["/docker-entrypoint.sh"]
