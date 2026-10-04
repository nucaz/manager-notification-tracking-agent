---
name: asistente-ia-solo-lectura
description: 'Usar al tocar el asistente "Preguntar a la IA" de la app principal (src/services/assistantService.js): sumar datos que pueda consultar, cambiar sus instrucciones, sus herramientas, los reportes temporales o la búsqueda en internet. Ejemplos - "que el asistente también vea X", "que la IA pueda hacer Y", "el asistente responde mal sobre Z", "agrega una herramienta al asistente".'
---

# Asistente: libertad para leer, ninguna herramienta para escribir

## La regla que sostiene todo

La IA **nunca escribe SQL ni toca la base**. Elige entre herramientas
fijas de solo lectura; la consulta la ejecuta la aplicación. No existe
ninguna herramienta que cree, cambie o borre datos, así que una inyección
de instrucciones (en un nombre, una nota, una página web) no tiene con
qué hacer daño. Si alguien pide "que la IA pueda registrar/editar": no se
agrega una herramienta de escritura sin una decisión explícita del
usuario y un diseño de confirmación humana.

## Cómo está armado

- `consultar_datos`: un catálogo de conjuntos de datos (`datasets()`):
  los reportes de `reportService` más los de `EXTRA`. La IA pide
  `{reporte, filtros, buscar, agrupar_por, sumar, columnas, ordenar_por,
  descendente, limite}`; `runQuery` valida cada nombre contra el catálogo
  y devuelve error descriptivo si algo no existe (la IA corrige sola).
- **Las cifras que ve el usuario salen del servidor**, no del texto de la
  IA: la tabla se arma en `runQuery` y se muestra debajo de la respuesta.
  A la IA solo se le pasan las primeras filas.
- **Permisos**: `datasets(user, enabledModules)` filtra por módulo y por
  `adminOnly`. Lo que el usuario no puede abrir no aparece ni en las
  instrucciones ni en el `enum` de la herramienta.
- **Reporte temporal / Excel / PDF**: el navegador envía la *consulta*
  (`spec`), nunca las filas; el servidor la vuelve a ejecutar con los
  permisos de quien la pide. Nada se guarda.
- `buscar_en_internet`: una llamada **aparte** a Gemini con
  `tools: [{ google_search: {} }]` (no se puede combinar con las otras
  herramientas en la misma llamada). Solo se ofrece si hay un proveedor
  activo con búsqueda (`aiService.webSearchProvider()`); si no, tampoco se
  promete en las instrucciones. Las fuentes llegan al navegador solo si
  son `http(s)`.
- **El modelo no está fijo**: lo da `aiService` (ver el skill
  `ia-configuracion-unica`). El bucle trabaja con mensajes neutros
  (`user` / `assistant` con `calls` y `raw` / `tool` con `results`) y las
  herramientas en JSON Schema en minúsculas; cada proveedor lo traduce.

## Al sumar un conjunto de datos

1. Agrégalo a `EXTRA` con `table(label, acceso, columnas, sql, map)`.
   `acceso` es `{ module: '...' }`, `{ adminOnly: true }` o `{}` (todos).
2. **Elige las columnas una por una; nunca `SELECT *`.** Ni contraseñas,
   ni hashes, ni secretos de 2FA, ni tokens. La prueba revisa que
   `usuarios` no los exponga.
3. SQL fijo, sin datos del usuario dentro. Los filtros se aplican en
   memoria sobre lo cargado.
4. Suma el caso a `tests/asistente.e2e.js`.

## Detalles que ya costaron

- REST directo con `axios` (convención del repo: sin SDK).
- **El turno de la IA se devuelve tal cual** en la llamada siguiente
  (`messages.push({ role: 'assistant', ..., raw: r.raw })`): Gemini trae
  firmas (`thoughtSignature`) que exige de vuelta; `ai/providers.js` usa
  `raw` cuando es de su mismo tipo.
- Los pasos siguientes de una pregunta van al **mismo** proveedor que
  respondió el primero (`{ provider: r.resolved }`), aunque haya sido el
  respaldo.
- Tope de pasos (`MAX_STEPS`): una IA que no deja de pedir datos se corta
  y se muestra lo encontrado.
- La API key va en cabecera (nunca en la URL) y los errores de red se
  reescriben sin la URL (`ai/providers.js`, `http()`).
- Límite de uso por usuario (12 por minuto) y registro en
  `agent_message_log` como canal `web`.

## En el navegador

`public/js/asistente.js` escribe el texto de la IA y las celdas con
`textContent`, nunca como HTML. Solo interpreta `**negritas**`, listas y
saltos de línea. Los enlaces de fuentes se crean solo si empiezan con
`http(s)://`.

## Cómo probarlo

Con un Gemini **simulado** (un proveedor de prueba en `ai_providers` con
`base_url` apuntando a un servidor local que sigue un guion,
`tests/asistente.e2e.js`) y un Ollama simulado (`tests/ia_config.e2e.js`): se comprueba qué le envía la aplicación a la
IA y qué le devuelve, sin gastar la API. Antes de darlo por bueno en
producción, una pregunta real: los errores de clave o de saldo
(`HTTP 400 API key not valid`, `HTTP 402`) solo aparecen ahí.
