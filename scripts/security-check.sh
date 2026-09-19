#!/usr/bin/env bash
# Audita dependencias vulnerables en las dos apps de este repo (Node en
# la raiz, Python en devops-sidecar) y sale con codigo distinto de cero
# si encuentra hallazgos high/critical - se puede correr a mano o desde
# CI (ver .github/workflows/security-audit.yml).
#
# Usa las herramientas nativas si estan instaladas (ej. en el runner de
# GitHub Actions, que ya trae node y python) y cae a un contenedor
# descartable si no (ej. un PC sin npm/pip-audit a mano).
#
# Uso: ./scripts/security-check.sh
set -uo pipefail  # sin -e a proposito: se corren AMBAS auditorias aunque una falle

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAIL=0

echo "== npm audit (glpi-licencias-app) =========================================="
if command -v npm >/dev/null 2>&1; then
  (cd "$REPO_ROOT" && npm audit --audit-level=high)
else
  echo "(npm no esta instalado aca - se corre en un contenedor node:20-alpine)"
  docker run --rm -v "$REPO_ROOT:/app" -w /app node:20-alpine npm audit --audit-level=high
fi
[ "$?" -ne 0 ] && FAIL=1

echo
echo "== pip-audit (devops-sidecar) ==============================================="
# pip-audit crea un venv aislado internamente - en un Ubuntu sin el
# paquete python3-venv (Debian/Ubuntu lo separan del python3 base a
# proposito) esto falla por el entorno, no por una vulnerabilidad real.
# Por eso, si el intento nativo falla por CUALQUIER motivo (no solo si
# python3 no esta instalado), se reintenta en el contenedor oficial de
# Python, que si trae venv completo.
pip_status=1
if command -v pip-audit >/dev/null 2>&1; then
  pip-audit -r "$REPO_ROOT/devops-sidecar/requirements.txt"
  pip_status=$?
elif command -v python3 >/dev/null 2>&1; then
  python3 -m pip install --quiet pip-audit 2>/dev/null
  pip-audit -r "$REPO_ROOT/devops-sidecar/requirements.txt"
  pip_status=$?
fi
if [ "$pip_status" -ne 0 ] && command -v docker >/dev/null 2>&1; then
  echo "(pip-audit nativo no disponible o fallo por el entorno - reintentando en un contenedor python:3.12-slim)"
  docker run --rm -v "$REPO_ROOT/devops-sidecar:/app" -w /app python:3.12-slim \
    bash -c "pip install --quiet pip-audit && pip-audit -r requirements.txt"
  pip_status=$?
fi
[ "$pip_status" -ne 0 ] && FAIL=1

echo
if [ "$FAIL" -ne 0 ]; then
  echo "RESULTADO: se encontraron vulnerabilidades - revisa el detalle arriba."
else
  echo "RESULTADO: sin hallazgos high/critical."
fi
exit "$FAIL"
