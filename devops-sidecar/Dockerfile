FROM python:3.12-slim

WORKDIR /app

# git: para clonar/sincronizar/mirrorear repos (via subprocess, nunca una
# libreria que reimplemente git). tzdata: para que APScheduler use la
# zona horaria configurada (America/Lima) correctamente.
# rclone: motor de los destinos externos (OneDrive, Google Drive, S3, SFTP,
# SMB, WebDAV). Version fija y SHA-256 verificado contra SHA256SUMS oficial
# de downloads.rclone.org - si la descarga no coincide, el build falla.
# El de apt de Debian es mas viejo y OneDrive cambio su API varias veces.
ARG RCLONE_VERSION=1.75.1
ARG TARGETARCH
RUN apt-get update \
  && apt-get install -y --no-install-recommends git tzdata ca-certificates curl unzip \
  && ARCH="${TARGETARCH:-amd64}" \
  && case "$ARCH" in \
       amd64) RCLONE_SHA=982b5aa772841168f8e380f139e9e787b2a105403e32b94da8676a0e1c0a13ab ;; \
       arm64) RCLONE_SHA=03f2504174034b6d004152ed7369251c9a9ec1f7e0836eda420f5c7a5ec0dff9 ;; \
       *) echo "Arquitectura no soportada para rclone: $ARCH" && exit 1 ;; \
     esac \
  && curl -fsSL -o /tmp/rclone.zip "https://downloads.rclone.org/v${RCLONE_VERSION}/rclone-v${RCLONE_VERSION}-linux-${ARCH}.zip" \
  && echo "${RCLONE_SHA}  /tmp/rclone.zip" | sha256sum -c - \
  && unzip -j /tmp/rclone.zip "*/rclone" -d /usr/local/bin \
  && chmod 755 /usr/local/bin/rclone \
  && rm /tmp/rclone.zip \
  && apt-get purge -y curl unzip && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

# Sistemas externos (services/external_sources.py), solo para LEER:
# - mariadb-client: mariadb-dump para MySQL/MariaDB (Azure, cPanel).
# - postgresql-client del repositorio oficial PGDG: pg_dump no respalda un
#   servidor MAS NUEVO que el; el de Debian (17) se quedaria corto con
#   Azure PostgreSQL 18. La llave del repo se verifica por su huella.
# - sqlpackage (Azure SQL / SQL Server, .bacpac): version fija y SHA-256
#   verificado; Microsoft solo lo publica para x64 (en arm64 se omite y
#   "Probar conexion" lo informa). Necesita libicu.
ARG PG_CLIENT_MAJOR=18
ARG PGDG_KEY_FPR=B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8
ARG SQLPACKAGE_URL=https://download.microsoft.com/download/18a5e51e-8332-4cbe-bb50-6d3a50c704c5/sqlpackage-linux-x64-en-170.4.83.3.zip
ARG SQLPACKAGE_SHA=e81ede2429f3a15d9e752845c8928569c7706b3a911fad2d1717c0f03e0fc7c3
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl gnupg unzip mariadb-client libicu76 \
  && curl -fsSL -o /tmp/pgdg.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  && gpg --batch --show-keys --with-colons /tmp/pgdg.asc | grep -q "^fpr:::::::::${PGDG_KEY_FPR}:" \
  && gpg --batch --dearmor -o /usr/share/keyrings/pgdg.gpg /tmp/pgdg.asc \
  && echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt trixie-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update && apt-get install -y --no-install-recommends "postgresql-client-${PG_CLIENT_MAJOR}" \
  && ARCH="${TARGETARCH:-amd64}" \
  && if [ "$ARCH" = "amd64" ]; then \
       curl -fsSL -o /tmp/sqlpackage.zip "$SQLPACKAGE_URL" \
       && echo "${SQLPACKAGE_SHA}  /tmp/sqlpackage.zip" | sha256sum -c - \
       && mkdir -p /opt/sqlpackage && unzip -q /tmp/sqlpackage.zip -d /opt/sqlpackage \
       && chmod 755 /opt/sqlpackage/sqlpackage && rm /tmp/sqlpackage.zip; \
     fi \
  && rm -f /tmp/pgdg.asc && apt-get purge -y curl gnupg unzip && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/* /root/.gnupg

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN mkdir -p /data/repos /data/backups /data/reports /data/db \
  && addgroup --system app && adduser --system --ingroup app app \
  && chown -R app:app /app /data

USER app

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
