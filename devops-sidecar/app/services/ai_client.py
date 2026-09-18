"""Cliente de IA intercambiable (Gemini / Claude / Ollama) via HTTP REST
directo - no via SDK de cada proveedor, para no depender de nombres de
paquete/API que cambian con el tiempo. Cada funcion se verifico contra la
documentacion oficial de cada API antes de escribirla:
- Gemini: POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
- Claude (Anthropic): POST https://api.anthropic.com/v1/messages
- Ollama: POST {base_url}/api/generate (API local, sin autenticacion)
"""
import httpx

from ..config import settings


class AIClientError(Exception):
    pass


async def generate_gemini(prompt: str) -> str:
    if not settings.gemini_api_key:
        raise AIClientError("Falta GEMINI_API_KEY en la configuracion.")
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{settings.gemini_model}:generateContent"
    async with httpx.AsyncClient(timeout=180) as client:
        resp = await client.post(
            url,
            params={"key": settings.gemini_api_key},
            json={"contents": [{"parts": [{"text": prompt}]}], "generationConfig": {"temperature": 0.2}},
        )
    if resp.status_code != 200:
        raise AIClientError(f"Gemini HTTP {resp.status_code}: {resp.text[:500]}")
    data = resp.json()
    candidates = data.get("candidates") or []
    if not candidates:
        raise AIClientError(f"Gemini no devolvio candidatos: {data}")
    parts = candidates[0].get("content", {}).get("parts", [])
    text = "".join(p.get("text", "") for p in parts)
    if not text:
        raise AIClientError("Gemini no devolvio texto interpretable.")
    return text


async def generate_claude(prompt: str) -> str:
    if not settings.anthropic_api_key:
        raise AIClientError("Falta ANTHROPIC_API_KEY en la configuracion.")
    url = "https://api.anthropic.com/v1/messages"
    headers = {
        "x-api-key": settings.anthropic_api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    async with httpx.AsyncClient(timeout=180) as client:
        resp = await client.post(
            url,
            headers=headers,
            json={
                "model": settings.anthropic_model,
                "max_tokens": 4096,
                "messages": [{"role": "user", "content": prompt}],
            },
        )
    if resp.status_code != 200:
        raise AIClientError(f"Claude HTTP {resp.status_code}: {resp.text[:500]}")
    data = resp.json()
    blocks = data.get("content") or []
    text = "".join(b.get("text", "") for b in blocks if b.get("type") == "text")
    if not text:
        raise AIClientError("Claude no devolvio texto interpretable.")
    return text


async def generate_ollama(prompt: str) -> str:
    url = f"{settings.ollama_base_url.rstrip('/')}/api/generate"
    async with httpx.AsyncClient(timeout=600) as client:
        resp = await client.post(url, json={"model": settings.ollama_model, "prompt": prompt, "stream": False})
    if resp.status_code != 200:
        raise AIClientError(f"Ollama HTTP {resp.status_code}: {resp.text[:500]}")
    data = resp.json()
    text = data.get("response", "")
    if not text:
        raise AIClientError("Ollama no devolvio texto interpretable.")
    return text


PROVIDERS = {"gemini": generate_gemini, "claude": generate_claude, "ollama": generate_ollama}


async def generate(prompt: str, provider: str | None = None) -> str:
    provider = provider or settings.ai_provider
    fn = PROVIDERS.get(provider)
    if not fn:
        raise AIClientError(f"Proveedor de IA desconocido: '{provider}'. Usa: {', '.join(PROVIDERS)}.")
    return await fn(prompt)


async def test_connection(provider: str, cfg: dict) -> tuple[bool, str]:
    """Prueba la conexion con los valores que el usuario tiene en el
    formulario de Configuracion (aun sin guardar) - si un campo viene
    vacio, usa el valor ya guardado en `settings` (ej. para probar sin
    tener que reescribir una API key que ya esta configurada)."""
    try:
        if provider == "gemini":
            api_key = cfg.get("gemini_api_key") or settings.gemini_api_key
            model = cfg.get("gemini_model") or settings.gemini_model
            if not api_key:
                return False, "Falta la API key de Gemini."
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(
                    url,
                    params={"key": api_key},
                    json={"contents": [{"parts": [{"text": "Responde solo con la palabra OK."}]}]},
                )
            if resp.status_code != 200:
                return False, f"Gemini respondió HTTP {resp.status_code}: {resp.text[:300]}"
            return True, "Conexión con Gemini exitosa."

        if provider == "claude":
            api_key = cfg.get("anthropic_api_key") or settings.anthropic_api_key
            model = cfg.get("anthropic_model") or settings.anthropic_model
            if not api_key:
                return False, "Falta la API key de Claude."
            headers = {
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            }
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(
                    "https://api.anthropic.com/v1/messages",
                    headers=headers,
                    json={"model": model, "max_tokens": 16, "messages": [{"role": "user", "content": "Responde solo con la palabra OK."}]},
                )
            if resp.status_code != 200:
                return False, f"Claude respondió HTTP {resp.status_code}: {resp.text[:300]}"
            return True, "Conexión con Claude exitosa."

        if provider == "ollama":
            base_url = (cfg.get("ollama_base_url") or settings.ollama_base_url).rstrip("/")
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.get(f"{base_url}/api/tags")
            if resp.status_code != 200:
                return False, f"No se pudo conectar a Ollama en {base_url} (HTTP {resp.status_code})."
            data = resp.json()
            nombres = [m.get("name") for m in data.get("models", [])]
            if not nombres:
                return True, (
                    f"Conectado a Ollama en {base_url}, pero no hay ningún modelo descargado. "
                    "Corre 'ollama pull llama3' (u otro modelo) en la máquina donde corre Ollama."
                )
            return True, f"Conectado a Ollama en {base_url}. Modelos disponibles: {', '.join(nombres)}."

        return False, f"Proveedor desconocido: '{provider}'."
    except httpx.RequestError as e:
        return False, f"No se pudo conectar: {e}"
