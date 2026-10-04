"""Pruebas de la configuracion unica de IA: el sidecar le pide a la
aplicacion principal que genere (POST /interno/ia/generar con un pase
"app-ai"), y usa su configuracion local solo si la aplicacion principal no
responde. La aplicacion principal y Ollama se SIMULAN con un servidor
local; base y carpetas TEMPORALES, nunca las reales.

Correr dentro del contenedor:
  docker compose exec devops-sidecar python tests/test_ia_compartida.py
"""
import asyncio
import json
import os
import shutil
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(tempfile.mkdtemp(prefix="rt_ia_"))
os.environ.update({
    "DATABASE_PATH": str(ROOT / "db" / "sidecar.db"),
    "BACKUPS_PATH": str(ROOT / "backups"),
    "REPOS_BASE_PATH": str(ROOT / "repos"),
    "REPORTS_PATH": str(ROOT / "reports"),
    "SSO_SHARED_SECRET": "secreto-de-prueba",
})
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import settings  # noqa: E402
from app.services import ai_client, sso_service  # noqa: E402

RESULTS: list[tuple[bool, str]] = []
SEEN: dict = {"generar": [], "ollama": [], "auth": []}
MODE = {"app": "ok"}  # ok | error | 401


def check(name, cond):
    RESULTS.append((bool(cond), name))


class Fake(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, status, data):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _auth_ok(self):
        header = self.headers.get("authorization", "")
        SEEN["auth"].append(header)
        return header.startswith("Bearer ") and sso_service.verify(header[7:], "app-ai") is not None

    def do_GET(self):
        if self.path == "/interno/ia/estado":
            if not self._auth_ok():
                return self._send(401, {"ok": False})
            return self._send(200, {"ok": True, "usos": {"sidecar_auditoria": {"label": "Servidor local", "model": "gemma4:26b", "location": "local"}}})
        self._send(404, {})

    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
        if self.path == "/interno/ia/generar":
            if MODE["app"] == "401" or not self._auth_ok():
                return self._send(401, {"ok": False, "error": "Pase no válido"})
            SEEN["generar"].append(data)
            if MODE["app"] == "error":
                return self._send(502, {"ok": False, "error": "El modelo \"x\" no está descargado en el servidor Ollama."})
            return self._send(200, {"ok": True, "text": "Informe de la IA compartida", "proveedor": {"label": "Servidor local", "model": "gemma4:26b"}, "respaldo": None})
        if self.path == "/api/generate":  # Ollama local de emergencia
            SEEN["ollama"].append(data)
            return self._send(200, {"response": "Informe de la IA local"})
        self._send(404, {})


def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Fake)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_address[1]}"
    settings.main_app_internal_url = url
    settings.ai_provider = "ollama"
    settings.ollama_base_url = url
    settings.ollama_model = "llama-local"
    run = asyncio.run
    try:
        text, label = run(ai_client.generate_detailed("Audita este diff", ai_client.USO_AUDITORIA))
        check("Con acceso único, genera la aplicación principal con el uso pedido y dice qué proveedor fue",
              text == "Informe de la IA compartida" and label == "Servidor local · gemma4:26b"
              and SEEN["generar"][-1] == {"uso": "sidecar_auditoria", "prompt": "Audita este diff"} and not SEEN["ollama"])
        check("El pedido lleva un pase firmado para la aplicación principal (aud app-ai), no una contraseña",
              sso_service.verify(SEEN["auth"][-1][7:], "app-ai")["sub"] == "devops-sidecar")
        text = run(ai_client.generate("Resume este commit"))
        check("generate() sin proveedor usa la configuración única (uso: asistente y resúmenes)", text == "Informe de la IA compartida"
              and SEEN["generar"][-1]["uso"] == "sidecar_textos")

        MODE["app"] = "error"
        try:
            run(ai_client.generate_detailed("x", ai_client.USO_AUDITORIA))
            err = ""
        except ai_client.AIClientError as e:
            err = str(e)
        check("Si la IA configurada falla, se informa el error de la aplicación principal (no se cambia de proveedor a escondidas)",
              "no está descargado" in err and not SEEN["ollama"])

        MODE["app"] = "401"
        text, label = run(ai_client.generate_detailed("x", ai_client.USO_AUDITORIA))
        check("Pase rechazado (secreto distinto): se usa la configuración local de emergencia", text == "Informe de la IA local"
              and "configuración local" in label and SEEN["ollama"][-1]["model"] == "llama-local")

        MODE["app"] = "ok"
        settings.main_app_internal_url = "http://127.0.0.1:9"
        text, label = run(ai_client.generate_detailed("x", ai_client.USO_AUDITORIA))
        check("Aplicación principal caída: se usa la configuración local de emergencia", text == "Informe de la IA local" and "ollama" in label)
        check("Estado: sin aplicación principal no hay datos que mostrar", run(ai_client.shared_status()) is None)

        settings.main_app_internal_url = url
        status = run(ai_client.shared_status())
        check("Estado: la página de Configuración muestra qué proveedor usa cada función", status["sidecar_auditoria"]["model"] == "gemma4:26b")

        real = settings.sso_shared_secret
        settings.sso_shared_secret = ""
        before = len(SEEN["generar"])
        text, label = run(ai_client.generate_detailed("x"))
        check("Sin acceso único configurado: solo la configuración local (como antes)", text == "Informe de la IA local" and len(SEEN["generar"]) == before)
        settings.sso_shared_secret = real

        settings.ai_provider = "ollama"
        text = run(ai_client.generate("x", provider="ollama"))
        check("Pedir un proveedor explícito (botón Probar de la configuración local) no pasa por la aplicación principal", text == "Informe de la IA local")
    finally:
        server.shutdown()
        shutil.rmtree(ROOT, ignore_errors=True)

    fails = [n for ok, n in RESULTS if not ok]
    for ok, name in RESULTS:
        print(("OK    " if ok else "FALLA ") + name)
    print(f"{len(RESULTS)} pruebas, {len(fails)} fallas")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
