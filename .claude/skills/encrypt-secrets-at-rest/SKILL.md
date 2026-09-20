---
name: encrypt-secrets-at-rest
description: Agregar cifrado en base de datos para credenciales guardadas (API keys, tokens, contraseñas de servicios externos) sin romper una instalación ya en producción. Usar cuando un campo secreto vive en texto plano en una tabla tipo key/value o en una columna de un modelo, y se decide cifrarlo.
---

# Cifrar credenciales en reposo sin romper producción

## El patrón (ya implementado dos veces en este proyecto: Node y Python)

1. **Cifrado simétrico con clave desde variable de entorno**, nunca
   hardcodeada ni derivada de algo predecible:
   - Node: AES-256-GCM con el módulo `crypto` nativo (sin dependencia
     nueva). Clave: 32 bytes en hex (64 caracteres) en `.env`.
   - Python: `Fernet` de la librería `cryptography`. Clave: urlsafe-
     base64 de 32 bytes (formato de `Fernet.generate_key()`).
   - Generar la clave con `openssl rand -hex 32` (Node) o
     `openssl rand 32 | base64 | tr '+/' '-_'` (Fernet, sin necesitar
     Python instalado en quien la genera).

2. **Prefijo versionado en el valor guardado**: `enc:v1:<datos>` — así
   se distingue sin ambigüedad un valor ya cifrado de uno legado en
   texto plano, sin depender de heurísticas sobre el contenido (una
   clave hex real podría coincidir por casualidad con datos cifrados si
   no hay marcador explícito).

3. **Fallback "sin clave = sin cifrar"**: si la variable de entorno de
   la clave no está configurada, `encrypt()`/`decrypt()` se comportan
   como identidad (devuelven el valor tal cual) en vez de lanzar error.
   Esto es lo que permite que una instancia YA EN PRODUCCIÓN siga
   funcionando igual después de un `git pull` + rebuild normal, aunque
   todavía no le hayan agregado la clave nueva — empieza a cifrar solo
   en cuanto la agreguen y reinicien.

4. **Migración automática y perezosa, sin script aparte**: al LEER un
   valor que no tiene el prefijo de versión (legado en texto plano), se
   usa tal cual para no romper nada en el momento, Y se re-guarda ya
   cifrado como efecto secundario de esa misma lectura. Verificado en
   este proyecto contra datos reales de producción: al agregar la clave
   y reiniciar el contenedor, tokens ya guardados (Telegram, Gemini,
   GLPI) se migraron solos, sin intervención manual y sin downtime.

5. **Manejo de errores de descifrado sin tumbar la app**: si la clave
   cambió, es incorrecta, o el dato está corrupto, `decrypt()` debe
   devolver el valor cifrado tal cual (o lanzar un error contenido)
   en vez de propagar una excepción que rompa toda la request — un
   campo secreto ilegible no debería tumbar el resto de la aplicación.

## Antes de aplicarlo a un campo nuevo

- Verifica si ya existe la infraestructura de cifrado en el proyecto
  (`src/services/cryptoService.js` en Node,
  `devops-sidecar/app/services/crypto_service.py` en Python) — no la
  reimplementes, reutilízala.
- Decide explícitamente qué campos entran en el alcance de "secreto" (
  ej. `SECRET_KEYS` en `src/config/secretKeys.js`) — un cambio de
  cifrado que solo cubre ALGUNOS campos secretos y no otros similares
  debe documentarse explícitamente cuáles quedaron afuera y por qué
  (ejemplo real de este proyecto: `users.otp_secret` y
  `repos.github_token` quedaron deliberadamente fuera de la primera
  ronda de cifrado — anotado en la bitácora del proyecto, no olvidado).

## Verificación obligatoria

No alcanza con un test unitario de `encrypt`/`decrypt` en aislado.
Verifica contra una instancia real corriendo CON DATOS PREEXISTENTES
reales (no solo fixtures sintéticas):
1. Agrega la clave al `.env` real y reinicia el contenedor.
2. Confirma en la base de datos real que el valor quedó con el prefijo
   `enc:v1:` (o el que corresponda) y NO en texto plano.
3. Confirma que la aplicación sigue funcionando con ese valor (ej. la
   auditoría de IA sigue llamando a la API con la key correcta) sin
   imprimir el secreto real en ningún log de verificación.
4. Si es posible, simula un dato legado (inserta un valor sin el
   prefijo directamente en la BD) y confirma que se lee bien Y queda
   re-cifrado solo en la siguiente lectura.

## Checklist de migración cruzada de servidor

Si además existe una función de backup/restore o de migración a otro
servidor (ver skill `respaldo-restauracion-segura`), la clave de
cifrado (`CREDENTIALS_ENC_KEY` o el nombre que corresponda) DEBE viajar
junto con los datos al servidor nuevo — si no, los valores cifrados
restaurados quedan permanentemente ilegibles. Este aviso debe estar en
el propio flujo de backup/restore (manifiesto, mensaje en la UI), no
solo en un README aparte que un administrador migrando podría no leer.
