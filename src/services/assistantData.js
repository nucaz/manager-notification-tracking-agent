// Datos que el asistente "Preguntar a la IA" puede LEER, y la consulta que
// arma para cada pregunta. La IA nunca escribe SQL: pide
// { reporte, filtros, buscar, agrupar_por, sumar, columnas, ordenar_por,
// descendente, limite } y aqui se arma un SELECT con:
//   - solo columnas de la lista blanca de cada conjunto (expresiones SQL fijas);
//   - todo valor que llega de la IA como parametro "?";
//   - filtros, agrupacion, sumas, orden y tope en MariaDB, con sus indices
//     (nunca se carga una tabla completa en memoria);
//   - una conexion propia, START TRANSACTION READ ONLY y cada SELECT con
//     max_statement_time (15 s): aunque algo se colara, MariaDB rechaza
//     cualquier escritura y corta una consulta que se demore.
// El usuario puede ser uno de MariaDB solo con SELECT (src/db/assistantPool.js).
//
// Cada conjunto declara: from (FROM/JOIN fijo), base (su tabla principal,
// para buscar los valores de una columna sin los JOIN), columnas
// { key, label, expr, type: text|number|money|date, cat (pocos valores),
// personal (dato de una persona: no se envia a una IA en la nube), when /
// code (como se filtra por su etiqueta usando el indice de la columna real) },
// defaults, order, scope(user) (WHERE fijo con parametros) y, si sus datos
// vienen de afuera, ensure() (renueva la copia local: externalSyncService).
const mysql = require('mysql2');
const reportService = require('./reportService');
const glpiClient = require('./glpiClient');
const externalSyncService = require('./externalSyncService');
const labels = require('../config/mobileLabels');

const MODES = ['igual', 'contiene', 'distinto', 'vacio', 'no_vacio', 'menor_que', 'mayor_que'];
const SCREEN_ROWS = 300;     // filas que se muestran en el panel
const REPORT_ROWS = 20000;   // tope de un reporte temporal o un Excel
const VALUES_LIMIT = 2000;   // valores distintos que se revisan para resolver un "igual"
const HIDDEN = '[dato personal oculto]';

// Ajustables desde las pruebas (pool de otra base, tiempo maximo, registro de cada SELECT).
const config = { pool: null, statementSeconds: 15, onQuery: null };
const poolOf = () => config.pool || require('../db/assistantPool');

const lit = (v) => mysql.escape(v); // solo para constantes del codigo (etiquetas), nunca para lo que pide la IA
const text = (value) => (value === null || value === undefined ? '' : String(value));
const fold = (value) => text(value).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

const col = (key, label, expr, type = 'text', extra = {}) => ({ key, label, expr, type, ...extra });
const cat = (key, label, expr, extra = {}) => col(key, label, expr, 'text', { cat: true, ...extra });
const personal = (key, label, expr) => col(key, label, expr, 'text', { personal: true });
const labelsOf = (map) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, typeof v === 'string' ? v : v.label]));
// Columna guardada como codigo (ej. status = 'en_stock') que se muestra con
// su etiqueta: se filtra por el codigo (usa el indice), se muestra la etiqueta.
const coded = (key, label, field, map, extra = {}) => {
  const m = labelsOf(map);
  return cat(key, label, `CASE ${field} ${Object.entries(m).map(([k, v]) => `WHEN ${lit(k)} THEN ${lit(v)}`).join(' ')} ELSE COALESCE(${field}, '—') END`,
    { code: { field, map: m }, ...extra });
};
// Columna calculada con pocos valores fijos: cada etiqueta tiene su condicion.
const derived = (key, label, when) => cat(key, label,
  `CASE ${Object.entries(when).map(([v, cond]) => `WHEN ${cond} THEN ${lit(v)}`).join(' ')} END`, { when });
const flag = (key, label, cond) => derived(key, label, { 'Sí': cond, 'No': `NOT IFNULL(${cond}, 0)` });
const none = () => ({ sql: '1=1', params: [] });

// ---------------------------------------------------------------------
// Vencimientos (licencias, dominios, ISP, servidores, certificados)
// ---------------------------------------------------------------------
function expiry(key, table, dateField, columns) {
  const d = `t.${dateField}`;
  return {
    key, from: `${table} t`, base: `${table} t`,
    columns: [
      ...columns.map(([k, label, type = 'text', extra = {}]) => col(k, label, `t.${k}`, type, extra)),
      col('days_left', 'Días restantes', `DATEDIFF(${d}, CURDATE())`, 'number'),
      derived('estado', 'Estado', {
        'Sin fecha': `${d} IS NULL`,
        Vencido: `${d} < CURDATE()`,
        'Por vencer': `${d} BETWEEN CURDATE() AND CURDATE() + INTERVAL 30 DAY`,
        Activo: `${d} > CURDATE() + INTERVAL 30 DAY`,
      }),
    ],
    order: `${d} IS NULL, ${d}, t.id`,
  };
}
const C = (extra) => ['text', { cat: true, ...extra }];
const P = ['text', { personal: true }];

// ---------------------------------------------------------------------
// Celulares y chips
// ---------------------------------------------------------------------
const celulares = {
  key: 'celulares',
  from: `mobile_devices d LEFT JOIN mobile_device_assignments a ON a.device_id = d.id AND a.returned_date IS NULL`,
  base: 'mobile_devices d',
  columns: [
    col('asset_code', 'Código', 'd.asset_code'), col('imei', 'IMEI', 'd.imei'), cat('brand', 'Marca', 'd.brand'), cat('model', 'Modelo', 'd.model'),
    personal('phone_number', 'Número', 'd.phone_number'),
    personal('numero_2', 'Número 2 (doble SIM)', `(SELECT GROUP_CONCAT(l2.phone_number ORDER BY l2.id SEPARATOR ', ') FROM mobile_lines l2
      WHERE l2.device_id = d.id AND (d.phone_number IS NULL OR l2.phone_number <> d.phone_number))`),
    cat('operadora', 'Operadora', 'd.operadora'), coded('estado', 'Estado', 'd.status', labels.DEVICE_STATUS),
    cat('area', 'Área', 'd.area'), cat('sede', 'Sede', 'd.sede'), personal('holder_name', 'Asignado a', 'a.holder_name'),
    cat('cargo', 'Cargo', 'a.cargo'), cat('condicion', 'Condición', 'd.condicion'), col('purchase_date', 'Fecha de compra', 'd.purchase_date', 'date'),
  ],
  order: 'd.sede, d.area, d.asset_code, d.id',
};

const ubicacion = "CASE WHEN l.device_id IS NOT NULL THEN 'en_celular' WHEN la.id IS NOT NULL THEN la.uso ELSE 'en_stock' END";
const chips = {
  key: 'chips',
  from: `mobile_lines l
    LEFT JOIN mobile_devices d ON d.id = l.device_id
    LEFT JOIN mobile_device_assignments da ON da.device_id = d.id AND da.returned_date IS NULL
    LEFT JOIN mobile_line_assignments la ON la.line_id = l.id AND la.returned_date IS NULL
    LEFT JOIN employees e ON e.id = la.employee_id`,
  base: 'mobile_lines l',
  columns: [
    personal('phone_number', 'Número', 'l.phone_number'), cat('operadora', 'Operadora', 'l.operadora'), col('iccid', 'ICCID', 'l.iccid'),
    cat('plan', 'Plan', 'l.plan'), coded('estado_label', 'Estado', 'l.estado', labels.LINE_ESTADO),
    derived('ubicacion_label', 'Ubicación', Object.fromEntries(Object.entries(labels.LINE_UBICACION).map(([k, v]) => [v.label, `(${ubicacion}) = ${lit(k)}`]))),
    // Mismo criterio que chipUsageService.categoryOf (agrupado como en Reportes).
    derived('uso_real', 'Uso real', {
      'De baja': "l.estado = 'de_baja'",
      'En uso': "IFNULL(l.estado, '') <> 'de_baja' AND ((l.device_id IS NOT NULL AND d.status IN ('asignado', 'en_reparacion')) OR (l.device_id IS NULL AND la.uso IN ('personal', 'emergencia')))",
      Guardado: "IFNULL(l.estado, '') <> 'de_baja' AND NOT ((l.device_id IS NOT NULL AND IFNULL(d.status IN ('asignado', 'en_reparacion'), 0)) OR (l.device_id IS NULL AND IFNULL(la.uso IN ('personal', 'emergencia'), 0)))",
    }),
    col('asset_code', 'Celular (código)', 'd.asset_code'), col('imei', 'Celular (IMEI)', 'd.imei'),
    personal('holder', 'Titular', 'COALESCE(da.holder_name, la.holder_name)'),
    cat('area', 'Área', 'COALESCE(d.area, e.area)'), cat('sede', 'Sede', 'COALESCE(d.sede, e.sede)'),
    col('costo', 'Costo del plan', 'l.costo_plan', 'money'), col('descuento', 'Descuento', 'l.descuento_plan', 'money'),
    col('neto', 'Se paga', 'CASE WHEN l.costo_plan IS NULL THEN NULL ELSE ROUND(l.costo_plan - IFNULL(l.descuento_plan, 0), 2) END', 'money'),
  ],
  order: 'l.phone_number',
};

// ---------------------------------------------------------------------
// GLPI y DevOps: copias locales (externalSyncService)
// ---------------------------------------------------------------------
const GLPI_KIND = {
  state: C(), type: C(), manufacturer: C(), model: C(), location: C(), entity: C(), os: C(), os_version: C(), memory_type: C(), user: P,
};
function glpiSet(typeKey) {
  const type = glpiClient.ASSET_TYPES[typeKey];
  return {
    key: `glpi_${typeKey}`,
    from: 'glpi_assets g', base: 'glpi_assets g',
    scope: () => ({ sql: 'g.asset_type = ?', params: [typeKey] }),
    ensure: () => externalSyncService.ensureFresh(`glpi_${typeKey}`),
    columns: [col('id', 'ID GLPI', 'g.glpi_id', 'number'),
      ...type.columns.map((c) => col(c.key, c.label, `g.${c.key === 'user' ? 'user_name' : c.key}`, ...(GLPI_KIND[c.key] || ['text'])))],
    order: 'g.location, g.name, g.glpi_id',
  };
}

const repositorios = {
  key: 'repositorios',
  from: 'devops_repos r', base: 'devops_repos r',
  ensure: () => externalSyncService.ensureFresh('devops_repos'),
  columns: [
    col('name', 'Repositorio', 'r.name'), col('github_url', 'GitHub', 'r.github_url'), flag('activo', 'Activo', 'r.active = 1'),
    col('sync_interval_minutes', 'Sincroniza cada (min)', 'r.sync_interval_minutes', 'number'),
    col('ultima_sync', 'Última sincronización', "COALESCE(r.last_synced_at, 'Nunca')"), cat('last_sync_status', 'Resultado', 'r.last_sync_status'),
    col('ultima_auditoria', 'Última auditoría IA', 'r.last_audit'),
  ],
  order: 'r.name',
};

// Los conjuntos de Reportes: misma clave, titulo, acceso, filtros de lista y codigo de barras que alla.
const FROM_REPORTS = [
  expiry('license', 'software_licenses', 'expiration_date', [['product_name', 'Producto'], ['vendor', 'Proveedor', ...C()], ['assigned_to', 'Asignado a', ...P],
    ['seats', 'Puestos', 'number'], ['cost', 'Costo', 'money'], ['currency', 'Moneda', ...C()], ['expiration_date', 'Vence', 'date']]),
  expiry('domain', 'domains', 'expiration_date', [['domain_name', 'Dominio'], ['registrar', 'Registrador', ...C()], ['responsible', 'Responsable', ...P],
    ['renewal_cost', 'Costo de renovación', 'money'], ['currency', 'Moneda', ...C()], ['expiration_date', 'Vence', 'date']]),
  expiry('isp_contract', 'isp_contracts', 'end_date', [['provider', 'Proveedor', ...C()], ['contract_number', 'N.º de contrato'], ['bandwidth_down', 'Bajada'],
    ['bandwidth_up', 'Subida'], ['monthly_cost', 'Costo mensual', 'money'], ['currency', 'Moneda', ...C()], ['end_date', 'Termina', 'date']]),
  expiry('server', 'servers', 'support_expiration_date', [['name', 'Nombre'], ['asset_type', 'Tipo de activo', ...C()], ['environment', 'Ambiente', ...C()],
    ['criticality', 'Criticidad', ...C()], ['responsible', 'Responsable', ...P], ['status', 'Situación', ...C()], ['support_expiration_date', 'Vence el soporte', 'date']]),
  expiry('certificate', 'certificates', 'expiration_date', [['common_name', 'Dominio cubierto'], ['certificate_type', 'Tipo', ...C()], ['issuer', 'Emisor', ...C()],
    ['responsible', 'Responsable', ...P], ['cost', 'Costo', 'money'], ['currency', 'Moneda', ...C()], ['expiration_date', 'Vence', 'date']]),
  celulares, chips, glpiSet('computadoras'), glpiSet('monitores'), glpiSet('impresoras'), repositorios,
];

// ---------------------------------------------------------------------
// Datos que solo consulta el asistente
// ---------------------------------------------------------------------
const EXTRA = [
  { key: 'empleados', label: 'Empleados', module: 'empleados', from: 'employees e', base: 'employees e',
    columns: [personal('dni', 'DNI', 'e.dni'), personal('first_name', 'Nombres', 'e.first_name'), personal('last_name', 'Apellidos', 'e.last_name'),
      cat('area', 'Área', 'e.area'), cat('sede', 'Sede', 'e.sede'), cat('cargo', 'Cargo', 'e.cargo')],
    order: 'e.last_name, e.first_name, e.id' },
  { key: 'asignaciones_celulares', label: 'Asignaciones de celulares (historial: quién tuvo cada equipo)', module: 'celulares',
    from: 'mobile_device_assignments a JOIN mobile_devices d ON d.id = a.device_id', base: 'mobile_device_assignments a',
    columns: [col('asset_code', 'Código', 'd.asset_code'), col('imei', 'IMEI', 'd.imei'), cat('model', 'Modelo', 'd.model'),
      personal('holder_name', 'Persona', 'a.holder_name'), cat('cargo', 'Cargo', 'a.cargo'), cat('turno', 'Turno', 'a.turno'),
      col('assigned_date', 'Desde', 'a.assigned_date', 'date'), col('returned_date', 'Hasta', 'a.returned_date', 'date'),
      flag('vigente', 'Vigente', 'a.returned_date IS NULL'), cat('area', 'Área', 'd.area'), cat('sede', 'Sede', 'd.sede'),
      col('observacion', 'Observación', 'a.observacion'),
      cat('area_asignacion', 'Área durante la asignación', 'a.area'), cat('sede_asignacion', 'Sede durante la asignación', 'a.sede')],
    order: 'a.assigned_date DESC, a.id DESC' },
  { key: 'incidentes_celulares', label: 'Incidentes de celulares (reparaciones, accidentes, decomisos, bajas)', module: 'celulares',
    from: 'mobile_device_incidents i JOIN mobile_devices d ON d.id = i.device_id', base: 'mobile_device_incidents i',
    columns: [col('asset_code', 'Código', 'd.asset_code'), col('imei', 'IMEI', 'd.imei'), coded('tipo', 'Tipo', 'i.tipo', labels.INCIDENT_TIPO),
      cat('motivo', 'Motivo', `CASE i.motivo ${Object.entries(labels.DECOMISO_MOTIVO).map(([k, v]) => `WHEN ${lit(k)} THEN ${lit(v)}`).join(' ')} ELSE i.motivo END`,
        { code: { field: 'i.motivo', map: labels.DECOMISO_MOTIVO } }),
      col('fecha', 'Fecha', 'i.fecha', 'date'), col('fecha_resolucion', 'Resuelto el', 'i.fecha_resolucion', 'date'), col('costo', 'Costo', 'i.costo', 'money'),
      col('descripcion', 'Descripción', 'i.descripcion'), cat('area', 'Área', 'd.area'), cat('sede', 'Sede', 'd.sede')],
    order: 'i.fecha DESC, i.id DESC' },
  { key: 'recibos', label: 'Recibos de la operadora (totales por recibo)', module: 'celulares', from: 'mobile_bills b', base: 'mobile_bills b',
    columns: [cat('operadora', 'Operadora', 'b.operadora'), col('recibo_nro', 'N.º de recibo', 'b.recibo_nro'), col('fecha_emision', 'Emisión', 'b.fecha_emision', 'date'),
      col('periodo_inicio', 'Periodo desde', 'b.periodo_inicio', 'date'), col('periodo_fin', 'Periodo hasta', 'b.periodo_fin', 'date'),
      col('fecha_vencimiento', 'Vence', 'b.fecha_vencimiento', 'date'), col('total_pagar', 'Total a pagar', 'b.total_pagar', 'money'),
      col('total_lineas', 'Total líneas', 'b.total_lineas', 'money'), col('total_cargos', 'Total otros cargos', 'b.total_cargos', 'money'),
      col('saldo_anterior', 'Saldo anterior', 'b.saldo_anterior', 'money')],
    order: 'b.fecha_emision DESC, b.id DESC' },
  { key: 'recibos_lineas', label: 'Detalle de recibos: lo facturado por cada número', module: 'celulares',
    from: 'mobile_bill_lines l JOIN mobile_bills b ON b.id = l.bill_id', base: 'mobile_bill_lines l',
    columns: [cat('operadora', 'Operadora', 'b.operadora'), col('recibo_nro', 'N.º de recibo', 'b.recibo_nro'), col('fecha_emision', 'Emisión', 'b.fecha_emision', 'date'),
      personal('phone_number', 'Número', 'l.phone_number'), cat('plan', 'Plan', 'l.plan'), col('cargo_fijo', 'Cargo fijo', 'l.cargo_fijo', 'money'),
      col('descuento', 'Descuento', 'l.descuento', 'money'), col('otros', 'Otros', 'l.otros', 'money'), col('monto_total', 'Monto total', 'l.monto_total', 'money'),
      cat('descuento_tipo', 'Tipo de descuento', 'l.descuento_tipo')],
    order: 'b.fecha_emision DESC, l.phone_number' },
  { key: 'recibos_cargos', label: 'Detalle de recibos: equipos en cuotas y otros cargos', module: 'celulares',
    from: 'mobile_bill_charges c JOIN mobile_bills b ON b.id = c.bill_id', base: 'mobile_bill_charges c',
    columns: [cat('operadora', 'Operadora', 'b.operadora'), col('recibo_nro', 'N.º de recibo', 'b.recibo_nro'), col('fecha_emision', 'Emisión', 'b.fecha_emision', 'date'),
      col('descripcion', 'Descripción', 'c.descripcion'), col('imei', 'IMEI', 'c.imei'), cat('modelo', 'Modelo', 'c.modelo'),
      col('cuota_nro', 'Cuota', 'c.cuota_nro', 'number'), col('cuota_total', 'De cuotas', 'c.cuota_total', 'number'), col('monto', 'Monto', 'c.monto', 'money')],
    order: 'b.fecha_emision DESC, c.id' },
  { key: 'catalogos', label: 'Catálogos (sedes, áreas, marcas, modelos, operadoras)', from: 'catalog_items ci', base: 'catalog_items ci',
    columns: [cat('catalog_type', 'Catálogo', 'ci.catalog_type'), col('value', 'Valor', 'ci.value'), flag('activo', 'Activo', 'ci.active = 1')],
    order: 'ci.catalog_type, ci.value' },
  { key: 'adjuntos', label: 'Adjuntos y facturas (con lo que extrajo la IA)', module: 'licencias', from: 'attachments t', base: 'attachments t',
    columns: [cat('entity_type', 'Pertenece a', 't.entity_type'), cat('doc_type', 'Tipo de documento', 't.doc_type'), col('original_name', 'Archivo', 't.original_name'),
      col('uploaded_at', 'Subido el', 't.uploaded_at', 'date'), cat('extracted_provider', 'Proveedor', 't.extracted_provider'),
      col('extracted_invoice_number', 'N.º de factura', 't.extracted_invoice_number'), col('extracted_amount', 'Monto', 't.extracted_amount', 'money'),
      cat('extracted_currency', 'Moneda', 't.extracted_currency'), col('extracted_concept', 'Concepto', 't.extracted_concept'),
      col('extracted_issue_date', 'Emisión', 't.extracted_issue_date', 'date'), col('extracted_due_date', 'Vencimiento', 't.extracted_due_date', 'date'),
      cat('extracted_site', 'Local', 't.extracted_site')],
    order: 't.uploaded_at DESC, t.id DESC' },
  { key: 'diagramas_red', label: 'Diagramas de red', module: 'red', from: 'network_diagrams n', base: 'network_diagrams n',
    columns: [cat('category', 'Categoría', 'n.category'), col('title', 'Título', 'n.title'), col('description', 'Descripción', 'n.description'),
      col('version', 'Versión', 'n.version'), col('original_name', 'Archivo', 'n.original_name'), col('uploaded_at', 'Subido el', 'n.uploaded_at', 'date')],
    order: 'n.category, n.title' },
  // Solo administradores. Nunca contrasenas, secretos de 2FA ni tokens.
  { key: 'usuarios', label: 'Usuarios de la aplicación', adminOnly: true, from: 'users u', base: 'users u',
    columns: [personal('full_name', 'Nombre', 'u.full_name'), personal('email', 'Correo', 'u.email'), cat('role', 'Rol', 'u.role'),
      flag('activo', 'Activo', 'u.active = 1'), flag('dos_pasos', '2FA activo', 'u.otp_enabled = 1'), flag('bloqueado', 'Bloqueado', 'u.locked = 1'),
      col('created_at', 'Creado el', 'u.created_at', 'date')],
    order: 'u.full_name' },
  { key: 'auditoria', label: 'Auditoría (quién hizo qué)', adminOnly: true, from: 'audit_log al', base: 'audit_log al',
    columns: [col('created_at', 'Fecha', 'al.created_at', 'date'), personal('user_email', 'Usuario', 'al.user_email'), cat('action', 'Acción', 'al.action'),
      col('target', 'Sobre', 'al.target'), col('detail', 'Detalle', 'al.detail'), personal('ip_address', 'IP', 'al.ip_address')],
    order: 'al.created_at DESC, al.id DESC' },
];

const DATASETS = {};
for (const d of FROM_REPORTS) {
  const r = reportService.REPORTS[d.key];
  DATASETS[d.key] = { label: r.label, module: r.module, adminOnly: r.adminOnly, barcodes: r.barcodes || [], selects: (r.selects || []).map((s) => s.key), ...d };
}
for (const d of EXTRA) DATASETS[d.key] = { barcodes: [], selects: [], ...d };
for (const d of Object.values(DATASETS)) {
  d.defaults = d.defaults || d.columns.slice(0, 9).map((c) => c.key);
  d.scope = d.scope || none;
  d.baseAlias = d.base.split(/\s+/).pop();
}

// Lo que este usuario puede consultar (el mismo criterio que Reportes).
function datasets(user, enabledModules) {
  const out = {};
  for (const [key, d] of Object.entries(DATASETS)) {
    const ok = d.adminOnly ? !!(user && user.role === 'admin') : (!d.module || !!(enabledModules || {})[d.module]);
    if (ok) out[key] = { ...d, user };
  }
  return out;
}

// ---------------------------------------------------------------------
// Consulta
// ---------------------------------------------------------------------
function column(dataset, name) {
  const wanted = fold(name);
  return dataset.columns.find((c) => c.key === name) || dataset.columns.find((c) => fold(c.key) === wanted || fold(c.label) === wanted) || null;
}
const isNumeric = (c) => c.type === 'number' || c.type === 'money';
const likeOf = (value) => `%${text(value).replace(/[!%_]/g, (ch) => `!${ch}`)}%`; // con ESCAPE '!': %, _ y ! se buscan tal cual
const aliasesIn = (expr) => new Set([...String(expr).matchAll(/\b([a-z_][a-z0-9_]*)\.[a-z_]/gi)].map((m) => m[1]));

function cell(value, type) {
  if (value === null || value === undefined) return '';
  if (type === 'number') { const n = Number(value); return Number.isFinite(n) ? n : String(value); }
  if (type === 'money') { const n = Number(value); return Number.isFinite(n) ? n.toFixed(2) : String(value); }
  return String(value);
}

class QueryTimeout extends Error {}

// -> { spec, title, columns, personal, rows, total, lines, shown, grouped, reportUrl, notes, source, barcodes }
async function runQuery(sets, raw, _unused, { limit = SCREEN_ROWS } = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const key = text(input.reporte);
  const dataset = Object.prototype.hasOwnProperty.call(sets, key) ? sets[key] : null;
  if (!dataset) throw new Error(`El reporte "${key}" no existe o este usuario no tiene acceso. Disponibles: ${Object.keys(sets).join(', ')}.`);
  const need = (name) => {
    const c = column(dataset, name);
    if (!c) throw new Error(`La columna "${text(name)}" no existe en "${key}". Columnas: ${dataset.columns.map((x) => x.key).join(', ')}.`);
    return c;
  };
  const notes = dataset.ensure ? [...await dataset.ensure()] : [];
  const scope = dataset.scope(dataset.user);
  // Tabla minima para buscar los valores de una columna (sin los JOIN si no hacen falta).
  const fromFor = (expr) => {
    const used = new Set([...aliasesIn(expr), ...aliasesIn(scope.sql)]);
    return [...used].every((a) => a === dataset.baseAlias) ? dataset.base : dataset.from;
  };

  const conn = await poolOf().getConnection();
  let inTransaction = false;
  try {
    await conn.query('START TRANSACTION READ ONLY');
    inTransaction = true;
    const q = async (sql, params = []) => {
      if (config.onQuery) config.onQuery(sql, params);
      try {
        const [rows] = await conn.query(`SET STATEMENT max_statement_time=${Number(config.statementSeconds)} FOR ${sql}`, params);
        return rows;
      } catch (err) {
        if (err.errno === 1969 || err.code === 'ER_STATEMENT_TIMEOUT') {
          throw new QueryTimeout(`La consulta de "${dataset.label}" tardó más de ${config.statementSeconds} s y se canceló. Pida menos datos: filtre (por sede, estado o fechas) o use un tope.`);
        }
        throw err;
      }
    };

    const where = [scope.sql];
    const params = [...scope.params];
    const add = (sql, p = []) => { where.push(sql); params.push(...p); };
    const parts = [];
    const specFilters = [];
    const filters = (Array.isArray(input.filtros) ? input.filtros : []).slice(0, 8);
    let resolvedAll = true;
    const resolvedValues = [];
    for (const f of filters) {
      const c = need(f && f.columna);
      const mode = MODES.includes(f.modo) ? f.modo : 'igual';
      const value = text(f.valor).slice(0, 120);
      const e = `(${c.expr})`;
      let resolved = null;
      if (mode === 'vacio') add(c.type === 'text' ? `(${e} IS NULL OR ${e} = '')` : `${e} IS NULL`);
      else if (mode === 'no_vacio') add(c.type === 'text' ? `(${e} IS NOT NULL AND ${e} <> '')` : `${e} IS NOT NULL`);
      else if (mode === 'contiene') add(`${e} LIKE ? ESCAPE '!'`, [likeOf(value)]);
      else if (mode === 'menor_que' || mode === 'mayor_que') {
        const op = mode === 'menor_que' ? '<' : '>';
        if (isNumeric(c)) {
          const n = Number(value.replace(',', '.'));
          if (!value.trim() || !Number.isFinite(n)) throw new Error(`"${value}" no es un número para comparar en ${c.label}.`);
          add(`${e} ${op} ?`, [n]);
        } else if (c.type === 'date') {
          if (!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/.test(value.trim())) throw new Error(`Para comparar ${c.label} use una fecha AAAA-MM-DD (recibí "${value}").`);
          add(`${e} ${op} ?`, [value.trim()]);
        } else {
          add(`(${e} <> '' AND ${e} ${op} ?)`, [value]);
        }
      } else if (c.cat) {
        // "igual" / "distinto" en una columna de pocos valores: se busca el
        // valor real (sin mayusculas ni tildes; si nada es igual, lo que lo
        // contenga: "surco" -> "SEDE SURCO") y se filtra con IN (...).
        let found;
        if (c.when) found = Object.keys(c.when).map((label) => ({ label }));
        else if (c.code) {
          const rows = await q(`SELECT DISTINCT ${c.code.field} AS v FROM ${fromFor(c.code.field)} WHERE ${scope.sql} LIMIT ${VALUES_LIMIT}`, scope.params);
          found = rows.map((r) => ({ label: r.v === null ? '—' : (c.code.map[r.v] || String(r.v)), code: r.v }));
        } else {
          const rows = await q(`SELECT DISTINCT ${c.expr} AS v FROM ${fromFor(c.expr)} WHERE ${scope.sql} LIMIT ${VALUES_LIMIT}`, scope.params);
          found = rows.filter((r) => text(r.v) !== '').map((r) => ({ label: String(r.v) }));
        }
        const wanted = fold(value);
        let matches = found.filter((v) => fold(v.label) === wanted);
        if (!matches.length && wanted) matches = found.filter((v) => fold(v.label).includes(wanted));
        if (!matches.length) {
          notes.push(`Ningún registro tiene "${value}" en ${c.label}. Valores que existen: ${[...new Set(found.map((v) => v.label))].filter(Boolean).sort((a, b) => a.localeCompare(b, 'es')).slice(0, 40).join(', ') || '(ninguno)'}.`);
        }
        if (new Set(matches.map((m) => m.label)).size === 1) resolved = matches[0].label;
        let cond = null;
        let condParams = [];
        if (matches.length && c.when) cond = matches.map((m) => `(${c.when[m.label]})`).join(' OR ');
        else if (matches.length && c.code) {
          const codes = matches.map((m) => m.code).filter((v) => v !== null);
          cond = [codes.length ? `${c.code.field} IN (?)` : null, matches.some((m) => m.code === null) ? `${c.code.field} IS NULL` : null].filter(Boolean).join(' OR ');
          if (codes.length) condParams = [codes];
        } else if (matches.length) {
          cond = `${e} IN (?)`;
          condParams = [matches.map((m) => m.label)];
        }
        if (mode === 'distinto') add(cond ? `NOT IFNULL((${cond}), 0)` : '1=1', condParams);
        else add(cond ? `(${cond})` : '1=0', condParams);
      } else {
        // Otras columnas: igualdad en MariaDB; la intercalacion (*_ci, sin
        // distinguir mayusculas ni tildes) hace el resto.
        let v = value;
        if (isNumeric(c)) {
          const n = Number(value.replace(',', '.'));
          if (!value.trim() || !Number.isFinite(n)) throw new Error(`"${value}" no es un número para ${c.label}.`);
          v = n;
        }
        add(mode === 'distinto' ? `NOT IFNULL(${e} = ?, 0)` : `${e} = ?`, [v]);
      }
      if (mode !== 'igual' || resolved === null) resolvedAll = false;
      resolvedValues.push({ col: c, value: resolved });
      specFilters.push({ columna: c.key, modo: mode, valor: value });
      parts.push(`${c.label} ${mode === 'igual' ? '=' : mode.replace('_', ' ')} ${mode.includes('vacio') ? '' : value}`.trim());
    }

    const buscar = text(input.buscar).slice(0, 120);
    if (buscar.trim()) {
      add(`(${dataset.columns.map((c) => `(${c.expr}) LIKE ? ESCAPE '!'`).join(' OR ')})`, dataset.columns.map(() => likeOf(buscar.trim())));
      parts.push(`búsqueda "${buscar.trim()}"`);
    }
    const whereSql = where.join(' AND ');

    const groupBy = (Array.isArray(input.agrupar_por) ? input.agrupar_por : []).slice(0, 3).map(need);
    const sums = (Array.isArray(input.sumar) ? input.sumar : []).slice(0, 4).map(need);
    for (const s of sums) {
      if (!isNumeric(s)) throw new Error(`"${s.key}" no es numérica: no se puede sumar. Numéricas en "${key}": ${dataset.columns.filter(isNumeric).map((x) => x.key).join(', ') || '(ninguna)'}.`);
    }
    const grouped = !!(groupBy.length || sums.length);
    const top = Number.isInteger(input.limite) && input.limite > 0 ? Math.min(input.limite, REPORT_ROWS) : null;
    const descending = input.descendente === true;
    const fetchRows = Math.min(top || limit, limit);
    const spec = {
      reporte: key, filtros: specFilters, buscar: buscar.trim(), agrupar_por: groupBy.map((c) => c.key), sumar: sums.map((c) => c.key),
      columnas: [], ordenar_por: '', descendente: descending, limite: top,
    };

    const [{ n: totalRaw }] = await q(`SELECT COUNT(*) AS n FROM ${dataset.from} WHERE ${whereSql}`, params);
    const total = Number(totalRaw);
    let columns;
    let personalCols;
    let rows;
    let lines;
    let source = null;
    if (grouped) {
      columns = [...groupBy.map((c) => c.label), 'Cantidad', ...sums.map((c) => `Suma de ${c.label}`)];
      personalCols = [...groupBy.map((c) => !!c.personal), false, ...sums.map(() => false)];
      const gExpr = (c) => (c.type === 'text' ? `COALESCE(NULLIF(${c.expr}, ''), 'Sin dato')` : `(${c.expr})`);
      const selects = [...groupBy.map((c, i) => `${gExpr(c)} AS g${i}`), 'COUNT(*) AS n',
        ...sums.map((c, i) => `ROUND(COALESCE(SUM(${c.expr}), 0), 2) AS s${i}`), 'COUNT(*) OVER () AS total_groups'];
      const aliases = [...groupBy.map((_, i) => `g${i}`), 'n', ...sums.map((_, i) => `s${i}`)];
      const wantedOrder = fold(input.ordenar_por);
      const index = wantedOrder ? columns.findIndex((label, i) => fold(label) === wantedOrder
        || (i === groupBy.length && wantedOrder === 'cantidad')
        || (i < groupBy.length && fold(groupBy[i].key) === wantedOrder)
        || (i > groupBy.length && fold(sums[i - groupBy.length - 1].key) === wantedOrder)) : -1;
      let orderBy = ['n DESC', ...groupBy.map((_, i) => `g${i}`)].join(', ');
      if (index > -1) {
        orderBy = `${aliases[index]} ${descending ? 'DESC' : 'ASC'}, ${orderBy}`;
        spec.ordenar_por = columns[index];
      }
      const found = total === 0 && !groupBy.length ? [] : await q(
        `SELECT ${selects.join(', ')} FROM ${dataset.from} WHERE ${whereSql}${groupBy.length ? ` GROUP BY ${groupBy.map((_, i) => `g${i}`).join(', ')}` : ''} ORDER BY ${orderBy} LIMIT ?`,
        [...params, fetchRows]);
      lines = Math.min(found.length ? Number(found[0].total_groups) : 0, top || Infinity);
      rows = found.map((r) => [
        ...groupBy.map((c, i) => { const v = cell(r[`g${i}`], c.type); return v === '' ? 'Sin dato' : v; }),
        Number(r.n),
        ...sums.map((_, i) => Number(r[`s${i}`])),
      ]);
    } else {
      const wanted = (Array.isArray(input.columnas) ? input.columnas : []).slice(0, 14).map(need);
      const shown = wanted.length ? wanted : dataset.defaults.map(need);
      spec.columnas = shown.map((c) => c.key);
      columns = shown.map((c) => c.label);
      personalCols = shown.map((c) => !!c.personal);
      let orderBy = dataset.order;
      if (text(input.ordenar_por)) {
        const by = need(input.ordenar_por);
        spec.ordenar_por = by.key;
        orderBy = `(${by.expr}) IS NULL, (${by.expr}) ${descending ? 'DESC' : 'ASC'}, ${dataset.order}`;
      }
      const barcodeCols = dataset.barcodes.map((b) => need(b.key));
      const selects = [...shown.map((c, i) => `${c.expr} AS c${i}`), ...barcodeCols.map((c, i) => `${c.expr} AS b${i}`)];
      const found = fetchRows > 0 ? await q(`SELECT ${selects.join(', ')} FROM ${dataset.from} WHERE ${whereSql} ORDER BY ${orderBy} LIMIT ?`, [...params, fetchRows]) : [];
      rows = found.map((r) => shown.map((c, i) => cell(r[`c${i}`], c.type)));
      source = found.map((r) => Object.fromEntries(barcodeCols.map((c, i) => [c.key, cell(r[`b${i}`], c.type)])));
      lines = Math.min(total, top || total);
    }
    await conn.query('COMMIT');
    inTransaction = false;

    // Enlace al mismo resultado en Reportes (de ahi sale el PDF con codigo de
    // barras), cuando los filtros son de los que esa pantalla sabe aplicar.
    let reportUrl = null;
    if (reportService.REPORTS[key] && !top && resolvedAll && resolvedValues.every((r) => dataset.selects.includes(r.col.key))) {
      const p = new URLSearchParams({ modulo: key });
      resolvedValues.forEach((r) => p.set(`f_${r.col.key}`, r.value));
      if (spec.buscar) p.set('q', spec.buscar);
      reportUrl = `/reportes?${p.toString()}`;
    }
    if (top) parts.push(`primeros ${top}`);
    const title = `${dataset.label}${groupBy.length ? ` por ${groupBy.map((c) => c.label.toLowerCase()).join(' y ')}` : ''}${parts.length ? ` (${parts.join(', ')})` : ''}`;
    return {
      spec, title, columns, personal: personalCols, rows, total, lines, shown: rows.length, grouped, reportUrl, notes,
      source, barcodes: grouped ? [] : dataset.barcodes,
    };
  } finally {
    if (inTransaction) await conn.query('ROLLBACK').catch(() => {});
    conn.release();
  }
}

// Lo que se le pasa a la IA de una fila: con un proveedor en la nube, los
// datos personales van ocultos (el usuario los ve igual en la tabla).
function forModel(result, rows, local) {
  if (local) return rows;
  return rows.map((r) => r.map((v, i) => (result.personal[i] && v !== '' && v !== 'Sin dato' ? HIDDEN : v)));
}

// Tablas que lee el asistente (para el usuario de MariaDB solo con SELECT).
function tablesUsed() {
  const names = new Set();
  for (const d of Object.values(DATASETS)) {
    for (const m of `FROM ${d.from} ${d.columns.map((c) => c.expr).join(' ')}`.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/gi)) names.add(m[1]);
  }
  return [...names].sort();
}

module.exports = {
  DATASETS, MODES, SCREEN_ROWS, REPORT_ROWS, HIDDEN, config, datasets, runQuery, forModel, tablesUsed, QueryTimeout,
  _fold: fold,
};
