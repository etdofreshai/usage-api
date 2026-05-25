FROM node:22-slim

WORKDIR /app
RUN chown node:node /app

# Persistent data directory for history (created as root before USER node)
RUN mkdir -p /home/node/data && chown node:node /home/node/data
VOLUME /home/node/data

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

CMD ["node", "dist/server.js"]
