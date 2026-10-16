# Northflank-ready Node.js Discord gateway bot.
# Stage 1: compile/install dependencies for Linux; no Windows node_modules reused.
FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Stage 2: runtime with yt-dlp for Linux and FFmpeg.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/yt-dlp \
    && /opt/yt-dlp/bin/pip install --no-cache-dir yt-dlp
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY bin/slskd/slskd-source.zip bin/slskd/LICENSE bin/slskd/SOURCE.md ./bin/slskd/
RUN mkdir -p data/binance data/machugi data/lossless && chown -R node:node /app
ENV NODE_ENV=production \
    YT_DLP_PATH=/opt/yt-dlp/bin/yt-dlp \
    WEB_ENABLED=1 WEB_PORT=3000 WEB_HOST=0.0.0.0 WEB_TUNNEL=0
USER node
EXPOSE 3000
CMD ["npm", "start"]
