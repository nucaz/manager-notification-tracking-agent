"""Pruebas del acceso unico (un solo usuario para la aplicacion principal y
este modulo). Usa una base y carpetas TEMPORALES, nunca las reales.

Los dos pases "VECTOR_*" los genero la aplicacion principal (Node,
src/services/ssoService.js) con el secreto de prueba: si este modulo los
acepta, las dos implementaciones del formato son compatibles. La prueba
de Node (tests/sso.e2e.js) comprueba que sigue generando exactamente esos.

Correr dentro del contenedor:
  docker compose exec devops-sidecar python tests/test_sso.py
"""
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(tempfile.mkdtemp(prefix="rt_sso_"))
os.environ.update({
    "DATABASE_PATH": str(ROOT / "db" / "sidecar.db"),
    "BACKUPS_PATH": str(ROOT / "backups"),
    "REPOS_BASE_PATH": str(ROOT / "repos"),
    "REPORTS_PATH": str(ROOT / "reports"),
    "SSO_SHARED_SECRET": "secreto-de-prueba",
    "DASHBOARD_USER": "panel",
    "DASHBOARD_PASSWORD": "clave-compartida",
    "DASHBOARD_BASIC_AUTH": "auto",
    "MAIN_APP_URL": "",
})
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

from app.config import settings  # noqa: E402
from app.database import init_db  # noqa: E402
from app.main import app  # noqa: E402
from app.services import sso_service  # noqa: E402

VECTOR_PASE = ("v1.eyJhdWQiOiJzaWRlY2FyLXNzbyIsImV4cCI6NDEwMjQ0NDgwMCwianRpIjoidmVjdG9yLTEiLCJzdWIiOiJhbmFAcHJ1ZWJhIiwibmFtZSI6IkFuYSDDkWFuZMO6Iiwicm9sZSI6ImFkbWluIiwiYXBwIjoiaHR0cHM6Ly9hcHAucHJ1ZWJhIn0"
               ".OXsCKS10oXunFBSzxqG4CFx0cfzjoCVf83IbxE7zLw0")
VECTOR_SERVICIO = "v1.eyJhdWQiOiJzaWRlY2FyLWFwaSIsImV4cCI6NDEwMjQ0NDgwMCwic3ViIjoiYXBsaWNhY2lvbi1wcmluY2lwYWwifQ.oiShJEAh4r7gKwhQ8zL2eA8iWNmTvLDxIFHs0UYaSZg"

RESULTS: list[tuple[bool, str]] = []
HTML = {"accept": "text/html"}


def check(name, cond):
    RESULTS.append((bool(cond), name))


def pase(**extra):
    payload = {"aud": "sidecar-sso", "exp": int(time.time()) + 60, "jti": os.urandom(8).hex(),
               "sub": "ana@prueba", "name": "Ana Ñandú", "role": "admin", "app": "http://app.prueba:8090"}
    payload.update(extra)
    return sso_service.sign(payload)


def main():
    init_db()
    try:
        # --- Sin sesion
        c = TestClient(app, follow_redirects=False)
        r = c.get("/", headers=HTML)
        check("Sin sesión y sin saber de qué aplicación viene: 401 con indicación de entrar por la aplicación principal",
              r.status_code == 401 and "aplicacion principal" in r.text and "www-authenticate" not in r.headers)
        r = c.get("/", auth=("panel", "clave-compartida"), headers=HTML)
        check("Con acceso único activo, el usuario/contraseña compartidos ya no abren el módulo", r.status_code == 401)
        check("El healthcheck sigue sin pedir nada", c.get("/healthz").status_code == 200)

        # --- Compatibilidad con la aplicacion principal (pases generados por Node)
        data = sso_service.verify(VECTOR_PASE, "sidecar-sso")
        check("Un pase generado por la aplicación principal (Node) se verifica aquí, con sus datos intactos",
              data and data["sub"] == "ana@prueba" and data["name"] == "Ana Ñandú" and data["app"] == "https://app.prueba")
        check("Un pase vale solo para lo que fue emitido (el de entrada no sirve como pase de servicio)",
              sso_service.verify(VECTOR_PASE, "sidecar-api") is None and sso_service.verify(VECTOR_SERVICIO, "sidecar-sso") is None)

        # --- Entrada con pase
        r = c.post("/sso", data={"token": pase()})
        cookies = r.headers.get_list("set-cookie")
        sesion = next((x for x in cookies if x.startswith("sidecar_session=")), "")
        check("Pase válido: abre sesión (cookie HttpOnly, SameSite=Lax) y lleva al inicio",
              r.status_code == 303 and r.headers["location"] == "/" and "HttpOnly" in sesion and "samesite=lax" in sesion.lower() and "Max-Age=28800" in sesion)
        check("En una conexión sin cifrar la cookie no se marca Secure (si no, el navegador no la devolvería)", "secure" not in sesion.lower())
        r = c.get("/", headers=HTML)
        check("Con la sesión abierta se ve el módulo, con el nombre del usuario y el enlace para volver a la aplicación",
              r.status_code == 200 and "Ana Ñandú" in r.text and 'href="http://app.prueba:8090/"' in r.text and "Cerrar DevOps" in r.text)
        check("La API también responde con esa sesión", c.get("/api/repos").status_code == 200)

        c2 = TestClient(app, follow_redirects=False)
        r = c2.post("/sso", data={"token": pase()}, headers={"x-forwarded-proto": "https"})
        check("Detrás de HTTPS la cookie de sesión sale marcada Secure",
              any(x.startswith("sidecar_session=") and "secure" in x.lower() for x in r.headers.get_list("set-cookie")))

        # --- Pases que no deben servir
        usado = pase()
        c3 = TestClient(app, follow_redirects=False)
        primero = c3.post("/sso", data={"token": usado})
        c4 = TestClient(app, follow_redirects=False)
        segundo = c4.post("/sso", data={"token": usado})
        check("Un pase sirve una sola vez: quien lo capture no puede reutilizarlo", primero.status_code == 303 and segundo.status_code == 401
              and "ya se us" in segundo.text and "set-cookie" not in segundo.headers)
        malos = {
            "vencido": pase(exp=int(time.time()) - 1),
            "de otro tipo": sso_service.sign({"aud": "sidecar-api", "exp": int(time.time()) + 60, "jti": "x1", "sub": "ana@prueba"}),
            "firma alterada": pase()[:-3] + "abc",
            "carga alterada": "v1." + sso_service._b64(b'{"aud":"sidecar-sso","exp":4102444800,"jti":"z","sub":"otro@prueba","role":"admin"}') + "." + pase().split(".")[2],
            "vacío": "",
            "basura": "no-es-un-pase",
        }
        check("Pases vencidos, de otro tipo, alterados o inventados: rechazados sin abrir sesión",
              all(TestClient(app, follow_redirects=False).post("/sso", data={"token": t}).status_code == 401 for t in malos.values()))
        real = settings.sso_shared_secret
        settings.sso_shared_secret = "otro-secreto"
        ajeno = pase()
        settings.sso_shared_secret = real
        check("Un pase firmado con otro secreto no entra", TestClient(app, follow_redirects=False).post("/sso", data={"token": ajeno}).status_code == 401)

        # --- Llamadas de servicio de la aplicacion principal
        s = TestClient(app, follow_redirects=False)
        r = s.get("/api/repos", headers={"authorization": f"Bearer {VECTOR_SERVICIO}"})
        check("La aplicación principal consulta la API con su pase de servicio (sin usuario ni contraseña)", r.status_code == 200 and r.json() == [])
        galleta = c.cookies.get("sidecar_session")
        check("Una sesión de persona no sirve como pase de servicio, ni un pase de entrada",
              s.get("/api/repos", headers={"authorization": f"Bearer {galleta}"}).status_code == 401
              and s.get("/api/repos", headers={"authorization": f"Bearer {pase()}"}).status_code == 401)

        # --- Formularios desde otro sitio
        r = c.post("/api/repos", json={}, headers={"origin": "http://otro-sitio.prueba"})
        check("Con sesión por cookie, una orden que llega desde otro sitio se rechaza (403)", r.status_code == 403)
        r = c.post("/api/repos", json={}, headers={"origin": "http://testserver"})
        check("La misma orden desde el propio módulo sí pasa la comprobación (falla solo por datos incompletos)", r.status_code == 422)

        # --- Sesion vencida / cerrar
        r = c.get("/salir")
        check("Cerrar DevOps borra la sesión y devuelve a la aplicación principal",
              r.status_code == 303 and r.headers["location"] == "http://app.prueba:8090" and any("sidecar_session=" in x and "Max-Age=0" in x for x in r.headers.get_list("set-cookie")))
        c.cookies.delete("sidecar_session")
        r = c.get("/repos", headers=HTML)
        check("Sin sesión, un navegador que ya entró antes vuelve solo a la aplicación principal (que emite un pase nuevo si su sesión sigue viva)",
              r.status_code == 307 and r.headers["location"] == "http://app.prueba:8090/devops")
        check("Sin sesión, la API responde 401 (no redirige)", c.get("/api/repos").status_code == 401)

        # --- Instalacion sin acceso unico: todo como antes
        settings.sso_shared_secret = ""
        b = TestClient(app, follow_redirects=False)
        r0 = b.get("/", headers=HTML)
        r1 = b.get("/", auth=("panel", "clave-compartida"), headers=HTML)
        r2 = b.get("/", auth=("panel", "otra"), headers=HTML)
        r3 = b.post("/sso", data={"token": VECTOR_PASE})
        check("Sin secreto compartido: HTTP Basic como siempre, y la entrada por pase queda cerrada",
              r0.status_code == 401 and r0.headers.get("www-authenticate") == "Basic" and r1.status_code == 200 and "Cerrar DevOps" not in r1.text
              and r2.status_code == 401 and r3.status_code == 401)
        settings.sso_shared_secret = real
        settings.dashboard_basic_auth = "on"
        r = TestClient(app, follow_redirects=False).get("/", auth=("panel", "clave-compartida"), headers=HTML)
        check("DASHBOARD_BASIC_AUTH=on mantiene la entrada de emergencia junto al acceso único", r.status_code == 200)
        settings.dashboard_basic_auth = "auto"
    finally:
        shutil.rmtree(ROOT, ignore_errors=True)

    fails = [n for ok, n in RESULTS if not ok]
    for ok, name in RESULTS:
        print(("OK    " if ok else "FALLA ") + name)
    print(f"{len(RESULTS)} pruebas, {len(fails)} fallas")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
