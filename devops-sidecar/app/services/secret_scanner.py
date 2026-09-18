"""Escaneo deterministico de secretos en un diff (regex, sin IA). Se usa
ADEMAS del analisis de la IA, no en vez de - la deteccion por patrones es
mas confiable para esto que confiar solo en que la IA "se de cuenta"."""
import re

PATTERNS = [
    ("AWS Access Key", re.compile(r"AKIA[0-9A-Z]{16}")),
    ("Google API Key", re.compile(r"AIza[0-9A-Za-z\-_]{35}")),
    ("Llave privada", re.compile(r"-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----")),
    ("Slack Token", re.compile(r"xox[baprs]-[0-9A-Za-z-]{10,48}")),
    ("Token generico (api_key/secret/token=...)", re.compile(
        r"(?i)(api[_-]?key|secret[_-]?key|access[_-]?token|password)\s*[:=]\s*['\"]?[A-Za-z0-9_\-]{16,}['\"]?"
    )),
    ("JWT", re.compile(r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}")),
]

MAX_ALERTS = 30


def _mask(value: str) -> str:
    if len(value) <= 8:
        return "*" * len(value)
    return f"{value[:4]}...{value[-4:]}"


def scan_diff(diff_text: str) -> list[dict]:
    """Devuelve una lista de alertas: {type, file, preview}. 'preview' ya
    viene enmascarado - nunca se guarda ni se muestra el secreto completo."""
    alerts: list[dict] = []
    current_file = None
    for line in diff_text.splitlines():
        if line.startswith("+++ b/"):
            current_file = line[len("+++ b/"):]
            continue
        if not line.startswith("+") or line.startswith("+++"):
            continue  # solo interesan lineas agregadas, no borradas ni contexto
        for label, pattern in PATTERNS:
            match = pattern.search(line)
            if match:
                alerts.append({"type": label, "file": current_file, "preview": _mask(match.group(0))})
                if len(alerts) >= MAX_ALERTS:
                    return alerts
    return alerts
