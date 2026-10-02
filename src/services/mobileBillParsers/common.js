// Utilidades compartidas por los lectores de recibos.

// Error con un mensaje pensado para mostrarse al usuario tal cual.
class BillFormatError extends Error {}

function norm(text) {
  return String(text === null || text === undefined ? '' : text)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u00ba\u00b0]/g, 'o') // ordinal y grado: 'N.o' de recibo -> 'no'
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

// "1,234.56", "-S/ 19,429.10", 31.9 -> numero con 2 decimales (o null).
function money(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Math.round(value * 100) / 100;
  const s = String(value).replace(/S\/\s*/g, '').replace(/,/g, '').trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(parseFloat(s) * 100) / 100;
}

const round2 = (n) => Math.round(n * 100) / 100;

const MESES = { ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12 };
const pad = (n) => String(n).padStart(2, '0');

// Devuelve 'YYYY-MM-DD' o null. Acepta Date, el numero de serie de Excel,
// "22/09/2026" y "22/Sep/2026".
function isoDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  }
  if (typeof value === 'number' || /^\d{5}(\.\d+)?$/.test(String(value))) {
    // Serie de Excel: dias desde el 30/12/1899.
    return isoDate(new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(value)) * 86400000));
  }
  const m = String(value).trim().match(/^(\d{1,2})[/-]([A-Za-zñ]{3,}|\d{1,2})[/-](\d{4})$/);
  if (!m) return null;
  const month = /^\d+$/.test(m[2]) ? Number(m[2]) : MESES[norm(m[2]).slice(0, 3)];
  const day = Number(m[1]);
  if (!month || month > 12 || day < 1 || day > 31) return null;
  return `${m[3]}-${pad(month)}-${pad(day)}`;
}

// "S002-990000001" y "990000001" son el mismo recibo: el Excel de la
// operadora no trae la serie y el PDF si.
function reciboNumber(value) {
  const s = String(value === null || value === undefined ? '' : value).trim();
  const m = s.match(/(\d{5,})\s*$/);
  return m ? m[1] : s;
}

// "Cuota Diferida - ZTE BLADE A76 256GB BK 5G - IMEI: 990000000000011 - Folio Venta: F999-00000001"
const CUOTA_EQUIPO = /^Cuota Diferida\s*-\s*(.+?)\s*-\s*IMEI:\s*(\d{14,16})\s*-\s*Folio Venta:\s*(\S+)$/i;

function chargeFromText(descripcion, monto, extra = {}) {
  const text = String(descripcion).replace(/\s+/g, ' ').trim();
  const m = text.match(CUOTA_EQUIPO);
  return {
    descripcion: text.slice(0, 255),
    imei: m ? m[2] : null,
    modelo: m ? m[1].slice(0, 100) : null,
    folio: m ? m[3].slice(0, 40) : null,
    cuota_nro: extra.cuota_nro || null,
    cuota_total: extra.cuota_total || null,
    monto,
  };
}

module.exports = { BillFormatError, norm, money, round2, isoDate, reciboNumber, chargeFromText };
