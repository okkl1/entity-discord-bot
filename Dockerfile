# syntax=docker/dockerfile:1
# Combined service for Discord gateway + quiz web UI + optional Linux Soulseek client.
FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Official slskd self-contained Linux application (do NOT expose its HTTP port publicly).
FROM ghcr.io/slskd/slskd:0.26.0 AS slskd_binary

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-venv ffmpeg ca-certificates libicu72 libssl3 \
        libgssapi-krb5-2 zlib1g \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/yt-dlp \
    && /opt/yt-dlp/bin/pip install --no-cache-dir "yt-dlp[default]" \
    && /opt/yt-dlp/bin/yt-dlp --version \
    && /opt/yt-dlp/bin/pip show yt-dlp-ejs >/dev/null
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=slskd_binary /slskd /opt/slskd
COPY package.json package-lock.json ./
COPY src ./src
COPY bin/slskd/slskd-source.zip bin/slskd/LICENSE bin/slskd/SOURCE.md ./bin/slskd/
RUN test -x /opt/slskd/slskd \
    && mkdir -p data/binance data/machugi data/lossless data/chzzk /tmp/dotnet-bundle \
    && chown -R node:node /app /tmp/dotnet-bundle
ENV NODE_ENV=production \
    ENTITY_MEMORY_PROFILE=compact \
    YT_DLP_PATH=/opt/yt-dlp/bin/yt-dlp \
    SLSKD_EXECUTABLE=/opt/slskd/slskd \
    DOTNET_BUNDLE_EXTRACT_BASE_DIR=/tmp/dotnet-bundle \
    SLSKD_NO_DISK_LOGGER=1 \
    CHZZK_AUTH_FILE=/app/data/chzzk/.auth.json \
    LOSSLESS_MIN_FREE_MB=256 \
    WEB_ENABLED=1 WEB_PORT=3000 WEB_HOST=0.0.0.0 WEB_TUNNEL=0
USER node
EXPOSE 3000
CMD ["node", "src/index.js"]
