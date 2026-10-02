// Prueba del captcha del inicio de sesion: monta la ruta REAL de /login
// con sesiones reales. No inicia sesion con ninguna cuenta: usa un correo
// que no existe, asi no toca intentos fallidos de nadie. Solo deja (y
// borra) filas de auditoria con ese correo.
//
// Uso (dentro del contenedor): node tests/captcha.e2e.js
const path = require('path');
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');

const ROOT = path.join(__dirname, '..');
const pool = require(path.join(ROOT, 'src/db/pool'));
const captchaService = require(path.join(ROOT, 'src/services/captchaService'));
const { ensureCsrfToken } = require(path.join(ROOT, 'src/middleware/csrf'));

const EMAIL = 'nadie-e2e-captcha@prueba.invalid';
const results = [];
const check = (name, cond) => results.push([!!cond, name]);

async function main() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(ROOT, 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: 'e2e', resave: false, saveUninitialized: false }));
  app.use(flash());
  app.use(ensureCsrfToken);
  app.use((req, res, next) => {
    Object.assign(res.locals, { currentUser: null, successMessages: req.flash('success'), errorMessages: req.flash('error'), appName: 'Prueba' });
    next();
  });
  // Solo para la prueba: ver lo que la sesion guarda (el navegador nunca lo ve).
  app.get('/__sesion', (req, res) => res.json({ captcha: req.session.captcha || null, csrf: req.session.csrfToken }));
  app.post('/__vencer', (req, res) => { if (req.session.captcha) req.session.captcha.expires = Date.now() - 1; res.json({}); });
  app.use('/', require(path.join(ROOT, 'src/routes/auth')));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const req = async (method, url, form) => {
    const opts = { method, redirect: 'manual', headers: { cookie } };
    if (form) { opts.body = new URLSearchParams(form).toString(); opts.headers['content-type'] = 'application/x-www-form-urlencoded'; }
    const r = await fetch(base + url, opts);
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: r.status, location: r.headers.get('location'), text: await r.text() };
  };
  const sesion = async () => JSON.parse((await req('GET', '/__sesion')).text);
  const login = async (captcha) => {
    const s = await sesion();
    const r = await req('POST', '/login', { _csrf: s.csrf, email: EMAIL, password: 'x', captcha });
    return (await req('GET', r.location || '/login')).text;
  };
  const audits = async () => (await pool.query('SELECT detail FROM audit_log WHERE target = ? ORDER BY id', [EMAIL]))[0].map((r) => r.detail);

  try {
    // --- La imagen
    let page = await req('GET', '/login');
    let s = await sesion();
    const svg = page.text.slice(page.text.indexOf('<svg'), page.text.indexOf('</svg>') + 6);
    check('El formulario de inicio de sesión muestra el captcha y pide el código', page.status === 200 && svg.startsWith('<svg') && page.text.includes('name="captcha"')
      && page.text.includes(`maxlength="${captchaService.LENGTH}"`) && s.captcha.code.length === 5);
    check('La respuesta no está en la página: la imagen son solo trazos, sin texto ni el código en ningún atributo', !/<text|<tspan/i.test(svg)
      && !page.text.includes(s.captcha.code) && (svg.match(/<path /g) || []).length >= 10);
    const codes = new Set();
    const images = new Set();
    for (let i = 0; i < 40; i++) {
      const fake = { session: {} };
      images.add(captchaService.issue(fake));
      codes.add(fake.session.captcha.code);
    }
    check('Cada captcha es distinto (código e imagen), con caracteres que no se confunden entre sí', codes.size >= 39 && images.size === 40
      && [...codes].every((c) => /^[0-9ACEFHKLMNPTUXY]{5}$/.test(c)));
    const a = captchaService._render('A4K7N');
    const b = captchaService._render('A4K7N');
    check('El mismo código nunca se dibuja igual dos veces (deformación y ruido aleatorios)', a !== b);

    // --- La comprobacion
    let out = await login('00000');
    let log = await audits();
    check('Código equivocado: no se llega a probar la contraseña y se pide el código nuevo', out.includes('El código de verificación no coincide') && log.length === 1
      && log[0].includes('código de verificación'));
    const oldCode = s.captcha.code;
    s = await sesion();
    check('Tras un intento se emite otro código', s.captcha && s.captcha.code !== oldCode);
    out = await login(s.captcha.code.toLowerCase());
    log = await audits();
    check('Código correcto (en minúsculas también): pasa a la comprobación de usuario y contraseña', out.includes('Credenciales invalidas') && log[1] === 'usuario no encontrado o inactivo');

    // Reusar un codigo ya usado
    await req('GET', '/login');
    s = await sesion();
    const once = s.captcha.code;
    const csrf = s.csrf;
    await req('POST', '/login', { _csrf: csrf, email: EMAIL, password: 'x', captcha: once });
    const again = await req('POST', '/login', { _csrf: csrf, email: EMAIL, password: 'x', captcha: once });
    out = (await req('GET', again.location)).text;
    check('Un código sirve para un solo intento (un script no puede reutilizarlo)', out.includes('El código de verificación no coincide'));

    await req('GET', '/login');
    s = await sesion();
    await req('POST', '/__vencer');
    out = await login(s.captcha.code);
    check('Un código vencido (más de 5 minutos) no se acepta', out.includes('El código de verificación no coincide'));

    await req('GET', '/login');
    const s2 = await sesion();
    const r = await req('POST', '/login', { _csrf: s2.csrf, email: EMAIL, password: 'x' });
    check('Sin enviar el código: rechazado', r.status === 302 && (await req('GET', r.location)).text.includes('El código de verificación no coincide'));
    const otra = { session: { captcha: { code: 'ABCDE', expires: Date.now() + 1000 } } };
    check('Respuestas raras (acentos, muy largas, objetos) no rompen la comprobación', captchaService.verify({ session: { captcha: { code: 'ABCDE', expires: Date.now() + 1000 } } }, 'ÁBCDE') === false
      && captchaService.verify({ session: { captcha: { code: 'ABCDE', expires: Date.now() + 1000 } } }, 'x'.repeat(5000)) === false
      && captchaService.verify({ session: { captcha: { code: 'ABCDE', expires: Date.now() + 1000 } } }, { a: 1 }) === false
      && captchaService.verify({ session: {} }, 'ABCDE') === false && captchaService.verify(otra, ' abcde ') === true && otra.session.captcha === undefined);
  } finally {
    server.close();
    await pool.query('DELETE FROM audit_log WHERE target = ?', [EMAIL]);
    await pool.end();
  }
}

main()
  .catch((err) => { console.error(err); results.push([false, `Excepción: ${err.message}`]); })
  .finally(() => {
    for (const [ok, name] of results) console.log(`${ok ? 'PASA ' : 'FALLA'} ${name}`);
    const ok = results.filter((r) => r[0]).length;
    console.log(`\n${ok}/${results.length} pruebas correctas`);
    process.exit(ok === results.length ? 0 : 1);
  });
