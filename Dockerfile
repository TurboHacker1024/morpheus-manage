FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

RUN mkdir -p /app/cache && chown -R node:node /app

USER node

EXPOSE 4173

CMD ["node", "server.js"]
