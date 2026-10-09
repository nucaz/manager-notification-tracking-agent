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
st computer create PC-SIN-DNS --computerou="OU=Equipos,OU=Depilzone" --description="Equipo sin registro DNS"

# DNS integrado: A del equipo, A huerfano (equipo que ya no existe) y un CNAME.
DNS() { samba-tool dns add 127.0.0.1 prueba.local "$@" -U Administrator --password="$PW" 2>&1 | grep -v -i warning || true; }
DNS pc-ventas-01 A 10.10.0.21
DNS srv-archivos A 10.10.0.5
DNS pc-fantasma A 10.10.0.99
DNS intranet CNAME srv-archivos.prueba.local
DNS pc-antigua A 10.10.0.30
# Zona inversa con el PTR de pc-antigua (al eliminar el equipo se borran A y PTR).
samba-tool dns zonecreate 127.0.0.1 0.10.10.in-addr.arpa -U Administrator --password="$PW" 2>&1 | grep -v -i warning || true
samba-tool dns add 127.0.0.1 0.10.10.in-addr.arpa 30 PTR pc-antigua.prueba.local -U Administrator --password="$PW" 2>&1 | grep -v -i warning || true

# Fase 2: cuenta de ESCRITURA delegada solo sobre OU=Depilzone (control total
# heredado en esa OU), la zona DNS del dominio (para borrar los registros de
# un equipo) y "Reanimar desechados" en la raiz (restaurar de la papelera).
st user create svc-escritor "$UPW" --userou="OU=Servicios" --description="Cuenta de servicio de escritura del Gestor (delegada)"
SID=$(samba-tool user show svc-escritor --attributes=objectSid -H ldap://127.0.0.1 -U Administrator --password="$PW" 2>/dev/null | sed -n 's/^objectSid: //p')
acl() { samba-tool dsacl set --objectdn="$1" --sddl="$2" -H ldap://127.0.0.1 -U Administrator --password="$PW" >/dev/null 2>&1 || true; }
acl "OU=Depilzone,$B" "(A;CI;GA;;;$SID)"
# El contenedor Computers tambien (equipos recien unidos que hay que mover a una OU); Users no.
acl "CN=Computers,$B" "(A;CI;GA;;;$SID)"
st computer create PC-RECIEN-UNIDA --description="Equipo recien unido, aun en Computers"
acl "DC=prueba.local,CN=MicrosoftDNS,DC=DomainDnsZones,$B" "(A;CI;GA;;;$SID)"
acl "DC=0.10.10.in-addr.arpa,CN=MicrosoftDNS,DC=DomainDnsZones,$B" "(A;CI;GA;;;$SID)" 2>/dev/null || true
acl "$B" "(OA;;CR;45ec5156-db7e-47bb-b53f-dbeb2d03c40f;;$SID)"
acl "CN=Deleted Objects,$B" "(A;;LCRPWP;;;$SID)"
echo SEMBRADO
