#!/usr/bin/env bash
# ==========================================================================
# Instalacion completa en un servidor Ubuntu limpio: instala Docker si hace
# falta, clona/actualiza el repositorio, genera los .env de "app" y de
# "devops-sidecar" (pidiendo SOLO las contraseñas/credenciales criticas de
# forma interactiva y oculta), levanta los contenedores y aplica migraciones
# + usuario administrador inicial.
#
# Uso:
#   sudo bash install-ubuntu.sh
#   (o dale permiso de ejecucion antes: chmod +x install-ubuntu.sh)
#
# Es seguro volver a correrlo: si detecta un .env ya existente pregunta si
# quieres conservarlo (no repite las preguntas de contraseña), y
# "npm run migrate" es incremental (no duplica ni pisa nada ya aplicado).
# ==========================================================================
set -euo pipefail

# --- Re-ejecutar como root si hace falta (apt/docker lo requieren) --------
if [ "$(id -u)" -ne 0 ]; then
  exec sudo -E bash "$0" "$@"
fi

REPO_URL_DEFAULT="https://github.com/nucaz/manager-notification-tracking-agent.git"
COMPOSE="docker compose"

# --- Utilidades ------------------------------------------------------------
c_info()  { printf '\033[1;34m[info]\033[0m %s\n' "$1"; }
c_ok()    { printf '\033[1;32m[ok]\033[0m %s\n' "$1"; }
c_warn()  { printf '\033[1;33m[aviso]\033[0m %s\n' "$1"; }
c_err()   { printf '\033[1;31m[error]\033[0m %s\n' "$1" >&2; }

ask() {
  # ask "Pregunta" "valor_por_defecto" -> hace echo del valor elegido
  local prompt="$1" default="${2:-}" reply
  if [ -n "$default" ]; then
    read -r -p "$prompt [$default]: " reply || true
    echo "${reply:-$default}"
  else
    read -r -p "$prompt: " reply || true
    echo "$reply"
  fi
}

ask_yes_no() {
  # ask_yes_no "Pregunta" "s|n(default)" -> devuelve 0 (si) o 1 (no)
  local prompt="$1" default="${2:-n}" reply
  local hint="s/N"; [ "$default" = "s" ] && hint="S/n"
  read -r -p "$prompt [$hint]: " reply || true
  reply="${reply:-$default}"
  [[ "$reply" =~ ^[sSyY] ]]
}

ask_secret() {
  # ask_secret "Etiqueta" "largo_minimo" -> hace echo del valor (pide dos
  # veces y valida que coincidan y cumplan el largo minimo)
  local label="$1" minlen="${2:-8}" pass1 pass2
  while true; do
    read -r -s -p "$label: " pass1; echo
    if [ "${#pass1}" -lt "$minlen" ]; then
      c_warn "Debe tener al menos $minlen caracteres."
      continue
    fi
    read -r -s -p "Repite $label: " pass2; echo
    if [ "$pass1" != "$pass2" ]; then
      c_warn "No coinciden, intenta de nuevo."
      continue
    fi
    echo "$pass1"
    return
  done
}

gen_secret() {
  # Secreto aleatorio para valores que NO escribe una persona (SESSION_SECRET,
  # WEBHOOK_SECRET) - no hace falta preguntarlos, solo que sean unicos y largos.
  openssl rand -hex 32 2>/dev/null || head -c48 /dev/urandom | base64 | tr -d '\n'
}

set_env_var() {
  # set_env_var archivo CLAVE valor -> reemplaza "CLAVE=..." si existe,
  # o agrega la linea al final si no existe. Escapa \, & y | (delimitador
  # usado abajo) para que una contraseña con esos caracteres no rompa el
  # sed ni se interprete como referencia al match (&) - el orden importa:
  # backslash primero, para no doble-escapar lo que agregan los siguientes.
  local file="$1" key="$2" value="$3"
  local escaped
  escaped=$(printf '%s' "$value" | sed -e 's/\\/\\\\/g' -e 's/&/\\&/g' -e 's/|/\\|/g')
  if grep -q "^${key}=" "$file" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${escaped}|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

wait_for_running() {
  # wait_for_running nombre_contenedor segundos_timeout
  # Se consulta por nombre de CONTENEDOR (fijo en docker-compose.yml, ej.
  # "licencias_app") en vez del --format de "docker compose ps", que varia
  # entre versiones del plugin.
  local container="$1" timeout="${2:-90}" waited=0
  until [ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null)" = "true" ]; do
    sleep 2; waited=$((waited + 2))
    if [ "$waited" -ge "$timeout" ]; then
      c_err "El contenedor '$container' no llegó a estado 'running' en ${timeout}s."
      docker logs --tail=40 "$container" 2>&1 || true
      exit 1
    fi
  done
}

wait_for_healthy() {
  # wait_for_healthy nombre_contenedor segundos_timeout
  local container="$1" timeout="${2:-120}" waited=0
  until [ "$(docker inspect -f '{{.State.Health.Status}}' "$container" 2>/dev/null)" = "healthy" ]; do
    sleep 3; waited=$((waited + 3))
    if [ "$waited" -ge "$timeout" ]; then
      c_err "El contenedor '$container' no quedo 'healthy' en ${timeout}s."
      docker logs --tail=40 "$container" 2>&1 || true
      exit 1
    fi
  done
}

# ==========================================================================
# 1. Requisitos del sistema operativo
# ==========================================================================
if [ -r /etc/os-release ] && ! grep -qi ubuntu /etc/os-release; then
  c_warn "Esto no parece Ubuntu (revisa /etc/os-release). Se continua igual,"
  c_warn "pero los pasos de instalacion de Docker via apt podrian fallar."
fi

c_info "Instalando dependencias del sistema (git, curl, openssl)..."
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git openssl >/dev/null

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  c_info "Docker/Docker Compose no encontrados: instalando desde el repositorio oficial de Docker..."
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  UBUNTU_CODENAME="$(. /etc/os-release && echo "${VERSION_CODENAME:-${UBUNTU_CODENAME:-}}")"
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${UBUNTU_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
  systemctl enable --now docker
  c_ok "Docker instalado ($(docker --version))."
else
  c_ok "Docker ya estaba instalado ($(docker --version))."
fi

if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
  if ! id -nG "$SUDO_USER" | grep -qw docker; then
    usermod -aG docker "$SUDO_USER"
    c_warn "Se agrego '$SUDO_USER' al grupo 'docker' - cierra sesion y vuelve a"
    c_warn "entrar para poder usar 'docker compose' sin sudo (no afecta a este script)."
  fi
fi

# ==========================================================================
# 2. Obtener el codigo (clonar o reusar el directorio actual)
# ==========================================================================
if [ -f "./docker-compose.yml" ] && [ -d "./devops-sidecar" ]; then
  PROJECT_DIR="$(pwd)"
  c_info "Usando el proyecto ya presente en $PROJECT_DIR"
else
  DEFAULT_DIR="/opt/glpi-licencias-app"
  TARGET_DIR="$(ask "Directorio donde instalar el proyecto" "$DEFAULT_DIR")"
  if [ -d "$TARGET_DIR/.git" ]; then
    c_info "Ya existe un repositorio en $TARGET_DIR, actualizando (git pull)..."
    git -C "$TARGET_DIR" pull
  else
    REPO_URL="$(ask "URL del repositorio a clonar" "$REPO_URL_DEFAULT")"
    c_info "Clonando $REPO_URL en $TARGET_DIR ..."
    mkdir -p "$(dirname "$TARGET_DIR")"
    git clone "$REPO_URL" "$TARGET_DIR"
  fi
  PROJECT_DIR="$TARGET_DIR"
fi
cd "$PROJECT_DIR"

DETECTED_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
DETECTED_IP="${DETECTED_IP:-127.0.0.1}"

# ==========================================================================
# 3. .env de la aplicacion principal (glpi-licencias-app)
# ==========================================================================
echo
c_info "=== Configuracion de la aplicacion principal (.env) ==="

CONFIGURE_APP_ENV=1
if [ -f ".env" ]; then
  if ! ask_yes_no "Ya existe un .env en la app. ¿Reconfigurarlo desde cero?" "n"; then
    CONFIGURE_APP_ENV=0
    c_info "Se conserva el .env existente tal cual esta."
  fi
fi

if [ "$CONFIGURE_APP_ENV" -eq 1 ]; then
  cp .env.example .env

  DB_NAME_VAL="$(ask "Nombre de la base de datos" "licencias_app")"
  DB_USER_VAL="$(ask "Usuario de la base de datos" "licencias")"
  echo
  c_warn "Contraseña de la base de datos (usuario de la app) - PASO CRITICO:"
  DB_PASSWORD_VAL="$(ask_secret "Contraseña de BD ($DB_USER_VAL)" 8)"
  echo
  c_warn "Contraseña root de MariaDB (administra el motor de BD) - PASO CRITICO:"
  DB_ROOT_PASSWORD_VAL="$(ask_secret "Contraseña root de MariaDB" 8)"

  APP_BASE_URL_VAL="$(ask "URL base publica de la app" "http://${DETECTED_IP}:8090")"

  ADMIN_NAME_VAL="$(ask "Nombre del administrador inicial" "Administrador")"
  ADMIN_EMAIL_VAL="$(ask "Correo del administrador inicial" "admin@depilzone.com.pe")"
  echo
  c_warn "Contraseña del usuario administrador inicial - PASO CRITICO:"
  ADMIN_PASSWORD_VAL="$(ask_secret "Contraseña de $ADMIN_EMAIL_VAL" 8)"

  SESSION_SECRET_VAL="$(gen_secret)"

  set_env_var .env DB_NAME "$DB_NAME_VAL"
  set_env_var .env DB_USER "$DB_USER_VAL"
  set_env_var .env DB_PASSWORD "$DB_PASSWORD_VAL"
  set_env_var .env DB_ROOT_PASSWORD "$DB_ROOT_PASSWORD_VAL"
  set_env_var .env APP_BASE_URL "$APP_BASE_URL_VAL"
  set_env_var .env ADMIN_NAME "$ADMIN_NAME_VAL"
  set_env_var .env ADMIN_EMAIL "$ADMIN_EMAIL_VAL"
  set_env_var .env ADMIN_PASSWORD "$ADMIN_PASSWORD_VAL"
  set_env_var .env SESSION_SECRET "$SESSION_SECRET_VAL"

  chmod 600 .env
  c_ok ".env de la app generado (SMTP y GLPI quedan en blanco - se completan"
  c_ok "despues desde la propia web, en Configuracion, sin tocar archivos)."
fi

# ==========================================================================
# 4. .env de devops-sidecar
# ==========================================================================
echo
c_info "=== Configuracion de DevOps Sidecar (devops-sidecar/.env) ==="

CONFIGURE_SIDECAR_ENV=1
if [ -f "devops-sidecar/.env" ]; then
  if ! ask_yes_no "Ya existe devops-sidecar/.env. ¿Reconfigurarlo desde cero?" "n"; then
    CONFIGURE_SIDECAR_ENV=0
    c_info "Se conserva el devops-sidecar/.env existente tal cual esta."
  fi
fi

if [ "$CONFIGURE_SIDECAR_ENV" -eq 1 ]; then
  cp devops-sidecar/.env.example devops-sidecar/.env

  DASHBOARD_USER_VAL="$(ask "Usuario del dashboard de DevOps Sidecar" "admin")"
  echo
  c_warn "Contraseña del dashboard de DevOps Sidecar - PASO CRITICO:"
  DASHBOARD_PASSWORD_VAL="$(ask_secret "Contraseña de $DASHBOARD_USER_VAL" 8)"

  WEBHOOK_SECRET_VAL="$(gen_secret)"

  set_env_var devops-sidecar/.env DASHBOARD_USER "$DASHBOARD_USER_VAL"
  set_env_var devops-sidecar/.env DASHBOARD_PASSWORD "$DASHBOARD_PASSWORD_VAL"
  set_env_var devops-sidecar/.env WEBHOOK_SECRET "$WEBHOOK_SECRET_VAL"

  chmod 600 devops-sidecar/.env
  c_ok "devops-sidecar/.env generado (el proveedor de IA y su API key se"
  c_ok "eligen despues desde el propio dashboard, en Configuracion - no hace"
  c_ok "falta editar este archivo para eso)."
fi

# ==========================================================================
# 5. Construir y levantar los contenedores
# ==========================================================================
echo
c_info "=== Construyendo y levantando los contenedores (puede tardar varios minutos) ==="
$COMPOSE up -d --build

c_info "Esperando a que la base de datos quede saludable..."
wait_for_healthy licencias_db 120
c_ok "Base de datos lista."

wait_for_running licencias_app 60
wait_for_running devops_sidecar 60

# ==========================================================================
# 6. Migraciones y usuario administrador
# ==========================================================================
c_info "Aplicando el esquema/migraciones de base de datos..."
$COMPOSE exec -T app npm run migrate

c_info "Creando el usuario administrador inicial..."
if ! $COMPOSE exec -T app npm run seed; then
  c_warn "El seed no se aplico (es normal si ya existia un admin de una corrida"
  c_warn "anterior con este mismo .env). Continuando."
fi

# ==========================================================================
# 7. Firewall (opcional)
# ==========================================================================
if command -v ufw >/dev/null 2>&1 && ufw status | grep -qi "Status: active"; then
  echo
  if ask_yes_no "ufw esta activo. ¿Abrir los puertos 8090 y 8091 (app y DevOps Sidecar)?" "s"; then
    ufw allow 8090/tcp
    ufw allow 8091/tcp
    c_ok "Puertos 8090/8091 abiertos en ufw."
  fi
fi

# ==========================================================================
# 8. Resumen final
# ==========================================================================
echo
c_ok "=========================================================================="
c_ok " Instalacion completa."
c_ok "=========================================================================="
echo "  App principal:   http://${DETECTED_IP}:8090"
echo "  DevOps Sidecar:  http://${DETECTED_IP}:8091"
echo
echo "  Las contraseñas que ingresaste quedaron guardadas (solo lectura para"
echo "  root) en:"
echo "    - $PROJECT_DIR/.env"
echo "    - $PROJECT_DIR/devops-sidecar/.env"
echo "  Guardalas tambien en un gestor de contraseñas: no se te van a volver a"
echo "  mostrar en pantalla."
echo
echo "  Pendiente por completar desde la web (Configuracion), sin reiniciar"
echo "  contenedores: SMTP, integracion con GLPI, y en DevOps Sidecar el"
echo "  proveedor de IA (Gemini/Claude/Ollama) para las auditorias."
echo
echo "  Para ver logs:        $COMPOSE logs -f app"
echo "  Para actualizar:      git pull && $COMPOSE up -d --build && $COMPOSE exec app npm run migrate"
c_ok "=========================================================================="
