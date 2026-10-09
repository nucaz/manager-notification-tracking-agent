FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .

# mariadb-client: provee los binarios mariadb-dump/mariadb usados por
# backupService.js para exportar/restaurar la base de datos desde la UI.
# iputils-tracepath: ruta (saltos) para las herramientas del modulo Red; a
# diferencia de traceroute, no necesita privilegios.
RUN apk add --no-cache mariadb-client iputils-tracepath \
  && mkdir -p /app/uploads/adjuntos /app/uploads/red \
  && addgroup -S app && adduser -S app -G app \
  && chown -R app:app /app

USER app

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/server.js"]
