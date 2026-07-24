# syntax=docker/dockerfile:1

# ---- Dependencies ----
FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json ./
RUN npm ci

# ---- Build ----
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
RUN npm run build

# ---- Production runner ----
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN apk add --no-cache libc6-compat su-exec \
  && addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs \
  && mkdir -p /app/data /app/public \
  && chown -R nextjs:nodejs /app

# Public assets (may be empty)
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Standalone Next.js server output
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --chown=nextjs:nodejs scripts/start.sh ./start.sh
# Normalize CRLF from Windows checkouts so Alpine can exec the script
RUN sed -i 's/\r$//' ./start.sh && chmod +x ./start.sh

# Run entrypoint as root so it can chown the Railway volume at /app/data,
# then drop privileges to nextjs via su-exec in start.sh.
EXPOSE 3000

# Railway injects PORT. Force HOSTNAME=0.0.0.0 so Next does not bind to the
# container hostname (which breaks Railway health checks).
CMD ["./start.sh"]
