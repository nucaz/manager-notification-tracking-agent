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

# Directivas de grupo de prueba, directo en la base del DC (no hace falta SYSVOL
# para lo que lee la aplicacion): una exigida con filtro WMI, una con scripts,
# software y unidades de red, y una vacia sin vincular. OU=Sistemas bloquea la
# herencia y OU=Depilzone tiene un vinculo deshabilitado y otro huerfano.
L=/var/lib/samba/private/sam.ldb
P="CN=Policies,CN=System,$B"
gpo() { # guid nombre flags version extensiones-de-equipo extensiones-de-usuario
  { echo "dn: CN={$1},$P"; echo "objectClass: groupPolicyContainer"; echo "displayName: $2"
    echo "gPCFileSysPath: \\\\prueba.local\\sysvol\\prueba.local\\Policies\\{$1}"; echo "gPCFunctionalityVersion: 2"
    echo "flags: $3"; echo "versionNumber: $4"
    [ -n "$5" ] && echo "gPCMachineExtensionNames: $5"; [ -n "$6" ] && echo "gPCUserExtensionNames: $6"; true; } | ldbadd -H $L >/dev/null 2>&1 || true
}
G1=11111111-1111-1111-1111-111111111111; G2=22222222-2222-2222-2222-222222222222; G3=33333333-3333-3333-3333-333333333333
gpo $G1 "Bloqueo de pantalla" 0 131075 "[{35378EAC-683F-11D2-A89A-00C04FBBCFA2}{D02B1F72-3407-48AE-BA88-E8213C6761F1}]" ""
gpo $G2 "Scripts de inicio y software" 0 65538 "[{42B5FAAE-6536-11D2-AE5A-0000F87571E3}{40B6664F-4972-11D1-A7CA-0000F87571E3}][{C6DC5466-785A-11D2-84D0-00C04FB169F7}{942A8E4F-A261-11D1-A760-00C04FB9603F}]" "[{5794DAFD-BE60-433F-88A2-1A31939AC01F}{2EA1A81B-48E5-45E9-8BB7-A6E3AC170006}]"
gpo $G3 "Sin vincular y vacia" 3 0 "" ""
ldbadd -H $L >/dev/null 2>&1 <<EOF || true
dn: CN=Machine,CN={$G2},$P
objectClass: container

dn: CN=Class Store,CN=Machine,CN={$G2},$P
objectClass: classStore

dn: CN=aaaaaaaa-0000-0000-0000-000000000001,CN=Class Store,CN=Machine,CN={$G2},$P
objectClass: packageRegistration
displayName: 7-Zip 24 (x64)
msiFileList: 0:\\\\srv-archivos\\software\\7z2408-x64.msi
packageFlags: 1610612736

dn: CN={44444444-4444-4444-4444-444444444444},CN=SOM,CN=WMIPolicy,CN=System,$B
objectClass: msWMI-Som
msWMI-ID: {44444444-4444-4444-4444-444444444444}
msWMI-Name: Solo Windows 11
msWMI-Parm2: 1;3;10;61;WQL;root\\CIMv2;Select * from Win32_OperatingSystem where Version like "10.0.2%";
EOF
ldbmodify -H $L >/dev/null 2>&1 <<EOF || true
dn: OU=Depilzone,$B
changetype: modify
replace: gPLink
gPLink: [LDAP://cn={99999999-9999-9999-9999-999999999999},cn=policies,cn=system,$B;0][LDAP://cn={$G2},cn=policies,cn=system,$B;1][LDAP://cn={$G1},cn=policies,cn=system,$B;2]

dn: OU=Ventas,OU=Depilzone,$B
changetype: modify
replace: gPLink
gPLink: [LDAP://cn={$G2},cn=policies,cn=system,$B;0]

dn: OU=Sistemas,OU=Depilzone,$B
changetype: modify
replace: gPOptions
gPOptions: 1

dn: CN={$G1},$P
changetype: modify
replace: gPCWQLFilter
gPCWQLFilter: [prueba.local;{44444444-4444-4444-4444-444444444444};0]
EOF
echo SEMBRADO
