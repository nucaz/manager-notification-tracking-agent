// El credito del desarrollador al pie de la aplicacion es fijo: esta prueba
// falla si se quita, se cambia o se vuelve configurable.
//   - el texto exacto esta en views/partials/credito.ejs y en el base.html de
//     DevOps Sidecar, y al pie de los PDF de Reportes;
//   - toda pagina completa (con </body>) lo incluye: las del layout por
//     partials/foot.ejs y las sueltas (login, 2FA, entrada a DevOps) directo;
//   - no sale de la configuracion, de variables de entorno ni de la base
//     (el parcial no usa variables para el texto).
// No necesita base de datos. Uso: node tests/credito.test.js
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const ROOT = path.join(__dirname, '..');
const TEXT = 'Juan Carlos Aguirre Alvarado - Develop Infraestructura TI Ciberseguridad';
const results = [];
const check = (name, cond) => results.push([!!cond, name]);
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const partial = read('views/partials/credito.ejs');
check('El parcial lleva el texto exacto', partial.includes(`>${TEXT}</footer>`));
const inner = (partial.match(/data-credito="desarrollador">([\s\S]*?)<\/footer>/) || [])[1];
check('El texto no sale de una variable (no se puede configurar)', inner === TEXT);

const html = ejs.render(partial, {}, { filename: path.join(ROOT, 'views/partials/credito.ejs') });
check('Se dibuja el pie con el texto', html.includes(TEXT) && html.includes('data-credito="desarrollador"'));

// Toda vista que cierra </body> incluye el credito (directo o via foot.ejs).
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
}
const views = walk(path.join(ROOT, 'views')).filter((f) => f.endsWith('.ejs'));
const missing = views.filter((f) => {
  const s = fs.readFileSync(f, 'utf8');
  return s.includes('</body>') && !s.includes("partials/credito'") && !s.includes("include('credito'");
});
check(`Todas las páginas completas incluyen el crédito${missing.length ? ': faltan ' + missing.map((f) => path.relative(ROOT, f)).join(', ') : ''}`, missing.length === 0);
const withLayout = views.filter((f) => fs.readFileSync(f, 'utf8').includes("partials/head"));
const noFoot = withLayout.filter((f) => !fs.readFileSync(f, 'utf8').includes('partials/foot'));
check(`Las páginas con el menú cierran con partials/foot (que lleva el crédito)${noFoot.length ? ': ' + noFoot.map((f) => path.relative(ROOT, f)).join(', ') : ''}`, noFoot.length === 0);
check('partials/foot.ejs incluye el crédito', read('views/partials/foot.ejs').includes("include('credito'"));

check('DevOps Sidecar lleva el mismo texto al pie', read('devops-sidecar/app/templates/base.html').includes(`>${TEXT}</footer>`));
check('Los PDF de Reportes lo llevan al pie', read('src/services/reportPdf.js').includes(TEXT));
check('El autor también va en la cabecera de las páginas', read('views/partials/head.ejs').includes(`<meta name="author" content="${TEXT}">`));

// Nadie lo lee de settings ni de .env.
const src = walk(path.join(ROOT, 'src')).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
check('No hay ajuste ni variable de entorno para cambiarlo', !/(settings|process\.env)[^\n]*(credito|developer|desarrollador)/i.test(src));

const fails = results.filter(([ok]) => !ok);
for (const [ok, name] of results) console.log(`${ok ? 'PASA ' : 'FALLA'}  ${name}`);
console.log(`\n${results.length - fails.length}/${results.length} pruebas correctas`);
process.exit(fails.length ? 1 : 0);
