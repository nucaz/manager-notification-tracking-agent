// Reportes y consultas: un catalogo de reportes con la misma forma, para
// que la pantalla, el Excel, el CSV y el PDF imprimible salgan de un solo
// lugar. Hay tres familias:
//   - vencimientos (licencias, dominios, ISP, servidores, certificados)
//   - inventario (celulares, chips y lo que se lee de GLPI), con codigo de
//     barras para la verificacion fisica
//   - DevOps (repositorios del sidecar)
//   - Clinic, Microsoft 365, Solicitudes y el cruce por persona (celular,
//     Clinic y Microsoft 365 de cada empleado, con lo que hay que revisar)
//
// Cada reporte declara:
//   columns  -> columnas de pantalla y Excel/CSV: [{ key, label }]
//   print    -> columnas del PDF (pocas, las que sirven con el equipo en la mano): [{ key, label, w }]
//   barcodes -> que dato puede ir como codigo de barras: [{ key, label }] (el primero es el predeterminado)
//   selects  -> filtros de lista; sus opciones salen de los propios datos
//   groupBy  -> desgloses del resumen ("cuantos hay por...")
//   load()   -> todas las filas, ya con textos listos para mostrar
const ExcelJS = require('exceljs');
const pool = require('../db/pool');
const { daysUntil, statusFromDays } = require('./expirationService');
const mobileLabels = require('../config/mobileLabels');
const mobileLineService = require('./mobileLineService');
const chipUsageService = require('./chipUsageService');
const glpiClient = require('./glpiClient');
const devopsSidecarClient = require('./devopsSidecarClient');
const clinicService = require('./clinicService');
const m365Service = require('./m365Service');
const requestService = require('./requestService');

const STATUS_LABEL = { vencido: 'Vencido', por_vencer: 'Por vencer', activo: 'Activo', sin_fecha: 'Sin fecha' };
const STATUS_BADGE = { vencido: 'bg-danger', por_vencer: 'bg-warning text-dark', activo: 'bg-success', sin_fecha: 'bg-secondary' };
const join = (...parts) => parts.filter((p) => p !== null && p !== undefined && String(p).trim() !== '').join(' ');
const pair = (a, b, sep = ' / ') => [a, b].filter((p) => p !== null && p !== undefined && String(p).trim() !== '').join(sep);
const stacked = (a, b) => pair(a, b, '\n'); // en el PDF, un dato por renglon de la celda
const money = (n) => (n === null || n === undefined || n === '' ? '' : Number(n).toFixed(2));

// ---------------------------------------------------------------------
// Vencimientos
// ---------------------------------------------------------------------
function expiry({ label, table, dateField, columns }) {
  return {
    label,
    group: 'Vencimientos',
    kind: 'vencimientos',
    columns: [...columns.map(([key, text]) => ({ key, label: text })), { key: 'days_left', label: 'Días restantes' },
      { key: 'estado', label: 'Estado', badge: (r) => STATUS_BADGE[r.computed_status] }],
    print: [...columns.map(([key, text]) => ({ key, label: text, w: key === columns[0][0] ? 2 : 1 })), { key: 'days_left', label: 'Días', w: 0.6 },
      { key: 'estado', label: 'Estado', w: 0.9 }],
    barcodes: [],
    selects: [],
    groupBy: [{ key: 'estado', label: 'Por estado' }],
    async load({ from, to, status } = {}) {
      const [rows] = await pool.query(`SELECT * FROM ${table}`);
      let list = rows.map((r) => {
        const days = daysUntil(r[dateField]);
        const computed = statusFromDays(days);
        return { ...r, _date: r[dateField], days_left: days, computed_status: computed, estado: STATUS_LABEL[computed] };
      });
      if (from) list = list.filter((r) => r._date && r._date >= from);
      if (to) list = list.filter((r) => r._date && r._date <= to);
      if (status) list = list.filter((r) => r.computed_status === status);
      return list.sort((a, b) => (a.days_left ?? 9999) - (b.days_left ?? 9999));
    },
  };
}

// ---------------------------------------------------------------------
// Inventario propio: celulares y chips
// ---------------------------------------------------------------------
const celulares = {
  label: 'Celulares (equipos)',
  group: 'Inventario',
  module: 'celulares',
  columns: [
    { key: 'asset_code', label: 'Código' }, { key: 'imei', label: 'IMEI' }, { key: 'brand', label: 'Marca' }, { key: 'model', label: 'Modelo' },
    { key: 'phone_number', label: 'Número' }, { key: 'numero_2', label: 'Número 2 (doble SIM)' }, { key: 'operadora', label: 'Operadora' },
    { key: 'estado', label: 'Estado' }, { key: 'area', label: 'Área' }, { key: 'sede', label: 'Sede' }, { key: 'holder_name', label: 'Asignado a' }, { key: 'cargo', label: 'Cargo' },
    { key: 'condicion', label: 'Condición' }, { key: 'purchase_date', label: 'Fecha de compra' },
  ],
  print: [
    { key: 'asset_code', label: 'Código', w: 0.75 }, { key: 'equipo', label: 'Equipo', w: 1.05 }, { key: 'numeros', label: 'Número(s)', w: 0.95 },
    { key: 'holder_name', label: 'Asignado a', w: 1.4 }, { key: 'lugar', label: 'Área / Sede', w: 1.3 }, { key: 'estado', label: 'Estado', w: 0.75 },
  ],
  barcodes: [{ key: 'imei', label: 'IMEI' }, { key: 'asset_code', label: 'Código interno' }, { key: 'phone_number', label: 'Número' }, { key: 'numero_2', label: 'Número 2' }],
  selects: [{ key: 'estado', label: 'Estado' }, { key: 'sede', label: 'Sede' }, { key: 'area', label: 'Área' }, { key: 'operadora', label: 'Operadora' }],
  groupBy: [{ key: 'estado', label: 'Por estado' }, { key: 'sede', label: 'Por sede' }],
  async load() {
    const [rows] = await pool.query(`
      SELECT d.*, a.holder_name, a.cargo,
             (SELECT GROUP_CONCAT(l.phone_number ORDER BY l.id SEPARATOR ', ') FROM mobile_lines l
              WHERE l.device_id = d.id AND (d.phone_number IS NULL OR l.phone_number <> d.phone_number)) AS numero_2
      FROM mobile_devices d
      LEFT JOIN mobile_device_assignments a ON a.device_id = d.id AND a.returned_date IS NULL
      ORDER BY d.sede IS NULL, d.sede, d.area, d.asset_code, d.id`);
    return rows.map((d) => ({
      ...d, estado: mobileLabels.deviceStatus(d.status).label, equipo: join(d.brand, d.model), lugar: stacked(d.area, d.sede),
      numeros: stacked(d.phone_number, d.numero_2),
    }));
  },
};

const chips = {
  label: 'Chips (líneas)',
  group: 'Inventario',
  module: 'celulares',
  columns: [
    { key: 'phone_number', label: 'Número' }, { key: 'operadora', label: 'Operadora' }, { key: 'iccid', label: 'ICCID' }, { key: 'plan', label: 'Plan' },
    { key: 'estado_label', label: 'Estado' }, { key: 'ubicacion_label', label: 'Ubicación' }, { key: 'uso_real', label: 'Uso real' },
    { key: 'asset_code', label: 'Celular (código)' },
    { key: 'imei', label: 'Celular (IMEI)' }, { key: 'holder', label: 'Titular' }, { key: 'area', label: 'Área' }, { key: 'sede', label: 'Sede' },
    { key: 'costo', label: 'Costo del plan' }, { key: 'descuento', label: 'Descuento' }, { key: 'neto', label: 'Se paga' },
  ],
  print: [
    { key: 'phone_number', label: 'Número', w: 1 }, { key: 'operadora', label: 'Operadora', w: 0.95 }, { key: 'ubicacion_label', label: 'Ubicación', w: 1 },
    { key: 'donde', label: 'Celular / Titular', w: 1.55 }, { key: 'lugar', label: 'Área / Sede', w: 1.5 }, { key: 'estado_label', label: 'Estado', w: 0.9 },
  ],
  barcodes: [{ key: 'phone_number', label: 'Número' }, { key: 'iccid', label: 'ICCID' }],
  selects: [{ key: 'uso_real', label: 'Uso real' }, { key: 'estado_label', label: 'Estado' }, { key: 'operadora', label: 'Operadora' }, { key: 'ubicacion_label', label: 'Ubicación' },
    { key: 'sede', label: 'Sede' }],
  groupBy: [{ key: 'uso_real', label: 'Por uso real' }, { key: 'operadora', label: 'Por operadora' }, { key: 'estado_label', label: 'Por estado' }, { key: 'ubicacion_label', label: 'Por ubicación' }],
  async load() {
    const rows = await mobileLineService.listLines({});
    return rows.map((l) => ({
      ...l, estado_label: mobileLabels.lineEstado(l.estado).label, ubicacion_label: mobileLabels.lineUbicacion(l.ubicacion).label,
      donde: stacked(l.asset_code, l.holder), lugar: stacked(l.area, l.sede),
      uso_real: chipUsageService.GROUPS[chipUsageService.CATEGORIES[chipUsageService.categoryOf(l)].group].split(':')[0],
      costo: money(l.costo_plan), descuento: money(l.descuento_plan), neto: money(mobileLineService.netCost(l)),
    }));
  },
};

// ---------------------------------------------------------------------
// Inventario de GLPI: computadoras, monitores e impresoras
// ---------------------------------------------------------------------
function glpi(typeKey) {
  const type = glpiClient.ASSET_TYPES[typeKey];
  return {
    label: `${type.label} (GLPI)`,
    group: 'Inventario',
    module: 'glpi_inventario',
    columns: [{ key: 'id', label: 'ID GLPI' }, ...type.columns.map((c) => ({ key: c.key, label: c.label }))],
    print: [
      { key: 'name', label: 'Nombre', w: 1.2 }, { key: 'equipo', label: 'Fabricante / Modelo', w: 1.4 }, { key: 'user', label: 'Usuario', w: 1 },
      { key: 'location', label: 'Ubicación', w: 1.3 }, { key: 'state', label: 'Estado', w: 0.8 },
    ],
    barcodes: [{ key: 'serial', label: 'N.º de serie' }, { key: 'otherserial', label: 'N.º de inventario' }, { key: 'name', label: 'Nombre' }],
    selects: [{ key: 'state', label: 'Estado' }, { key: 'entity', label: 'Entidad' }, { key: 'location', label: 'Ubicación' }, { key: 'type', label: 'Tipo' }],
    groupBy: [{ key: 'state', label: 'Por estado' }, { key: 'entity', label: 'Por entidad' }, { key: 'type', label: 'Por tipo' }],
    async load() {
      const rows = await glpiClient.listAllItems(typeKey, {});
      return rows.map((r) => ({ ...r, equipo: pair(r.manufacturer, r.model) }))
        .sort((a, b) => String(a.location || '').localeCompare(String(b.location || ''), 'es') || String(a.name || '').localeCompare(String(b.name || ''), 'es'));
    },
  };
}

// ---------------------------------------------------------------------
// Usuarios de Clinic, Microsoft 365 y Solicitudes
// ---------------------------------------------------------------------
const day = (v) => (v ? String(v).slice(0, 10) : '');
const yesNo = (v) => (v ? 'Sí' : 'No');
// Tramo de antiguedad de la ultima conexion (los mismos del tablero de Clinic).
const loginBucket = (last) => clinicService.bucketLabel(clinicService.bucketOf(last));
// Empleado de planilla, creado desde Clinic o sin empleado.
const payroll = (employeeId, source) => (!employeeId ? 'Sin empleado' : (source === 'clinic' ? 'Creado desde Clinic' : 'Planilla / directorio'));

const clinicUsuarios = {
  label: 'Usuarios de Clinic',
  group: 'Clinic',
  module: 'clinic',
  columns: [
    { key: 'clinic_id', label: 'Id Clinic' }, { key: 'username', label: 'Usuario' }, { key: 'full_name', label: 'Nombre' }, { key: 'dni', label: 'DNI' },
    { key: 'profile_name', label: 'Perfil' }, { key: 'sede_name', label: 'Sede' }, { key: 'area_name', label: 'Área' },
    { key: 'supervisor_username', label: 'Supervisor' }, { key: 'estado', label: 'Estado aquí' }, { key: 'en_clinic', label: 'Estado en Clinic' },
    { key: 'aprobado', label: 'Aprobado' }, { key: 'ultima', label: 'Última conexión' }, { key: 'tramo', label: 'Antigüedad de conexión' },
    { key: 'planilla', label: 'Empleado' }, { key: 'registered_by', label: 'Creado en Clinic por' }, { key: 'creado', label: 'Fecha de creación' },
    { key: 'baja', label: 'Fecha de baja' }, { key: 'baja_reason', label: 'Motivo de baja' },
  ],
  print: [
    { key: 'username', label: 'Usuario', w: 0.9 }, { key: 'full_name', label: 'Nombre', w: 1.6 }, { key: 'lugar', label: 'Perfil / Sede', w: 1.4 },
    { key: 'tramo', label: 'Conexión', w: 0.9 }, { key: 'estado', label: 'Estado', w: 0.7 },
  ],
  barcodes: [{ key: 'username', label: 'Usuario' }, { key: 'dni', label: 'DNI' }],
  selects: [{ key: 'estado', label: 'Estado' }, { key: 'tramo', label: 'Conexión' }, { key: 'sede_name', label: 'Sede' }, { key: 'profile_name', label: 'Perfil' },
    { key: 'planilla', label: 'Empleado' }, { key: 'aprobado', label: 'Aprobado' }],
  groupBy: [{ key: 'estado', label: 'Por estado' }, { key: 'tramo', label: 'Por antigüedad de conexión' }, { key: 'sede_name', label: 'Por sede' },
    { key: 'planilla', label: 'Por vínculo con Empleados' }, { key: 'profile_name', label: 'Por perfil' }],
  async load() {
    const { items } = await clinicService.list(clinicService.filtersOf({}), { all: true });
    const [emps] = await pool.query("SELECT id FROM employees WHERE source = 'clinic'");
    const fromClinic = new Set(emps.map((e) => e.id));
    const [origin] = await pool.query('SELECT clinic_user_id, clinic_status FROM clinic_user_origin');
    const clinicStatus = new Map(origin.map((o) => [o.clinic_user_id, o.clinic_status]));
    return items.map((c) => ({
      ...c, estado: clinicService.STATUS[c.status].label, aprobado: (clinicService.APPROVAL[c.approved] || {}).label || String(c.approved),
      en_clinic: clinicService.STATUS[clinicStatus.get(c.id)] ? clinicService.STATUS[clinicStatus.get(c.id)].label : '',
      ultima: dateTime(c.last_login_at), tramo: loginBucket(c.last_login_at), creado: day(c.registered_at), baja: day(c.baja_date),
      planilla: payroll(c.employee_id, fromClinic.has(c.employee_id) ? 'clinic' : null), lugar: stacked(c.profile_name, c.sede_name),
    }));
  },
};

const m365Cuentas = {
  label: 'Cuentas de Microsoft 365',
  group: 'Microsoft 365',
  module: 'm365',
  columns: [
    { key: 'upn', label: 'Correo' }, { key: 'display_name', label: 'Nombre' }, { key: 'dni', label: 'DNI' }, { key: 'cargo', label: 'Cargo' },
    { key: 'area', label: 'Área' }, { key: 'sede', label: 'Sede' }, { key: 'tipo', label: 'Tipo' }, { key: 'estado', label: 'Estado' },
    { key: 'jefatura', label: 'Jefatura' }, { key: 'licenses', label: 'Licencias (registradas)' }, { key: 'tenant', label: 'En el tenant' },
    { key: 'tenant_licenses', label: 'Licencias (tenant)' }, { key: 'diferencias', label: 'Diferencias' },
    { key: 'ultima', label: 'Última conexión' }, { key: 'conexion_label', label: 'Antigüedad de conexión' },
  ],
  print: [
    { key: 'upn', label: 'Correo', w: 1.6 }, { key: 'display_name', label: 'Nombre', w: 1.3 }, { key: 'lugar', label: 'Cargo / Área', w: 1.3 },
    { key: 'estado', label: 'Estado', w: 0.8 }, { key: 'licenses', label: 'Licencias', w: 1.2 },
  ],
  barcodes: [],
  selects: [{ key: 'estado', label: 'Estado' }, { key: 'tipo', label: 'Tipo' }, { key: 'area', label: 'Área' }, { key: 'sede', label: 'Sede' },
    { key: 'con_diferencias', label: 'Con diferencias' }, { key: 'conexion_label', label: 'Conexión' }],
  groupBy: [{ key: 'estado', label: 'Por estado' }, { key: 'conexion_label', label: 'Por antigüedad de conexión' }, { key: 'tipo', label: 'Por tipo' },
    { key: 'area', label: 'Por área' }, { key: 'con_diferencias', label: 'Diferencias con el tenant' }],
  async load() {
    const rows = await m365Service.list({});
    const [emps] = await pool.query('SELECT id, dni FROM employees');
    const dni = new Map(emps.map((e) => [e.id, e.dni]));
    return rows.map((a) => ({
      ...a, dni: dni.get(a.employee_id) || '', tipo: m365Service.ACCOUNT_TYPES[a.account_type] || a.account_type,
      estado: (m365Service.STATUS[a.status] || {}).label || a.status, jefatura: yesNo(a.is_manager),
      tenant: a.tenant_enabled === null || a.tenant_enabled === undefined ? 'Sin leer' : (a.tenant_enabled ? 'Puede iniciar sesión' : 'Bloqueada'),
      diferencias: a.diffs.join('; '), con_diferencias: yesNo(a.diffs.length), lugar: stacked(a.cargo, a.area),
      ultima: a.last_seen ? String(a.last_seen).slice(0, a.last_seen.length > 10 ? 16 : 10) : '',
    }));
  },
};

const m365Licencias = {
  label: 'Licencias del tenant (Microsoft 365)',
  group: 'Microsoft 365',
  module: 'm365',
  columns: [
    { key: 'nombre', label: 'Licencia' }, { key: 'part_number', label: 'Código (SKU)' }, { key: 'prepaid', label: 'Compradas' },
    { key: 'consumed', label: 'Asignadas' }, { key: 'libres', label: 'Libres' }, { key: 'situacion', label: 'Situación' }, { key: 'leido', label: 'Leído del tenant' },
  ],
  print: [
    { key: 'nombre', label: 'Licencia', w: 2 }, { key: 'prepaid', label: 'Compradas', w: 0.7 }, { key: 'consumed', label: 'Asignadas', w: 0.7 },
    { key: 'libres', label: 'Libres', w: 0.6 }, { key: 'situacion', label: 'Situación', w: 0.9 },
  ],
  barcodes: [],
  selects: [{ key: 'situacion', label: 'Situación' }],
  groupBy: [{ key: 'situacion', label: 'Por situación' }],
  async load() {
    const [rows] = await pool.query('SELECT * FROM m365_skus ORDER BY COALESCE(friendly_name, part_number)');
    return rows.map((s) => {
      const libres = Number(s.prepaid) - Number(s.consumed);
      return { ...s, nombre: s.friendly_name || s.part_number, libres, leido: dateTime(s.synced_at),
        situacion: libres < 0 ? 'Excedida' : (libres === 0 ? 'Agotada' : 'Con licencias libres') };
    });
  },
};

const solicitudes = {
  label: 'Solicitudes (quién pidió qué)',
  group: 'Solicitudes',
  module: 'solicitudes',
  columns: [
    { key: 'id', label: 'N.º' }, { key: 'fecha', label: 'Fecha' }, { key: 'modulo', label: 'Módulo' }, { key: 'tipo', label: 'Tipo' },
    { key: 'requested_by_name', label: 'Solicitado por' }, { key: 'requested_by_cargo', label: 'Cargo' }, { key: 'requested_by_area', label: 'Área' },
    { key: 'request_ref', label: 'Referencia' }, { key: 'beneficiary_name', label: 'Para' }, { key: 'estado', label: 'Estado' },
    { key: 'pasos', label: 'Pasos' }, { key: 'completada', label: 'Completada' },
  ],
  print: [
    { key: 'fecha', label: 'Fecha', w: 0.7 }, { key: 'que', label: 'Módulo / Tipo', w: 1.3 }, { key: 'requested_by_name', label: 'Solicitado por', w: 1.3 },
    { key: 'beneficiary_name', label: 'Para', w: 1.3 }, { key: 'estado', label: 'Estado', w: 0.8 },
  ],
  barcodes: [],
  selects: [{ key: 'modulo', label: 'Módulo' }, { key: 'tipo', label: 'Tipo' }, { key: 'estado', label: 'Estado' }, { key: 'requested_by_name', label: 'Solicitado por' }],
  groupBy: [{ key: 'modulo', label: 'Por módulo' }, { key: 'estado', label: 'Por estado' }, { key: 'requested_by_name', label: 'Por solicitante' }],
  async load() {
    const types = { ...m365Service.REQUEST_TYPES, asignacion: 'Asignación de celular', reactivacion: 'Reactivación' };
    const rows = await requestService.list({ limit: 20000 });
    return rows.map((r) => ({
      ...r, fecha: day(r.request_date), modulo: requestService.MODULES[r.module] || r.module, tipo: types[r.request_type] || r.request_type,
      estado: (requestService.STATUS[r.status] || {}).label || r.status, pasos: r.tasks_total ? `${r.tasks_done}/${r.tasks_total}` : '',
      completada: dateTime(r.completed_at), que: stacked(requestService.MODULES[r.module] || r.module, types[r.request_type] || r.request_type),
    }));
  },
};

// Cruce por persona: celular asignado, usuario(s) de Clinic y cuenta(s) de
// Microsoft 365 de cada empleado, mas los accesos ACTIVOS que no tienen
// empleado. Marca lo que no cuadra (ej. retirado con acceso vigente).
const personas = {
  label: 'Accesos por persona (celular, Clinic y Microsoft 365)',
  group: 'Cruces',
  module: 'empleados',
  columns: [
    { key: 'persona', label: 'Persona' }, { key: 'dni', label: 'DNI' }, { key: 'origen', label: 'Empleado' }, { key: 'area', label: 'Área' },
    { key: 'sede', label: 'Sede' }, { key: 'celulares', label: 'Celular(es) asignado(s)' }, { key: 'clinic', label: 'Clinic' },
    { key: 'clinic_conexion', label: 'Última conexión a Clinic' }, { key: 'm365', label: 'Microsoft 365' }, { key: 'alertas', label: 'Revisar' },
  ],
  print: [
    { key: 'persona', label: 'Persona', w: 1.5 }, { key: 'dni', label: 'DNI', w: 0.7 }, { key: 'celulares', label: 'Celular', w: 1 },
    { key: 'clinic', label: 'Clinic', w: 1.1 }, { key: 'm365', label: 'Microsoft 365', w: 1.4 }, { key: 'alertas', label: 'Revisar', w: 1.4 },
  ],
  barcodes: [{ key: 'dni', label: 'DNI' }],
  selects: [{ key: 'con_alerta', label: 'Con algo que revisar' }, { key: 'origen', label: 'Empleado' }, { key: 'sede', label: 'Sede' }, { key: 'area', label: 'Área' }],
  groupBy: [{ key: 'con_alerta', label: 'Con algo que revisar' }, { key: 'origen', label: 'Por vínculo con Empleados' }, { key: 'sede', label: 'Por sede' }],
  async load() {
    const [emps] = await pool.query('SELECT id, dni, first_name, last_name, area, sede, source FROM employees ORDER BY last_name, first_name');
    const [phones] = await pool.query(
      `SELECT a.employee_id, d.imei, d.phone_number, d.asset_code FROM mobile_device_assignments a
       JOIN mobile_devices d ON d.id = a.device_id WHERE a.returned_date IS NULL AND a.employee_id IS NOT NULL`
    );
    const [clin] = await pool.query(
      `SELECT c.id, c.employee_id, c.dni, c.username, c.full_name, c.status, o.clinic_status, o.last_login_at, s.name AS sede_name
       FROM clinic_users c LEFT JOIN clinic_user_origin o ON o.clinic_user_id = c.id LEFT JOIN clinic_sedes s ON s.id = c.sede_id`
    );
    const [accs] = await pool.query("SELECT employee_id, upn, display_name, status, sede, area FROM m365_accounts WHERE account_type = 'usuario'");
    const by = (list, k) => list.reduce((m, x) => { if (x[k]) (m.get(x[k]) || m.set(x[k], []).get(x[k])).push(x); return m; }, new Map());
    const phonesBy = by(phones, 'employee_id');
    const clinicBy = by(clin, 'employee_id');
    const m365By = by(accs, 'employee_id');
    const label = (s, map) => (map[s] || {}).label || s;
    const describe = (person) => {
      const ph = person.phones || [];
      const cl = person.clinic || [];
      const ms = person.m365 || [];
      const clinicActive = cl.some((c) => c.status === 'activo' || (c.status === 'baja' && c.clinic_status === 'activo'));
      const clinicOff = cl.length && cl.every((c) => c.status !== 'activo');
      const m365Active = ms.some((a) => a.status === 'activa');
      const m365Off = ms.length && ms.every((a) => a.status !== 'activa');
      const alerts = [];
      if (cl.some((c) => c.status === 'baja' && c.clinic_status === 'activo')) alerts.push('Baja aquí pero ACTIVO en Clinic');
      if (m365Off && clinicActive) alerts.push('Microsoft 365 dada de baja y Clinic activo');
      if (clinicOff && m365Active) alerts.push('Clinic dado de baja y Microsoft 365 activa');
      if ((m365Off || clinicOff) && ph.length) alerts.push('Celular asignado a alguien con accesos dados de baja');
      if (cl.filter((c) => c.status === 'activo').length > 1) alerts.push('Más de un usuario de Clinic activo');
      if (person.origen !== 'Planilla / directorio' && (clinicActive || m365Active)) alerts.push('Accesos activos sin empleado en planilla');
      const last = cl.map((c) => c.last_login_at).filter(Boolean).sort().pop();
      return {
        ...person,
        celulares: ph.map((p) => join(p.asset_code, p.phone_number || p.imei)).join(', '),
        clinic: cl.map((c) => `${c.username} (${label(c.status, clinicService.STATUS).toLowerCase()}${c.status === 'baja' && c.clinic_status === 'activo' ? ', activo en Clinic' : ''})`).join(', '),
        clinic_conexion: last ? `${day(last)} · ${loginBucket(last)}` : (cl.length ? 'Nunca entró' : ''),
        m365: ms.map((a) => `${a.upn} (${label(a.status, m365Service.STATUS).toLowerCase()})`).join(', '),
        alertas: alerts.join('; '), con_alerta: yesNo(alerts.length),
      };
    };
    const out = emps.map((e) => describe({
      persona: join(e.last_name, e.first_name), dni: e.dni, origen: payroll(e.id, e.source), area: e.area || '', sede: e.sede || '',
      phones: phonesBy.get(e.id), clinic: clinicBy.get(e.id), m365: m365By.get(e.id),
    }));
    // Accesos activos sin empleado (Clinic agrupado por DNI).
    const orphans = new Map();
    clin.filter((c) => !c.employee_id && (c.status === 'activo' || c.clinic_status === 'activo')).forEach((c) => {
      const k = c.dni ? `dni:${c.dni}` : `u:${c.id}`;
      const o = orphans.get(k) || { persona: c.full_name, dni: c.dni || '', origen: 'Sin empleado', area: '', sede: c.sede_name || '', clinic: [], m365: [] };
      o.clinic.push(c);
      orphans.set(k, o);
    });
    accs.filter((a) => !a.employee_id && a.status === 'activa').forEach((a) => {
      orphans.set(`m:${a.upn}`, { persona: a.display_name, dni: '', origen: 'Sin empleado', area: a.area || '', sede: a.sede || '', clinic: [], m365: [a] });
    });
    return out.concat([...orphans.values()].map(describe))
      .sort((a, b) => (b.alertas ? 1 : 0) - (a.alertas ? 1 : 0) || String(a.persona).localeCompare(String(b.persona), 'es'));
  },
};

// ---------------------------------------------------------------------
// DevOps: repositorios que vigila el sidecar
// ---------------------------------------------------------------------
const dateTime = (iso) => (iso ? String(iso).replace('T', ' ').slice(0, 16) : '');
const repositorios = {
  label: 'Repositorios (DevOps)',
  group: 'DevOps',
  adminOnly: true, // el modulo DevOps es solo de administradores
  columns: [
    { key: 'name', label: 'Repositorio' }, { key: 'github_url', label: 'GitHub' }, { key: 'activo', label: 'Activo' },
    { key: 'sync_interval_minutes', label: 'Sincroniza cada (min)' }, { key: 'ultima_sync', label: 'Última sincronización' },
    { key: 'last_sync_status', label: 'Resultado' }, { key: 'ultima_auditoria', label: 'Última auditoría IA' },
  ],
  print: [
    { key: 'name', label: 'Repositorio', w: 1.2 }, { key: 'github_url', label: 'GitHub', w: 2 }, { key: 'activo', label: 'Activo', w: 0.5 },
    { key: 'ultima_sync', label: 'Última sincronización', w: 1 }, { key: 'last_sync_status', label: 'Resultado', w: 1 },
    { key: 'ultima_auditoria', label: 'Última auditoría IA', w: 1 },
  ],
  barcodes: [],
  selects: [{ key: 'activo', label: 'Activo' }],
  groupBy: [{ key: 'activo', label: 'Activos' }, { key: 'last_sync_status', label: 'Por resultado de la última sincronización' }],
  async load() {
    const repos = await devopsSidecarClient.listRepos();
    return Promise.all(repos.map(async (repo) => {
      let audit = '';
      try {
        const last = await devopsSidecarClient.latestReport(repo.id);
        audit = last && last.found ? join(last.report_date, last.ai_provider_used ? `(${last.ai_provider_used})` : '') : 'Sin auditorías';
      } catch (_) { audit = ''; }
      return { ...repo, activo: repo.active ? 'Sí' : 'No', ultima_sync: dateTime(repo.last_synced_at) || 'Nunca', ultima_auditoria: audit };
    }));
  },
};

const REPORTS = {
  license: expiry({ label: 'Licencias de software', table: 'software_licenses', dateField: 'expiration_date',
    columns: [['product_name', 'Producto'], ['vendor', 'Proveedor'], ['assigned_to', 'Asignado a'], ['seats', 'Puestos'], ['cost', 'Costo'],
      ['currency', 'Moneda'], ['expiration_date', 'Vence']] }),
  domain: expiry({ label: 'Dominios', table: 'domains', dateField: 'expiration_date',
    columns: [['domain_name', 'Dominio'], ['registrar', 'Registrador'], ['responsible', 'Responsable'], ['renewal_cost', 'Costo de renovación'],
      ['currency', 'Moneda'], ['expiration_date', 'Vence']] }),
  isp_contract: expiry({ label: 'Contratos ISP', table: 'isp_contracts', dateField: 'end_date',
    columns: [['provider', 'Proveedor'], ['contract_number', 'N.º de contrato'], ['bandwidth_down', 'Bajada'], ['bandwidth_up', 'Subida'],
      ['monthly_cost', 'Costo mensual'], ['currency', 'Moneda'], ['end_date', 'Termina']] }),
  server: expiry({ label: 'Servidores y Activos TI', table: 'servers', dateField: 'support_expiration_date',
    columns: [['name', 'Nombre'], ['asset_type', 'Tipo de activo'], ['environment', 'Ambiente'], ['criticality', 'Criticidad'],
      ['responsible', 'Responsable'], ['status', 'Situación'], ['support_expiration_date', 'Vence el soporte']] }),
  certificate: expiry({ label: 'Certificados TLS', table: 'certificates', dateField: 'expiration_date',
    columns: [['common_name', 'Dominio cubierto'], ['certificate_type', 'Tipo'], ['issuer', 'Emisor'], ['responsible', 'Responsable'],
      ['cost', 'Costo'], ['currency', 'Moneda'], ['expiration_date', 'Vence']] }),
  celulares,
  chips,
  glpi_computadoras: glpi('computadoras'),
  glpi_monitores: glpi('monitores'),
  glpi_impresoras: glpi('impresoras'),
  clinic_usuarios: clinicUsuarios,
  m365_cuentas: m365Cuentas,
  m365_licencias: m365Licencias,
  solicitudes,
  personas,
  repositorios,
};

// Reportes que puede abrir este usuario: los de inventario piden tener
// habilitado el modulo de donde salen los datos.
function available(user, enabledModules) {
  return Object.fromEntries(Object.entries(REPORTS).filter(([, r]) => {
    if (r.adminOnly) return user && user.role === 'admin';
    return !r.module || !!(enabledModules || {})[r.module];
  }));
}

const text = (value) => (value === null || value === undefined ? '' : String(value));
const fold = (value) => text(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// Carga el reporte y aplica los filtros de la pantalla. Las opciones de
// cada filtro de lista salen de los datos SIN filtrar, para poder cambiar
// de una opcion a otra.
async function run(report, query = {}) {
  const all = await report.load({ from: query.from || '', to: query.to || '', status: query.status || '' });
  const selects = report.selects.map((s) => ({
    ...s,
    name: `f_${s.key}`,
    value: text(query[`f_${s.key}`]),
    options: [...new Set(all.map((r) => text(r[s.key])).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es')),
  }));
  const q = fold(query.q).trim();
  const keys = [...new Set([...report.columns, ...report.barcodes].map((c) => c.key))];
  const rows = all.filter((r) => selects.every((s) => !s.value || text(r[s.key]) === s.value)
    && (!q || keys.some((k) => fold(r[k]).includes(q))));
  const barcode = report.barcodes.find((b) => b.key === query.barras) || report.barcodes[0] || null;
  return { rows, selects, barcode, summary: summarize(report, rows), filtersText: describeFilters(report, query, selects) };
}

function summarize(report, rows) {
  return {
    total: rows.length,
    groups: report.groupBy.map((g) => {
      const counts = new Map();
      rows.forEach((r) => { const k = text(r[g.key]) || 'Sin dato'; counts.set(k, (counts.get(k) || 0) + 1); });
      return { label: g.label, items: [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es')) };
    }).filter((g) => g.items.length),
  };
}

function describeFilters(report, query, selects) {
  const parts = selects.filter((s) => s.value).map((s) => `${s.label}: ${s.value}`);
  if (text(query.q).trim()) parts.push(`Búsqueda: "${text(query.q).trim()}"`);
  if (report.kind === 'vencimientos') {
    if (query.from) parts.push(`Vence desde ${query.from}`);
    if (query.to) parts.push(`Vence hasta ${query.to}`);
    if (query.status && STATUS_LABEL[query.status]) parts.push(`Estado: ${STATUS_LABEL[query.status]}`);
  }
  return parts.join(' · ');
}

function now() {
  return new Intl.DateTimeFormat('es-PE', {
    timeZone: process.env.TZ || 'America/Lima', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date()).replace(',', '');
}

function csvEscape(value) {
  const str = text(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function buildCsv(report, rows) {
  const lines = [report.columns.map((c) => csvEscape(c.label)).join(',')];
  rows.forEach((r) => lines.push(report.columns.map((c) => csvEscape(r[c.key])).join(',')));
  return String.fromCharCode(0xFEFF) + lines.join('\n'); // BOM: Excel lee bien los acentos
}

// Excel: hoja "Resumen" (cuantos hay, en total y por grupo) y hoja "Datos".
async function buildWorkbook(report, result, meta) {
  const workbook = new ExcelJS.Workbook();
  const resumen = workbook.addWorksheet('Resumen');
  resumen.addRow([`Reporte: ${report.label}`]).font = { bold: true, size: 14 };
  resumen.addRow([`Generado el ${meta.generatedAt} por ${meta.generatedBy}`]);
  if (result.filtersText) resumen.addRow([`Filtros: ${result.filtersText}`]);
  resumen.addRow([]);
  resumen.addRow(['Total de registros', result.summary.total]).font = { bold: true };
  result.summary.groups.forEach((g) => {
    resumen.addRow([]);
    resumen.addRow([g.label, 'Cantidad']).font = { bold: true };
    g.items.forEach((i) => resumen.addRow([i[0], i[1]]));
  });
  resumen.getColumn(1).width = 46;
  resumen.getColumn(2).width = 14;

  const datos = workbook.addWorksheet('Datos');
  datos.addRow(report.columns.map((c) => c.label)).font = { bold: true };
  result.rows.forEach((r) => datos.addRow(report.columns.map((c) => {
    const v = r[c.key];
    return v === null || v === undefined ? '' : (typeof v === 'number' ? v : String(v));
  })));
  datos.views = [{ state: 'frozen', ySplit: 1 }];
  datos.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: report.columns.length } };
  datos.columns.forEach((col) => { col.width = 22; });
  return workbook.xlsx.writeBuffer();
}

module.exports = { REPORTS, STATUS_LABEL, available, run, now, buildCsv, buildWorkbook };
