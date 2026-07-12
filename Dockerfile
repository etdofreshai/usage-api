FROM node:22-slim

ARG CODEX_VERSION=0.144.1
ARG CLAUDE_CODE_VERSION=2.1.207

WORKDIR /app
RUN chown node:node /app

# Keep the authentication CLIs in the main service so its Dokploy terminal can
# renew the same credential volume the API reads.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl less \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g \
      "@openai/codex@${CODEX_VERSION}" \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

# Persistent data directory for history (created as root before USER node)
RUN mkdir -p /home/node/data && chown node:node /home/node/data
VOLUME /home/node/data

# Usage API owns a separate credential volume. The entrypoint seeds it from
# the legacy ai-sessions bind mounts on the first deployment only.
RUN mkdir -p /home/node/auth && chown node:node /home/node/auth
VOLUME /home/node/auth

COPY scripts/docker-entrypoint.sh /usr/local/bin/usage-api-entrypoint
COPY scripts/usage-auth.sh /usr/local/bin/usage-auth
RUN chmod 755 /usr/local/bin/usage-api-entrypoint /usr/local/bin/usage-auth

USER node

COPY --chown=node:node package.json package-lock.json* ./
RUN npm install --omit=dev=false

COPY --chown=node:node tsconfig.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
RUN npx tsc

ENV PORT=3000
EXPOSE 3000

ENV USAGE_HISTORY_FILE=/home/node/data/usage-history.jsonl
ENV CLAUDE_CREDENTIALS_PATH=/home/node/auth/.claude/.credentials.json
ENV CLAUDE2_CREDENTIALS_PATH=/home/node/auth/.claude2/.credentials.json
ENV CODEX_AUTH_PATH=/home/node/auth/.codex/auth.json

CMD ["usage-api-entrypoint"]
