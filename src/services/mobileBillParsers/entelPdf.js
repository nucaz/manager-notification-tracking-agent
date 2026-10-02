// Recibo de Entel Peru en PDF. Trabaja sobre los renglones de texto (ver
// pdfText.js), en tres bloques del mismo documento:
// - "Resumen": una fila por numero con plan, prorrateo, cargos adicionales,
//   descuentos, equipos, saldo anterior y monto.
// - "Detalle": por numero, de donde sale el tipo de descuento y, si es por
//   fidelizacion, en que mes va (ej. 11/18) — dato que el Excel no trae.
// - "Cuenta Cliente": cuotas de equipos con IMEI, folio y numero de cuota.
const { BillFormatError, money, round2, isoDate, reciboNumber, chargeFromText } = require('./common');

const AMOUNT = '(-?[\\d,]+\\.\\d{2})';
const RESUMEN = new RegExp(`^(\\d{7,12}) (.+?) ${Array(7).fill(AMOUNT).join(' ')}$`);
const DETALLE_HEAD = new RegExp(`^(\\d{7,12}) \\((.+)\\) ${AMOUNT}$`);
const DESCUENTO = new RegExp(`^(.*?[Dd]escuento.*?)(?: \\d{1,2}-[a-z]{3} al \\d{1,2}-[a-z]{3})?(?: \\d+ d[ií]as| \\d+)? ${AMOUNT}$`);
const AVANCE = /\((\d{1,3})\/(\d{1,3})\)/;
const CUOTA = new RegExp(`^(Cuota Diferida - .+?) (\\d{1,3})\\/(\\d{1,3}) ${AMOUNT}$`);
const CARGO_CUENTA = new RegExp(`^(.+?) ${AMOUNT}$`);

function detect(lines) {
  const head = lines.slice(0, 40).join('\n');
  return /Entel Per[uú]/i.test(head) && /Recibo N[º°o]/i.test(head);
}

function field(text, rx) {
  const m = text.match(rx);
  return m ? m[1].trim() : null;
}

function parse(lines) {
  const head = lines.slice(0, 60).join('\n');
  const recibo = field(head, /Recibo N[º°o]\s*:\s*(\S+)/i);
  if (!recibo) throw new BillFormatError('El PDF parece de Entel, pero no se encontró el número de recibo. ¿Cambió el formato?');

  // La razon social es el renglon siguiente al saludo del encabezado.
  const hola = lines.findIndex((l) => /Te enviamos tu recibo/i.test(l));
  const vence = lines.slice(0, 60).find((l) => /^\d{1,2}\/[A-Za-z]{3}\/\d{4} S\//.test(l));
  const totalAt = lines.findIndex((l) => /^Total a pagar$/i.test(l));

  const byNumber = new Map();
  const charges = [];
  let saldoAnterior = 0;
  let current = null; // linea cuyo detalle se esta leyendo
  let inCuenta = false;
  let pending = null; // cuota de equipo partida en dos renglones

  for (const line of lines) {
    const sum = line.match(RESUMEN);
    if (sum) {
      const [plan, , , descuento, , , monto] = sum.slice(3).map(money);
      byNumber.set(sum[1], {
        phone_number: sum[1],
        plan: sum[2].trim().slice(0, 80),
        cargo_fijo: plan,
        descuento,
        otros: round2(monto - plan - descuento),
        monto_total: monto,
        descuento_tipo: null,
        descuento_cuota: null,
        descuento_cuotas: null,
      });
      continue;
    }
    // Con un solo monto es el titulo del bloque; con siete, la fila del resumen.
    if (/^Cuenta Cliente -?[\d,]+\.\d{2}$/.test(line)) { inCuenta = true; current = null; continue; }
    if (/^Saldos Anteriores /.test(line)) {
      saldoAnterior = money(line.replace(/^Saldos Anteriores /, '')) || 0;
      inCuenta = false;
      continue;
    }

    if (inCuenta) {
      if (/^(Página \d+ de \d+|Mira aquí el detalle|tu recibo|Conceptos detallados .*|Equipos .*)$/.test(line)) continue;
      const text = pending ? `${pending} ${line}` : line;
      const cuota = text.match(CUOTA);
      if (cuota) {
        charges.push(chargeFromText(cuota[1], money(cuota[4]), { cuota_nro: Number(cuota[2]), cuota_total: Number(cuota[3]) }));
        pending = null;
      } else if (/^Cuota Diferida/.test(text) && !pending) {
        pending = text; // la descripcion sigue en el renglon siguiente
      } else {
        const other = text.match(CARGO_CUENTA);
        if (other) charges.push(chargeFromText(other[1], money(other[2])));
        pending = null;
      }
      continue;
    }

    const head2 = line.match(DETALLE_HEAD);
    if (head2) { current = byNumber.get(head2[1]) || null; continue; }
    if (current && !current.descuento_tipo && !/^Descuentos /.test(line)) {
      const d = line.match(DESCUENTO);
      if (d) {
        const avance = d[1].match(AVANCE);
        current.descuento_tipo = d[1].replace(AVANCE, '').replace(/\s+/g, ' ').trim().slice(0, 120);
        if (avance) { current.descuento_cuota = Number(avance[1]); current.descuento_cuotas = Number(avance[2]); }
      }
    }
  }

  return {
    operadora: 'Entel',
    origen: 'pdf',
    recibo_nro: reciboNumber(recibo),
    cuenta: field(head, /N[º°o] de Cuenta\s*:\s*(\S+)/i),
    razon_social: hola >= 0 && lines[hola + 1] ? lines[hola + 1].slice(0, 150) : null,
    ruc: field(head, /N[º°o] Doc \(RUC\)\s*:\s*(\d+)/i),
    fecha_emision: isoDate(field(head, /Emisi[oó]n\s*:\s*(\S+)/i)),
    periodo_inicio: isoDate(field(head, /Inicio del Periodo\s*:\s*(\S+)/i)),
    periodo_fin: isoDate(field(head, /Fin del Periodo\s*:\s*(\S+)/i)),
    fecha_vencimiento: vence ? isoDate(vence.split(' ')[0]) : null,
    total_pagar: totalAt >= 0 ? money(lines[totalAt + 1]) : null,
    saldo_anterior: saldoAnterior,
    lines: [...byNumber.values()],
    charges,
  };
}

module.exports = { name: 'Entel (recibo PDF)', detect, parse };
