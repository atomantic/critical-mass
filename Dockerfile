# ─── Stage 1: Build admin UI ───────────────────────────────────
FROM --platform=$BUILDPLATFORM node:26-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216 AS builder

WORKDIR /app

# The pinned base predates Alpine's zlib security fixes.
RUN apk add --no-cache 'zlib>=1.4-r0'

COPY admin/package.json admin/package-lock.json ./admin/
RUN cd admin && npm ci

COPY admin/ ./admin/
COPY shared/ ./shared/
RUN cd admin && npm run build

# ─── Stage 2: Production runtime ──────────────────────────────
FROM node:26-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216

WORKDIR /app

# Install the container process manager from its dedicated dependency lock
COPY docker/pm2/package.json docker/pm2/package-lock.json /opt/pm2/
RUN npm ci --omit=dev --prefix /opt/pm2
ENV PATH="/opt/pm2/node_modules/.bin:${PATH}"
# PM2 otherwise calls version.pm2.io daily with TLS verification disabled
ENV PM2_DISABLE_VERSION_CHECK=1
# Register the locked rotation module in PM2's usual module layout.
# pm2-runtime needs a writable PM2 home, but the package stays under /opt/pm2.
ENV PM2_HOME=/opt/pm2-home
COPY --chown=1000:1000 docker/pm2/module_conf.json /opt/pm2-home/module_conf.json
RUN mkdir -p "$PM2_HOME/modules/pm2-logrotate/node_modules" \
    && ln -s /opt/pm2/node_modules/pm2-logrotate "$PM2_HOME/modules/pm2-logrotate/node_modules/pm2-logrotate" \
    && chown -R 1000:1000 "$PM2_HOME"

# zip/unzip are used by src/backup-service.js for archive create/restore
RUN apk add --no-cache zip unzip 'zlib>=1.4-r0'

# Prepare writable application storage before adding dependencies or code.
RUN mkdir -p data logs && chown 1000:1000 /app data logs
USER 1000:1000

# Install production dependencies as the runtime user.
COPY --chown=1000:1000 package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application code
COPY --chown=1000:1000 server.js ecosystem.config.cjs ./
# Seed config (safe dry-run defaults); operator config.json stays excluded
COPY --chown=1000:1000 config.example.json ./
COPY --chown=1000:1000 src/ ./src/
COPY --chown=1000:1000 shared/ ./shared/
COPY --chown=1000:1000 engines/ ./engines/
# Ordered gateway-then-engines stop, run by docker-entrypoint.sh on SIGTERM
COPY --chown=1000:1000 scripts/pm2-stack.js ./scripts/pm2-stack.js

# Copy built admin UI from builder stage
COPY --chown=1000:1000 --from=builder /app/admin/dist ./admin/dist

COPY --chmod=755 docker-entrypoint.sh /docker-entrypoint.sh

EXPOSE 5570

ENTRYPOINT ["/docker-entrypoint.sh"]
