---
name: acceso-unico-entre-servicios
description: 'Usar al tocar el acceso único entre la app principal y DevOps Sidecar (pases firmados, /devops, /sso, sesión del sidecar, llamadas de servicio), al sumar otro servicio que deba entrar con el mismo usuario, o al cambiar el login (captcha, 2FA, límites). Ejemplos - "que el módulo X use el mismo usuario", "el sidecar pide contraseña otra vez", "agrega otro servicio al compose con login".'
---

# Un solo usuario para varios servicios: pases firmados

## El patrón

La app principal (Node) es **la única que autentica personas**: usuario,
contraseña (bcrypt), captcha, 2FA, límite de intentos y bloqueo de
cuenta. Los demás servicios no guardan usuarios: reciben un **pase
firmado** y abren su propia sesión.

- Secreto compartido `SSO_SHARED_SECRET`, el mismo valor en `.env` y en
  `devops-sidecar/.env`. Lo genera el instalador; nadie lo escribe.
- Formato: `v1.<carga JSON en base64url>.<HMAC-SHA256 en base64url>`.
  Implementado dos veces, y deben coincidir:
  `src/services/ssoService.js` y
  `devops-sidecar/app/services/sso_service.py`.
- La carga lleva siempre `aud` (para qué sirve) y `exp` (vence):
  `sidecar-sso` (entrada de una persona, 60 s, un solo uso con `jti`),
  `sidecar-session` (cookie de sesión, 8 h), `sidecar-origin` (a qué app
  volver), `sidecar-api` (llamada de servicio, 60 s).

## Decisiones que no hay que deshacer

1. **El pase viaja por POST, no en la URL.** Un `?token=` queda en el
   historial del navegador y en los logs de acceso. La app entrega una
   página con un formulario que se envía solo (`views/devops/entrar.ejs`).
2. **Un pase sirve para una sola cosa** (`aud`) **y una sola vez**
   (`jti`). Un pase de entrada no sirve como pase de servicio ni al revés;
   una sesión tampoco sirve como pase de servicio.
3. **Comparación de firmas en tiempo constante** (`hmac.compare_digest`).
4. **Con sesión por cookie hay que frenar las órdenes desde otro sitio.**
   El sidecar no tenía tokens CSRF (usaba HTTP Basic). Ahora, en todo
   método que no sea GET/HEAD/OPTIONS, compara `Origin`/`Referer` con su
   propio `Host` y rechaza con 403 lo que venga de otro. Cookie
   `HttpOnly`, `SameSite=Lax` y `Secure` si llegó por HTTPS
   (`X-Forwarded-Proto`).
5. **Con acceso único, el usuario/contraseña compartidos quedan
   apagados** (`DASHBOARD_BASIC_AUTH=auto`). Si siguieran activos serían
   una puerta sin captcha ni 2FA. `on` los conserva como entrada de
   emergencia: es una decisión explícita, no el predeterminado.
6. **Sin secreto, todo funciona como antes** (HTTP Basic). Una instalación
   ya desplegada no se rompe con un `git pull`.
7. **El permiso se consulta directo** (`moduleEnabled(role, 'devops')`),
   no desde `res.locals.enabledModules`: ese resumen es para el menú y, si
   la consulta falla, deja todo habilitado.
8. **Dentro del sidecar no hay roles**: quien entra puede restaurar o
   borrar. Por eso el permiso "DevOps" viene apagado para editor y lector.

## Las llamadas entre servicios

`devopsSidecarClient.js` manda `Authorization: Bearer <pase sidecar-api>`.
Así la app no necesita guardar la contraseña del sidecar, y desaparece el
error de "401 credenciales inválidas" cuando alguien cambiaba una y no la
otra.

## Cómo probarlo

- Formato compatible entre lenguajes: los dos `VECTOR_*` son pases
  generados por Node con un secreto de prueba. `tests/sso.e2e.js`
  comprueba que Node sigue generando exactamente esos;
  `devops-sidecar/tests/test_sso.py`, que Python los acepta. Si cambias el
  formato, regenera los vectores en los dos archivos.
- De punta a punta con los contenedores reales: desde el contenedor de la
  app, pedir un pase y enviarlo a `http://devops-sidecar:8000/sso`; debe
  responder 303 con las dos cookies, y el mismo pase por segunda vez, 401.

## Captcha del inicio de sesión

`src/services/captchaService.js`: sin servicios externos (red interna).
El código se dibuja como trazos en SVG, sin texto en la página; la
respuesta vive en la sesión, sirve para un intento y caduca a los 5
minutos. Se comprueba **antes** de la contraseña, para que un script no
consuma intentos de la cuenta. Es un freno para scripts genéricos, no una
garantía contra un atacante con OCR: no reemplaza al límite de intentos
ni al bloqueo de cuenta.
