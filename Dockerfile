FROM node:22-slim

WORKDIR /app
RUN chown node:node /app

USER node

COPY --chown=node:node package.json package-lock.json* ./
RUN npm install --omit=dev=false

COPY --chown=node:node tsconfig.json ./
COPY --chown=node:node src ./src
RUN npx tsc

ENV PORT=3000
EXPOSE 3000

# Mount auth state from host (shared with ai-sessions):
#   -v $HOME/.claude:/home/node/.claude
#   -v $HOME/.codex:/home/node/.codex

CMD ["node", "dist/server.js"]
