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

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN mkdir -p /data/repos /data/backups /data/reports /data/db \
  && addgroup --system app && adduser --system --ingroup app app \
  && chown -R app:app /app /data

USER app

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
