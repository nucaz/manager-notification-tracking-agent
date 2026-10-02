// Texto de un PDF, reconstruido renglon por renglon.
//
// pdf.js entrega fragmentos sueltos con su posicion; aqui se agrupan los que
// comparten altura y se ordenan de izquierda a derecha, que es como se leen
// las tablas de un recibo. No interpreta nada: eso lo hace cada lector.
const { BillFormatError } = require('./common');

const MAX_PAGES = 1500;
let pdfjs = null;

async function extractLines(buffer) {
  // pdfjs-dist se distribuye solo como modulo ES: se carga con import().
  if (!pdfjs) pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(buffer), verbosity: 0, isEvalSupported: false, disableFontFace: true, useSystemFonts: false,
    }).promise;
  } catch (err) {
    throw new BillFormatError(`No se pudo abrir el PDF (${err.name === 'PasswordException' ? 'está protegido con contraseña' : 'el archivo está dañado o no es un PDF'}).`);
  }
  try {
    if (doc.numPages > MAX_PAGES) throw new BillFormatError(`El PDF tiene ${doc.numPages} páginas; el máximo es ${MAX_PAGES}.`);
    const lines = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const rows = [];
      for (const item of content.items) {
        if (!item.str || !item.str.trim()) continue;
        const y = item.transform[5];
        let row = rows.find((r) => Math.abs(r.y - y) <= 2);
        if (!row) { row = { y, items: [] }; rows.push(row); }
        row.items.push({ x: item.transform[4], s: item.str });
      }
      rows.sort((a, b) => b.y - a.y).forEach((row) => {
        lines.push(row.items.sort((a, b) => a.x - b.x).map((i) => i.s).join(' ').replace(/\s+/g, ' ').trim());
      });
      page.cleanup();
    }
    return lines;
  } finally {
    await doc.destroy();
  }
}

module.exports = { extractLines };
