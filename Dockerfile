# syntax=docker/dockerfile:1

# Debian, not Alpine: Playwright's Chromium needs glibc and its system libraries.
# ---- Dependencies ----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts ./scripts
# Browsers are installed once in the runner, outside the Railway /app/data volume.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci

# ---- Build ----
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm run build

# ---- Production runner ----
FROM node:22-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates gosu \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs --create-home nextjs \
  && mkdir -p /app/data /app/public /opt/playwright-browsers \
  && chown -R nextjs:nodejs /app

# Public assets (may be empty)
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Standalone Next.js server output
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --chown=nextjs:nodejs scripts/start.sh ./start.sh
# Playwright is externalized. Copy it even if the standalone trace misses a nested file.
COPY --from=builder /app/node_modules/playwright ./node_modules/playwright
COPY --from=builder /app/node_modules/playwright-core ./node_modules/playwright-core

# Chromium lives outside /app/data so a Railway volume cannot hide it.
RUN node node_modules/playwright/cli.js install --with-deps chromium \
  && chmod -R a+rX /opt/playwright-browsers

# Normalize CRLF from Windows checkouts so Debian can exec the script
RUN sed -i 's/\r$//' ./start.sh && chmod +x ./start.sh

# Run entrypoint as root so it can chown the Railway volume at /app/data,
# then drop privileges to nextjs via gosu in start.sh.
EXPOSE 3000

# Railway injects PORT. Force HOSTNAME=0.0.0.0 so Next does not bind to the
# container hostname (which breaks Railway health checks).
CMD ["./start.sh"]
