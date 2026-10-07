<#
  Crea la cuenta de servicio del Gestor en el directorio activo, con el
  minimo privilegio. NO la agrega a ningun grupo privilegiado.

  Ejecutar en un controlador de dominio (o equipo con RSAT) como
  administrador del dominio, en PowerShell como administrador.

  Cuenta de LECTURA (Directorio activo, fase 1):
    .\ad-cuenta-servicio.ps1 -Nombre svc-gestor-lectura -Lectura -Papelera

  Cuenta de ESCRITURA (cambios), delegada solo en las OU que se gestionan:
    .\ad-cuenta-servicio.ps1 -Nombre svc-gestor-escritura `
        -OUs "OU=Depilzone,DC=ad,DC=depilzone,DC=com,DC=pe" -DNS -Papelera

  -OUs        Unidades organizativas gestionadas (las mismas que se escriben en la aplicacion).
  -OUCuenta   Donde se crea la cuenta (por defecto, CN=Users).
  -DNS        Permite borrar los registros DNS de un equipo eliminado (zonas integradas en AD).
  -Papelera   Lectura: ver la papelera. Escritura: ademas, restaurar de ella.
  -SoloPermisos  La cuenta ya existe: solo aplica los permisos.

  La contrasena se escribe al ejecutar (no queda en pantalla ni en el historial).
  Para deshacer: borrar la cuenta; sus permisos delegados quedan sin efecto.
#>
param(
  [Parameter(Mandatory)] [string] $Nombre,
  [string[]] $OUs = @(),
  [string] $OUCuenta = '',
  [switch] $Lectura,
  [switch] $DNS,
  [switch] $Papelera,
  [switch] $SoloPermisos
)
$ErrorActionPreference = 'Stop'
Import-Module ActiveDirectory

$dom = Get-ADDomain
$who = "$($dom.NetBIOSName)\$Nombre"
if (-not $Lectura -and -not $OUs.Count) { throw 'Indique -OUs con las unidades organizativas que se van a gestionar (o -Lectura).' }

# ---- 1) la cuenta
if (-not $SoloPermisos) {
  if (-not $OUCuenta) { $OUCuenta = $dom.UsersContainer }
  $pw = Read-Host "Contraseña para $Nombre (20 o más caracteres, solo para esta cuenta)" -AsSecureString
  New-ADUser -Name $Nombre -SamAccountName $Nombre -UserPrincipalName "$Nombre@$($dom.DNSRoot)" -Path $OUCuenta `
    -AccountPassword $pw -Enabled $true -PasswordNeverExpires $true -CannotChangePassword $true `
    -Description ($(if ($Lectura) { 'Gestor: lectura del directorio (sin privilegios)' } else { 'Gestor: cambios delegados solo en las OU gestionadas' }))
  # "La cuenta es importante y no se puede delegar"
  Set-ADAccountControl -Identity $Nombre -AccountNotDelegated $true
  Write-Host "Cuenta $Nombre@$($dom.DNSRoot) creada (no es miembro de ningún grupo privilegiado)." -ForegroundColor Green
}

function Grant([string] $dn, [string[]] $args2) {
  & dsacls.exe $dn @args2 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "dsacls falló en $dn ($($args2 -join ' '))" }
}

# ---- 2) delegacion en cada OU gestionada (escritura)
foreach ($ou in $OUs) {
  Get-ADOrganizationalUnit -Identity $ou | Out-Null   # que exista
  # Usuarios: crear y eliminar; leer y escribir sus datos (incluye deshabilitar,
  # desbloquear y "cambiar la contraseña al iniciar sesión"); restablecer contraseña;
  # eliminar con lo que tengan dentro (dispositivos).
  Grant $ou @('/I:T', '/G', "${who}:CCDC;user")
  Grant $ou @('/I:S', '/G', "${who}:RPWPDT;;user")
  Grant $ou @('/I:S', '/G', "${who}:CA;Reset Password;user")
  # Grupos: crear, eliminar y cambiar miembros y datos.
  Grant $ou @('/I:T', '/G', "${who}:CCDC;group")
  Grant $ou @('/I:S', '/G', "${who}:RPWP;;group")
  # Equipos: crear (pre-crear para unirse), deshabilitar y eliminar con su contenido (BitLocker).
  Grant $ou @('/I:T', '/G', "${who}:CCDC;computer")
  Grant $ou @('/I:S', '/G', "${who}:RPWPDT;;computer")
  # Sub-unidades organizativas: solo crear (no eliminar).
  Grant $ou @('/I:T', '/G', "${who}:CC;organizationalUnit")
  Write-Host "Delegado en $ou" -ForegroundColor Green
}
if ($OUs.Count) {
  Write-Host 'Las cuentas de administradores quedan protegidas igual: AD (AdminSDHolder) no hereda esta delegación sobre ellas.'
}

# ---- 3) DNS: borrar los registros de un equipo eliminado (sin ser DnsAdmins)
if ($DNS -and -not $Lectura) {
  $zonas = Get-ADObject -SearchBase "CN=MicrosoftDNS,DC=DomainDnsZones,$($dom.DistinguishedName)" -SearchScope OneLevel -LDAPFilter '(objectClass=dnsZone)' |
    Where-Object { $_.Name -eq $dom.DNSRoot -or $_.Name -like '*.in-addr.arpa' -or $_.Name -like '*.ip6.arpa' }
  foreach ($z in $zonas) {
    Grant $z.DistinguishedName @('/I:T', '/G', "${who}:DC;dnsNode")
    Grant $z.DistinguishedName @('/I:S', '/G', "${who}:SD;;dnsNode")
    Write-Host "DNS: puede eliminar registros en la zona $($z.Name)" -ForegroundColor Green
  }
}

# ---- 4) Papelera de AD
if ($Papelera) {
  $del = "CN=Deleted Objects,$($dom.DistinguishedName)"
  & dsacls.exe $del /takeownership | Out-Null
  if ($Lectura) {
    Grant $del @('/G', "${who}:LCRP")
    Write-Host 'Papelera: puede verla (listar y leer).' -ForegroundColor Green
  } else {
    Grant $del @('/G', "${who}:LCRPWP")
    Grant $dom.DistinguishedName @('/G', "${who}:CA;Reanimate Tombstones")
    Write-Host 'Papelera: puede verla y restaurar (lo que estaba en una OU gestionada).' -ForegroundColor Green
  }
}

Write-Host ''
Write-Host "Listo. En la aplicación use: $Nombre@$($dom.DNSRoot)" -ForegroundColor Cyan
Write-Host 'Recomendado: permitir a esta cuenta solo el puerto 636 desde la IP del servidor de la aplicación y revisar sus inicios de sesión.'
