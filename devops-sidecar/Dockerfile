FROM python:3.12-slim

WORKDIR /app

# git: para clonar/sincronizar/mirrorear repos (via subprocess, nunca una
# libreria que reimplemente git). tzdata: para que APScheduler use la
# zona horaria configurada (America/Lima) correctamente.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git tzdata \
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
