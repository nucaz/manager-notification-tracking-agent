// Prueba de public/js/tablas.js en un navegador simulado (jsdom): ordenar
// con clic en el encabezado (numeros, montos, fechas, vacios al final),
// ordenar junto con filtros y paginacion, recordar el orden, y en tablas
// paginadas en el servidor: orden y filtros por columna en la URL.
//
// jsdom no es dependencia de la aplicacion. Uso:
//   npm install --no-save jsdom   (una vez)
//   node tests/tablas.dom.js
// o con JSDOM_PATH apuntando a una carpeta node_modules/jsdom ya instalada.
const fs = require('fs');
const path = require('path');

let JSDOM;
try { ({ JSDOM } = require(process.env.JSDOM_PATH || 'jsdom')); } catch (err) {
  console.error('Falta jsdom: npm install --no-save jsdom (o defina JSDOM_PATH).');
  process.exit(2);
}

// La navegacion (location.href = ...) se captura en window.__destino.
const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'tablas.js'), 'utf8')
  .replace(/location\.href = /g, 'window.__destino = ');
const results = [];
const check = (name, cond) => results.push([!!cond, name]);

async function page(html, url = 'http://localhost/prueba') {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  if (dom.window.document.readyState === 'loading') {
    await new Promise((r) => dom.window.document.addEventListener('DOMContentLoaded', r));
  }
  dom.window.eval(SCRIPT);
  return dom;
}
const col = (dom, i) => [...dom.window.document.querySelectorAll('tbody tr')].filter((r) => !r.hidden).map((r) => r.cells[i].textContent.trim());
const click = (dom, el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const th = (dom, i) => dom.window.document.querySelectorAll('thead th')[i];
const button = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent === text);

async function main() {
  // ---------------- tabla del navegador ----------------
  const rows = [
    ['Beta', '10', '05/01/2026', 'S/ 1,200.50'],
    ['alfa', '9', '2025-12-31', 'S/ 80.00'],
    ['Ñandú', '', '—', ''],
    ['Gamma 2', '100', '01/02/2026', 'S/ 15.5'],
    ['Gamma 10', '2', '15/01/2026', 'S/ 3'],
  ];
  const table = `<div class="card"><div class="table-responsive"><table class="table"><thead><tr><th>Nombre</th><th>Cant.</th><th>Fecha</th><th>Monto</th><th></th></tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}<td><a href="#">ver</a></td></tr>`).join('')}</tbody></table></div></div>`;

  let dom = await page(table);
  check('Encabezados con texto se pueden ordenar; la columna sin título no', th(dom, 0).classList.contains('col-ordenable') && !th(dom, 4).classList.contains('col-ordenable'));
  click(dom, th(dom, 1));
  check('Números: 2, 9, 10, 100 y el vacío al final', col(dom, 1).join('|') === '2|9|10|100|');
  click(dom, th(dom, 1));
  check('Segundo clic: descendente, el vacío sigue al final', col(dom, 1).join('|') === '100|10|9|2|');
  check('Indicador y aria-sort', th(dom, 1).getAttribute('aria-sort') === 'descending' && th(dom, 1).querySelector('.col-orden.activo'));
  click(dom, th(dom, 1));
  check('Tercer clic: vuelve al orden original', col(dom, 0).join('|') === 'Beta|alfa|Ñandú|Gamma 2|Gamma 10');
  click(dom, th(dom, 2));
  check('Fechas DD/MM/AAAA y AAAA-MM-DD juntas', col(dom, 2).join('|') === '2025-12-31|05/01/2026|15/01/2026|01/02/2026|—');
  click(dom, th(dom, 3));
  check('Montos con S/ y miles', col(dom, 3).join('|') === 'S/ 3|S/ 15.5|S/ 80.00|S/ 1,200.50|');
  click(dom, th(dom, 0));
  check('Texto sin distinguir mayúsculas, con números naturales (Gamma 2 antes que Gamma 10)', col(dom, 0).join('|') === 'alfa|Beta|Gamma 2|Gamma 10|Ñandú');
  const saved = JSON.parse(dom.window.localStorage.getItem('tabla:/prueba:0') || '{}');
  check('El orden se recuerda por pantalla y tabla', saved.ordenar && saved.ordenar.col === 'Nombre' && saved.ordenar.dir === 'asc');
  click(dom, dom.window.document.querySelector('tbody a'));
  check('Un clic en un enlace de la fila no ordena', col(dom, 0)[0] === 'alfa');
  const again = await page(table);
  again.window.localStorage.setItem('tabla:/prueba:0', JSON.stringify({ ordenar: { col: 'Cant.', dir: 'desc' } }));
  const reload = await page(table);
  reload.window.localStorage.setItem('tabla:/prueba:0', JSON.stringify({ ordenar: { col: 'Cant.', dir: 'desc' } }));
  const restored = new JSDOM(`<!doctype html><body>${table}</body>`, { url: 'http://localhost/prueba', runScripts: 'outside-only' });
  restored.window.localStorage.setItem('tabla:/prueba:0', JSON.stringify({ ordenar: { col: 'Cant.', dir: 'desc' } }));
  restored.window.eval(SCRIPT);
  await new Promise((r) => setTimeout(r, 20));
  check('Al volver a la pantalla se aplica el orden guardado', col(restored, 1).join('|') === '100|10|9|2|');

  // Una fila de totales (celdas combinadas) no se mueve al cargar ni al quitar el orden.
  const totals = `<div class="table-responsive"><table class="table"><thead><tr><th>Sede</th><th>Equipos</th></tr></thead><tbody>
    <tr><td>SURCO</td><td>5</td></tr><tr><td>IZAGUIRRE</td><td>2</td></tr><tr><td colspan="2">Total 7</td></tr></tbody></table></div>`;
  dom = await page(totals, 'http://localhost/totales');
  const bodyText = () => [...dom.window.document.querySelectorAll('tbody tr')].map((r) => [...r.cells].map((c) => c.textContent.trim()).join(' ')).join('|');
  check('Sin orden activo, la tabla queda tal cual al cargar', bodyText() === 'SURCO 5|IZAGUIRRE 2|Total 7');
  click(dom, th(dom, 1));
  check('Ordenada, la fila de totales queda al final', bodyText() === 'IZAGUIRRE 2|SURCO 5|Total 7');
  click(dom, th(dom, 1));
  click(dom, th(dom, 1));
  check('Al quitar el orden todo vuelve a su lugar', bodyText() === 'SURCO 5|IZAGUIRRE 2|Total 7');

  // Orden + filtros + paginacion (mas de 10 filas).
  const many = Array.from({ length: 25 }, (_, i) => [`Item ${i + 1}`, String((i * 7) % 25), i % 2 ? 'SURCO' : 'IZAGUIRRE']);
  dom = await page(`<div class="card"><div class="table-responsive"><table class="table"><thead><tr><th>Item</th><th>Valor</th><th>Sede</th></tr></thead><tbody>
    ${many.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div>`, 'http://localhost/muchas');
  const sel = dom.window.document.querySelector('.tabla-filas select');
  sel.value = '10';
  sel.dispatchEvent(new dom.window.Event('change'));
  click(dom, th(dom, 1));
  check('Con paginación: la primera página muestra los menores de TODA la tabla', col(dom, 1).join(',') === '0,1,2,3,4,5,6,7,8,9');
  check('Los filtros por columna siguen junto con el orden', dom.window.document.querySelectorAll('thead .col-filtro').length === 3);
  click(dom, th(dom, 2).querySelector('.col-filtro'));
  const panel = dom.window.document.querySelector('.col-filtro-panel');
  [...panel.querySelectorAll('input[type=checkbox]')].forEach((b) => { b.checked = b.parentNode.textContent.includes('SURCO'); b.dispatchEvent(new dom.window.Event('change')); });
  click(dom, button(panel, 'Aplicar'));
  check('Filtrar mantiene el orden', col(dom, 2).length && col(dom, 2).every((v) => v === 'SURCO') && col(dom, 1).map(Number).every((v, i, a) => !i || a[i - 1] <= v));
  click(dom, th(dom, 2).querySelector('.col-filtro'));
  check('Abrir el filtro no ordena la columna', th(dom, 2).getAttribute('aria-sort') === 'none');

  // ---------------- tabla paginada en el servidor ----------------
  const server = `<div class="card"><div class="table-responsive"><table class="table" data-tabla="servidor"><thead><tr>
    <th data-orden="usuario" data-filtro-texto="usuario">Usuario</th>
    <th data-orden="perfil" data-filtro="perfil" data-opciones='[["1","ESPECIALISTA"],["3","BACKOFFICE"],["7","SISTEMAS"]]'>Perfil</th>
    <th data-orden="conexion" data-orden-inicial="desc">Última conexión</th><th>Notas</th></tr></thead>
    <tbody><tr><td>B</td><td>X</td><td>1</td><td>n</td></tr><tr><td>A</td><td>Y</td><td>2</td><td>n</td></tr></tbody></table></div>
    <nav><ul class="pagination"><li>1</li></ul></nav></div>`;
  dom = await page(server, 'http://localhost/clinic?estado=activo&pagina=3');
  click(dom, th(dom, 2));
  check('Servidor: no ordena en el navegador (solo hay una página)', col(dom, 0).join('') === 'BA');
  check('Servidor: primer clic en "Última conexión" ordena descendente y vuelve a la página 1',
    dom.window.__destino === '/clinic?estado=activo&orden=conexion&dir=desc');
  check('Servidor: sin data-orden no ordena ni filtra', !th(dom, 3).classList.contains('col-ordenable') && !th(dom, 3).querySelector('.col-filtro'));
  check('Servidor: embudo en columnas con data-filtro y data-filtro-texto (y no en las demás)', th(dom, 0).querySelector('.col-filtro')
    && th(dom, 1).querySelector('.col-filtro') && !th(dom, 2).querySelector('.col-filtro'));
  click(dom, th(dom, 1).querySelector('.col-filtro'));
  const sp = dom.window.document.querySelector('.col-filtro-panel');
  check('Servidor: el panel lista las opciones dadas por el servidor', sp && sp.querySelectorAll('input[type=checkbox]').length === 3 && sp.textContent.includes('BACKOFFICE'));

  dom = await page(server, 'http://localhost/clinic?orden=usuario&dir=asc&perfil=1,3&usuario=jp');
  check('Servidor: indicador del orden actual leído de la URL', th(dom, 0).getAttribute('aria-sort') === 'ascending');
  check('Servidor: embudos activos con los filtros de la URL', th(dom, 1).querySelector('.col-filtro.activo') && th(dom, 0).querySelector('.col-filtro.activo'));
  click(dom, th(dom, 0));
  check('Servidor: segundo clic invierte el sentido', dom.window.__destino === '/clinic?orden=usuario&dir=desc&perfil=1%2C3&usuario=jp');
  click(dom, th(dom, 1).querySelector('.col-filtro'));
  let p3 = dom.window.document.querySelector('.col-filtro-panel');
  const boxes = [...p3.querySelectorAll('input[type=checkbox]')];
  check('Servidor: el panel marca solo los valores filtrados', boxes.map((b) => b.checked).join(',') === 'true,true,false');
  boxes.forEach((b, i) => { b.checked = i !== 1; });
  click(dom, button(p3, 'Aplicar'));
  check('Servidor: aplicar el filtro de columna pone los valores en la URL', dom.window.__destino === '/clinic?orden=usuario&dir=asc&perfil=1%2C7&usuario=jp');
  click(dom, th(dom, 0).querySelector('.col-filtro'));
  p3 = dom.window.document.querySelector('.col-filtro-panel');
  const input = p3.querySelector('input[type=search]');
  check('Servidor: filtro de texto con el valor actual', input && input.value === 'jp');
  click(dom, button(p3, 'Quitar filtro'));
  check('Servidor: quitar el filtro de texto lo saca de la URL', dom.window.__destino === '/clinic?orden=usuario&dir=asc&perfil=1%2C3');

  const fails = results.filter(([ok]) => !ok);
  for (const [ok, name] of results) console.log(`${ok ? 'PASA ' : 'FALLA'}  ${name}`);
  console.log(`\n${results.length - fails.length}/${results.length} pruebas correctas`);
  process.exit(fails.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
