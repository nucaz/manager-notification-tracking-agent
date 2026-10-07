#!/bin/sh
# Controlador de dominio DESECHABLE para probar el modulo Directorio activo
# (tests/ad.e2e.js): Samba AD DC en Docker, dominio prueba.local, en la red
# de docker-compose para que la aplicacion lo alcance como dc1.prueba.local.
# Nunca apunte la prueba a un dominio real.
#
# Uso (en el equipo con Docker, desde la raiz del proyecto):
#   sh scripts/ad-prueba/levantar.sh          # crea, siembra y deja el CA en /tmp/ca.pem del contenedor de la app
#   docker rm -f zz_samba_dc                   # para borrarlo
set -e
NET=$(docker inspect licencias_app --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}')
DIR=$(mktemp -d)
# Contrasena del Administrator del dominio de prueba: aleatoria, solo en este equipo.
head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 18 | sed 's/^/Pr0/;s/$/!x/' > "$DIR/pw"
chmod 600 "$DIR/pw"
docker rm -f zz_samba_dc >/dev/null 2>&1 || true
docker run -d --name zz_samba_dc --hostname dc1 --network "$NET" --network-alias dc1.prueba.local --privileged \
  -e REALM=prueba.local -e WORKGROUP=PRUEBA -e ALLOW_DNS_UPDATES=nonsecure -e BIND_INTERFACES_ONLY=no \
  -v "$DIR/pw:/run/secrets/samba-admin-password:ro" instantlinux/samba-dc:latest >/dev/null
echo "Esperando al controlador de dominio..."
sleep 25
docker cp "$(dirname "$0")/sembrar.sh" zz_samba_dc:/tmp/sembrar.sh
docker exec zz_samba_dc sh /tmp/sembrar.sh
docker exec zz_samba_dc cat /var/lib/samba/private/tls/ca.pem > "$DIR/ca.pem"
docker cp "$DIR/ca.pem" licencias_app:/tmp/ca.pem
echo "Listo. Contraseña del Administrator de PRUEBA en $DIR/pw. Ejecute:"
echo "  docker exec -e E2E_PERMITIR=1 -e AD_TEST_URL=ldaps://dc1.prueba.local:636 -e AD_TEST_CA=/tmp/ca.pem \\"
echo "    -e AD_TEST_USER=svc-gestor@prueba.local -e 'AD_TEST_PASSWORD=Usu4rio-Prueba!2026' \\"
echo "    -e AD_TEST_WRITE_USER=svc-escritor@prueba.local -e 'AD_TEST_WRITE_PASSWORD=Usu4rio-Prueba!2026' \\"
echo "    -e AD_TEST_ADMIN_USER=Administrator@prueba.local -e AD_TEST_ADMIN_PASSWORD=\"\$(cat $DIR/pw)\" licencias_app node tests/ad.e2e.js"
echo "  (y luego, con las mismas variables, tests/ad_cambios.e2e.js: modifica el DC; para repetir, vuelva a levantarlo)"
