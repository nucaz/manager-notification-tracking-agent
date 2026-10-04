---
name: ia-configuracion-unica
description: 'Usar al tocar cualquier uso de IA en la app principal o en DevOps Sidecar: agregar un proveedor o tipo (Ollama, Gemini, Claude, compatible con OpenAI), cambiar de modelo, sumar una función que use IA, el respaldo, la elección local/nube por pregunta, la lectura de facturas o la auditoría del sidecar. Ejemplos - "cambia el modelo a X", "que el sidecar use otro modelo", "agrega OpenAI", "que la nueva pantalla le pregunte a la IA", "la IA local no responde".'
---

# Una sola configuración de IA para las dos aplicaciones

## Dónde vive

- **Proveedores**: tabla `ai_providers` (MariaDB de la app principal).
  Tipo (`ollama | gemini | anthropic | openai`), `location` (`local` =
  los datos no salen de la empresa | `nube`), dirección, modelo, API key
  **cifrada** (`cryptoService`, `enc:v1:`), capacidades
  (`supports_tools`, `supports_vision`, `supports_web`),
  `context_tokens` (Ollama `num_ctx`) y `timeout_seconds`.
- **Qué usa cada función**: `settings` → `ai_uso_asistente`,
  `ai_uso_chatbot`, `ai_uso_facturas`, `ai_uso_sidecar_auditoria`,
  `ai_uso_sidecar_textos` (id de proveedor), `ai_respaldo` (vacío = sin
  respaldo) y `ai_elegir_por_pregunta`.
- **Pantalla**: Configuración > Inteligencia artificial
  (`src/routes/aiSettings.js`, `views/settings/ai.ejs`,
  `public/js/ia-config.js`).

## Capas (Node)

- `src/services/ai/providers.js`: HTTP por tipo, una sola forma de
  conversación (`messages` neutros, herramientas en JSON Schema
  minúsculas). También `listModels` y `capabilities` (Ollama `/api/show`).
  Lanza `AIError` con `retryable` (caído, lento, 5xx, 402/429).
- `src/services/aiService.js`: proveedores guardados, `resolve(uso,
  elegido)`, `chat` (con respaldo y herramientas **emuladas** si el modelo
  no las tiene), `generateText`, `webSearch`, `choices`, `test`, `models`.
- Consumidores: `assistantService` (asistente), `chatAgent` (chatbot),
  `invoiceExtractor` (facturas), `routes/internalAi.js` (sidecar).

## El sidecar no configura nada

`devops-sidecar/app/services/ai_client.py` → `generate_detailed(prompt,
uso)` hace `POST {MAIN_APP_INTERNAL_URL}/interno/ia/generar` con un pase
`app-ai` firmado con `SSO_SHARED_SECRET`. Solo si la app principal **no
responde** (conexión o pase rechazado) usa su configuración local de
emergencia. Si la IA configurada falla, informa el error: no cambia de
proveedor a escondidas.

## Al sumar una función que use IA

1. Agregar el uso a `USES` en `aiService.js` (etiqueta y ayuda): la
   pantalla y la asignación lo toman solas. Si es del sidecar, también a
   `SIDECAR_USES` en `internalAi.js` y una constante en `ai_client.py`.
2. Agregar `ai_uso_<uso>` a la migración que corresponda, apuntando al
   proveedor local, con `INSERT IGNORE` (no pisar lo que eligió el admin).
3. Llamar `aiService.generateText('<uso>', prompt, opts)` o
   `aiService.chat(...)`. Nunca leer una API key de `settings` ni llamar a
   un proveedor directo.
4. Mostrar quién respondió (`r.provider.label`) cuando la respuesta la ve
   una persona.

## Al agregar un tipo de proveedor

Un adaptador en `providers.js` (`CHAT`, `listModels`, `capabilities`),
su entrada en `KINDS` (`base`, `location`, `needsKey`) y casos en
`tests/ia_config.e2e.js` con un servidor simulado.

## Reglas que ya costaron

- **La API key en cabecera, nunca en la URL**; los errores de red sin la
  URL.
- **Ollama corta en silencio** lo que no cabe en `num_ctx`: fijar
  `context_tokens` en textos largos (auditoría).
- **Un modelo local no lee PDF**: se le manda el texto (pdf.js); imagen
  solo con visión; PDF escaneado → decirlo.
- **El respaldo a la nube es una decisión**: viene vacío; cuando actúa,
  la respuesta lo avisa (`notice`).
- **Validar el nombre del modelo** (sin espacios): "Gemini 3 Flash-Lite"
  no es un identificador.

## Cómo probar

- `tests/ia_config.e2e.js` (Ollama y Gemini simulados; desactiva los
  proveedores reales mientras corre y los reactiva al final) y
  `tests/asistente.e2e.js`.
- `devops-sidecar/tests/test_ia_compartida.py` (app principal simulada).
- Antes de dar por bueno: "Probar" contra el servidor real y una pregunta
  real al asistente; los errores de red, de modelo no descargado o de
  saldo solo aparecen ahí.
