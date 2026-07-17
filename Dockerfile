FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime

ARG CODEX_VERSION=0.144.5
ARG PLAYWRIGHT_VERSION=1.54.0

ENV NODE_ENV=production \
    HOME=/home/node \
    OPENCODE_MULTI_AUTH_ALLOW_REMOTE_HOST=1 \
    OPENCODE_MULTI_AUTH_STORE_DIR=/home/node/.config/opencode-multi-auth \
    OPENCODE_MULTI_AUTH_CODEX_AUTH_FILE=/home/node/.codex/auth.json \
    OPENCODE_MULTI_AUTH_AUTO_LOGIN_CREDENTIALS_FILE=/home/node/.config/opencode-multi-auth/credentials.json \
    CODEX_SOFT_LOG_PATH=/home/node/.config/opencode-multi-auth/logs/codex-soft.log

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium python3 python3-pip \
    && python3 -m pip install --break-system-packages --no-cache-dir "playwright==${PLAYWRIGHT_VERSION}" \
    && npm install --global "@openai/codex@${CODEX_VERSION}" \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p \
      /home/node/.config/opencode-multi-auth/logs \
      /home/node/.codex \
      /home/node/.codex-multi \
    && chown -R 1000:1000 /home/node /app

COPY --from=build --chown=1000:1000 /app/dist ./dist
COPY --chown=1000:1000 package.json ./
COPY --chown=1000:1000 auto-login/auto_login.py auto-login/credentials.example.json ./auto-login/

VOLUME ["/home/node/.config", "/home/node/.codex", "/home/node/.codex-multi"]

USER 1000:1000

EXPOSE 3434 1455

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3434/api/state').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "dist/cli.js", "web", "--host", "0.0.0.0", "--port", "3434"]
