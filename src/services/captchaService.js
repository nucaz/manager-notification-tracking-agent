// Captcha propio para el inicio de sesion: frena scripts de fuerza bruta,
// fuzzing y scraping sin depender de un servicio externo (la aplicacion
// corre en red interna y no puede contar con reCAPTCHA y similares).
//
// El codigo se dibuja como TRAZOS (lineas) en un SVG, deformados y con
// ruido: en la pagina no hay ningun texto que un script pueda leer. La
// respuesta se guarda en la sesion, vale para un solo intento y caduca.
//
// No reemplaza al limite de intentos ni al bloqueo de cuenta: los
// complementa. Un atacante dedicado con OCR puede resolverlo; un script
// generico, no.
const crypto = require('crypto');

const LENGTH = 5;
const TTL_MS = 5 * 60 * 1000;
const WIDTH = 220;
const HEIGHT = 70;

// Cada caracter, como trazos sobre una cuadricula de 4 x 6. Se dejan fuera
// los que se confunden entre si (O/0, I/1, S/5, B/8, Z/2, G/6, Q, D, V, W, R, J).
const GLYPHS = {
  0: [[[0, 0], [4, 0], [4, 6], [0, 6], [0, 0]], [[4, 0], [0, 6]]],
  1: [[[1, 1], [2, 0], [2, 6]], [[1, 6], [3, 6]]],
  2: [[[0, 1], [1, 0], [3, 0], [4, 1], [4, 2], [0, 6], [4, 6]]],
  3: [[[0, 0], [4, 0], [2, 2.5], [4, 4], [4, 5], [3, 6], [1, 6], [0, 5]]],
  4: [[[3, 6], [3, 0], [0, 4], [4, 4]]],
  5: [[[4, 0], [0, 0], [0, 2.5], [3, 2.5], [4, 3.5], [4, 5], [3, 6], [0, 6]]],
  6: [[[4, 0], [1, 0], [0, 1], [0, 6], [4, 6], [4, 3], [0, 3]]],
  7: [[[0, 0], [4, 0], [1.5, 6]]],
  8: [[[0, 0], [4, 0], [4, 6], [0, 6], [0, 0]], [[0, 3], [4, 3]]],
  9: [[[4, 3], [0, 3], [0, 0], [4, 0], [4, 5], [3, 6], [0, 6]]],
  A: [[[0, 6], [2, 0], [4, 6]], [[1, 4], [3, 4]]],
  C: [[[4, 1], [3, 0], [1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5]]],
  E: [[[4, 0], [0, 0], [0, 6], [4, 6]], [[0, 3], [3, 3]]],
  F: [[[4, 0], [0, 0], [0, 6]], [[0, 3], [3, 3]]],
  H: [[[0, 0], [0, 6]], [[4, 0], [4, 6]], [[0, 3], [4, 3]]],
  K: [[[0, 0], [0, 6]], [[4, 0], [0, 3], [4, 6]]],
  L: [[[0, 0], [0, 6], [4, 6]]],
  M: [[[0, 6], [0, 0], [2, 3], [4, 0], [4, 6]]],
  N: [[[0, 6], [0, 0], [4, 6], [4, 0]]],
  P: [[[0, 6], [0, 0], [4, 0], [4, 3], [0, 3]]],
  T: [[[0, 0], [4, 0]], [[2, 0], [2, 6]]],
  U: [[[0, 0], [0, 5], [1, 6], [3, 6], [4, 5], [4, 0]]],
  X: [[[0, 0], [4, 6]], [[4, 0], [0, 6]]],
  Y: [[[0, 0], [2, 3], [4, 0]], [[2, 3], [2, 6]]],
};
const ALPHABET = Object.keys(GLYPHS);

// Aleatorio criptografico en [min, max).
const rand = (min, max) => min + (crypto.randomInt(0, 1000000) / 1000000) * (max - min);
const n = (value) => value.toFixed(1);

function randomCode() {
  let code = '';
  for (let i = 0; i < LENGTH; i++) code += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
  return code;
}

function render(code) {
  const paths = [];
  const slot = (WIDTH - 30) / code.length;
  [...code].forEach((ch, i) => {
    const scale = rand(5.2, 6.6);
    const angle = rand(-0.28, 0.28);
    const cx = 15 + slot * i + slot / 2 + rand(-3, 3);
    const cy = HEIGHT / 2 + rand(-6, 6);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const d = GLYPHS[ch].map((line) => line.map(([x, y], k) => {
      // centrado en la cuadricula, deformado punto a punto, girado y colocado
      const px = (x - 2) * scale + rand(-1.1, 1.1);
      const py = (y - 3) * scale + rand(-1.1, 1.1);
      return `${k ? 'L' : 'M'}${n(cx + px * cos - py * sin)} ${n(cy + px * sin + py * cos)}`;
    }).join(' ')).join(' ');
    paths.push(`<path d="${d}" fill="none" stroke="hsl(${crypto.randomInt(200, 260)},45%,${crypto.randomInt(22, 38)}%)" stroke-width="${n(rand(2.1, 2.9))}" stroke-linecap="round" stroke-linejoin="round"/>`);
  });
  // Ruido: curvas que cruzan el codigo y puntos sueltos, del mismo tono que los trazos.
  for (let i = 0; i < 5; i++) {
    paths.push(`<path d="M${n(rand(0, 30))} ${n(rand(5, HEIGHT - 5))} Q${n(rand(60, 160))} ${n(rand(-10, HEIGHT + 10))} ${n(rand(WIDTH - 30, WIDTH))} ${n(rand(5, HEIGHT - 5))}" fill="none" stroke="hsl(${crypto.randomInt(200, 260)},40%,${crypto.randomInt(35, 60)}%)" stroke-width="${n(rand(1, 1.9))}"/>`);
  }
  for (let i = 0; i < 28; i++) {
    paths.push(`<circle cx="${n(rand(4, WIDTH - 4))}" cy="${n(rand(4, HEIGHT - 4))}" r="${n(rand(0.7, 1.6))}" fill="hsl(${crypto.randomInt(200, 260)},35%,${crypto.randomInt(35, 65)}%)"/>`);
  }
  // Los trazos y el ruido van mezclados, para que no se puedan separar por posicion en el documento.
  for (let i = paths.length - 1; i > 0; i--) { const j = crypto.randomInt(0, i + 1); [paths[i], paths[j]] = [paths[j], paths[i]]; }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="Código de verificación"><rect width="100%" height="100%" rx="6" fill="#eef1f5"/>${paths.join('')}</svg>`;
}

// Emite un captcha nuevo para esta sesion (reemplaza al anterior) y devuelve su SVG.
function issue(req) {
  const code = randomCode();
  req.session.captcha = { code, expires: Date.now() + TTL_MS };
  return render(code);
}

// Comprueba la respuesta. El captcha se consume siempre: acierte o no, el
// siguiente intento necesita uno nuevo.
function verify(req, answer) {
  const stored = req.session.captcha;
  delete req.session.captcha;
  if (!stored || typeof stored.code !== 'string' || Date.now() > stored.expires) return false;
  const given = String(answer || '').trim().toUpperCase();
  const a = Buffer.from(given);
  const b = Buffer.from(stored.code);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { issue, verify, LENGTH, _render: render, _alphabet: ALPHABET };
