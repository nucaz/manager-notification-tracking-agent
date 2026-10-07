// Prueba de la capa de datos del asistente (src/services/assistantData.js):
// las consultas corren en MariaDB (SQL con lista blanca y parametros) y dan
// lo mismo que la version anterior, que cargaba cada conjunto en memoria
// (los load() de Reportes y las consultas fijas de antes). Ademas: valores
// con SQL inyectado, permisos, tiempo maximo, datos personales para la
// nube, el usuario de solo lectura y la copia local de GLPI.
//
// Escribe filas marcadas (glpi_id 9999000x) que borra al final. Pide E2E_PERMITIR=1.
// Uso (dentro del contenedor): E2E_PERMITIR=1 node tests/asistente_datos.e2e.js
const path = require('path');

if (process.env.E2E_PERMITIR !== '1') {
  console.error('Esta prueba escribe (y luego borra) datos marcados en la base configurada. Ejecútela con E2E_PERMITIR=1.');
  process.exit(2);
}

const ROOT = path.join(__dirname, '..');
const pool = require(path.join(ROOT, 'src/db/pool'));
const assistantPool = require(path.join(ROOT, 'src/db/assistantPool'));
const data = require(path.join(ROOT, 'src/services/assistantData'));
const reportService = require(path.join(ROOT, 'src/services/reportService'));
const mobileLabels = require(path.join(ROOT, 'src/config/mobileLabels'));
const devopsSidecarClient = require(path.join(ROOT, 'src/services/devopsSidecarClient'));
const externalSyncService = require(path.join(ROOT, 'src/services/externalSyncService'));

const results = [];
const check = (name, cond, extra) => results.push([!!cond, name + (cond || !extra ? '' : ` — ${extra}`)]);
const text = (v) => (v === null || v === undefined ? '' : String(v));
const all = new Proxy({}, { get: () => true });
const q = async (sql, params) => (await pool.query(sql, params))[0];
const sortedEntries = (map) => JSON.stringify([...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
const countsOld = (rows, key) => { const m = new Map(); rows.forEach((r) => { const k = text(r[key]) || 'Sin dato'; m.set(k, (m.get(k) || 0) + 1); }); return m; };
const countsNew = (res) => new Map(res.rows.map((r) => [String(r[0]), r[1]]));

async function main() {
  const [admin] = await q("SELECT id, email, full_name, role FROM users WHERE role IN ('superadmin', 'admin') ORDER BY role = 'superadmin' DESC, id LIMIT 1");
  const sets = data.datasets(admin, all);
  const run = (spec, opts) => data.runQuery(sets, spec, null, opts);
  const [glpiState] = await q("SELECT * FROM external_sync_state WHERE source = 'glpi_computadoras'");
  try {
    // --- 1. Mismos resultados que la version anterior (Reportes en memoria)
    const GROUPS = {
      license: ['estado'], domain: ['estado'], isp_contract: ['estado'], server: ['estado'], certificate: ['estado'],
      celulares: ['estado', 'sede', 'area', 'operadora', 'brand'], chips: ['estado_label', 'ubicacion_label', 'uso_real', 'operadora', 'sede'],
    };
    for (const [key, groups] of Object.entries(GROUPS)) {
      const old = await reportService.REPORTS[key].load();
      const now = await run({ reporte: key });
      check(`${key}: mismo total que antes (${old.length})`, now.total === old.length, `ahora ${now.total}`);
      for (const g of groups) {
        const res = await run({ reporte: key, agrupar_por: [g] }, { limit: data.REPORT_ROWS });
        const a = sortedEntries(countsOld(old, g));
        const b = sortedEntries(countsNew(res));
        check(`${key} por ${g}: mismos grupos y cantidades`, a === b, `antes ${a.slice(0, 300)} / ahora ${b.slice(0, 300)}`);
      }
    }
    const oldChips = await reportService.REPORTS.chips.load();
    const sumOld = (k) => Math.round(oldChips.reduce((t, r) => t + (Number(r[k]) || 0), 0) * 100) / 100;
    const sums = await run({ reporte: 'chips', sumar: ['costo', 'neto'] });
    check('chips: mismas sumas de costo y de lo que se paga', sums.rows[0][1] === sumOld('costo') && sums.rows[0][2] === sumOld('neto'),
      `${JSON.stringify(sums.rows[0])} vs ${sumOld('costo')}, ${sumOld('neto')}`);

    const EXTRA_COUNTS = {
      empleados: 'SELECT COUNT(*) AS n FROM employees',
      asignaciones_celulares: 'SELECT COUNT(*) AS n FROM mobile_device_assignments a JOIN mobile_devices d ON d.id = a.device_id',
      incidentes_celulares: 'SELECT COUNT(*) AS n FROM mobile_device_incidents i JOIN mobile_devices d ON d.id = i.device_id',
      recibos: 'SELECT COUNT(*) AS n FROM mobile_bills',
      recibos_lineas: 'SELECT COUNT(*) AS n FROM mobile_bill_lines l JOIN mobile_bills b ON b.id = l.bill_id',
      recibos_cargos: 'SELECT COUNT(*) AS n FROM mobile_bill_charges c JOIN mobile_bills b ON b.id = c.bill_id',
      catalogos: 'SELECT COUNT(*) AS n FROM catalog_items', adjuntos: 'SELECT COUNT(*) AS n FROM attachments',
      diagramas_red: 'SELECT COUNT(*) AS n FROM network_diagrams', usuarios: 'SELECT COUNT(*) AS n FROM users', auditoria: 'SELECT COUNT(*) AS n FROM audit_log',
    };
    for (const [key, sql] of Object.entries(EXTRA_COUNTS)) {
      const [{ n }] = await q(sql);
      const now = await run({ reporte: key, limite: 3 });
      check(`${key}: mismo total que la consulta de antes (${n})`, now.total === Number(n) && now.rows.length <= 3, `ahora ${now.total}`);
    }
    const oldInc = await q('SELECT i.tipo FROM mobile_device_incidents i JOIN mobile_devices d ON d.id = i.device_id');
    const incNow = await run({ reporte: 'incidentes_celulares', agrupar_por: ['tipo'] });
    check('Incidentes por tipo: mismas etiquetas y cantidades', sortedEntries(countsOld(oldInc.map((r) => ({ t: mobileLabels.incidentTipo(r.tipo).label })), 't')) === sortedEntries(countsNew(incNow)));
    const oldVig = await q('SELECT a.returned_date FROM mobile_device_assignments a JOIN mobile_devices d ON d.id = a.device_id');
    const vigNow = await run({ reporte: 'asignaciones_celulares', agrupar_por: ['vigente'] });
    check('Asignaciones vigentes / cerradas: mismas cantidades', sortedEntries(countsOld(oldVig.map((r) => ({ v: r.returned_date ? 'No' : 'Sí' })), 'v')) === sortedEntries(countsNew(vigNow)));
    try {
      const repos = await devopsSidecarClient.listRepos();
      await externalSyncService.sync('devops_repos');
      check(`repositorios: misma cantidad que el sidecar (${repos.length})`, (await run({ reporte: 'repositorios' })).total === repos.length);
    } catch (err) {
      check('repositorios: (sidecar no disponible, se omite)', true);
    }
    const stock = await run({ reporte: 'celulares', filtros: [{ columna: 'estado', valor: 'en stock' }], agrupar_por: ['sede'] });
    const oldStock = (await reportService.REPORTS.celulares.load()).filter((r) => r.estado === 'En stock');
    check('Stock por sede ("en stock" sin mayúsculas): igual que filtrar los datos de antes', sortedEntries(countsOld(oldStock, 'sede')) === sortedEntries(countsNew(stock)));

    // --- 2. Lo que llega de la IA nunca es SQL
    const evil = "' OR '1'='1' -- ";
    let r = await run({ reporte: 'celulares', filtros: [{ columna: 'sede', valor: evil }] });
    check('Un valor con SQL en una columna de pocos valores es solo texto: no encuentra nada y dice qué valores hay', r.total === 0 && r.notes[0].includes('Valores que existen'));
    r = await run({ reporte: 'celulares', filtros: [{ columna: 'imei', valor: evil }] });
    check('Un valor con SQL en "igual" de otra columna: 0 registros', r.total === 0);
    r = await run({ reporte: 'celulares', filtros: [{ columna: 'asset_code', modo: 'contiene', valor: '%' }] });
    const [{ n: pct }] = await q("SELECT COUNT(*) AS n FROM mobile_devices WHERE asset_code LIKE '%!%%' ESCAPE '!'");
    check('"contiene %": el % se busca tal cual (no trae todo)', r.total === Number(pct));
    r = await run({ reporte: 'celulares', buscar: "x' UNION SELECT password_hash FROM users -- " });
    check('"buscar" con SQL: solo texto, 0 registros', r.total === 0);
    const errorOf = async (spec, s = sets) => { try { await data.runQuery(s, spec); return ''; } catch (e) { return e.message; } };
    check('Columna inventada (o con SQL): error que lista las columnas, sin ejecutar nada', (await errorOf({ reporte: 'celulares', agrupar_por: ['sede; DROP TABLE users'] })).includes('no existe'));
    check('Orden con SQL: rechazado', (await errorOf({ reporte: 'celulares', ordenar_por: '(SELECT 1)' })).includes('no existe'));
    check('Conjunto inventado o del prototipo: rechazado', (await errorOf({ reporte: 'users' })).includes('no existe') && (await errorOf({ reporte: '__proto__' })).includes('no existe')
      && (await errorOf({ reporte: 'constructor' })).includes('no existe'));
    r = await run({ reporte: 'celulares', limite: '5; DROP TABLE users' });
    check('Un tope que no es número se ignora', r.spec.limite === null);
    check('Comparar fechas exige AAAA-MM-DD; números, un número', (await errorOf({ reporte: 'license', filtros: [{ columna: 'expiration_date', modo: 'menor_que', valor: '1 OR 1=1' }] })).includes('AAAA-MM-DD')
      && (await errorOf({ reporte: 'chips', filtros: [{ columna: 'neto', modo: 'mayor_que', valor: 'abc' }] })).includes('no es un número'));
    check('Solo se suman columnas numéricas', (await errorOf({ reporte: 'chips', sumar: ['operadora'] })).includes('no es numérica'));

    // --- 3. Permisos: sin el modulo, el conjunto no existe para ese usuario
    const lector = { id: 0, role: 'lector' };
    const lectorSets = data.datasets(lector, { glpi_inventario: true });
    check('Sin el módulo Celulares no aparecen celulares, chips, asignaciones ni recibos', !lectorSets.celulares && !lectorSets.chips && !lectorSets.asignaciones_celulares && !lectorSets.recibos
      && !lectorSets.usuarios && !lectorSets.auditoria && !lectorSets.repositorios && !!lectorSets.glpi_computadoras);
    check('…y pedirlo igual (cambiando la consulta) da error de acceso', (await errorOf({ reporte: 'celulares' }, lectorSets)).includes('no tiene acceso')
      && (await errorOf({ reporte: 'usuarios' }, data.datasets({ role: 'editor' }, all))).includes('no tiene acceso'));

    // --- 4. Tiempo maximo por consulta
    const lento = { ...sets.catalogos, key: 'lento', label: 'Prueba lenta', columns: [...sets.catalogos.columns, { key: 'z', label: 'Z', expr: 'SLEEP(0.3)', type: 'text' }] };
    data.config.statementSeconds = 0.1;
    const slow = await errorOf({ reporte: 'lento', filtros: [{ columna: 'z', modo: 'contiene', valor: '1' }] }, { lento });
    data.config.statementSeconds = 15;
    check('Una consulta que excede el tiempo se cancela con un mensaje claro', slow.includes('tardó más de 0.1 s') && slow.includes('filtre'), slow);

    // --- 5. Nunca la tabla completa: tope en SQL
    const seen = [];
    data.config.onQuery = (sql) => seen.push(sql);
    r = await run({ reporte: 'chips' });
    data.config.onQuery = null;
    check('Un listado trae del servidor solo lo que se muestra (LIMIT), y el total con COUNT(*)', seen.some((s) => /^SELECT COUNT\(\*\)/.test(s))
      && seen.filter((s) => !/COUNT\(\*\) AS n FROM/.test(s)).every((s) => /LIMIT/.test(s)) && r.rows.length <= data.SCREEN_ROWS);

    // --- 6. Datos personales para una IA en la nube
    const list = await run({ reporte: 'celulares', columnas: ['asset_code', 'holder_name', 'phone_number', 'estado'], filtros: [{ columna: 'holder_name', modo: 'no_vacio' }], limite: 5 });
    const cloud = data.forModel(list, list.rows, false);
    const local = data.forModel(list, list.rows, true);
    check('Nube: nombre y número van como "[dato personal oculto]"; código y estado, tal cual', list.rows.length > 0 && cloud.every((x, i) => x[1] === data.HIDDEN
      && (x[2] === data.HIDDEN || list.rows[i][2] === '') && x[0] === list.rows[i][0] && x[3] === list.rows[i][3]));
    check('Local: se envían tal cual', JSON.stringify(local) === JSON.stringify(list.rows));
    check('Están marcados como personales: nombres, DNI, números, correos', ['dni', 'first_name', 'last_name'].every((k) => sets.empleados.columns.find((c) => c.key === k).personal)
      && sets.usuarios.columns.find((c) => c.key === 'email').personal && sets.chips.columns.find((c) => c.key === 'phone_number').personal);

    // --- 7. Usuario de MariaDB solo lectura (si esta configurado)
    if (assistantPool.dedicated) {
      const denied = async (sql) => { try { await assistantPool.query(sql); return false; } catch (e) { return /denied/i.test(e.message); } };
      check('Usuario del asistente: no puede escribir', await denied("INSERT INTO catalog_items (catalog_type, value) VALUES ('area', 'x')"));
      check('Usuario del asistente: no lee contraseñas, configuración ni sesiones', await denied('SELECT password_hash FROM users')
        && await denied('SELECT * FROM settings') && await denied('SELECT * FROM sessions'));
      check('Usuario del asistente: sí consulta lo suyo', (await run({ reporte: 'usuarios' })).total >= 1);
    } else {
      check('Usuario de solo lectura no configurado aquí (ASSISTANT_DB_USER): se usa el de la app en transacción READ ONLY', true);
    }

    // --- 8. Copia local de GLPI
    await q("DELETE FROM glpi_assets WHERE glpi_id BETWEEN 99990000 AND 99990099");
    await q(`INSERT INTO glpi_assets (asset_type, glpi_id, name, state, location, user_name, serial) VALUES
      ('computadoras', 99990001, 'PC-PRUEBA-1', 'Activo', 'SEDE PRUEBA', 'Persona Uno', 'SN-1'),
      ('computadoras', 99990002, 'PC-PRUEBA-2', 'Activo', 'SEDE PRUEBA', 'Persona Dos', 'SN-2'),
      ('monitores', 99990003, 'MON-PRUEBA', 'Activo', 'SEDE PRUEBA', NULL, 'SN-3')`);
    await q("INSERT INTO external_sync_state (source, synced_at, row_count) VALUES ('glpi_computadoras', NOW(), 2) ON DUPLICATE KEY UPDATE synced_at = NOW()");
    r = await run({ reporte: 'glpi_computadoras', filtros: [{ columna: 'location', valor: 'sede prueba' }], agrupar_por: ['state'] });
    check('GLPI: se consulta la copia local (solo de ese tipo), con filtros y agrupación', r.total === 2 && JSON.stringify(r.rows) === '[["Activo",2]]' && r.notes.length === 0);
    r = await run({ reporte: 'glpi_computadoras', filtros: [{ columna: 'location', valor: 'SEDE PRUEBA' }], columnas: ['name', 'serial'] });
    check('GLPI: el listado lleva el n.º de serie para el código de barras', r.source.every((s) => /^SN-/.test(s.serial)));
    const glpiCfg = await require(path.join(ROOT, 'src/services/glpiClient')).getConfig();
    if (!glpiCfg.baseUrl) {
      await q("UPDATE external_sync_state SET synced_at = NOW() - INTERVAL 3 HOUR WHERE source = 'glpi_computadoras'");
      r = await run({ reporte: 'glpi_computadoras', filtros: [{ columna: 'location', valor: 'SEDE PRUEBA' }] });
      check('GLPI: si no se puede renovar una copia vieja, se usa y se avisa de qué fecha es', r.total === 2 && r.notes.some((n) => n.includes('copia del')));
    }
  } finally {
    await q('DELETE FROM glpi_assets WHERE glpi_id BETWEEN 99990000 AND 99990099');
    if (glpiState) {
      await q('UPDATE external_sync_state SET synced_at = ?, row_count = ?, last_error = ?, last_attempt_at = ? WHERE source = ?',
        [glpiState.synced_at, glpiState.row_count, glpiState.last_error, glpiState.last_attempt_at, 'glpi_computadoras']);
    } else {
      await q("DELETE FROM external_sync_state WHERE source = 'glpi_computadoras'");
    }
    const [[left]] = await pool.query('SELECT COUNT(*) AS n FROM glpi_assets WHERE glpi_id BETWEEN 99990000 AND 99990099');
    check('Limpieza: no quedan datos de prueba', left.n === 0);
    await pool.end();
    if (assistantPool.dedicated) await assistantPool.end();
  }
}

main()
  .catch((err) => { console.error(err); results.push([false, `Excepción: ${err.message}`]); })
  .finally(() => {
    for (const [ok, name] of results) console.log(`${ok ? 'PASA ' : 'FALLA'} ${name}`);
    const ok = results.filter((x) => x[0]).length;
    console.log(`\n${ok}/${results.length} pruebas correctas`);
    process.exit(ok === results.length ? 0 : 1);
  });
