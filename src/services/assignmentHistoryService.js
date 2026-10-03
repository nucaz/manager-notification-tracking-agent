// Historial de asignaciones de celulares: en que sede y area estuvo el
// equipo durante cada asignacion, como termino (otra persona, stock, baja)
// y que le paso antes y durante (reparaciones, accidentes, decomisos por
// denuncia / investigacion / observado, bajas).
//
// Sede, area y como termino se guardan en la asignacion (mobile_device_
// assignments). Lo de "antes" y "durante" se deduce de los incidentes del
// equipo por fecha, asi tambien vale para asignaciones anteriores a este
// cambio.
const pool = require('../db/pool');
const labels = require('../config/mobileLabels');

const FINAL = {
  reasignado: 'Pasó a otra persona',
  en_stock: 'Devuelto a stock',
  de_baja: 'Dado de baja',
  en_decomiso: 'Retirado por decomiso',
};

// Cierra la asignacion vigente del celular. estadoFinal: clave de FINAL.
async function close(deviceId, estadoFinal, note, conn = pool) {
  const [[active]] = await conn.query('SELECT id, holder_name FROM mobile_device_assignments WHERE device_id = ? AND returned_date IS NULL', [deviceId]);
  if (!active) return null;
  await conn.query(
    `UPDATE mobile_device_assignments SET returned_date = CURDATE(), estado_final = ?,
       observacion = TRIM(BOTH ' - ' FROM CONCAT_WS(' - ', observacion, ?)) WHERE id = ?`,
    [estadoFinal, note || null, active.id]
  );
  return active;
}

// Si el equipo cambia de sede o area mientras alguien lo tiene, la
// asignacion vigente refleja donde esta.
async function syncPlace(deviceId, area, sede, conn = pool) {
  await conn.query('UPDATE mobile_device_assignments SET area = ?, sede = ? WHERE device_id = ? AND returned_date IS NULL', [area || null, sede || null, deviceId]);
}

const day = (v) => (v ? String(v).slice(0, 10) : null);

function describe(inc) {
  const tipo = labels.incidentTipo(inc.tipo).label;
  const motivo = inc.motivo ? ` por ${String(labels.DECOMISO_MOTIVO[inc.motivo] || inc.motivo).toLowerCase()}` : '';
  const fin = inc.fecha_resolucion ? ` → resuelto ${day(inc.fecha_resolucion)}` : (['reparacion', 'decomiso'].includes(inc.tipo) ? ' (sin resolver)' : '');
  return `${tipo}${motivo} ${day(inc.fecha)}${fin}`;
}

// Agrega a cada asignacion: lugar, como termino, y los incidentes de antes
// (desde la asignacion anterior) y de durante.
function enrich(assignments, incidents) {
  const asc = [...assignments].sort((a, b) => String(day(a.assigned_date) || day(a.created_at)).localeCompare(String(day(b.assigned_date) || day(b.created_at))) || a.id - b.id);
  const today = new Date().toISOString().slice(0, 10);
  const info = new Map();
  asc.forEach((a, i) => {
    const desde = day(a.assigned_date) || day(a.created_at);
    const hasta = day(a.returned_date) || today;
    const prev = asc[i - 1];
    const prevFin = prev ? (day(prev.returned_date) || day(prev.assigned_date)) : null;
    // Antes: lo que empezo despues de la asignacion anterior, o que seguia
    // abierto (o se resolvio) cuando esta termino; por ejemplo, un decomiso
    // por investigacion que se resolvio el mismo dia que se cerro la anterior.
    const antes = incidents.filter((inc) => {
      const f = day(inc.fecha);
      const r = day(inc.fecha_resolucion);
      return f <= desde && (!prevFin || f > prevFin || !r || r >= prevFin);
    });
    const durante = incidents.filter((inc) => { const f = day(inc.fecha); return f > desde && f <= hasta; });
    info.set(a.id, {
      lugar: [a.area, a.sede].filter(Boolean).join(' / ') || null,
      termino: a.returned_date ? (FINAL[a.estado_final] || null) : 'Vigente',
      antes: antes.map(describe),
      durante: durante.map(describe),
    });
  });
  return assignments.map((a) => ({ ...a, ...info.get(a.id) }));
}

module.exports = { FINAL, close, syncPlace, enrich, describe };
