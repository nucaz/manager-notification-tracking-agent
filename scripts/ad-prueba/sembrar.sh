#!/bin/sh
# Datos de prueba para el dominio prueba.local (Samba AD DC desechable).
set -e
PW="$(cat /run/secrets/samba-admin-password)"
UPW='Usu4rio-Prueba!2026'
B='DC=prueba,DC=local'
st() { samba-tool "$@" -H ldap://127.0.0.1 -U Administrator --password="$PW" 2>&1 | grep -v -i warning || true; }

st ou create "OU=Depilzone,$B"
st ou create "OU=Ventas,OU=Depilzone,$B"
st ou create "OU=Sistemas,OU=Depilzone,$B"
st ou create "OU=Equipos,OU=Depilzone,$B"
st ou create "OU=Servicios,$B"

st user create juan.perez "$UPW" --userou="OU=Ventas,OU=Depilzone" --given-name=Juan --surname=Perez --mail-address=juan.perez@prueba.local --job-title="Vendedor" --department="Ventas"
st user create maria.lopez "$UPW" --userou="OU=Ventas,OU=Depilzone" --given-name=Maria --surname=Lopez --job-title="Vendedora" --department="Ventas"
st user disable maria.lopez
st user create ana.admin "$UPW" --userou="OU=Sistemas,OU=Depilzone" --given-name=Ana --surname=Admin --job-title="Jefa de Sistemas" --department="Sistemas"
st group addmembers "Domain Admins" ana.admin
st user create pedro.soporte "$UPW" --userou="OU=Sistemas,OU=Depilzone" --given-name=Pedro --surname=Soporte --department="Sistemas"
st user setexpiry pedro.soporte --noexpiry
st group add "Soporte-TI" --groupou="OU=Sistemas,OU=Depilzone" --description="Mesa de ayuda"
st group addmembers "Soporte-TI" pedro.soporte
# Anidado: Soporte-TI dentro de Administradores (builtin) -> pedro es privilegiado por cadena.
st group addmembers "Administrators" "Soporte-TI"
st group add "Ventas-Lima" --groupou="OU=Ventas,OU=Depilzone"
st group addmembers "Ventas-Lima" juan.perez,maria.lopez
st user create svc-gestor "$UPW" --userou="OU=Servicios" --description="Cuenta de servicio de lectura del Gestor"
st user create borrado.temp "$UPW" --userou="OU=Ventas,OU=Depilzone"
st user delete borrado.temp

st computer create PC-VENTAS-01 --computerou="OU=Equipos,OU=Depilzone" --description="Caja 1"
st computer create PC-ANTIGUA --computerou="OU=Equipos,OU=Depilzone"
st computer create SRV-ARCHIVOS --computerou="OU=Equipos,OU=Depilzone"

# DNS integrado: A del equipo, A huerfano (equipo que ya no existe) y un CNAME.
DNS() { samba-tool dns add 127.0.0.1 prueba.local "$@" -U Administrator --password="$PW" 2>&1 | grep -v -i warning || true; }
DNS pc-ventas-01 A 10.10.0.21
DNS srv-archivos A 10.10.0.5
DNS pc-fantasma A 10.10.0.99
DNS intranet CNAME srv-archivos.prueba.local
echo SEMBRADO
