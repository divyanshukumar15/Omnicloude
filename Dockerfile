# syntax=docker/dockerfile:1
# OmniHub GovJobs Automation AI - control app (API + scheduler + UI).
# The official-source acquisition worker has its own image: worker/Dockerfile.production

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATABASE_PATH=/app/data/govjobs.db \
    DOCUMENT_STORAGE_DIR=/app/documents \
    BACKUP_DIR=/app/backups
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY tsconfig.json server.ts ./
COPY src ./src
RUN mkdir -p /app/data /app/documents /app/backups && chown -R node:node /app
USER node
VOLUME ["/app/data", "/app/documents", "/app/backups"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.ts"]
