---
name: shell-docker-verification
description: Verificar scripts de shell (instaladores, entrypoints) y cambios relacionados con Docker de punta a punta contra un contenedor real desechable, antes de darlos por corregidos. Usar siempre que se escriba o depure un script bash interactivo, algo que use sed/read/docker exec, o un Dockerfile/docker-compose.
---

# Verificación real de scripts de shell y Docker

## Principio central

Nunca confíes solo en el razonamiento para escapado de shell, timing de
stdin, o comportamiento de `sed`/`docker` entre distintos entornos. Un
bash de Windows/Git-Bash (MSYS), una imagen `alpine` (BusyBox), y un
Ubuntu real con GNU sed/coreutils se comportan distinto. Reproduce
SIEMPRE contra un contenedor que coincida con el entorno real de destino
(normalmente `ubuntu:22.04` para instaladores pensados para servidores
Ubuntu) antes de decir que algo quedó arreglado.

## Gotchas encontrados y confirmados en este proyecto

1. **`MSYS_NO_PATHCONV` en Windows Git Bash**: una ruta absoluta estilo
   Unix (`/data/backups/...`) pasada como argumento a `docker exec`,
   `docker run -v`, etc. se mangla en silencio por la capa de traducción
   de rutas de MSYS, a menos que el comando lleve el prefijo
   `MSYS_NO_PATHCONV=1`. Esto puede hacer que un `rm -rf` o un montaje
   `-v` no-opeen sin ningún error visible (causó un bug real: archivos
   huérfanos en disco sin fila correspondiente en la base de datos).

2. **La sustitución de comandos captura TODO el stdout de la función**:
   cualquier función pensada para usarse como `X="$(fn ...)"` no puede
   tener NINGÚN `echo`/`printf` a stdout aparte del que devuelve el
   valor final — ni siquiera uno "solo decorativo" (ej. bajar de línea
   después de un `read -s`, que no hace eco del Enter). Ese output
   decorativo queda pegado DENTRO del valor capturado. Ruta cualquier
   salida que no sea el valor de retorno a stderr (`>&2`). Bug real
   causado por esto: una contraseña terminaba con `"\n\nMiClave123"` y
   rompía el `sed` que la insertaba en un `.env`, con el error
   `sed: -e expression #1, char N: unterminated 's' command`.

3. **Escapado de `sed` con delimitador distinto de `/`**: aun usando
   `s|patron|reemplazo|`, hay que escapar el delimitador (`|`), `&`
   (referencia al match) y `\` dentro del texto de reemplazo si viene de
   una variable con contenido arbitrario (ej. una contraseña). El orden
   importa: escapar backslash PRIMERO, luego los demás — si no, se
   doble-escapa lo que agregan los pasos siguientes.

4. **Contar `read` a mano en flujos con ramas condicionales es
   propenso a error**: cuando un script salta preguntas según una
   condición (ej. "si el archivo ya existe, no preguntes"), es fácil
   miscontar cuántas líneas de stdin corresponden a cada prompt al armar
   un test. Si el conteo no calza, `ask_secret`-style loops (que
   reintentan si la confirmación no coincide) pueden girar para siempre
   leyendo EOF. Traza el camino condicional REAL antes de armar el
   stdin de prueba, no cuentes a ojo.

5. **Debian/Ubuntu separan `python3-venv` del `python3` base**: una
   herramienta que crea un venv interno (ej. `pip-audit`) falla en un
   Ubuntu mínimo sin ese paquete — no es una vulnerabilidad real, es el
   entorno. Si un script debe correr en "cualquier Ubuntu", ten un
   fallback (ej. correr la herramienta dentro de un contenedor
   `python:3.12-slim`, que sí trae venv completo).

## Receta de verificación concreta

1. **Inyecta el script vía base64 en una variable de entorno** en vez de
   montar un volumen — evita TODOS los problemas de traducción de rutas
   de Windows/MSYS:
   ```bash
   SCRIPT_B64=$(base64 -w0 mi_script.sh)
   docker run --rm -e SCRIPT_B64="$SCRIPT_B64" ubuntu:22.04 bash -c '
     echo "$SCRIPT_B64" | base64 -d > /tmp/s.sh
     bash /tmp/s.sh
   '
   ```
2. **Traza a mano cada `read` esperado**, en el orden exacto que el
   script los ejecuta (incluyendo qué se salta por condicionales), y
   arma el stdin como un archivo real con `printf` explícito línea por
   línea — NO un heredoc a ojo cuando hay más de ~5 líneas:
   ```bash
   printf '%s\n' "" "valor1" "valor1" "" "admin@x.com" > stdin.txt
   docker run --rm -i ... < stdin.txt
   ```
3. **Si algo se comporta raro, usa `bash -x`** para ver los valores
   REALMENTE expandidos en cada comando, en vez de seguir adivinando.
4. **Siempre pon un timeout** (`timeout 90 docker run ...` o el
   parámetro de background del harness) — un loop infinito por EOF mal
   contado puede generar millones de líneas de salida en segundos.
5. Para un cambio en un instalador (`install-ubuntu.sh` o similar), no
   basta `bash -n` (solo valida sintaxis) — corre el flujo interactivo
   completo (o la sección relevante) contra un Ubuntu real antes de
   decir que está corregido.
