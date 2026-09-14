// Respaldo y restauracion de la base de datos desde la UI (Configuracion).
// Reutiliza los binarios reales de MariaDB (mariadb-dump / mariadb,
// instalados en el Dockerfile) en vez de reimplementar el dump/restore a
// mano en JS - son las herramientas ya probadas para esto, y evitan tener
// que resolver a mano el orden de tablas/foreign keys/escapado de valores.
//
// Los comandos se ejecutan con execFile/spawn (arreglo de argumentos, sin
// shell), nunca con exec sobre un string armado a mano - asi no hay riesgo
// de inyeccion de comandos aunque el nombre de la base de datos viniera de
// configuracion. La contrasena se pasa por la variable de entorno MYSQL_PWD
// en vez de como argumento -p, para que no quede visible en la lista de
// procesos del contenedor.
const { spawn, execFile } = require('child_process');
const { ZipArchive } = require('archiver');
const env = require('../config/env');
const { UPLOAD_ROOT } = require('./uploadService');

function mysqlEnv() {
  return { ...process.env, MYSQL_PWD: env.db.password };
}

function checkBinaryAvailable(bin) {
  return new Promise((resolve, reject) => {
    execFile(bin, ['--version'], (err) => {
      if (err) {
        reject(new Error(`No se encontró el binario "${bin}" en el servidor. ¿Falta instalar mariadb-client en la imagen?`));
      } else {
        resolve();
      }
    });
  });
}

// Arma un .zip con el dump completo de la base de datos (backup.sql) mas
// los archivos adjuntos/diagramas de red (carpeta uploads/), y lo escribe
// directo en la respuesta HTTP (sin guardar nada temporal en disco).
async function streamBackupZip(res, filename) {
  await checkBinaryAvailable('mariadb-dump');

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const archive = new ZipArchive({ zlib: { level: 9 } });
  archive.on('warning', (err) => console.error('[backup] Advertencia al armar el zip:', err.message));
  archive.on('error', (err) => {
    console.error('[backup] Error armando el zip:', err.message);
    res.destroy(err);
  });
  archive.pipe(res);

  const dump = spawn(
    'mariadb-dump',
    ['-h', env.db.host, '-P', String(env.db.port), '-u', env.db.user, '--routines', '--triggers', '--single-transaction', env.db.database],
    { env: mysqlEnv() }
  );

  let dumpError = '';
  dump.stderr.on('data', (chunk) => { dumpError += chunk.toString(); });
  dump.on('error', (err) => archive.emit('error', new Error(`No se pudo ejecutar mariadb-dump: ${err.message}`)));
  dump.on('close', (code) => {
    if (code !== 0) {
      console.error(`[backup] mariadb-dump terminó con código ${code}: ${dumpError}`);
    }
  });

  archive.append(dump.stdout, { name: 'backup.sql' });
  archive.directory(UPLOAD_ROOT, 'uploads');
  await archive.finalize();
}

// Ejecuta un dump .sql (por ejemplo, el que genera streamBackupZip o el
// que ya usaba el procedimiento por terminal) contra la base de datos
// actual. Es DESTRUCTIVO: el propio dump trae DROP TABLE/CREATE TABLE,
// asi que reemplaza el contenido de las tablas existentes.
async function restoreFromSqlBuffer(sqlBuffer) {
  await checkBinaryAvailable('mariadb');
  return new Promise((resolve, reject) => {
    const restore = spawn(
      'mariadb',
      ['-h', env.db.host, '-P', String(env.db.port), '-u', env.db.user, env.db.database],
      { env: mysqlEnv() }
    );

    let stderr = '';
    restore.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    restore.on('error', (err) => reject(new Error(`No se pudo ejecutar mariadb: ${err.message}`)));
    restore.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(stderr.trim() || `mariadb terminó con código ${code}`));
    });

    restore.stdin.on('error', () => {}); // evita crash si el proceso ya cerro stdin al fallar
    restore.stdin.write(sqlBuffer);
    restore.stdin.end();
  });
}

module.exports = { streamBackupZip, restoreFromSqlBuffer };
