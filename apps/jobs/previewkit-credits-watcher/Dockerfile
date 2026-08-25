# --- Stage 1: bundle the watcher -------------------------------------------------
FROM node:24-alpine AS builder

RUN corepack enable

WORKDIR /app
COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @autonoma/job-previewkit-credits-watcher build

# --- Stage 2: runtime ------------------------------------------------------------
FROM node:24-alpine

RUN apk add --no-cache openssl

WORKDIR /app
COPY --from=builder /app/apps/jobs/previewkit-credits-watcher/dist ./dist

ENV NODE_ENV=production
USER node

CMD ["node", "--enable-source-maps", "dist/index.js"]
