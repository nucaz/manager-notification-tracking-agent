// Importacion masiva de registros existentes desde un archivo CSV o Excel
// (.xlsx), reutilizado por los routers de licencias, dominios, ISP,
// servidores y certificados. Se usa `exceljs` (activamente mantenido) en
// vez de `xlsx`/SheetJS: la ultima version de "xlsx" publicada en el
// registro de npm tiene vulnerabilidades altas (prototype pollution y
// ReDoS) sin fix disponible ahi, y este archivo lo sube el usuario.
const ExcelJS = require('exceljs');
const { Readable } = require('stream');
const pool = require('../db/pool');

function bufferToStream(buffer) {
  const stream = new Readable();
  stream.push(buffer);
  stream.push(null);
  return stream;
}

function worksheetToObjects(worksheet) {
  const rows = [];
  let headers = [];
  worksheet.eachRow((row, rowNumber) => {
    const values = row.values; // array 1-indexado; values[0] no se usa
    if (rowNumber === 1) {
      headers = values.slice(1).map((h) => (h === undefined || h === null ? '' : String(h).trim()));
      return;
    }
    const obj = {};
    headers.forEach((h, idx) => {
      if (!h) return;
      const cell = values[idx + 1];
      obj[h] = cell === undefined || cell === null ? '' : cell;
    });
    rows.push(obj);
  });
  return rows;
}

// originalName decide si se lee como CSV o como XLSX (mismo criterio que
// el filtro de extensiones de multer en uploadService.js).
async function parseSpreadsheet(buffer, originalName) {
  const workbook = new ExcelJS.Workbook();
  const isCsv = /\.csv$/i.test(originalName || '');

  if (isCsv) {
    const worksheet = await workbook.csv.read(bufferToStream(buffer));
    return worksheetToObjects(worksheet);
  }

  await workbook.xlsx.load(buffer);
  const worksheet = workbook.worksheets[0];
  return worksheetToObjects(worksheet);
}

// Acepta AAAA-MM-DD o DD/MM/AAAA (o un objeto Date si la celda de Excel
// ya tenia formato de fecha). Devuelve undefined si el valor no es una
// fecha valida.
function formatDateValue(value) {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  const str = String(value).trim();
  if (!str) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const m = str.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) {
    const [, d, mo, y] = m;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return undefined;
}

function parseBool(value) {
  const str = String(value).trim().toLowerCase();
  return ['si', 'sí', 'yes', 'true', '1'].includes(str) ? 1 : 0;
}

// columns: [{ header, field, required, type: 'text'|'date'|'bool'|'number' }]
async function importRows(rows, columns, { table, userId }) {
  const errors = [];
  let importedCount = 0;

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 2; // fila 1 es el encabezado
    const row = rows[i];
    const data = {};
    let rowError = null;

    for (const col of columns) {
      const raw = row[col.header];

      if (raw === undefined || raw === '') {
        if (col.required) {
          rowError = `Falta el campo obligatorio "${col.header}"`;
          break;
        }
        data[col.field] = null;
        continue;
      }

      if (col.type === 'date') {
        const formatted = formatDateValue(raw);
        if (formatted === undefined) {
          rowError = `Fecha inválida en "${col.header}" (usa AAAA-MM-DD o DD/MM/AAAA)`;
          break;
        }
        data[col.field] = formatted;
      } else if (col.type === 'bool') {
        data[col.field] = parseBool(raw);
      } else if (col.type === 'number') {
        const num = parseFloat(raw);
        if (Number.isNaN(num)) {
          rowError = `Valor numérico inválido en "${col.header}"`;
          break;
        }
        data[col.field] = num;
      } else {
        data[col.field] = String(raw).trim();
      }
    }

    if (rowError) {
      errors.push({ row: rowNum, message: rowError });
      continue;
    }

    try {
      const cols = Object.keys(data);
      const values = Object.values(data);
      const placeholders = cols.map(() => '?').join(', ');
      await pool.query(
        `INSERT INTO ${table} (${cols.join(', ')}, created_by) VALUES (${placeholders}, ?)`,
        [...values, userId]
      );
      importedCount += 1;
    } catch (err) {
      errors.push({ row: rowNum, message: err.message });
    }
  }

  return { imported: importedCount, errors };
}

async function buildTemplateBuffer(columns) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Plantilla');
  worksheet.addRow(columns.map((c) => c.header));
  return workbook.xlsx.writeBuffer();
}

module.exports = { parseSpreadsheet, importRows, buildTemplateBuffer };
