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

- **Los datos viven en `src/services/assistantData.js`** (el bucle con la
  IA en `assistantService.js`). Cada conjunto es declarativo: `from`
  (FROM/JOIN fijo), `base` (su tabla principal), columnas
  `{ key, label, expr (SQL fijo), type: text|number|money|date, cat,
  personal, when | code }`, `defaults`, `order`, `scope(user)` y, si viene
  de afuera, `ensure()`. Los de Reportes conservan su clave, título,
  acceso, filtros de lista y código de barras.
- **SQL armado con lista blanca y parámetros; filtros, agrupación y orden
  en MariaDB con índices; nunca cargar tablas completas.** `runQuery`
  solo usa expresiones de la lista blanca; todo valor que llega de la IA
  va como `?`. Total con `COUNT(*)`, resúmenes con `GROUP BY` y
  `COUNT(*) OVER ()`, listados con `ORDER BY` y `LIMIT` (300 en pantalla,
  20 000 en reporte o Excel).
  - `igual`/`distinto` en columnas `cat`: se busca el valor real (sin
    mayúsculas ni tildes; si nada es igual, el que lo contiene) con
    `SELECT DISTINCT` sobre la tabla base (`LIMIT 2000`), y se filtra con
    `IN (...)`. Si no existe, la IA recibe los valores que sí existen.
    `code` filtra por el código guardado (`d.status IN ('en_stock')`, usa
    el índice) y muestra la etiqueta; `when` es una condición fija por
    etiqueta (vencido = `fecha < CURDATE()`, vigente = `returned_date IS
    NULL`).
  - Otras columnas: `=` en MariaDB; la intercalación `utf8mb4_unicode_ci`
    (tablas) y `uca1400_ai_ci` (conexión) ya ignora mayúsculas y tildes.
  - `contiene` y `buscar`: `LIKE ? ESCAPE '!'` (se escapan `%`, `_` y `!`;
    la barra invertida no es especial con ese ESCAPE).
  - `menor_que`/`mayor_que`: números como números; fechas AAAA-MM-DD.
- **Ejecución**: conexión propia, `START TRANSACTION READ ONLY`, cada
  SELECT con `SET STATEMENT max_statement_time=15 FOR`, `COMMIT` y
  `release` siempre (también ante error). Con `ASSISTANT_DB_USER` usa un
  usuario de MariaDB solo con SELECT sobre las tablas del asistente
  (`scripts/crear-usuario-asistente.js`; de `users`, solo columnas
  seguras).
- **GLPI y repositorios** no se descargan en cada pregunta: se consultan
  copias locales (`glpi_assets`, `devops_repos`) que renueva
  `externalSyncService` cada 30 min y, si la copia es vieja, al
  consultarla (si falla, usa la anterior y avisa de qué fecha es).
- **Datos personales** (`personal: true`: nombres, DNI, números,
  correos, IP): a una IA en la **nube** se le envían como
  `[dato personal oculto]` (`forModel`) y sus instrucciones lo dicen; el
  usuario los ve igual en la tabla. Con Ollama local van tal cual.
- **Las cifras que ve el usuario salen del servidor**, no del texto de la
  IA. A la IA solo se le pasan las primeras filas.
- **Permisos**: `datasets(user, enabledModules)` filtra por módulo y por
  `adminOnly`. Lo que el usuario no puede abrir no aparece ni en las
  instrucciones ni en el `enum`, y pedirlo igual da error.
- **Reporte temporal / Excel / PDF**: el navegador envía la *consulta*
  (`spec`), nunca las filas; el servidor la vuelve a ejecutar con los
  permisos de quien la pide. Nada se guarda.
- `buscar_en_internet`: una llamada **aparte** a Gemini con
  `tools: [{ google_search: {} }]`. Solo se ofrece si hay un proveedor
  activo con búsqueda. Las fuentes llegan al navegador solo si son
  `http(s)`.
- **El modelo no está fijo**: lo da `aiService` (skill
  `ia-configuracion-unica`).

## Al sumar un conjunto de datos

1. Agrégalo a `EXTRA` (o a `FROM_REPORTS` si es de Reportes) en
   `assistantData.js`. Acceso: `module`, `adminOnly` o ninguno.
2. **Columnas una por una; nunca `SELECT *`.** Ni contraseñas, ni hashes,
   ni secretos de 2FA, ni tokens. `personal: true` en todo dato de una
   persona; `cat: true` en las de pocos valores.
3. Índice para lo que se filtre u ordene seguido (migración + `schema.sql`)
   y un caso en `tests/asistente_indices.e2e.js` (EXPLAIN sobre 300 000
   filas: ninguna tabla grande recorrida completa). Para un `COUNT` con
   JOIN, el índice debe **cubrir** las columnas del JOIN (ej.
   `(estado, operadora, device_id)`), si no MariaDB prefiere leer todo.
4. Vuelve a correr `scripts/crear-usuario-asistente.js` si usa una tabla
   nueva (el usuario de solo lectura no la ve).
5. Casos en `tests/asistente_datos.e2e.js` (mismo resultado que la
   pantalla de donde sale) y `tests/asistente.e2e.js`.

## Sobre "buscar"

Un `LIKE '%texto%'` no usa un índice B-tree: recorre las filas que ya
dejaron pasar los demás filtros. Se evaluó FULLTEXT y se descartó: lo que
se busca suele ser un pedazo de número, IMEI o código (FULLTEXT solo
encuentra palabras o prefijos, con largo mínimo) y no cubre columnas
calculadas ni de tablas unidas. Con los tamaños de esta aplicación es
rápido, y el tope de 15 s corta el resto: a la IA se le pide filtrar
primero por columnas indexadas.

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
