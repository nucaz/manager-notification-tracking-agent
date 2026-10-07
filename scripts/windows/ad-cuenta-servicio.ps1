<#
.SYNOPSIS
  ES: Crea la cuenta de servicio del Gestor en el directorio activo con el minimo
      privilegio. NO la agrega a ningun grupo privilegiado.
  EN: Creates the Gestor service account in Active Directory with least
      privilege. It is NOT added to any privileged group.

.DESCRIPTION
  ES: Funciona igual con un controlador de dominio en espanol o en ingles: los
      permisos se aplican por GUID del esquema (clases y derechos extendidos),
      nunca por nombres que cambian con el idioma. Ejecutar en un DC (o equipo
      con RSAT) como administrador del dominio, en PowerShell como administrador.
  EN: Works the same on a Spanish or English domain controller: permissions are
      applied by schema GUID (classes and extended rights), never by names that
      change with the language. Run on a DC (or a machine with RSAT) as a domain
      admin, in an elevated PowerShell.

.EXAMPLE
  # ES: cuenta de LECTURA   / EN: READ-ONLY account
  .\ad-cuenta-servicio.ps1 -Name svc-gestor-lectura -ReadOnly -RecycleBin

.EXAMPLE
  # ES: cuenta de ESCRITURA delegada solo en las OU gestionadas
  # EN: WRITE account delegated only on the managed OUs
  .\ad-cuenta-servicio.ps1 -Name svc-gestor-escritura `
      -ManagedOUs "OU=Depilzone,DC=ad,DC=depilzone,DC=com,DC=pe" -DNS -RecycleBin

.PARAMETER Nombre
  ES: Nombre de la cuenta.  EN: Account name.  (-Name)
.PARAMETER OUs
  ES: OU gestionadas (las mismas que se escriben en la aplicacion).  EN: Managed OUs (same as in the app).  (-ManagedOUs)
.PARAMETER OUCuenta
  ES: Donde se crea la cuenta (por defecto, el contenedor Users).  EN: Where the account is created (default: Users container).  (-AccountOU)
.PARAMETER Lectura
  ES: Cuenta solo de lectura.  EN: Read-only account.  (-ReadOnly)
.PARAMETER DNS
  ES: Borrar los registros DNS de un equipo eliminado.  EN: Delete the DNS records of a deleted computer.
.PARAMETER Papelera
  ES: Lectura: ver la papelera. Escritura: ademas, restaurar.  EN: Read: view the recycle bin. Write: also restore.  (-RecycleBin)
.PARAMETER SoloPermisos
  ES: La cuenta ya existe: solo aplica los permisos.  EN: The account exists: only apply permissions.  (-PermissionsOnly)
.PARAMETER Idioma
  ES: es | en (por defecto, el idioma del servidor).  EN: es | en (default: the server language).  (-Language)
#>
param(
  [Parameter(Mandatory)] [Alias('Name')] [string] $Nombre,
  [Alias('ManagedOUs')] [string[]] $OUs = @(),
  [Alias('AccountOU')] [string] $OUCuenta = '',
  [Alias('ReadOnly')] [switch] $Lectura,
  [switch] $DNS,
  [Alias('RecycleBin')] [switch] $Papelera,
  [Alias('PermissionsOnly')] [switch] $SoloPermisos,
  [Alias('Language')] [ValidateSet('', 'es', 'en')] [string] $Idioma = ''
)
$ErrorActionPreference = 'Stop'
Import-Module ActiveDirectory

# ---------------- mensajes / messages ----------------
if (-not $Idioma) { $Idioma = $(if ((Get-UICulture).TwoLetterISOLanguageName -eq 'es') { 'es' } else { 'en' }) }
$M = @{
  es = @{
    needOus = 'Indique -OUs con las unidades organizativas que se van a gestionar (o -Lectura).'
    exists = 'La cuenta {0} ya existe. Para aplicarle solo los permisos, agregue -SoloPermisos.'
    password = 'Contraseña para {0} (20 o más caracteres, solo para esta cuenta)'
    created = 'Cuenta {0} creada (no es miembro de ningún grupo privilegiado).'
    descRead = 'Gestor: lectura del directorio (sin privilegios)'
    descWrite = 'Gestor: cambios delegados solo en las OU gestionadas'
    noOu = 'No existe la unidad organizativa {0}'
    delegated = 'Delegado en {0}: usuarios, grupos, equipos y sub-unidades.'
    adminSd = 'Las cuentas de administradores quedan protegidas igual: AD (AdminSDHolder) no les hereda esta delegación.'
    dnsZone = 'DNS: puede eliminar registros en la zona {0}'
    noZones = 'DNS: no se encontraron zonas integradas en DomainDnsZones.'
    binRead = 'Papelera: puede verla (listar y leer).'
    binWrite = 'Papelera: puede verla y restaurar (lo que estaba en una OU gestionada).'
    dsacls = 'dsacls falló en {0}'
    schema = 'No se encontró en el esquema: {0}'
    done = 'Listo. En la aplicación use: {0}'
    tip = 'Recomendado: permitir a esta cuenta solo el puerto 636 desde la IP del servidor de la aplicación y revisar sus inicios de sesión.'
  }
  en = @{
    needOus = 'Specify -ManagedOUs with the organizational units to manage (or -ReadOnly).'
    exists = 'Account {0} already exists. To only apply its permissions, add -PermissionsOnly.'
    password = 'Password for {0} (20+ characters, used only for this account)'
    created = 'Account {0} created (not a member of any privileged group).'
    descRead = 'Gestor: directory read (no privileges)'
    descWrite = 'Gestor: changes delegated only on the managed OUs'
    noOu = 'Organizational unit not found: {0}'
    delegated = 'Delegated on {0}: users, groups, computers and child OUs.'
    adminSd = 'Administrator accounts stay protected: AD (AdminSDHolder) does not inherit this delegation to them.'
    dnsZone = 'DNS: can delete records in zone {0}'
    noZones = 'DNS: no AD-integrated zones found in DomainDnsZones.'
    binRead = 'Recycle bin: can view it (list and read).'
    binWrite = 'Recycle bin: can view and restore it (objects that were in a managed OU).'
    dsacls = 'dsacls failed on {0}'
    schema = 'Not found in the schema: {0}'
    done = 'Done. In the application use: {0}'
    tip = 'Recommended: allow this account only port 636 from the application server IP and review its sign-ins.'
  }
}[$Idioma]
function Say([string] $key, $arg = $null, [string] $color = 'Green') { Write-Host ($M[$key] -f $arg) -ForegroundColor $color }

$dom = Get-ADDomain
$root = Get-ADRootDSE
if (-not $Lectura -and -not $OUs.Count) { throw $M.needOus }

# ---------------- GUID del esquema / schema GUIDs (independientes del idioma / language-independent) ----------------
function ClassGuid([string] $ldapName) {
  $o = Get-ADObject -SearchBase $root.schemaNamingContext -LDAPFilter "(lDAPDisplayName=$ldapName)" -Properties schemaIDGUID
  if (-not $o) { throw ($M.schema -f $ldapName) }
  [guid] $o.schemaIDGUID
}
function RightGuid([string] $cn) {
  $o = Get-ADObject -SearchBase "CN=Extended-Rights,$($root.configurationNamingContext)" -LDAPFilter "(cn=$cn)" -Properties rightsGuid
  if (-not $o) { throw ($M.schema -f $cn) }
  [guid] $o.rightsGuid
}

# ---------------- 1) la cuenta / the account ----------------
$existing = Get-ADUser -LDAPFilter "(sAMAccountName=$Nombre)"
if (-not $SoloPermisos) {
  if ($existing) { throw ($M.exists -f $Nombre) }
  if (-not $OUCuenta) { $OUCuenta = $dom.UsersContainer }
  $pw = Read-Host ($M.password -f $Nombre) -AsSecureString
  New-ADUser -Name $Nombre -SamAccountName $Nombre -UserPrincipalName "$Nombre@$($dom.DNSRoot)" -Path $OUCuenta `
    -AccountPassword $pw -Enabled $true -PasswordNeverExpires $true -CannotChangePassword $true `
    -Description $(if ($Lectura) { $M.descRead } else { $M.descWrite })
  # "La cuenta es importante y no se puede delegar" / "Account is sensitive and cannot be delegated"
  Set-ADAccountControl -Identity $Nombre -AccountNotDelegated $true
  Say 'created' "$Nombre@$($dom.DNSRoot)"
}
$sid = (Get-ADUser -Identity $Nombre).SID
$who = "$($dom.NetBIOSName)\$Nombre"

# Agrega una regla a la ACL de un objeto de AD / adds a rule to an AD object's ACL.
$R = [System.DirectoryServices.ActiveDirectoryRights]
$I = [System.DirectoryServices.ActiveDirectorySecurityInheritance]
function Allow([string] $dn, $rights, [guid] $objectType, $inheritance, [guid] $inheritedType) {
  $path = "AD:\$dn"
  $acl = Get-Acl -Path $path
  $acl.AddAccessRule((New-Object System.DirectoryServices.ActiveDirectoryAccessRule($sid, $rights, 'Allow', $objectType, $inheritance, $inheritedType)))
  Set-Acl -Path $path -AclObject $acl
}
$none = [guid]::Empty

# ---------------- 2) delegacion en cada OU / delegation on each OU (escritura / write) ----------------
if ($OUs.Count -and -not $Lectura) {
  $gUser = ClassGuid 'user'; $gGroup = ClassGuid 'group'; $gComputer = ClassGuid 'computer'; $gOu = ClassGuid 'organizationalUnit'
  $gReset = RightGuid 'User-Force-Change-Password'   # "Restablecer contraseña" / "Reset Password"
  foreach ($ou in $OUs) {
    try { Get-ADOrganizationalUnit -Identity $ou | Out-Null } catch { throw ($M.noOu -f $ou) }
    # Usuarios: crear/eliminar; leer/escribir datos (deshabilitar, desbloquear, cambiar al entrar); eliminar con su contenido; restablecer contraseña.
    # Users: create/delete; read/write data (disable, unlock, must change at logon); delete with children; reset password.
    Allow $ou ($R::CreateChild -bor $R::DeleteChild) $gUser $I::All $none
    Allow $ou ($R::ReadProperty -bor $R::WriteProperty -bor $R::DeleteTree) $none $I::Descendents $gUser
    Allow $ou $R::ExtendedRight $gReset $I::Descendents $gUser
    # Grupos / groups: crear, eliminar, miembros y datos / create, delete, members and data.
    Allow $ou ($R::CreateChild -bor $R::DeleteChild) $gGroup $I::All $none
    Allow $ou ($R::ReadProperty -bor $R::WriteProperty) $none $I::Descendents $gGroup
    # Equipos / computers: crear, deshabilitar y eliminar con su contenido (BitLocker) / create, disable, delete with children.
    Allow $ou ($R::CreateChild -bor $R::DeleteChild) $gComputer $I::All $none
    Allow $ou ($R::ReadProperty -bor $R::WriteProperty -bor $R::DeleteTree) $none $I::Descendents $gComputer
    # Sub-unidades: solo crear / child OUs: create only.
    Allow $ou $R::CreateChild $gOu $I::All $none
    Say 'delegated' $ou
  }
  Say 'adminSd' $null 'Gray'
}

# ---------------- 3) DNS (sin DnsAdmins / without DnsAdmins) ----------------
if ($DNS -and -not $Lectura) {
  $gNode = ClassGuid 'dnsNode'
  $zonas = Get-ADObject -SearchBase "CN=MicrosoftDNS,DC=DomainDnsZones,$($dom.DistinguishedName)" -SearchScope OneLevel -LDAPFilter '(objectClass=dnsZone)' |
    Where-Object { $_.Name -eq $dom.DNSRoot -or $_.Name -like '*.in-addr.arpa' -or $_.Name -like '*.ip6.arpa' }
  if (-not $zonas) { Say 'noZones' $null 'Yellow' }
  foreach ($z in $zonas) {
    Allow $z.DistinguishedName $R::DeleteChild $gNode $I::All $none
    Allow $z.DistinguishedName $R::Delete $none $I::Descendents $gNode
    Say 'dnsZone' $z.Name
  }
}

# ---------------- 4) Papelera / recycle bin ----------------
if ($Papelera) {
  $del = "CN=Deleted Objects,$($dom.DistinguishedName)"   # nombre fijo en todos los idiomas / fixed name in every language
  & dsacls.exe $del /takeownership | Out-Null
  $perm = $(if ($Lectura) { 'LCRP' } else { 'LCRPWP' })
  & dsacls.exe $del /G "${who}:$perm" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw ($M.dsacls -f $del) }
  if ($Lectura) { Say 'binRead' } else {
    Allow $dom.DistinguishedName $R::ExtendedRight (RightGuid 'Reanimate-Tombstones') $I::None $none
    Say 'binWrite'
  }
}

Write-Host ''
Say 'done' "$Nombre@$($dom.DNSRoot)" 'Cyan'
Say 'tip' $null 'Gray'
