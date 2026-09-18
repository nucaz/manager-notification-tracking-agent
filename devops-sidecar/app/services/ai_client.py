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
