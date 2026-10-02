// Lectores de recibos de operadoras. Cada formato (operadora + tipo de
// archivo) es un modulo con detect() y parse(); para sumar una operadora
// nueva se agrega su modulo a la lista, sin tocar el resto.
//
// Todos devuelven lo mismo: { operadora, origen, recibo_nro, cuenta,
// razon_social, ruc, fecha_emision, periodo_inicio, periodo_fin,
// fecha_vencimiento, total_pagar, saldo_anterior, lines[], charges[] }.
const path = require('path');
const ExcelJS = require('exceljs');
const { BillFormatError } = require('./common');
const { extractLines } = require('./pdfText');

const EXCEL = [require('./entelExcel')];
const PDF = [require('./entelPdf')];

const supported = () => [...EXCEL, ...PDF].map((p) => p.name).join(', ');

async function parseBill(buffer, filename) {
  const ext = path.extname(filename || '').toLowerCase();
  if (ext === '.xlsx') {
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(buffer);
    } catch (err) {
      throw new BillFormatError('No se pudo abrir el Excel: el archivo está dañado o no es un .xlsx.');
    }
    const parser = EXCEL.find((p) => p.detect(workbook));
    if (!parser) throw new BillFormatError(`No se reconoce el formato de este Excel. Formatos admitidos: ${supported()}.`);
    return parser.parse(workbook);
  }
  if (ext === '.pdf') {
    const lines = await extractLines(buffer);
    if (!lines.length) throw new BillFormatError('El PDF no tiene texto (parece una imagen escaneada): suba el PDF original de la operadora o su Excel.');
    const parser = PDF.find((p) => p.detect(lines));
    if (!parser) throw new BillFormatError(`No se reconoce el formato de este PDF. Formatos admitidos: ${supported()}.`);
    return parser.parse(lines);
  }
  throw new BillFormatError('Suba el recibo en PDF o en Excel (.xlsx).');
}

module.exports = { parseBill, BillFormatError, supported };
