// Prueba de "Unificar valores" de catálogos: cambia el valor en todos los
// lugares del campo elegido (y solo en ese campo), en una transacción, con
// vista previa, y deja el catálogo con el valor destino.
//
// Datos marcados que se borran al final (IMEI 99000000000000x, valores
// PRUEBA-UNI-*). Pide E2E_PERMITIR=1.
//
// Uso (dentro del contenedor): E2E_PERMITIR=1 node tests/catalogo_unificar.e2e.js
const path = require('path');
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');

if (process.env.E2E_PERMITIR !== '1') {
  console.error('Esta prueba escribe (y luego borra) datos marcados en la base configurada. Ejecútela con E2E_PERMITIR=1.');
  process.exit(2);
}

const ROOT = path.join(__dirname, '..');
const pool = require(path.join(ROOT, 'src/db/pool'));
const merge = require(path.join(ROOT, 'src/services/catalogMergeService'));

const IMEI = ['990000000000001', '990000000000002', '990000000000003'];
const A = 'PRUEBA-UNI-A';
const B = 'PRUEBA-UNI-B';
const DEST = 'PRUEBA-UNI-DEST';
const SEDE = 'PRUEBA-UNI-A'; // una sede con el MISMO texto que un area: no debe cambiar
const results = [];
const check = (name, cond) => results.push([!!cond, name]);
const q = async (sql, params) => (await pool.query(sql, params))[0];

async function cleanup() {
  await q('DELETE FROM mobile_devices WHERE imei IN (?)', [IMEI]);
  await q("DELETE FROM employees WHERE dni = '99999901'");
  await q("DELETE FROM catalog_items WHERE value LIKE 'PRUEBA-UNI-%'");
  await q("DELETE FROM mobile_device_area_audits WHERE area LIKE 'PRUEBA-UNI-%'");
  await q("DELETE FROM mobile_models WHERE brand LIKE 'PRUEBA-UNI-%'");
  await q("DELETE FROM audit_log WHERE action = 'catalogo_unificado' AND target LIKE '%PRUEBA-UNI-%'");
}

async function main() {
  const [admin] = await q("SELECT id, email, full_name, role FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
  await cleanup();
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(ROOT, 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: 'e2e', resave: false, saveUninitialized: true }));
  app.use(flash());
  const CSRF = 'token-de-prueba-e2e-0123456789abcdef0123456789abcdef';
  app.use((req, res, next) => {
    req.session.user = admin;
    req.session.csrfToken = CSRF;
    Object.assign(res.locals, { currentUser: admin, csrfToken: CSRF, successMessages: req.flash('success'), errorMessages: req.flash('error'),
      currentPath: req.path, currentHost: req.hostname, appName: 'Prueba', enabledModules: new Proxy({}, { get: () => true }) });
    next();
  });
  app.use('/configuracion/catalogos', require(path.join(ROOT, 'src/routes/catalogs')));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const keep = (r) => { const s = r.headers.get('set-cookie'); if (s) cookie = s.split(';')[0]; return r; };
  const get = async (u) => (keep(await fetch(base + u, { headers: { cookie } }))).text();
  const post = async (u, form) => {
    const body = new URLSearchParams({ _csrf: CSRF });
    Object.entries(form).forEach(([k, v]) => (Array.isArray(v) ? v : [v]).forEach((x) => body.append(k, x)));
    const r = keep(await fetch(base + u, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() }));
    return { status: r.status, location: r.headers.get('location'), text: await r.text() };
  };

  try {
    await q('INSERT INTO mobile_devices (imei, area, sede, status) VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)',
      [IMEI[0], A, SEDE, 'en_stock', IMEI[1], B, 'SURCO', 'asignado', IMEI[2], DEST, 'SURCO', 'asignado']);
    const ids = (await q('SELECT id, imei FROM mobile_devices WHERE imei IN (?) ORDER BY imei', [IMEI])).map((r) => r.id);
    await q("INSERT INTO mobile_device_assignments (device_id, holder_name, area, sede, assigned_date, returned_date) VALUES (?, 'X', ?, 'SURCO', '2026-01-01', '2026-02-01'), (?, 'Y', ?, 'SURCO', '2026-02-02', NULL)",
      [ids[1], B, ids[1], B]);
    await q("INSERT INTO employees (dni, first_name, last_name, area, sede) VALUES ('99999901', 'E', 'Prueba', ?, ?)", [A, SEDE]);
    await q("INSERT INTO catalog_items (catalog_type, value) VALUES ('area', ?), ('area', ?), ('area', 'PRUEBA-UNI-SOLOCAT'), ('sede', ?)", [A, B, SEDE]);
    await q("INSERT INTO mobile_device_area_audits (area, estatus) VALUES (?, 'pendiente'), (?, 'pendiente'), ('PRUEBA-UNI-TYPO', 'pendiente')", [A, B]);

    // --- Pantalla y vista previa
    let page = await get('/configuracion/catalogos/unificar?tipo=area');
    check('Pantalla: lista los valores con cuántos usos y dónde', page.includes(`value="${A}"`) && page.includes(`value="${B}"`) && page.includes('PRUEBA-UNI-SOLOCAT'));
    let r = await post('/configuracion/catalogos/unificar/vista-previa', { tipo: 'area', sources: [A, B, 'PRUEBA-UNI-SOLOCAT', 'PRUEBA-UNI-TYPO'], target: DEST });
    check('Vista previa: cuenta lo que cambia en celulares, empleados, historial, checklist y catálogo, sin cambiar nada', r.status === 200 && r.text.includes('id="vista_previa"')
      && /Celulares<\/td><td class="text-end">2</.test(r.text) && /Empleados<\/td><td class="text-end">1</.test(r.text) && /Historial de asignaciones<\/td><td class="text-end">2</.test(r.text)
      && /Checklist por área<\/td><td class="text-end">3</.test(r.text) && r.text.includes('se agrega ' + DEST)
      && (await q('SELECT COUNT(*) AS n FROM mobile_devices WHERE area = ?', [A]))[0].n === 1);

    // --- Aplicar
    r = await post('/configuracion/catalogos/unificar', { tipo: 'area', sources: [A, B, 'PRUEBA-UNI-SOLOCAT', 'PRUEBA-UNI-TYPO'], target: DEST });
    const devs = await q('SELECT imei, area, sede, status FROM mobile_devices WHERE imei IN (?) ORDER BY imei', [IMEI]);
    check('Aplicar: todos los celulares quedan en el área destino', devs.every((d) => d.area === DEST));
    check('No toca la sede ni el estado (aunque la sede tenga el mismo texto que el área unificada)', devs[0].sede === SEDE && devs[1].sede === 'SURCO'
      && devs[0].status === 'en_stock' && devs[1].status === 'asignado'
      && (await q("SELECT COUNT(*) AS n FROM catalog_items WHERE catalog_type = 'sede' AND value = ?", [SEDE]))[0].n === 1);
    const asg = await q('SELECT area, sede, returned_date FROM mobile_device_assignments WHERE device_id = ? ORDER BY id', [ids[1]]);
    check('El historial de asignaciones (vigente y cerrado) toma el área nueva y conserva su sede', asg.every((x) => x.area === DEST && x.sede === 'SURCO') && asg[0].returned_date);
    const [emp] = await q("SELECT area, sede FROM employees WHERE dni = '99999901'");
    check('Empleados: área nueva, misma sede', emp.area === DEST && emp.sede === SEDE);
    const audits = await q("SELECT area FROM mobile_device_area_audits WHERE area LIKE 'PRUEBA-UNI-%'");
    check('Checklist: queda una sola fila para el área destino y se van las mal escritas', audits.length === 1 && audits[0].area === DEST);
    const cat = await q("SELECT value, active FROM catalog_items WHERE catalog_type = 'area' AND value LIKE 'PRUEBA-UNI-%'");
    check('Catálogo: se quitan los valores unificados y queda el destino (agregado si no estaba)', cat.length === 1 && cat[0].value === DEST && cat[0].active === 1);
    const [log] = await q("SELECT target, detail FROM audit_log WHERE action = 'catalogo_unificado' ORDER BY id DESC LIMIT 1");
    check('Queda en la auditoría con lo que cambió en cada lugar', log && log.target.includes(DEST) && log.detail.includes('Celulares: 2'));
    page = await get(r.location);
    check('Mensaje con el resumen al terminar', page.includes(`Unificado en &#34;${DEST}&#34;`) || page.includes(`Unificado en "${DEST}"`));

    // --- Validaciones
    let err = '';
    try { await merge.preview('area', [DEST], DEST); } catch (e) { err = e.message; }
    check('Si solo se marca el mismo valor que queda, no hay nada que unificar', err.includes('al menos un valor distinto'));
    err = '';
    try { await merge.preview('usuarios', [A], DEST); } catch (e) { err = e.message; }
    check('Solo tipos de catálogo conocidos (no cualquier tabla)', err.includes('no válido'));

    // --- Marcas: el modelo repetido en la marca destino no se duplica
    await q("INSERT INTO mobile_models (brand, model) VALUES ('PRUEBA-UNI-MZ', 'X1'), ('PRUEBA-UNI-MZ', 'X2'), ('PRUEBA-UNI-MARCA', 'X1')");
    await merge.apply('marca', ['PRUEBA-UNI-MZ'], 'PRUEBA-UNI-MARCA', admin.id);
    const models = await q("SELECT brand, model FROM mobile_models WHERE brand LIKE 'PRUEBA-UNI-%' ORDER BY model");
    check('Marcas: los modelos pasan a la marca destino sin duplicarse', JSON.stringify(models) === JSON.stringify([{ brand: 'PRUEBA-UNI-MARCA', model: 'X1' }, { brand: 'PRUEBA-UNI-MARCA', model: 'X2' }]));
  } finally {
    server.close();
    await cleanup();
    check('Limpieza: no quedan datos de prueba', (await q('SELECT COUNT(*) AS n FROM mobile_devices WHERE imei IN (?)', [IMEI]))[0].n === 0);
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
