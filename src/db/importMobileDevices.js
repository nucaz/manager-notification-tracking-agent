// Importa celulares desde un Excel/CSV por linea de comandos, con las mismas
// reglas que la pantalla /celulares/importar (ver mobileDeviceService).
// Lee la PRIMERA hoja del archivo. Util para cargas grandes o para probar un
// archivo sin pasar por el navegador.
//
// Uso:
//   npm run import:celulares -- ruta/al/archivo.xlsx --dry-run   (solo valida, no guarda nada)
//   npm run import:celulares -- ruta/al/archivo.xlsx             (importa de verdad)
//   --user-id N   usuario que figura como creador (por defecto, el primer admin)
const fs = require('fs');
const path = require('path');
const pool = require('./pool');
const importService = require('../services/importService');
const mobileDeviceService = require('../services/mobileDeviceService');

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const dryRun = args.includes('--dry-run');
  const userIdArg = args.indexOf('--user-id');

  if (!file) {
    console.error('Uso: npm run import:celulares -- archivo.xlsx [--dry-run] [--user-id N]');
    process.exit(1);
  }

  let userId = userIdArg >= 0 ? parseInt(args[userIdArg + 1], 10) : null;
  if (!userId) {
    const [[admin]] = await pool.query('SELECT id FROM users WHERE role = "admin" ORDER BY id LIMIT 1');
    userId = admin ? admin.id : null;
  }

  const rows = await importService.parseSpreadsheet(fs.readFileSync(file), path.basename(file));
  console.log(`${dryRun ? '[SIMULACION] ' : ''}Archivo: ${path.basename(file)} - ${rows.length} fila(s) de datos`);

  const { imported, errors, byStatus } = await mobileDeviceService.importDevices(rows, userId, { dryRun });

  console.log(`${dryRun ? 'Se importarían' : 'Importados'}: ${imported}`);
  console.log('Por estado:', JSON.stringify(byStatus));
  console.log(`Con error u omitidos: ${errors.length}`);
  errors.slice(0, 60).forEach((e) => console.log(`  fila ${e.row}: ${e.message}`));
  if (errors.length > 60) console.log(`  ... y ${errors.length - 60} más`);

  process.exit(0);
}

main().catch((err) => {
  console.error('Error al importar:', err.message);
  process.exit(1);
});
