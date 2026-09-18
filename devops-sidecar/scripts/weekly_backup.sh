#!/usr/bin/env bash
# Respaldo semanal independiente (mirror completo + compresion + retencion).
# Es una alternativa standalone al scheduler de Python (app/scheduler.py +
# app/services/backup_service.py) - hace EXACTAMENTE lo mismo, pero se
# puede correr por fuera del contenedor via cron del sistema operativo,
# sin depender de que el proceso de FastAPI este vivo en ese momento.
#
# Uso: ./weekly_backup.sh /ruta/a/repos /ruta/a/backups [dias_retencion]
# Cron sugerido (domingos 2am): 0 2 * * 0 /ruta/weekly_backup.sh /data/repos /data/backups 30
set -euo pipefail

REPOS_DIR="${1:?Uso: $0 <repos_dir> <backups_dir> [retention_days]}"
BACKUPS_DIR="${2:?Uso: $0 <repos_dir> <backups_dir> [retention_days]}"
RETENTION_DAYS="${3:-30}"

WEEKLY_DIR="$BACKUPS_DIR/weekly"
TMP_DIR="$BACKUPS_DIR/_tmp"
STAMP="$(date +%Y%m%d)"

mkdir -p "$WEEKLY_DIR" "$TMP_DIR"

echo "[weekly_backup] Iniciando respaldo semanal ($STAMP)..."

for repo_path in "$REPOS_DIR"/*/; do
  [ -d "$repo_path/.git" ] || continue
  repo_name="$(basename "$repo_path")"
  mirror_path="$TMP_DIR/${repo_name}.git"
  tar_path="$WEEKLY_DIR/${repo_name}_${STAMP}.tar.gz"

  echo "[weekly_backup] -> $repo_name"
  rm -rf "$mirror_path"

  if git clone --mirror "$repo_path" "$mirror_path" >/dev/null 2>&1; then
    tar -czf "$tar_path" -C "$TMP_DIR" "${repo_name}.git"
    rm -rf "$mirror_path"
    echo "[weekly_backup]    listo: $tar_path ($(du -h "$tar_path" | cut -f1))"
  else
    echo "[weekly_backup]    ERROR clonando $repo_name, se omite" >&2
  fi
done

echo "[weekly_backup] Aplicando retención (> $RETENTION_DAYS días)..."
find "$WEEKLY_DIR" -name "*.tar.gz" -mtime "+$RETENTION_DAYS" -print -delete

echo "[weekly_backup] Listo."
