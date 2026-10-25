FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public

RUN mkdir -p /app/data /app/uploads && chown -R node:node /app

USER node

EXPOSE 7070

CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
