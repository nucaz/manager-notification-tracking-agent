FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .

RUN mkdir -p /app/uploads/adjuntos /app/uploads/red \
  && addgroup -S app && adduser -S app -G app \
  && chown -R app:app /app

USER app

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/server.js"]
