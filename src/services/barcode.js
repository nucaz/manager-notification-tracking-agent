// Codigo de barras Code 128 (el que lee cualquier lector de mano), para los
// reportes impresos de inventario. Sin dependencias: devuelve las barras
// como posiciones en "modulos" (el ancho de la barra mas fina) y quien
// dibuja decide la escala.
//
// Solo digitos -> juego C (dos digitos por simbolo: un IMEI ocupa la mitad).
// Cualquier otro texto ASCII -> juego B.

// Ancho de barra/espacio de cada simbolo (0-102 datos, 103-105 inicio A/B/C, 106 fin).
const PATTERNS = (
  '212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 '
  + '221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 '
  + '221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 '
  + '212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 '
  + '231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 '
  + '231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 '
  + '314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 '
  + '112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 '
  + '111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 '
  + '214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 '
  + '114131 311141 411131 211412 211214 211232 2331112'
).split(' ');

const START_B = 104;
const START_C = 105;
const CODE_B = 100;
const STOP = 106;
const QUIET = 10; // modulos en blanco a cada lado

// Simbolos (con inicio, digito de control y fin) o null si el texto no se
// puede codificar (vacio, o con caracteres fuera de ASCII imprimible).
function symbols(value) {
  const text = String(value === null || value === undefined ? '' : value).trim();
  if (!text) return null;
  let codes;
  if (/^[0-9]{4,}$/.test(text)) {
    const even = text.length - (text.length % 2);
    codes = [START_C];
    for (let i = 0; i < even; i += 2) codes.push(Number(text.substr(i, 2)));
    if (text.length % 2) codes.push(CODE_B, text.charCodeAt(text.length - 1) - 32); // digito suelto: pasa al juego B
  } else {
    codes = [START_B];
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c < 32 || c > 126) return null;
      codes.push(c - 32);
    }
  }
  const check = codes.reduce((sum, code, i) => sum + code * (i || 1), 0) % 103;
  return [...codes, check, STOP];
}

// { text, modules, bars: [[inicio, ancho], ...] } en modulos, con las zonas
// en blanco ya incluidas; null si no hay nada que codificar.
function code128(value) {
  const codes = symbols(value);
  if (!codes) return null;
  const bars = [];
  let x = QUIET;
  for (const code of codes) {
    const widths = PATTERNS[code];
    for (let i = 0; i < widths.length; i++) {
      const w = Number(widths[i]);
      if (i % 2 === 0) bars.push([x, w]);
      x += w;
    }
  }
  return { text: String(value).trim(), modules: x + QUIET, bars };
}

module.exports = { code128, _symbols: symbols, _patterns: PATTERNS };
