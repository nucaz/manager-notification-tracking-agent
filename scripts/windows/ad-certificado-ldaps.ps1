<#
.SYNOPSIS
  ES: Habilita LDAPS en ESTE controlador de dominio con un certificado
      autofirmado (sin instalar una CA ni tocar la confianza de otros equipos)
      y guarda un informe .txt con el certificado en PEM para la aplicacion.
  EN: Enables LDAPS on THIS domain controller with a self-signed certificate
      (no CA install, no trust change on other machines) and saves a .txt
      report with the PEM certificate for the application.

.DESCRIPTION
  ES: Ejecutelo en CADA controlador de dominio, en PowerShell como
      administrador. Detecta el dominio y el nombre del DC, revisa si ya hay un
      certificado valido (y ofrece reutilizarlo), crea el certificado (clave no
      exportable), hace que este DC confie en el, activa LDAPS sin reiniciar,
      VERIFICA que el puerto 636 presente el certificado nuevo, ofrece quitar
      los certificados anteriores del Gestor y guarda el informe y un .pem.
      Pegue en la aplicacion el PEM de cada DC, uno debajo del otro.
  EN: Run it on EACH domain controller, in an elevated PowerShell. It detects
      the domain and the DC name, checks for an existing valid certificate (and
      offers to reuse it), creates the certificate (non-exportable key), makes
      this DC trust it, enables LDAPS without a reboot, VERIFIES that port 636
      presents the new certificate, offers to remove previous Gestor
      certificates and saves the report and a .pem file.
      Paste the PEM of each DC in the application, one below the other.

.EXAMPLE
  .\ad-certificado-ldaps.ps1
  # ES: asistente / EN: wizard

.EXAMPLE
  .\ad-certificado-ldaps.ps1 -Years 3 -Yes
  # ES: sin preguntas (crea uno nuevo y quita los anteriores) / EN: no prompts (creates a new one, removes previous ones)

.PARAMETER Anios
  ES: Vigencia en años (1 a 5, por defecto 3).  EN: Validity in years (1 to 5, default 3).  (-Years)
.PARAMETER NombresExtra
  ES: Otros nombres DNS por los que la aplicacion llega a este DC.  EN: Other DNS names the application uses to reach this DC.  (-ExtraNames)
.PARAMETER Si
  ES: No preguntar: crea uno nuevo y quita los anteriores del Gestor.  EN: Do not ask: create a new one and remove previous Gestor ones.  (-Yes)
.PARAMETER Informe
  ES: Ruta del informe .txt (por defecto, junto al script).  EN: Path of the .txt report (default: next to the script).  (-Report)
.PARAMETER Idioma
  ES: es | en (por defecto, el idioma del servidor).  EN: es | en (default: the server language).  (-Language)
#>
param(
  [Alias('Years')] [ValidateRange(1, 5)] [int] $Anios = 3,
  [Alias('ExtraNames')] [string[]] $NombresExtra = @(),
  [Alias('Yes')] [switch] $Si,
  [Alias('Report')] [string] $Informe = '',
  [Alias('Language')] [ValidateSet('', 'es', 'en')] [string] $Idioma = ''
)
$ErrorActionPreference = 'Stop'
$FRIENDLY = 'LDAPS (Gestor)'
$SERVER_AUTH = '1.3.6.1.5.5.7.3.1'

# ======================= mensajes / messages =======================
if (-not $Idioma) { $Idioma = $(if ((Get-UICulture).TwoLetterISOLanguageName -eq 'es') { 'es' } else { 'en' }) }
$M = @{
  es = @{
    title = 'Certificado LDAPS para el Gestor (este controlador de dominio)'
    notDc = 'Este equipo no es un controlador de dominio. Ejecute el script en cada DC (por ejemplo ZEUS y Themis).'
    notAdmin = 'Ejecute PowerShell como administrador.'
    domain = 'Dominio: {0}'
    dc = 'Este DC: {0}'
    names = 'Nombres del certificado: {0}'
    existing = 'Certificados de servidor que ya tiene este DC para {0}:'
    none = '  (ninguno: por eso LDAPS no responde)'
    reuseQ = '¿Reutilizar el certificado vigente {0} (vence {1}) en lugar de crear uno nuevo?'
    yearsQ = 'Vigencia del certificado en años (1 a 5)'
    summary = 'Resumen'
    sAction = 'Acción'; aNew = 'crear un certificado nuevo y activar LDAPS'; aReuse = 'reutilizar el certificado vigente y activar LDAPS'
    sValid = 'Vigencia'; years = 'años'
    confirmQ = '¿Continuar?'
    yes = 's'; yn = '(S/n)'; ynNo = '(s/N)'
    cancelled = 'Cancelado: no se hizo ningún cambio.'
    created = 'Certificado creado: {0} (huella {1}), vence {2}. Clave privada no exportable.'
    reused = 'Se reutiliza el certificado {0} (huella {1}), vence {2}.'
    trusted = 'Este DC confía en su propio certificado (solo en este servidor).'
    renewed = 'LDAPS: se pidió al DC que cargue el certificado (renewServerCertificate), sin reiniciar.'
    renewFail = 'ldifde no pudo aplicar renewServerCertificate (código {0}). LDAPS tomará el certificado solo en unos minutos o al reiniciar.'
    verifying = 'Verificando LDAPS en {0}:636...'
    verifyOk = 'Verificado: el puerto 636 presenta el certificado {0}.'
    verifyOther = 'El puerto 636 presenta OTRO certificado ({0}). Puede tardar unos minutos en tomar el nuevo; si no, reinicie el servicio NTDS o el servidor.'
    verifyNo = 'No se pudo verificar LDAPS en el puerto 636 ({0}). Revise el firewall o espere unos minutos.'
    oldFound = 'Hay {0} certificado(s) anterior(es) del Gestor en este DC.'
    oldQ = '¿Quitarlos? (así LDAPS no elige uno viejo)'
    oldRemoved = 'Certificado anterior quitado: {0} (vencía {1}).'
    chainNote = 'El certificado lo emitió una CA ({0}): en la aplicación se pega el certificado raíz de esa CA (incluido en el informe).'
    pemCopied = 'El PEM quedó copiado en el portapapeles.'
    done = 'Listo.'
    report = 'Informe: {0}'
    pemFile = 'Certificado (PEM): {0}'
    failed = 'ERROR: {0}. El informe registra lo que alcanzó a hacerse.'
    rTitle = 'INFORME: CERTIFICADO LDAPS DEL CONTROLADOR DE DOMINIO'
    rDate = 'Fecha'; rBy = 'Ejecutado por'; rDomain = 'Dominio'; rDc = 'Controlador de dominio'; rNames = 'Nombres (SAN)'
    rThumb = 'Huella (SHA-1)'; rSha256 = 'Huella (SHA-256)'; rSerial = 'Número de serie'; rFrom = 'Válido desde'; rTo = 'Válido hasta'
    rIssuer = 'Emitido por'; rCheck = 'Verificación del puerto 636'; rActions = 'Acciones realizadas'; rResult = 'Resultado'; rOk = 'Completado'; rErr = 'Con error'
    rApp = 'En la aplicación (Directorio activo → Conexión)'
    rApp1 = 'Servidor: ldaps://{0}:636   (o ldaps://{1}, que apunta a todos los DC)'
    rApp2 = 'Certificados de confianza: pegue el bloque PEM de abajo y el de cada uno de los demás DC, uno debajo del otro.'
    rPem = 'Certificado en PEM (es público: no contiene la clave privada)'
    rRenew = 'Renovar antes de'
    rRenewTxt = 'Vuelva a ejecutar este script en este DC unas semanas antes y pegue el PEM nuevo en la aplicación (el Resumen del módulo avisa cuándo vence).'
    rUndo = 'Para deshacer'
    rUndoTxt = 'Quitar el certificado de los almacenes Personal y Raíz de confianza del equipo local (certlm.msc), o:'
  }
  en = @{
    title = 'LDAPS certificate for the Gestor (this domain controller)'
    notDc = 'This computer is not a domain controller. Run the script on each DC.'
    notAdmin = 'Run PowerShell as administrator.'
    domain = 'Domain: {0}'
    dc = 'This DC: {0}'
    names = 'Certificate names: {0}'
    existing = 'Server certificates this DC already has for {0}:'
    none = '  (none: that is why LDAPS does not answer)'
    reuseQ = 'Reuse the current certificate {0} (expires {1}) instead of creating a new one?'
    yearsQ = 'Certificate validity in years (1 to 5)'
    summary = 'Summary'
    sAction = 'Action'; aNew = 'create a new certificate and enable LDAPS'; aReuse = 'reuse the current certificate and enable LDAPS'
    sValid = 'Validity'; years = 'years'
    confirmQ = 'Continue?'
    yes = 'y'; yn = '(Y/n)'; ynNo = '(y/N)'
    cancelled = 'Cancelled: nothing was changed.'
    created = 'Certificate created: {0} (thumbprint {1}), expires {2}. Private key not exportable.'
    reused = 'Reusing certificate {0} (thumbprint {1}), expires {2}.'
    trusted = 'This DC trusts its own certificate (on this server only).'
    renewed = 'LDAPS: the DC was asked to load the certificate (renewServerCertificate), no reboot.'
    renewFail = 'ldifde could not apply renewServerCertificate (code {0}). LDAPS will pick the certificate up in a few minutes or after a reboot.'
    verifying = 'Verifying LDAPS on {0}:636...'
    verifyOk = 'Verified: port 636 presents certificate {0}.'
    verifyOther = 'Port 636 presents ANOTHER certificate ({0}). It may take a few minutes to pick up the new one; otherwise restart the NTDS service or the server.'
    verifyNo = 'Could not verify LDAPS on port 636 ({0}). Check the firewall or wait a few minutes.'
    oldFound = 'There are {0} previous Gestor certificate(s) on this DC.'
    oldQ = 'Remove them? (so LDAPS does not pick an old one)'
    oldRemoved = 'Previous certificate removed: {0} (expired on {1}).'
    chainNote = 'The certificate was issued by a CA ({0}): paste that CA root certificate in the application (included in the report).'
    pemCopied = 'The PEM was copied to the clipboard.'
    done = 'Done.'
    report = 'Report: {0}'
    pemFile = 'Certificate (PEM): {0}'
    failed = 'ERROR: {0}. The report records what was done before the error.'
    rTitle = 'REPORT: DOMAIN CONTROLLER LDAPS CERTIFICATE'
    rDate = 'Date'; rBy = 'Run by'; rDomain = 'Domain'; rDc = 'Domain controller'; rNames = 'Names (SAN)'
    rThumb = 'Thumbprint (SHA-1)'; rSha256 = 'Thumbprint (SHA-256)'; rSerial = 'Serial number'; rFrom = 'Valid from'; rTo = 'Valid to'
    rIssuer = 'Issued by'; rCheck = 'Port 636 check'; rActions = 'Actions performed'; rResult = 'Result'; rOk = 'Completed'; rErr = 'With error'
    rApp = 'In the application (Active Directory → Connection)'
    rApp1 = 'Server: ldaps://{0}:636   (or ldaps://{1}, which points to every DC)'
    rApp2 = 'Trusted certificates: paste the PEM block below and the one of every other DC, one below the other.'
    rPem = 'PEM certificate (public: it does not contain the private key)'
    rRenew = 'Renew before'
    rRenewTxt = 'Run this script again on this DC a few weeks before and paste the new PEM in the application (the module Summary warns when it expires).'
    rUndo = 'To undo'
    rUndoTxt = 'Remove the certificate from the local computer Personal and Trusted Root stores (certlm.msc), or:'
  }
}[$Idioma]
function Say([string] $key, $arg = $null, [string] $color = 'Green') { Write-Host ($M[$key] -f $arg) -ForegroundColor $color }
$acts = New-Object System.Collections.Generic.List[string]
function Log([string] $text) { $acts.Add($text); Write-Host "  · $text" -ForegroundColor Green }
function YesNo([string] $q, [bool] $default = $true) {
  if ($Si) { return $default }
  $a = Read-Host "$q $(if ($default) { $M.yn } else { $M.ynNo })"
  if ([string]::IsNullOrWhiteSpace($a)) { return $default }
  $a = $a.Trim().ToLower()
  return $a.StartsWith($M.yes) -or $a.StartsWith('y') -or $a.StartsWith('s')
}
function ToPem($cert) { "-----BEGIN CERTIFICATE-----`r`n" + [Convert]::ToBase64String($cert.RawData, 'InsertLineBreaks') + "`r`n-----END CERTIFICATE-----" }
function Sha256($cert) { ([Security.Cryptography.SHA256]::Create().ComputeHash($cert.RawData) | ForEach-Object { $_.ToString('X2') }) -join ':' }
function IsSelfSigned($cert) { $cert.Subject -eq $cert.Issuer }
function SanOf($cert) {
  $ext = $cert.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.17' }
  if ($ext) { ($ext.Format($false) -split ',\s*' | ForEach-Object { ($_ -replace '^[^=:]+[=:]\s*', '').Trim() }) } else { @() }
}

# Certificado que presenta el puerto 636 (solo para comprobar; no se confia en el por esto).
# Certificate presented on port 636 (only to check it; it is not trusted because of this).
function PresentedCert([string] $hostName) {
  $tcp = New-Object Net.Sockets.TcpClient
  try {
    $iar = $tcp.BeginConnect($hostName, 636, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne(5000)) { throw 'timeout' }
    $tcp.EndConnect($iar)
    $script:seen = $null
    # Se copian los bytes dentro de la validacion: al cerrar la conexion el objeto deja de ser valido.
    # Bytes are copied inside the callback: the object becomes invalid once the connection closes.
    $cb = [Net.Security.RemoteCertificateValidationCallback] { param($s, $c, $ch, $e) if ($c) { $script:seen = [byte[]] $c.GetRawCertData() }; $true }
    $ssl = New-Object Net.Security.SslStream($tcp.GetStream(), $false, $cb)
    try { $ssl.AuthenticateAsClient($hostName, $null, [Security.Authentication.SslProtocols]::Tls12, $false) } catch { } finally { $ssl.Dispose() }
    if ($script:seen) { return New-Object Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList (, [byte[]] $script:seen) }
    throw 'sin certificado / no certificate'
  } finally { $tcp.Close() }
}

# ======================= deteccion / detection =======================
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw $M.notAdmin }
if ((Get-CimInstance Win32_ComputerSystem).DomainRole -lt 4) { throw $M.notDc }
Import-Module ActiveDirectory
$dom = Get-ADDomain
$fqdn = $(try { (Get-ADDomainController -Identity $env:COMPUTERNAME).HostName } catch { ([System.Net.Dns]::GetHostEntry($env:COMPUTERNAME)).HostName })
$names = @($fqdn, $dom.DNSRoot) + @($NombresExtra | Where-Object { $_ }) | Select-Object -Unique

Write-Host ''
Write-Host "=== $($M.title) ===" -ForegroundColor Cyan
Say 'domain' "$($dom.DNSRoot) ($($dom.DistinguishedName))" 'White'
Say 'dc' $fqdn 'White'
Say 'names' ($names -join ', ') 'White'
Write-Host ''

# Certificados de servidor vigentes para este DC / current server certificates for this DC
$now = Get-Date
$mine = @(Get-ChildItem -Path Cert:\LocalMachine\My | Where-Object {
    $_.NotAfter -gt $now -and $_.HasPrivateKey -and ($_.EnhancedKeyUsageList.ObjectId -contains $SERVER_AUTH -or -not $_.EnhancedKeyUsageList) -and
    ((SanOf $_) -contains $fqdn -or $_.Subject -match [regex]::Escape("CN=$fqdn"))
  } | Sort-Object NotAfter -Descending)
Write-Host ($M.existing -f $fqdn) -ForegroundColor Cyan
if ($mine.Count) { $mine | ForEach-Object { Write-Host ("  - {0} · {1} · {2:yyyy-MM-dd} · {3}" -f $_.Subject, $_.Issuer, $_.NotAfter, $_.Thumbprint) } } else { Write-Host $M.none -ForegroundColor Yellow }
Write-Host ''

$reuse = $null
$best = $mine | Where-Object { ($_.NotAfter - $now).TotalDays -gt 60 } | Select-Object -First 1
if ($best -and -not $Si -and (YesNo ($M.reuseQ -f $best.Subject, $best.NotAfter.ToString('yyyy-MM-dd')) $true)) { $reuse = $best }
if (-not $reuse -and -not $Si) {
  do { $y = Read-Host "$($M.yearsQ) [$Anios]"; if ([string]::IsNullOrWhiteSpace($y)) { $y = "$Anios" } } until ($y -match '^[1-5]$')
  $Anios = [int]$y
}

Write-Host ''
Write-Host "=== $($M.summary) ===" -ForegroundColor Cyan
Write-Host ("  {0}: {1}" -f $M.sAction, $(if ($reuse) { $M.aReuse } else { $M.aNew }))
Write-Host ("  {0}: {1}" -f $M.rNames, ($names -join ', '))
if (-not $reuse) { Write-Host ("  {0}: {1} {2}" -f $M.sValid, $Anios, $M.years) }
if (-not (YesNo $M.confirmQ $(if ($Si) { $true } else { $false }))) { Say 'cancelled' $null 'Yellow'; return }

# ======================= cambios / changes =======================
$cert = $null; $rootCa = $null; $check = ''; $errorText = $null
try {
  Write-Host ''
  if ($reuse) {
    $cert = $reuse
    Log ($M.reused -f $cert.Subject, $cert.Thumbprint, $cert.NotAfter.ToString('yyyy-MM-dd'))
  } else {
    $cert = New-SelfSignedCertificate -DnsName $names -CertStoreLocation Cert:\LocalMachine\My -Type SSLServerAuthentication `
      -KeyAlgorithm RSA -KeyLength 3072 -KeyExportPolicy NonExportable -HashAlgorithm SHA256 -NotAfter (Get-Date).AddYears($Anios) -FriendlyName $FRIENDLY
    Log ($M.created -f $cert.Subject, $cert.Thumbprint, $cert.NotAfter.ToString('yyyy-MM-dd'))
  }
  if (IsSelfSigned $cert) {
    # Que este DC confie en su propio certificado (solo en este servidor) / this DC trusts its own certificate (this server only)
    $tmp = Join-Path $env:TEMP ("ldaps-{0}.cer" -f $cert.Thumbprint)
    Export-Certificate -Cert $cert -FilePath $tmp | Out-Null
    Import-Certificate -FilePath $tmp -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
    [IO.File]::Delete($tmp)
    Log $M.trusted
  } else {
    # Emitido por una CA: la aplicacion necesita la raiz de esa CA / issued by a CA: the application needs that CA root
    $chain = New-Object Security.Cryptography.X509Certificates.X509Chain
    [void] $chain.Build($cert)
    $rootCa = $chain.ChainElements[$chain.ChainElements.Count - 1].Certificate
    Say 'chainNote' $rootCa.Subject 'Yellow'
  }
  # Activar LDAPS sin reiniciar / enable LDAPS without a reboot
  $ldf = Join-Path $env:TEMP 'gestor-renew.ldf'
  [IO.File]::WriteAllText($ldf, "dn:`r`nchangetype: modify`r`nadd: renewServerCertificate`r`nrenewServerCertificate: 1`r`n-`r`n", [Text.Encoding]::ASCII)
  & ldifde.exe -i -f $ldf | Out-Null
  $code = $LASTEXITCODE
  [IO.File]::Delete($ldf)
  if ($code -eq 0) { Log $M.renewed } else { Say 'renewFail' $code 'Yellow'; $acts.Add(($M.renewFail -f $code)) }

  # Verificar / verify (hasta ~30 s / up to ~30 s)
  Say 'verifying' $fqdn 'White'
  $presented = $null; $lastErr = ''
  for ($n = 0; $n -lt 6; $n++) {
    try { $presented = PresentedCert $fqdn; if ($presented.Thumbprint -eq $cert.Thumbprint) { break } } catch { $lastErr = $_.Exception.Message }
    Start-Sleep -Seconds 5
  }
  if ($presented -and $presented.Thumbprint -eq $cert.Thumbprint) { $check = $M.verifyOk -f $cert.Thumbprint; Log $check }
  elseif ($presented) { $check = $M.verifyOther -f $presented.Thumbprint; Write-Host "  $check" -ForegroundColor Yellow }
  else { $check = $M.verifyNo -f $lastErr; Write-Host "  $check" -ForegroundColor Yellow }

  # Certificados anteriores del Gestor / previous Gestor certificates
  $old = @(Get-ChildItem -Path Cert:\LocalMachine\My | Where-Object { $_.FriendlyName -eq $FRIENDLY -and $_.Thumbprint -ne $cert.Thumbprint })
  if ($old.Count) {
    Say 'oldFound' $old.Count 'Yellow'
    if (YesNo $M.oldQ $true) {
      foreach ($o in $old) {
        foreach ($store in 'My', 'Root') {
          $p = "Cert:\LocalMachine\$store\$($o.Thumbprint)"
          if (Test-Path $p) { Remove-Item -Path $p }
        }
        Log ($M.oldRemoved -f $o.Thumbprint, $o.NotAfter.ToString('yyyy-MM-dd'))
      }
    }
  }
} catch {
  $errorText = $_.Exception.Message
  Say 'failed' $errorText 'Red'
}

# ======================= informe / report =======================
$dir = $(if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path })
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
if (-not $Informe) { $Informe = Join-Path $dir ("Gestor-LDAPS-{0}-{1}.txt" -f $env:COMPUTERNAME, $stamp) }
$pemCert = $(if ($rootCa) { $rootCa } else { $cert })
$pem = $(if ($pemCert) { ToPem $pemCert } else { '' })
$lines = @(
  $M.rTitle
  ('=' * $M.rTitle.Length)
  "$($M.rDate): $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
  "$($M.rBy): $env:USERDOMAIN\$env:USERNAME"
  "$($M.rDomain): $($dom.DNSRoot) ($($dom.DistinguishedName))"
  "$($M.rDc): $fqdn"
  "$($M.rResult): $(if ($errorText) { "$($M.rErr): $errorText" } else { $M.rOk })"
)
if ($cert) {
  $lines += @(
    "$($M.rNames): $((SanOf $cert) -join ', ')"
    "$($M.rIssuer): $($cert.Issuer)"
    "$($M.rFrom): $($cert.NotBefore.ToString('yyyy-MM-dd HH:mm'))"
    "$($M.rTo): $($cert.NotAfter.ToString('yyyy-MM-dd HH:mm'))"
    "$($M.rThumb): $($cert.Thumbprint)"
    "$($M.rSha256): $(Sha256 $cert)"
    "$($M.rSerial): $($cert.SerialNumber)"
    "$($M.rCheck): $check"
    ''
    "$($M.rRenew): $($cert.NotAfter.AddDays(-30).ToString('yyyy-MM-dd'))"
    "  $($M.rRenewTxt)"
  )
}
$lines += ''
$lines += "$($M.rActions):"
$lines += $(if ($acts.Count) { $acts | ForEach-Object { "  - $_" } } else { '  —' })
$lines += ''
$lines += "$($M.rApp):"
$lines += '  ' + ($M.rApp1 -f $fqdn.ToLower(), $dom.DNSRoot)
$lines += '  ' + $M.rApp2
if ($rootCa) { $lines += '  ' + ($M.chainNote -f $rootCa.Subject) }
if ($cert) {
  $lines += ''
  $lines += "$($M.rUndo):"
  $lines += '  ' + $M.rUndoTxt
  $lines += "    Get-ChildItem Cert:\LocalMachine\My\$($cert.Thumbprint), Cert:\LocalMachine\Root\$($cert.Thumbprint) -ErrorAction SilentlyContinue | Remove-Item"
}
if ($pem) {
  $lines += ''
  $lines += "$($M.rPem) · $($pemCert.Subject):"
  $lines += $pem
}
[IO.File]::WriteAllLines($Informe, [string[]] $lines, (New-Object Text.UTF8Encoding($true)))
$pemPath = $null
if ($pem) {
  $pemPath = Join-Path $dir ("Gestor-LDAPS-{0}.pem" -f $env:COMPUTERNAME)
  [IO.File]::WriteAllText($pemPath, $pem + "`r`n", (New-Object Text.UTF8Encoding($false)))
  try { $pem | Set-Clipboard; Say 'pemCopied' $null 'Gray' } catch { }
}

Write-Host ''
if (-not $errorText) { Say 'done' $null 'Cyan' }
Say 'report' $Informe 'Cyan'
if ($pemPath) { Say 'pemFile' $pemPath 'Cyan'; Write-Host ''; Write-Host $pem }
