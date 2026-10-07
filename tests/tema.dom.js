// Prueba del tema claro / oscuro / del sistema (views/partials/tema.ejs y
// tema_selector.ejs) en un navegador simulado (jsdom), y de que todas las
// paginas completas lo cargan en el <head>.
//
// Uso: npm install --no-save jsdom (una vez) y node tests/tema.dom.js
// (o con JSDOM_PATH apuntando a node_modules/jsdom).
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

let JSDOM;
try { ({ JSDOM } = require(process.env.JSDOM_PATH || 'jsdom')); } catch (err) {
  console.error('Falta jsdom: npm install --no-save jsdom (o defina JSDOM_PATH).');
  process.exit(2);
}
const ROOT = path.join(__dirname, '..');
const results = [];
const check = (name, cond) => results.push([!!cond, name]);
const render = (f, data = {}) => ejs.render(fs.readFileSync(path.join(ROOT, 'views/partials', f), 'utf8'), data, { filename: path.join(ROOT, 'views/partials', f) });
const HEAD = render('tema.ejs');
const SELECTOR = render('tema_selector.ejs');

// systemDark: lo que dice el sistema operativo; stored: lo guardado antes.
function page({ systemDark = false, stored = null, sidebar = false } = {}) {
  const listeners = [];
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${sidebar ? '<nav class="sidebar collapsed">' : ''}${SELECTOR}${sidebar ? '</nav>' : ''}</body></html>`,
    { url: 'http://localhost/', runScripts: 'outside-only' });
  const w = dom.window;
  const mq = { matches: systemDark, addEventListener: (t, fn) => listeners.push(fn) };
  w.matchMedia = () => mq;
  if (stored) w.localStorage.setItem('tema', stored);
  // El script del head y despues el del selector, como en la pagina real.
  w.eval(HEAD.replace(/<\/?script>/g, ''));
  const selScript = SELECTOR.slice(SELECTOR.indexOf('<script>') + 8, SELECTOR.lastIndexOf('</script>'));
  const group = w.document.querySelector('.tema-selector');
  w.eval(`(function(){ var __g = document.querySelector('.tema-selector'); ${selScript.replace('document.currentScript.previousElementSibling', '__g')} })();`);
  return { dom, w, group, mq, listeners, theme: () => w.document.documentElement.getAttribute('data-bs-theme') };
}
const btn = (p, v) => p.group.querySelector(`[data-tema-valor="${v}"]`);
const click = (p, el) => el.dispatchEvent(new p.w.MouseEvent('click', { bubbles: true }));

let p = page({ systemDark: true });
check('Sin elección guardada se usa el tema del sistema (oscuro)', p.theme() === 'dark' && btn(p, 'sistema').classList.contains('active'));
p.mq.matches = false;
p.listeners.forEach((fn) => fn());
check('Con "sistema", si el sistema cambia a claro la página cambia sola', p.theme() === 'light');
click(p, btn(p, 'oscuro'));
check('Elegir oscuro: se aplica, se marca el botón y se recuerda', p.theme() === 'dark' && btn(p, 'oscuro').classList.contains('active')
  && btn(p, 'oscuro').getAttribute('aria-pressed') === 'true' && p.w.localStorage.getItem('tema') === 'oscuro');
p.mq.matches = true;
p.listeners.forEach((fn) => fn());
p.mq.matches = false;
p.listeners.forEach((fn) => fn());
check('Con una elección fija, el cambio del sistema no la pisa', p.theme() === 'dark');
click(p, btn(p, 'claro'));
check('Elegir claro', p.theme() === 'light' && p.w.localStorage.getItem('tema') === 'claro');

p = page({ systemDark: true, stored: 'claro' });
check('Lo guardado gana al sistema al volver a entrar', p.theme() === 'light' && btn(p, 'claro').classList.contains('active'));
p = page({ stored: 'cualquier-cosa', systemDark: false });
check('Un valor guardado no válido vuelve a "sistema"', p.theme() === 'light' && btn(p, 'sistema').classList.contains('active'));

p = page({ stored: 'claro', sidebar: true });
click(p, btn(p, 'claro'));
check('Barra lateral colapsada: el único botón visible pasa al siguiente tema', p.theme() === 'dark' && p.w.localStorage.getItem('tema') === 'oscuro');

// Todas las paginas completas cargan el tema en el <head>.
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
}
const missing = walk(path.join(ROOT, 'views')).filter((f) => f.endsWith('.ejs')).filter((f) => {
  const s = fs.readFileSync(f, 'utf8');
  return s.includes('</head>') && !s.includes("partials/tema'") && !s.includes("include('tema')");
});
check(`Todas las páginas con <head> cargan el tema${missing.length ? ': faltan ' + missing.map((f) => path.relative(ROOT, f)).join(', ') : ''}`, missing.length === 0);
check('Ninguna pantalla suelta deja el fondo claro fijo', !walk(path.join(ROOT, 'views')).some((f) => f.endsWith('.ejs') && fs.readFileSync(f, 'utf8').includes('background:#eef1f5')));
const side = fs.readFileSync(path.join(ROOT, 'devops-sidecar/app/templates/base.html'), 'utf8');
check('DevOps Sidecar también tiene el tema y su selector', side.includes("data-bs-theme") && side.includes('data-tema-valor="oscuro"'));
const css = fs.readFileSync(path.join(ROOT, 'public/css/style.css'), 'utf8');
check('La hoja de estilos define los colores propios para el tema oscuro', /\[data-bs-theme="dark"\]\s*\{[^}]*--app-bg/.test(css));

const fails = results.filter(([ok]) => !ok);
for (const [ok, name] of results) console.log(`${ok ? 'PASA ' : 'FALLA'}  ${name}`);
console.log(`\n${results.length - fails.length}/${results.length} pruebas correctas`);
process.exit(fails.length ? 1 : 0);
