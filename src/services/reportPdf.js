// Reporte imprimible en PDF (A4 vertical): una fila por registro, con su
// codigo de barras al costado y una casilla para marcar a mano, pensado
// para verificar el inventario fisico contra lo que dice la aplicacion.
const PDFDocument = require('pdfkit');
const { code128 } = require('./barcode');

const MARGIN = 28;
const ROW = 27;          // alto de cada fila
const HEAD = 18;         // alto de la fila de encabezados
const NUM_W = 24;        // columna "N.º"
const BARCODE_MAX = 142; // la columna del codigo de barras se ajusta al codigo mas largo, hasta este ancho;
                         // un codigo mas largo se dibuja con barras mas finas para caber
const MODULE = 0.85;     // ancho de la barra mas fina, en puntos (0,3 mm: lo lee cualquier lector)
const CHECK_W = 44;
const FOOTER = 20;
const EXTRA = String.fromCharCode(8211, 8212, 8216, 8217, 8220, 8221, 8226, 8230, 8364); // lo que Helvetica (WinAnsi) si tiene fuera de Latin-1

// Las fuentes estandar del PDF solo cubren Latin-1: lo demas (flechas,
// emojis) saldria como basura, asi que se reemplaza.
function plain(value) {
  const text = String(value === null || value === undefined ? '' : value).replace(/\s+/g, ' ').trim();
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0);
    out += (c >= 32 && c <= 126) || (c >= 160 && c <= 255) || EXTRA.includes(ch) ? ch : '?';
  }
  return out;
}

// Una celda puede traer dos datos, uno por renglon (separados por salto de linea).
const cellText = (value) => String(value === null || value === undefined ? '' : value).split('\n').map(plain).filter(Boolean).join('\n');

// { title, appName, generatedBy, generatedAt, filtersText, summary: { total, groups },
//   columns: [{ key, label, w }], rows, barcode: { key, label } | null }  ->  Buffer
function buildPdf(report) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true, info: { Title: plain(report.title), Author: plain(report.appName) } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const width = doc.page.width - MARGIN * 2;
    const bottom = doc.page.height - MARGIN - FOOTER;
    const barcode = report.barcode || null;
    const codes = barcode ? report.rows.map((row) => code128(row[barcode.key])) : [];
    const longest = codes.reduce((max, code) => Math.max(max, code ? code.modules : 0), 0);
    const barcodeTitle = barcode ? plain(`Código de barras (${barcode.label})`) : '';
    const titleW = Math.ceil(doc.font('Helvetica-Bold').fontSize(7.5).widthOfString(barcodeTitle)) + 8; // el titulo de la columna siempre entra
    const BARCODE_W = Math.max(titleW, Math.min(BARCODE_MAX, Math.ceil(longest * MODULE) + 10));
    const textW = width - NUM_W - (barcode ? BARCODE_W + CHECK_W : 0);
    const weight = report.columns.reduce((sum, c) => sum + (c.w || 1), 0);
    let x = MARGIN + NUM_W;
    const cols = report.columns.map((c) => {
      const col = { ...c, x, width: textW * (c.w || 1) / weight };
      x += col.width;
      return col;
    });
    const barcodeX = MARGIN + NUM_W + textW;
    const checkX = barcodeX + BARCODE_W;
    let y = MARGIN;

    // --- Encabezado del reporte (solo primera pagina)
    doc.font('Helvetica-Bold').fontSize(14).fillColor('#000').text(plain(report.title), MARGIN, y, { width });
    y = doc.y + 2;
    doc.font('Helvetica').fontSize(8).fillColor('#444');
    doc.text(plain(`${report.appName} · Generado el ${report.generatedAt} por ${report.generatedBy}`), MARGIN, y, { width });
    if (report.filtersText) doc.text(plain(`Filtros: ${report.filtersText}`), MARGIN, doc.y, { width });
    y = doc.y + 5;
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#000').text(plain(`Total: ${report.summary.total} registro(s)`), MARGIN, y, { width });
    doc.font('Helvetica').fontSize(8).fillColor('#222');
    for (const group of report.summary.groups) {
      doc.text(plain(`${group.label}: ${group.items.map((i) => `${i[0]} ${i[1]}`).join(' · ')}`), MARGIN, doc.y + 1, { width });
    }
    y = doc.y + 8;

    function tableHead() {
      doc.rect(MARGIN, y, width, HEAD).fill('#e9ecef');
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#000');
      doc.text('N.º', MARGIN + 3, y + 5, { width: NUM_W - 4, lineBreak: false });
      cols.forEach((c) => doc.text(plain(c.label), c.x + 3, y + 5, { width: c.width - 5, height: 9, ellipsis: true, lineBreak: false }));
      if (barcode) {
        doc.text(barcodeTitle, barcodeX + 3, y + 5, { width: BARCODE_W - 4, lineBreak: false });
        doc.text('Verif.', checkX + 3, y + 5, { width: CHECK_W - 5, lineBreak: false });
      }
      y += HEAD;
    }

    tableHead();
    report.rows.forEach((row, index) => {
      if (y + ROW > bottom) {
        doc.addPage();
        y = MARGIN;
        tableHead();
      }
      doc.font('Helvetica').fontSize(7.5).fillColor('#000');
      doc.text(String(index + 1), MARGIN + 3, y + 5, { width: NUM_W - 4, lineBreak: false });
      cols.forEach((c) => {
        const value = cellText(row[c.key]);
        if (value) doc.text(value, c.x + 3, y + 5, { width: c.width - 5, height: ROW - 8, ellipsis: true });
      });
      if (barcode) {
        const code = codes[index];
        if (code) {
          const unit = Math.min(MODULE, (BARCODE_W - 8) / code.modules);
          const bx = barcodeX + (BARCODE_W - code.modules * unit) / 2;
          code.bars.forEach((b) => doc.rect(bx + b[0] * unit, y + 3, b[1] * unit, 14));
          doc.fill('#000');
          doc.fontSize(6.5).text(plain(code.text), barcodeX, y + 18.5, { width: BARCODE_W, align: 'center', lineBreak: false });
        } else {
          const raw = plain(row[barcode.key]);
          doc.fontSize(6.5).fillColor('#777').text(raw ? `${raw} (no admite código de barras)` : `Sin ${barcode.label.toLowerCase()}`,
            barcodeX + 3, y + 9, { width: BARCODE_W - 6, align: 'center', height: 8, ellipsis: true, lineBreak: false });
        }
        doc.lineWidth(0.7).strokeColor('#000').rect(checkX + (CHECK_W - 11) / 2, y + (ROW - 11) / 2, 11, 11).stroke();
      }
      y += ROW;
      doc.lineWidth(0.4).strokeColor('#bbb').moveTo(MARGIN, y).lineTo(MARGIN + width, y).stroke();
    });
    if (!report.rows.length) {
      doc.font('Helvetica').fontSize(9).fillColor('#555').text('Sin registros para los filtros seleccionados.', MARGIN, y + 8, { width, align: 'center' });
      y += 30;
    }

    // --- Cierre para la verificacion fisica
    if (barcode && report.rows.length) {
      if (y + 70 > bottom) { doc.addPage(); y = MARGIN; }
      y += 16;
      doc.font('Helvetica').fontSize(8.5).fillColor('#000');
      doc.text(`Encontrados: ________ de ${report.summary.total}        No encontrados: ________        Sobrantes (no figuran en la lista): ________`, MARGIN, y, { width });
      y += 34;
      doc.text('Verificado por: ________________________________        Fecha: ________________        Firma: ________________________', MARGIN, y, { width });
    }

    // --- Pie con numero de pagina. Con el margen inferior en 0, pdfkit no
    // abre una pagina nueva al escribir tan abajo.
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.page.margins.bottom = 0;
      doc.font('Helvetica').fontSize(7.5).fillColor('#555');
      doc.text(plain(`${report.title} · ${report.generatedAt}`), MARGIN, doc.page.height - MARGIN - 8, { width: width / 2, lineBreak: false });
      doc.text(`Página ${i + 1} de ${range.count}`, MARGIN + width / 2, doc.page.height - MARGIN - 8, { width: width / 2, align: 'right', lineBreak: false });
      // Credito del desarrollador: texto fijo (ver views/partials/credito.ejs).
      doc.fontSize(6.5).fillColor('#8a93a6')
        .text(plain('Juan Carlos Aguirre Alvarado - Develop Infraestructura TI Ciberseguridad'), MARGIN, doc.page.height - MARGIN + 2, { width, align: 'center', lineBreak: false });
    }
    doc.end();
  });
}

module.exports = { buildPdf, _plain: plain };
