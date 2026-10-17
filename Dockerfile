# syntax=docker/dockerfile:1
# Combined service for Discord gateway + quiz web UI + optional Linux Soulseek client.
FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY bin/slskd/slskd-source.zip /tmp/slskd-source.zip
RUN python3 -m zipfile -e /tmp/slskd-source.zip /slskd-source

# Build the matching Entity source: the stock image has no live RESPONSE events
# and misses the search finalization/concurrency fixes used by our web client.
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS slskd_binary
WORKDIR /source
COPY --from=dependencies /slskd-source/slskd-0.26.0/ ./
RUN dotnet publish src/slskd/slskd.csproj -c Release -r linux-x64 \
    --self-contained true -p:RunAnalyzers=false -p:EnableNETAnalyzers=false \
    -p:PublishSingleFile=false -o /entity-slskd

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
COPY --from=slskd_binary /entity-slskd /opt/slskd
COPY package.json package-lock.json ./
COPY src ./src
COPY bin/slskd/slskd-source.zip bin/slskd/LICENSE bin/slskd/SOURCE.md ./bin/slskd/
RUN test -x /opt/slskd/slskd \
    && /usr/bin/ffmpeg -nostdin -hide_banner -loglevel error -f lavfi -i sine=duration=0.1 \
       -c:a libopus -f null - \
    && mkdir -p data/machugi data/lossless data/chzzk /tmp/dotnet-bundle \
    && chown -R node:node /app /tmp/dotnet-bundle
ENV NODE_ENV=production \
    ENTITY_MEMORY_PROFILE=compact \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    YT_DLP_PATH=/opt/yt-dlp/bin/yt-dlp \
    SLSKD_EXECUTABLE=/opt/slskd/slskd \
    ENTITY_SLSKD_BUILD=entity-live-v4 \
    DOTNET_BUNDLE_EXTRACT_BASE_DIR=/tmp/dotnet-bundle \
    SLSKD_NO_DISK_LOGGER=1 \
    CHZZK_AUTH_FILE=/app/data/chzzk/.auth.json \
    LOSSLESS_MIN_FREE_MB=256 \
    WEB_ENABLED=1 WEB_PORT=3000 WEB_HOST=0.0.0.0 WEB_TUNNEL=0
USER node
EXPOSE 3000
CMD ["node", "src/index.js"]
