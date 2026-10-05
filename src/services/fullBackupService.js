// Respaldo COMPLETO de la aplicacion (para volver a levantarla en otro
// servidor si este se pierde) y su restauracion.
//
// Un solo archivo respaldo_aplicacion_<fecha>.tar.gz con:
//   basedatos.sql.gz      dump completo de MariaDB (mariadb-dump --single-transaction)
//   archivos/...          adjuntos, facturas, recibos y diagramas (uploads/, sin
//                         las copias previas a restaurar)
//   secretos.env.enc      los .env de la aplicacion y de DevOps Sidecar, CIFRADOS
//                         con la contrasena de recuperacion (si esta configurada).
//                         Sin ellos, las API keys y tokens guardados en la base
//                         no se pueden descifrar (CREDENTIALS_ENC_KEY).
//                         Formato de OpenSSL: se abre sin esta aplicacion con
//                         openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256
//   manifest.json         version, migraciones, cantidades y SHA-256 de cada archivo
//   RESTAURAR.txt         los pasos para recuperar todo en un servidor nuevo
//
// Lo genera a pedido DevOps Sidecar (trabajo de respaldo programado, que
// lo envia a OneDrive, Google Drive, SMB, S3...; ver src/routes/internalBackup.js)
// o un administrador desde Configuracion.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn, execFile } = require('child_process');
const { pipeline } = require('stream/promises');
const { TarArchive } = require('archiver');
const pool = require('../db/pool');
const env = require('../config/env');
const settingsService = require('./settingsService');
const backupService = require('./backupService');
const { UPLOAD_ROOT } = require('./uploadService');

const FORMAT = 1;
const PBKDF2_ITER = 200000;
const SKIP_DIRS = new Set(['pre_restore_backups']);
const ROOT = path.join(__dirname, '..', '..');
const COUNT_TABLES = ['users', 'software_licenses', 'domains', 'isp_contracts', 'servers', 'certificates', 'mobile_devices', 'mobile_lines',
  'employees', 'mobile_bills', 'attachments', 'network_diagrams', 'audit_log'];
// Variables que van al archivo de secretos aunque no esten en .env.example.
const EXTRA_ENV = ['DB_ROOT_PASSWORD', 'ASSISTANT_DB_USER', 'ASSISTANT_DB_PASSWORD', 'COMPOSE_FILE', 'APP_PUBLISH', 'SIDECAR_PUBLISH', 'SIDECAR_PUBLIC_URL', 'TZ'];

const sha256File = async (file) => {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
};
const keyFingerprint = (key) => (key ? crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 12) : null);
const stampNow = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);

// --- Cifrado compatible con `openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -md sha256`
function encryptOpenssl(plain, password) {
  const salt = crypto.randomBytes(8);
  const kiv = crypto.pbkdf2Sync(password, salt, PBKDF2_ITER, 48, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-cbc', kiv.subarray(0, 32), kiv.subarray(32));
  return Buffer.concat([Buffer.from('Salted__'), salt, cipher.update(plain), cipher.final()]);
}

function decryptOpenssl(data, password) {
  if (data.subarray(0, 8).toString() !== 'Salted__') throw new Error('El archivo de secretos no tiene el formato esperado.');
  const kiv = crypto.pbkdf2Sync(password, data.subarray(8, 16), PBKDF2_ITER, 48, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-cbc', kiv.subarray(0, 32), kiv.subarray(32));
  try {
    return Buffer.concat([decipher.update(data.subarray(16)), decipher.final()]);
  } catch (_) {
    throw new Error('Contraseña de recuperación incorrecta.');
  }
}

// Variables de entorno de esta aplicacion que forman su .env.
function appEnvKeys() {
  const keys = new Set(EXTRA_ENV);
  try {
    const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    for (const m of example.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)) keys.add(m[1]);
  } catch (_) { /* sin .env.example: solo las extra */ }
  return [...keys].filter((k) => process.env[k] !== undefined).sort();
}

function envText(title, vars) {
  const lines = Object.entries(vars).filter(([k]) => /^[A-Z][A-Z0-9_]*$/.test(k))
    .map(([k, v]) => `${k}=${String(v).replace(/\r?\n/g, ' ')}`);
  return `# === ${title} ===\n${lines.join('\n')}\n`;
}

async function recoveryPassword() {
  const s = await settingsService.getAll();
  return s.backup_recovery_password || '';
}

function dumpTo(file) {
  return new Promise((resolve, reject) => {
    const dump = spawn('mariadb-dump', ['-h', env.db.host, '-P', String(env.db.port), '-u', env.db.user, '--routines', '--triggers',
      '--single-transaction', '--default-character-set=utf8mb4', env.db.database], { env: { ...process.env, MYSQL_PWD: env.db.password } });
    let stderr = '';
    dump.stderr.on('data', (c) => { stderr += c.toString(); });
    dump.on('error', (err) => reject(new Error(`No se pudo ejecutar mariadb-dump: ${err.message}`)));
    const done = pipeline(dump.stdout, zlib.createGzip({ level: 9 }), fs.createWriteStream(file));
    dump.on('close', (code) => {
      done.then(() => (code === 0 ? resolve() : reject(new Error(stderr.trim().slice(0, 500) || `mariadb-dump terminó con código ${code}`))), reject);
    });
  });
}

function listFiles(dir, rel = '') {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!rel && SKIP_DIRS.has(e.name)) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(path.join(dir, e.name), r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

const RESTAURAR = (m) => `RESTAURAR LA APLICACION "Gestión de Licencias, Dominios y Contratos"
Respaldo del ${m.creado} (servidor ${m.servidor}). Formato ${m.formato}.

Contenido
  basedatos.sql.gz   base de datos completa (MariaDB)
  archivos/          adjuntos, facturas, recibos y diagramas
  secretos.env.enc   ${m.secretos.incluidos ? 'los .env de la aplicacion y de DevOps Sidecar, cifrados' : 'NO INCLUIDO: no habia contrasena de recuperacion configurada. Use su copia del .env.'}
  manifest.json      SHA-256 de cada archivo, migraciones y cantidades

Recuperar en un servidor nuevo
1. Instale la aplicacion (git clone del repositorio + install-ubuntu.sh, o docker compose).
2. Recupere los .env ANTES de iniciar:
     openssl enc -d -aes-256-cbc -pbkdf2 -iter ${PBKDF2_ITER} -md sha256 -in secretos.env.enc -out secretos.env
   (pide la contrasena de recuperacion). El archivo trae dos secciones: copie la
   primera en glpi-licencias-app/.env y la segunda en devops-sidecar/.env.
   Es imprescindible el mismo CREDENTIALS_ENC_KEY: con otro, las API keys y
   tokens guardados en la base no se pueden leer (huella de la clave de este
   respaldo: ${m.clave_cifrado_huella || 'sin clave'}).
3. Levante los contenedores (docker compose up -d) y espere a que la base este lista.
4. Restaure TODO de una de estas formas:
   a) DevOps Sidecar > Respaldos > Restaurar: agregue de nuevo el destino
      externo, explore, elija este punto y "Restaurar en la aplicacion".
   b) Aplicacion > Configuracion > Restaurar respaldo completo: suba este .tar.gz.
   c) A mano:
        gunzip -c basedatos.sql.gz | docker exec -i licencias_db sh -c 'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" ${env.db.database}'
        docker cp archivos/. licencias_app:/app/uploads/
        docker exec licencias_app npm run migrate
5. Entre con un usuario administrador y revise Configuracion (pruebe GLPI, correo, IA).
`;

// Genera el respaldo en un archivo temporal. sidecarEnv: variables de
// DevOps Sidecar (las manda el propio sidecar) para el archivo de secretos.
//   -> { file, name, size, sha256, manifest, cleanup() }
async function buildArchive({ sidecarEnv = null } = {}) {
  const stamp = stampNow();
  const name = `respaldo_aplicacion_${stamp}.tar.gz`;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'respaldo-'));
  const cleanup = () => fs.rmSync(work, { recursive: true, force: true });
  try {
    const sqlFile = path.join(work, 'basedatos.sql.gz');
    await dumpTo(sqlFile);
    const files = listFiles(UPLOAD_ROOT);
    const fileEntries = [];
    let filesBytes = 0;
    for (const rel of files) {
      const abs = path.join(UPLOAD_ROOT, rel);
      const size = fs.statSync(abs).size;
      filesBytes += size;
      fileEntries.push({ ruta: `archivos/${rel}`, bytes: size, sha256: await sha256File(abs) });
    }
    const password = await recoveryPassword();
    let secrets = null;
    if (password) {
      const appVars = Object.fromEntries(appEnvKeys().map((k) => [k, process.env[k]]));
      let text = envText('glpi-licencias-app/.env (aplicacion principal)', appVars);
      if (sidecarEnv && typeof sidecarEnv === 'object') text += `\n${envText('devops-sidecar/.env (DevOps Sidecar)', sidecarEnv)}`;
      secrets = encryptOpenssl(Buffer.from(text, 'utf8'), password);
      fs.writeFileSync(path.join(work, 'secretos.env.enc'), secrets, { mode: 0o600 });
    }
    const [migs] = await pool.query('SELECT name FROM schema_migrations ORDER BY name');
    const counts = {};
    for (const t of COUNT_TABLES) {
      try { const [[r]] = await pool.query('SELECT COUNT(*) AS n FROM ??', [t]); counts[t] = Number(r.n); } catch (_) { counts[t] = null; }
    }
    let version = '';
    try { version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch (_) { /* sin version */ }
    const manifest = {
      formato: FORMAT, aplicacion: 'glpi-licencias-app', version, creado: new Date().toISOString(), servidor: os.hostname(),
      base: { nombre: env.db.database, archivo: 'basedatos.sql.gz', bytes: fs.statSync(sqlFile).size, sha256: await sha256File(sqlFile) },
      archivos: { cantidad: fileEntries.length, bytes: filesBytes, lista: fileEntries },
      secretos: secrets ? { incluidos: true, archivo: 'secretos.env.enc', sha256: crypto.createHash('sha256').update(secrets).digest('hex'),
        sidecar: !!sidecarEnv, abrir: `openssl enc -d -aes-256-cbc -pbkdf2 -iter ${PBKDF2_ITER} -md sha256 -in secretos.env.enc -out secretos.env` }
        : { incluidos: false, motivo: 'Configure la contraseña de recuperación en Configuración > Respaldo.' },
      clave_cifrado_huella: keyFingerprint(env.credentialsEncKey),
      migraciones: migs.map((m) => m.name),
      cantidades: counts,
    };
    fs.writeFileSync(path.join(work, 'manifest.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(work, 'RESTAURAR.txt'), RESTAURAR(manifest));

    const out = path.join(work, name);
    const archive = new TarArchive({ gzip: true, gzipOptions: { level: 6 } });
    const written = pipeline(archive, fs.createWriteStream(out));
    archive.file(path.join(work, 'RESTAURAR.txt'), { name: 'RESTAURAR.txt' });
    archive.file(path.join(work, 'manifest.json'), { name: 'manifest.json' });
    archive.file(sqlFile, { name: 'basedatos.sql.gz' });
    if (secrets) archive.file(path.join(work, 'secretos.env.enc'), { name: 'secretos.env.enc' });
    for (const rel of files) archive.file(path.join(UPLOAD_ROOT, rel), { name: `archivos/${rel}` });
    await archive.finalize();
    await written;
    return { file: out, name, size: fs.statSync(out).size, sha256: await sha256File(out), manifest, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).toString().trim().slice(0, 500)));
      else resolve(stdout.toString());
    });
  });
}

// Revisa un respaldo sin aplicarlo: nombres seguros, manifest y SHA-256.
//   -> { dir, manifest, warnings, cleanup() }
async function inspectArchive(archiveFile) {
  const { stdout, stderr } = await new Promise((resolve, reject) => {
    execFile('tar', ['-tzvf', archiveFile], { maxBuffer: 64 * 1024 * 1024 }, (err, out, errOut) => (err
      ? reject(new Error(`No se pudo leer el respaldo (¿es un .tar.gz?): ${String(errOut || err.message).trim().slice(0, 200)}`))
      : resolve({ stdout: out.toString(), stderr: errOut.toString() })));
  });
  // tar avisa cuando quita "../" o "/" de un nombre: un respaldo propio nunca los trae.
  if (/removing leading/i.test(stderr)) throw new Error('Ruta no permitida dentro del respaldo (sale de su carpeta).');
  const listing = stdout.split('\n').filter(Boolean);
  for (const line of listing) {
    const entry = line.trim().split(/\s+/).slice(5).join(' ');
    if (!/^[-d]/.test(line.trim())) throw new Error('El respaldo trae enlaces o archivos especiales: no se acepta.');
    if (entry.startsWith('/') || entry.split('/').includes('..')) throw new Error(`Ruta no permitida dentro del respaldo: ${entry}`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restaurar-'));
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  try {
    await run('tar', ['-xzf', archiveFile, '-C', dir]);
    const mfFile = path.join(dir, 'manifest.json');
    if (!fs.existsSync(mfFile)) throw new Error('No es un respaldo completo de esta aplicación (falta manifest.json).');
    const manifest = JSON.parse(fs.readFileSync(mfFile, 'utf8'));
    if (manifest.aplicacion !== 'glpi-licencias-app') throw new Error('El respaldo es de otra aplicación.');
    if (manifest.formato > FORMAT) throw new Error(`El respaldo usa un formato más nuevo (${manifest.formato}); actualice la aplicación primero.`);
    const sql = path.join(dir, 'basedatos.sql.gz');
    if (!fs.existsSync(sql) || await sha256File(sql) !== manifest.base.sha256) throw new Error('La copia de la base está dañada (SHA-256 distinto).');
    for (const f of manifest.archivos.lista || []) {
      const abs = path.join(dir, f.ruta);
      if (!fs.existsSync(abs) || await sha256File(abs) !== f.sha256) throw new Error(`Archivo dañado o faltante en el respaldo: ${f.ruta}`);
    }
    const warnings = [];
    const fp = keyFingerprint(env.credentialsEncKey);
    if (manifest.clave_cifrado_huella && manifest.clave_cifrado_huella !== fp) {
      warnings.push('Este servidor tiene otro CREDENTIALS_ENC_KEY que el del respaldo: las API keys y tokens guardados no se podrán leer hasta poner en el .env el del respaldo (está en secretos.env.enc).');
    }
    if (!manifest.secretos || !manifest.secretos.incluidos) warnings.push('El respaldo no trae los .env cifrados (no había contraseña de recuperación).');
    return { dir, manifest, warnings, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

// Restaura base y archivos. DESTRUCTIVO: antes guarda una copia de la base
// actual (uploads/pre_restore_backups). Despues aplica las migraciones que
// falten (un respaldo de una version anterior queda al dia).
async function restoreArchive(archiveFile) {
  const { dir, manifest, warnings, cleanup } = await inspectArchive(archiveFile);
  try {
    const sql = zlib.gunzipSync(fs.readFileSync(path.join(dir, 'basedatos.sql.gz')));
    const { snapshotFile } = await backupService.restoreFromSqlBuffer(sql);
    let restored = 0;
    for (const f of manifest.archivos.lista || []) {
      const rel = f.ruta.replace(/^archivos\//, '');
      const target = path.join(UPLOAD_ROOT, rel);
      if (!target.startsWith(UPLOAD_ROOT + path.sep)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(dir, f.ruta), target);
      restored += 1;
    }
    let migrateLog = '';
    try { migrateLog = await run('node', [path.join(ROOT, 'src', 'db', 'migrate.js')], { cwd: ROOT }); } catch (err) {
      warnings.push(`Las migraciones fallaron después de restaurar: ${err.message}. Ejecute "npm run migrate".`);
    }
    const applied = (migrateLog.match(/\[aplicando\]/g) || []).length;
    return { manifest, warnings, snapshotFile, files: restored, migrationsApplied: applied };
  } finally {
    cleanup();
  }
}

module.exports = { buildArchive, inspectArchive, restoreArchive, encryptOpenssl, decryptOpenssl, keyFingerprint, PBKDF2_ITER };
