<#
.SYNOPSIS
  ES: Asistente que crea la cuenta de servicio del Gestor en el directorio activo
      con el minimo privilegio (lectura o escritura delegada). NO la agrega a
      ningun grupo privilegiado. Al final deja un informe .txt de lo realizado.
  EN: Wizard that creates the Gestor service account in Active Directory with
      least privilege (read-only or delegated write). It is NOT added to any
      privileged group. At the end it writes a .txt report of what was done.

.DESCRIPTION
  ES: Ejecutelo sin parametros y le guia: detecta el dominio, pregunta si la
      cuenta es de lectura (1) o de escritura (2), muestra las unidades
      organizativas, sugiere donde crear la cuenta, pide la contrasena (dos
      veces, validada contra la politica del dominio), muestra un resumen para
      confirmar y guarda el informe. Funciona igual con un DC en espanol o en
      ingles: los permisos se aplican por GUID del esquema, no por nombres.
      Ejecutar en un DC (o equipo con RSAT) como administrador del dominio, en
      PowerShell como administrador.
  EN: Run it without parameters and it guides you: detects the domain, asks
      whether the account is read-only (1) or write (2), lists the
      organizational units, suggests where to create the account, asks for the
      password (twice, checked against the domain policy), shows a summary to
      confirm and saves the report. Works the same on a Spanish or English DC:
      permissions are applied by schema GUID, never by names.
      Run on a DC (or a machine with RSAT) as a domain admin, elevated.

.EXAMPLE
  .\ad-cuenta-servicio.ps1
  # ES: asistente interactivo / EN: interactive wizard

.EXAMPLE
  .\ad-cuenta-servicio.ps1 -Name svc-gestor-lectura -ReadOnly -RecycleBin
  # ES: sin preguntas, cuenta de lectura / EN: no prompts, read-only account

.EXAMPLE
  .\ad-cuenta-servicio.ps1 -Name svc-gestor-escritura -ManagedOUs "OU=Depilzone,DC=ad,DC=depilzone,DC=com,DC=pe" -DNS -RecycleBin
  # ES: sin preguntas, cuenta de escritura / EN: no prompts, write account

.PARAMETER Nombre
  ES: Nombre de la cuenta (si se indica, no hay asistente).  EN: Account name (when given, no wizard).  (-Name)
.PARAMETER OUs
  ES: OU gestionadas (escritura).  EN: Managed OUs (write).  (-ManagedOUs)
.PARAMETER OUCuenta
  ES: Donde se crea la cuenta.  EN: Where the account is created.  (-AccountOU)
.PARAMETER Lectura
  ES: Cuenta solo de lectura.  EN: Read-only account.  (-ReadOnly)
.PARAMETER DNS
  ES: Borrar los registros DNS de un equipo eliminado.  EN: Delete the DNS records of a deleted computer.
.PARAMETER Papelera
  ES: Lectura: ver la papelera. Escritura: ademas, restaurar.  EN: Read: view the recycle bin. Write: also restore.  (-RecycleBin)
.PARAMETER Proteger
  ES: Otras cuentas a proteger cuando se gestiona la OU de las cuentas de servicio.  EN: Other accounts to protect when the service-accounts OU is managed.  (-Protect)
.PARAMETER SoloPermisos
  ES: La cuenta ya existe: solo aplica los permisos.  EN: The account exists: only apply permissions.  (-PermissionsOnly)
.PARAMETER Informe
  ES: Ruta del informe .txt (por defecto, junto al script).  EN: Path of the .txt report (default: next to the script).  (-Report)
.PARAMETER Idioma
  ES: es | en (por defecto, el idioma del servidor).  EN: es | en (default: the server language).  (-Language)
#>
param(
  [Alias('Name')] [string] $Nombre = '',
  [Alias('ManagedOUs')] [string[]] $OUs = @(),
  [Alias('AccountOU')] [string] $OUCuenta = '',
  [Alias('ReadOnly')] [switch] $Lectura,
  [switch] $DNS,
  [Alias('RecycleBin')] [switch] $Papelera,
  [Alias('PermissionsOnly')] [switch] $SoloPermisos,
  [Alias('Protect')] [string[]] $Proteger = @(),
  [Alias('Report')] [string] $Informe = '',
  [Alias('Language')] [ValidateSet('', 'es', 'en')] [string] $Idioma = ''
)
$ErrorActionPreference = 'Stop'
Import-Module ActiveDirectory

# ======================= mensajes / messages =======================
if (-not $Idioma) { $Idioma = $(if ((Get-UICulture).TwoLetterISOLanguageName -eq 'es') { 'es' } else { 'en' }) }
$M = @{
  es = @{
    title = 'Cuenta de servicio del Gestor (mínimo privilegio)'
    domain = 'Dominio detectado: {0}'
    dc = 'Controlador de dominio: {0}'
    policy = 'Política de contraseñas: mínimo {0} caracteres, complejidad {1}'
    kindQ = '¿Qué cuenta va a crear?'
    kind1 = '1) De LECTURA (recomendada primero): solo lee el directorio'
    kind2 = '2) De ESCRITURA: cambios delegados solo en las OU que elija'
    choose = 'Elija una opción'
    nameQ = 'Nombre de la cuenta'
    exists = 'La cuenta {0} ya existe en {1}.'
    existsQ = '¿Aplicarle solo los permisos, sin crearla de nuevo?'
    ouList = 'Unidades organizativas del dominio:'
    ouUsers = 'usuarios'
    accOuQ = '¿En qué unidad organizativa crear la cuenta? (número; Enter = sugerida)'
    suggested = 'sugerida'
    usersCont = 'Contenedor Users (predeterminado)'
    noSvcOu = 'No hay una OU de cuentas de servicio; se sugiere el contenedor Users. Puede crear una OU "Cuentas de servicio" antes y volver a ejecutar.'
    managedQ = '¿Qué unidades organizativas gestionará la aplicación? (números separados por coma, ej. 3,5,7 o 3-6)'
    managedNote = 'Elija las OU de usuarios y equipos de la empresa. No elija Domain Controllers ni la OU donde están las cuentas de administración.'
    dcOuWarn = 'Se quitó "{0}": es la OU de los controladores de dominio.'
    selfOuWarn = 'Se quitó "{0}": ahí están las cuentas de servicio; la cuenta no debe poder cambiarse a sí misma ni a la de lectura.'
    compQ = '¿Gestionar también el contenedor Computers? Solo equipos: sirve para mover a una OU los equipos recién unidos al dominio'
    usersQ = '¿Gestionar también el contenedor Users? Solo usuarios (no grupos). Ahí hay cuentas integradas y de sincronización: las sensibles se protegen'
    delegatedComp = 'Delegado en {0}: solo equipos.'
    delegatedUsers = 'Delegado en {0}: solo usuarios (sin grupos).'
    selfOuNote = '"{0}" contiene las cuentas de servicio (incluida esta).'
    selfOuQ = '¿Gestionarla también? Esta cuenta y las del Gestor quedan protegidas con una denegación explícita, y en la OU de las cuentas la aplicación podrá crear y modificar usuarios pero no eliminarlos ni moverlos'
    protectQ = 'Cuentas de servicio a proteger (nombres separados por coma; agregue aquí la de lectura si no aparece)'
    sProtect = 'Cuentas protegidas'
    protected = 'Protegida {0}: esta cuenta no puede modificarla, restablecer su contraseña ni eliminarla.'
    protectMissing = 'No se encontró la cuenta a proteger: {0} (no se protegió).'
    noDelete = 'En {0} la cuenta puede crear y modificar usuarios, pero no eliminarlos ni moverlos (protege a las cuentas de servicio).'
    dnsQ = '¿Permitir borrar los registros DNS de un equipo eliminado?'
    binReadQ = '¿Permitir ver la papelera de AD?'
    binWriteQ = '¿Permitir ver y restaurar de la papelera de AD?'
    yes = 's'; no = 'n'; yn = '(S/n)'; ynNo = '(s/N)'
    pw1 = 'Contraseña para {0} (mínimo {1} caracteres; se recomiendan 20 o más)'
    pw2 = 'Repita la contraseña'
    pwMismatch = 'Las contraseñas no coinciden. Intente de nuevo.'
    pwShort = 'La contraseña debe tener al menos {0} caracteres.'
    pwComplex = 'La contraseña debe combinar al menos 3 de: mayúsculas, minúsculas, números y símbolos.'
    summary = 'Resumen'
    sType = 'Tipo'; tRead = 'Lectura'; tWrite = 'Escritura (delegada)'
    sAccount = 'Cuenta'; sWhere = 'Se crea en'; sManaged = 'OU gestionadas'; sDns = 'DNS'; sBin = 'Papelera'; sMode = 'Modo'
    mCreate = 'crear la cuenta y aplicar permisos'; mPerms = 'solo aplicar permisos (la cuenta ya existe)'
    confirmQ = '¿Continuar?'
    cancelled = 'Cancelado: no se hizo ningún cambio.'
    needOus = 'Indique -OUs con las unidades organizativas que se van a gestionar (o -Lectura).'
    existsErr = 'La cuenta {0} ya existe. Para aplicarle solo los permisos, agregue -SoloPermisos.'
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
    report = 'Informe guardado en: {0}'
    failed = 'ERROR: {0}. El informe registra lo que alcanzó a hacerse.'
    rTitle = 'INFORME: CUENTA DE SERVICIO DEL GESTOR'
    rDate = 'Fecha'; rBy = 'Ejecutado por'; rHost = 'Equipo'; rDomain = 'Dominio'; rDn = 'DN de la cuenta'; rUpn = 'Usuario para la aplicación'
    rSid = 'SID'; rActions = 'Acciones realizadas'; rApp = 'En la aplicación (Directorio activo → Conexión)'
    rAppRead = 'Cuenta de servicio (lectura): {0}  · Contraseña: la que usted escribió (no se guarda en este informe).'
    rPwExisting = 'La contraseña es la que ya tenía la cuenta (este script no la cambió).'
    rAppWrite = 'Cambios en el dominio → Cuenta de escritura: {0}  · Unidades organizativas gestionadas (una por línea):'
    rUndo = 'Para deshacer'
    rUndo1 = 'Remove-ADUser -Identity {0}   (al borrar la cuenta, sus permisos delegados dejan de tener efecto)'
    rUndoAcl = 'Quitar solo los permisos que agregó este script (la cuenta se conserva):'
    rNoPw = 'Este informe NO contiene la contraseña.'
    rResult = 'Resultado'; rOk = 'Completado'; rErr = 'Con error'
  }
  en = @{
    title = 'Gestor service account (least privilege)'
    domain = 'Detected domain: {0}'
    dc = 'Domain controller: {0}'
    policy = 'Password policy: minimum {0} characters, complexity {1}'
    kindQ = 'Which account do you want to create?'
    kind1 = '1) READ-ONLY (recommended first): only reads the directory'
    kind2 = '2) WRITE: changes delegated only on the OUs you choose'
    choose = 'Choose an option'
    nameQ = 'Account name'
    exists = 'Account {0} already exists in {1}.'
    existsQ = 'Only apply its permissions, without creating it again?'
    ouList = 'Organizational units in the domain:'
    ouUsers = 'users'
    accOuQ = 'Which organizational unit should hold the account? (number; Enter = suggested)'
    suggested = 'suggested'
    usersCont = 'Users container (default)'
    noSvcOu = 'There is no service-accounts OU; the Users container is suggested. You can create a "Service Accounts" OU first and run again.'
    managedQ = 'Which organizational units will the application manage? (comma-separated numbers, e.g. 3,5,7 or 3-6)'
    managedNote = 'Choose the company user and computer OUs. Do not choose Domain Controllers or the OU holding admin accounts.'
    dcOuWarn = 'Removed "{0}": it is the domain controllers OU.'
    selfOuWarn = 'Removed "{0}": it holds the service accounts; the account must not be able to change itself or the read account.'
    compQ = 'Also manage the Computers container? Computers only: lets the application move newly joined computers to an OU'
    usersQ = 'Also manage the Users container? Users only (no groups). It holds built-in and sync accounts: the sensitive ones get protected'
    delegatedComp = 'Delegated on {0}: computers only.'
    delegatedUsers = 'Delegated on {0}: users only (no groups).'
    selfOuNote = '"{0}" holds the service accounts (including this one).'
    selfOuQ = 'Manage it too? This account and the Gestor accounts get an explicit deny, and in the accounts OU the application can create and modify users but not delete or move them'
    protectQ = 'Service accounts to protect (comma-separated names; add the read account here if it is missing)'
    sProtect = 'Protected accounts'
    protected = 'Protected {0}: this account cannot modify it, reset its password or delete it.'
    protectMissing = 'Account to protect not found: {0} (not protected).'
    noDelete = 'In {0} the account can create and modify users, but not delete or move them (protects the service accounts).'
    dnsQ = 'Allow deleting the DNS records of a deleted computer?'
    binReadQ = 'Allow viewing the AD recycle bin?'
    binWriteQ = 'Allow viewing and restoring from the AD recycle bin?'
    yes = 'y'; no = 'n'; yn = '(Y/n)'; ynNo = '(y/N)'
    pw1 = 'Password for {0} (minimum {1} characters; 20+ recommended)'
    pw2 = 'Repeat the password'
    pwMismatch = 'Passwords do not match. Try again.'
    pwShort = 'The password must have at least {0} characters.'
    pwComplex = 'The password must combine at least 3 of: uppercase, lowercase, digits and symbols.'
    summary = 'Summary'
    sType = 'Type'; tRead = 'Read-only'; tWrite = 'Write (delegated)'
    sAccount = 'Account'; sWhere = 'Created in'; sManaged = 'Managed OUs'; sDns = 'DNS'; sBin = 'Recycle bin'; sMode = 'Mode'
    mCreate = 'create the account and apply permissions'; mPerms = 'only apply permissions (account exists)'
    confirmQ = 'Continue?'
    cancelled = 'Cancelled: nothing was changed.'
    needOus = 'Specify -ManagedOUs with the organizational units to manage (or -ReadOnly).'
    existsErr = 'Account {0} already exists. To only apply its permissions, add -PermissionsOnly.'
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
    report = 'Report saved to: {0}'
    failed = 'ERROR: {0}. The report records what was done before the error.'
    rTitle = 'REPORT: GESTOR SERVICE ACCOUNT'
    rDate = 'Date'; rBy = 'Run by'; rHost = 'Computer'; rDomain = 'Domain'; rDn = 'Account DN'; rUpn = 'User for the application'
    rSid = 'SID'; rActions = 'Actions performed'; rApp = 'In the application (Active Directory → Connection)'
    rAppRead = 'Service account (read): {0}  · Password: the one you typed (not stored in this report).'
    rPwExisting = 'The password is the one the account already had (this script did not change it).'
    rAppWrite = 'Domain changes → Write account: {0}  · Managed organizational units (one per line):'
    rUndo = 'To undo'
    rUndo1 = 'Remove-ADUser -Identity {0}   (once the account is deleted, its delegated permissions have no effect)'
    rUndoAcl = 'Remove only the permissions this script added (the account is kept):'
    rNoPw = 'This report does NOT contain the password.'
    rResult = 'Result'; rOk = 'Completed'; rErr = 'With error'
  }
}[$Idioma]
function Say([string] $key, $arg = $null, [string] $color = 'Green') { Write-Host ($M[$key] -f $arg) -ForegroundColor $color }
$acts = New-Object System.Collections.Generic.List[string]   # para el informe / for the report
$touched = New-Object System.Collections.Generic.List[string] # objetos con permisos nuevos / objects with new permissions
function Log([string] $text) { $acts.Add($text); Write-Host "  · $text" -ForegroundColor Green }

function Ask([string] $q, [string] $default = '') {
  $a = Read-Host ($(if ($default) { "$q [$default]" } else { $q }))
  if ([string]::IsNullOrWhiteSpace($a)) { $default } else { $a.Trim() }
}
function YesNo([string] $q, [bool] $default = $true) {
  $a = Read-Host "$q $(if ($default) { $M.yn } else { $M.ynNo })"
  if ([string]::IsNullOrWhiteSpace($a)) { return $default }
  return $a.Trim().ToLower().StartsWith($M.yes) -or $a.Trim().ToLower().StartsWith('y') -or $a.Trim().ToLower().StartsWith('s')
}
# ¿$dn es $ou o esta dentro de ella? (sin distinguir mayusculas) / is $dn $ou or inside it?
function CoversDn([string] $ou, [string] $dn) {
  $dn.Equals($ou, [StringComparison]::OrdinalIgnoreCase) -or $dn.EndsWith(",$ou", [StringComparison]::OrdinalIgnoreCase)
}
# "3,5,7-9" -> 3,5,7,8,9
function ParseList([string] $text, [int] $max) {
  $out = @()
  foreach ($part in ($text -split '[,; ]+' | Where-Object { $_ })) {
    if ($part -match '^(\d+)-(\d+)$') { $out += [int]$Matches[1]..[int]$Matches[2] }
    elseif ($part -match '^\d+$') { $out += [int]$part }
  }
  $out | Where-Object { $_ -ge 1 -and $_ -le $max } | Select-Object -Unique
}

# ======================= dominio / domain =======================
$dom = Get-ADDomain
$root = Get-ADRootDSE
$dcName = (Get-ADDomainController -Discover -DomainName $dom.DNSRoot).HostName | Select-Object -First 1
$pol = Get-ADDefaultDomainPasswordPolicy
$minLen = [Math]::Max([int]$pol.MinPasswordLength, 12)
$interactive = -not $Nombre

Write-Host ''
Write-Host "=== $($M.title) ===" -ForegroundColor Cyan
Say 'domain' "$($dom.DNSRoot)  ($($dom.DistinguishedName), NetBIOS $($dom.NetBIOSName))" 'White'
Say 'dc' $dcName 'White'
Say 'policy' @($pol.MinPasswordLength, $pol.ComplexityEnabled) 'White'
Write-Host ''

# OU del dominio, con cuantos usuarios tiene cada una / domain OUs with their user count
# OJO: las variables de PowerShell no distinguen mayusculas: $ouList, no $ous (seria el parametro [string[]] $OUs).
function ListOus {
  $all = Get-ADOrganizationalUnit -Filter * -Properties CanonicalName | Sort-Object CanonicalName
  $idx = 0
  foreach ($o in $all) {
    $idx++
    $n = @(Get-ADUser -SearchBase $o.DistinguishedName -SearchScope OneLevel -Filter * -ResultSetSize 5000).Count
    $depth = ($o.CanonicalName -split '/').Count - 2
    [pscustomobject]@{ N = $idx; DN = $o.DistinguishedName; Name = $o.Name; Label = ('  ' * $depth) + $o.Name; Users = $n }
  }
}

$isNew = -not $SoloPermisos
if ($interactive) {
  # ---- 1) tipo de cuenta / account type
  Write-Host $M.kindQ -ForegroundColor Cyan
  Write-Host "  $($M.kind1)"
  Write-Host "  $($M.kind2)"
  do { $k = Ask $M.choose '1' } until ($k -in '1', '2')
  $Lectura = [switch]($k -eq '1')
  # ---- 2) nombre / name
  $Nombre = Ask $M.nameQ $(if ($Lectura) { 'svc-gestor-lectura' } else { 'svc-gestor-escritura' })
  $prev = Get-ADUser -LDAPFilter "(sAMAccountName=$Nombre)" -Properties UserPrincipalName
  if ($prev) {
    Say 'exists' @($Nombre, $prev.DistinguishedName) 'Yellow'
    if (-not (YesNo $M.existsQ $true)) { Say 'cancelled' $null 'Yellow'; return }
    $isNew = $false
  }
  # ---- 3) OU: donde crear la cuenta y, si es de escritura, cuales gestionar
  if ($isNew -or -not $Lectura) {
  $ouList = @(ListOus)
  Write-Host ''
  Write-Host $M.ouList -ForegroundColor Cyan
  $svc = $ouList | Where-Object { $_.Name -match '(?i)servic|service|svc|cuentas? de servicio|service accounts' } | Select-Object -First 1
  Write-Host ("  {0,3}) {1}" -f 0, $M.usersCont)
  foreach ($o in $ouList) {
    $mark = $(if ($svc -and $o.N -eq $svc.N) { "   <- $($M.suggested)" } else { '' })
    Write-Host ("  {0,3}) {1}  ({2} {3}){4}" -f $o.N, $o.Label, $o.Users, $M.ouUsers, $mark)
  }
  }
  if ($isNew) {
    if (-not $svc) { Say 'noSvcOu' $null 'Yellow' }
    $def = $(if ($svc) { "$($svc.N)" } else { '0' })
    do { $pick = Ask $M.accOuQ $def } until ($pick -match '^\d+$' -and [int]$pick -le $ouList.Count)
    $OUCuenta = $(if ([int]$pick -eq 0) { $dom.UsersContainer } else { ($ouList | Where-Object { $_.N -eq [int]$pick }).DN })
  }
  if (-not $Lectura) {
    Write-Host ''
    Say 'managedNote' $null 'Yellow'
    do {
      $sel = @(ParseList (Ask $M.managedQ) $ouList.Count)
      $OUs = @($ouList | Where-Object { $sel -contains $_.N } | ForEach-Object { $_.DN })
      $dcOu = $dom.DomainControllersContainer
      # OU donde vive la cuenta (nueva o existente) y sus superiores: no se gestionan.
      $selfOu = $(if ($isNew) { $OUCuenta } else { ($prev.DistinguishedName -split '(?<!\\),', 2)[1] })
      foreach ($x in @($OUs | Where-Object { $_ -eq $dcOu })) { Say 'dcOuWarn' $x 'Yellow' }
      $OUs = @($OUs | Where-Object { $_ -ne $dcOu })
      # La OU de las cuentas de servicio (y las de arriba): se pregunta. Si se gestiona, mas abajo se protegen las cuentas.
      $selfHit = @($OUs | Where-Object { CoversDn $_ $selfOu })
      if ($selfHit.Count) {
        foreach ($x in $selfHit) { Say 'selfOuNote' $x 'Yellow' }
        if (-not (YesNo $M.selfOuQ $false)) {
          foreach ($x in $selfHit) { Say 'selfOuWarn' $x 'Yellow' }
          $OUs = @($OUs | Where-Object { -not (CoversDn $_ $selfOu) })
        }
      }
      # Una OU dentro de otra elegida ya hereda los permisos: se deja solo la de arriba.
      $sel2 = $OUs
      $OUs = @($sel2 | Where-Object { $c = $_; -not ($sel2 | Where-Object { $_ -ne $c -and $c.EndsWith(",$_") }) })
    } until ($OUs.Count -gt 0)
    # Contenedores predeterminados (no son OU): se preguntan aparte y se delegan con menos permisos.
    if (YesNo $M.compQ $true) { $OUs += $dom.ComputersContainer }
    if (YesNo $M.usersQ $false) { $OUs += $dom.UsersContainer }
    $DNS = [switch](YesNo $M.dnsQ $true)
    $Papelera = [switch](YesNo $M.binWriteQ $true)
  } else {
    $Papelera = [switch](YesNo $M.binReadQ $true)
  }
} else {
  if (-not $Lectura -and -not $OUs.Count) { throw $M.needOus }
  $prev = Get-ADUser -LDAPFilter "(sAMAccountName=$Nombre)" -Properties UserPrincipalName
  if ($prev -and $isNew) { throw ($M.existsErr -f $Nombre) }
  if (-not $OUCuenta) { $OUCuenta = $dom.UsersContainer }
}
$upn = $(if (-not $isNew -and $prev -and $prev.UserPrincipalName) { $prev.UserPrincipalName } else { "$Nombre@$($dom.DNSRoot)" })

# ---- cuentas a proteger si se gestiona la OU donde viven las cuentas de servicio
# (con o sin asistente: si las OU elegidas cubren a la cuenta, siempre se protege)
$selfOuDn = $(if ($isNew) { $OUCuenta } elseif ($prev) { ($prev.DistinguishedName -split '(?<!\\),', 2)[1] } else { '' })
$protect = @()
$isCn = { param($a, $b) "$a".Equals("$b", [StringComparison]::OrdinalIgnoreCase) }
$selfCovered = (-not $Lectura) -and $selfOuDn -and (@($OUs | Where-Object { CoversDn $_ $selfOuDn }).Count -gt 0)
$usersChosen = (-not $Lectura) -and (@($OUs | Where-Object { & $isCn $_ $dom.UsersContainer }).Count -gt 0)
if ($selfCovered -or $usersChosen) {
  $auto = @()
  # Las que creo este script llevan la descripcion "Gestor: ..." / the ones this script created
  if ($selfCovered) { try { $auto += @(Get-ADUser -SearchBase $selfOuDn -SearchScope OneLevel -LDAPFilter '(description=Gestor:*)' | ForEach-Object { $_.SamAccountName }) } catch { } }
  # En Users: sincronizacion con Microsoft 365, krbtgt y cuentas con SPN (de servicio); AdminSDHolder no las cubre a todas.
  if ($usersChosen) { try { $auto += @(Get-ADUser -SearchBase $dom.UsersContainer -SearchScope OneLevel `
    -LDAPFilter '(|(sAMAccountName=MSOL_*)(sAMAccountName=AAD_*)(sAMAccountName=krbtgt*)(servicePrincipalName=*)(description=Gestor:*))' | ForEach-Object { $_.SamAccountName }) } catch { } }
  $protect = @(@($Nombre) + $auto + $Proteger | Where-Object { $_ } | Sort-Object -Unique)
  if ($interactive) {
    $typed = Ask $M.protectQ ($protect -join ', ')
    $protect = @(@($Nombre) + ($typed -split '[,; ]+') | Where-Object { $_ } | Sort-Object -Unique)
  }
}

# ---- 4) contrasena / password (solo si se crea / only when creating)
$pw = $null
if ($isNew) {
  $plain = { param($s) $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) } }
  while ($true) {
    $p1 = Read-Host ($M.pw1 -f $Nombre, $minLen) -AsSecureString
    $p2 = Read-Host $M.pw2 -AsSecureString
    $a = & $plain $p1; $b = & $plain $p2
    $ok = $true
    if ($a -cne $b) { Say 'pwMismatch' $null 'Red'; $ok = $false }
    elseif ($a.Length -lt $minLen) { Say 'pwShort' $minLen 'Red'; $ok = $false }
    elseif ((@('[A-Z]', '[a-z]', '[0-9]', '[^A-Za-z0-9]') | Where-Object { $a -cmatch $_ }).Count -lt 3) { Say 'pwComplex' $null 'Red'; $ok = $false }
    $a = $null; $b = $null
    if ($ok) { $pw = $p1; break }
  }
}

# ---- 5) resumen y confirmacion / summary and confirmation
Write-Host ''
Write-Host "=== $($M.summary) ===" -ForegroundColor Cyan
Write-Host ("  {0}: {1}" -f $M.sType, $(if ($Lectura) { $M.tRead } else { $M.tWrite }))
Write-Host ("  {0}: {1}" -f $M.sAccount, $upn)
Write-Host ("  {0}: {1}" -f $M.sMode, $(if ($isNew) { $M.mCreate } else { $M.mPerms }))
if ($isNew) { Write-Host ("  {0}: {1}" -f $M.sWhere, $OUCuenta) }
if (-not $Lectura) { Write-Host ("  {0}:" -f $M.sManaged); $OUs | ForEach-Object { Write-Host "      $_" }; Write-Host ("  {0}: {1}" -f $M.sDns, [bool]$DNS) }
if ($protect.Count) { Write-Host ("  {0}: {1}" -f $M.sProtect, ($protect -join ', ')) }
Write-Host ("  {0}: {1}" -f $M.sBin, [bool]$Papelera)
if ($interactive -and -not (YesNo $M.confirmQ $false)) { Say 'cancelled' $null 'Yellow'; return }

# ======================= cambios / changes =======================
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
$R = [System.DirectoryServices.ActiveDirectoryRights]
$I = [System.DirectoryServices.ActiveDirectorySecurityInheritance]
$none = [guid]::Empty
function Allow([string] $dn, $rights, [guid] $objectType, $inheritance, [guid] $inheritedType) { Rule 'Allow' $dn $rights $objectType $inheritance $inheritedType }
function Deny([string] $dn, $rights, [guid] $objectType, $inheritance, [guid] $inheritedType) { Rule 'Deny' $dn $rights $objectType $inheritance $inheritedType }
function Rule([string] $type, [string] $dn, $rights, [guid] $objectType, $inheritance, [guid] $inheritedType) {
  $path = "AD:\$dn"
  $acl = Get-Acl -Path $path
  # Tipos explicitos: con valores sin tipo PowerShell no encuentra el constructor de 6 argumentos.
  $rule = New-Object System.DirectoryServices.ActiveDirectoryAccessRule -ArgumentList @(
    [System.Security.Principal.IdentityReference] $script:sid,
    [System.DirectoryServices.ActiveDirectoryRights] $rights,
    [System.Security.AccessControl.AccessControlType] $type,
    [guid] $objectType,
    [System.DirectoryServices.ActiveDirectorySecurityInheritance] $inheritance,
    [guid] $inheritedType)
  $acl.AddAccessRule($rule)
  Set-Acl -Path $path -AclObject $acl
  if (-not $touched.Contains($dn)) { $touched.Add($dn) }
}

$errorText = $null
try {
  Write-Host ''
  # ---- la cuenta / the account
  if ($isNew) {
    New-ADUser -Name $Nombre -SamAccountName $Nombre -UserPrincipalName $upn -Path $OUCuenta `
      -AccountPassword $pw -Enabled $true -PasswordNeverExpires $true -CannotChangePassword $true `
      -Description $(if ($Lectura) { $M.descRead } else { $M.descWrite })
    # "La cuenta es importante y no se puede delegar" / "Account is sensitive and cannot be delegated"
    Set-ADAccountControl -Identity $Nombre -AccountNotDelegated $true
    Log ($M.created -f $upn)
  }
  $pw = $null
  $acct = Get-ADUser -Identity $Nombre
  $script:sid = [System.Security.Principal.SecurityIdentifier] "$($acct.SID)"
  $who = "$($dom.NetBIOSName)\$Nombre"

  # ---- delegacion en cada OU (escritura) / delegation on each OU (write)
  if ($OUs.Count -and -not $Lectura) {
    $gUser = ClassGuid 'user'; $gGroup = ClassGuid 'group'; $gComputer = ClassGuid 'computer'; $gOu = ClassGuid 'organizationalUnit'
    $gReset = RightGuid 'User-Force-Change-Password'   # "Restablecer contraseña" / "Reset Password"
    foreach ($ou in $OUs) {
      try { Get-ADObject -Identity $ou | Out-Null } catch { throw ($M.noOu -f $ou) }
      if (& $isCn $ou $dom.ComputersContainer) {
        Allow $ou ($R::CreateChild -bor $R::DeleteChild) $gComputer $I::All $none
        Allow $ou ($R::ReadProperty -bor $R::WriteProperty -bor $R::DeleteTree) $none $I::Descendents $gComputer
        Log ($M.delegatedComp -f $ou); continue
      }
      if (& $isCn $ou $dom.UsersContainer) {
        Allow $ou ($R::CreateChild -bor $R::DeleteChild) $gUser $I::All $none
        Allow $ou ($R::ReadProperty -bor $R::WriteProperty -bor $R::DeleteTree) $none $I::Descendents $gUser
        Allow $ou $R::ExtendedRight $gReset $I::Descendents $gUser
        Log ($M.delegatedUsers -f $ou); continue
      }
      # Usuarios: crear/eliminar; datos (deshabilitar, desbloquear, cambiar al entrar); eliminar con su contenido; restablecer contrasena.
      Allow $ou ($R::CreateChild -bor $R::DeleteChild) $gUser $I::All $none
      Allow $ou ($R::ReadProperty -bor $R::WriteProperty -bor $R::DeleteTree) $none $I::Descendents $gUser
      Allow $ou $R::ExtendedRight $gReset $I::Descendents $gUser
      # Grupos: crear, eliminar, miembros y datos.
      Allow $ou ($R::CreateChild -bor $R::DeleteChild) $gGroup $I::All $none
      Allow $ou ($R::ReadProperty -bor $R::WriteProperty) $none $I::Descendents $gGroup
      # Equipos: crear, deshabilitar y eliminar con su contenido (BitLocker).
      Allow $ou ($R::CreateChild -bor $R::DeleteChild) $gComputer $I::All $none
      Allow $ou ($R::ReadProperty -bor $R::WriteProperty -bor $R::DeleteTree) $none $I::Descendents $gComputer
      # Sub-unidades: solo crear.
      Allow $ou $R::CreateChild $gOu $I::All $none
      Log ($M.delegated -f $ou)
    }
    Write-Host "  $($M.adminSd)" -ForegroundColor Gray
    # ---- se gestiona la OU de las cuentas de servicio: denegaciones explicitas (ganan a lo heredado)
    if ($protect.Count) {
      # Eliminar o mover un objeto tambien se permite desde la OU (DeleteChild): se niega ahi para usuarios.
      if ($selfCovered -and -not (& $isCn $selfOuDn $dom.UsersContainer)) {
        Deny $selfOuDn $R::DeleteChild $gUser $I::None $none
        Log ($M.noDelete -f $selfOuDn)
      }
      foreach ($p in $protect) {
        $pa = Get-ADUser -LDAPFilter "(sAMAccountName=$p)"
        if (-not $pa) { Log ($M.protectMissing -f $p); continue }
        Deny $pa.DistinguishedName ($R::WriteProperty -bor $R::Delete -bor $R::DeleteTree -bor $R::WriteDacl -bor $R::WriteOwner) $none $I::None $none
        Deny $pa.DistinguishedName $R::ExtendedRight $none $I::None $none   # incluye restablecer la contrasena / includes reset password
        Log ($M.protected -f $p)
      }
    }
  }

  # ---- DNS (sin DnsAdmins / without DnsAdmins)
  if ($DNS -and -not $Lectura) {
    $gNode = ClassGuid 'dnsNode'
    $zonas = Get-ADObject -SearchBase "CN=MicrosoftDNS,DC=DomainDnsZones,$($dom.DistinguishedName)" -SearchScope OneLevel -LDAPFilter '(objectClass=dnsZone)' |
      Where-Object { $_.Name -eq $dom.DNSRoot -or $_.Name -like '*.in-addr.arpa' -or $_.Name -like '*.ip6.arpa' }
    if (-not $zonas) { Say 'noZones' $null 'Yellow' }
    foreach ($z in $zonas) {
      Allow $z.DistinguishedName $R::DeleteChild $gNode $I::All $none
      Allow $z.DistinguishedName $R::Delete $none $I::Descendents $gNode
      Log ($M.dnsZone -f $z.Name)
    }
  }

  # ---- Papelera / recycle bin
  if ($Papelera) {
    $del = "CN=Deleted Objects,$($dom.DistinguishedName)"   # nombre fijo en todos los idiomas / fixed in every language
    & dsacls.exe $del /takeownership | Out-Null
    & dsacls.exe $del /G "${who}:$(if ($Lectura) { 'LCRP' } else { 'LCRPWP' })" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw ($M.dsacls -f $del) }
    if (-not $touched.Contains($del)) { $touched.Add($del) }
    if ($Lectura) { Log $M.binRead } else {
      Allow $dom.DistinguishedName $R::ExtendedRight (RightGuid 'Reanimate-Tombstones') $I::None $none
      Log $M.binWrite
    }
  }
} catch {
  $errorText = $_.Exception.Message
  Say 'failed' $errorText 'Red'
}

# ======================= informe / report =======================
if (-not $Informe) {
  $dir = $(if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path })
  $Informe = Join-Path $dir ("Gestor-cuenta-{0}-{1}.txt" -f $Nombre, (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
$acctNow = Get-ADUser -LDAPFilter "(sAMAccountName=$Nombre)" -Properties UserPrincipalName, SID, DistinguishedName, whenCreated
$lines = @(
  $M.rTitle
  ('=' * $M.rTitle.Length)
  "$($M.rDate): $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
  "$($M.rBy): $env:USERDOMAIN\$env:USERNAME"
  "$($M.rHost): $env:COMPUTERNAME"
  "$($M.rDomain): $($dom.DNSRoot) ($($dom.DistinguishedName)) · DC $dcName"
  "$($M.sType): $(if ($Lectura) { $M.tRead } else { $M.tWrite })"
  "$($M.rUpn): $upn"
  "$($M.rDn): $(if ($acctNow) { $acctNow.DistinguishedName } else { '—' })"
  "$($M.rSid): $(if ($acctNow) { $acctNow.SID } else { '—' })"
  "$($M.rResult): $(if ($errorText) { "$($M.rErr): $errorText" } else { $M.rOk })"
  ''
  "$($M.rActions):"
)
$lines += $(if ($acts.Count) { $acts | ForEach-Object { "  - $_" } } else { '  —' })
if (-not $Lectura -and $OUs.Count) {
  $lines += ''
  $lines += "$($M.sManaged):"
  $lines += $OUs | ForEach-Object { "  $_" }
}
$lines += ''
$lines += "$($M.rApp):"
if ($Lectura) { $lines += '  ' + ($M.rAppRead -f $upn) } else { $lines += '  ' + ($M.rAppWrite -f $upn); $lines += $OUs | ForEach-Object { "      $_" } }
if (-not $isNew) { $lines += '  ' + $M.rPwExisting }
$lines += ''
$lines += "$($M.rUndo):"
if ($isNew) { $lines += '  ' + ($M.rUndo1 -f $Nombre) }
if ($touched.Count) {
  $lines += '  ' + $M.rUndoAcl
  $lines += $touched | ForEach-Object { "    dsacls `"$_`" /R `"$($dom.NetBIOSName)\$Nombre`"" }
}
$lines += ''
$lines += $M.rNoPw
[IO.File]::WriteAllLines($Informe, [string[]]$lines, (New-Object Text.UTF8Encoding($true)))

Write-Host ''
if (-not $errorText) { Say 'done' $upn 'Cyan'; Write-Host "  $($M.tip)" -ForegroundColor Gray }
Say 'report' $Informe 'Cyan'
