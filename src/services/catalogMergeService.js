// Unificar valores de un catalogo (ej. "BO" y "BACKOFFICE" -> "BACKOFFICE"):
// cambia el valor en TODOS los lugares donde se usa ese campo, en una sola
// transaccion, y deja el catalogo con solo el valor destino.
//
// Cada tipo de catalogo declara sus lugares (tabla y columna). Solo se toca
// ESE campo: unificar areas nunca cambia la sede, aunque el texto coincida
// (un area "SURCO" pasa a "CLINICA" y la sede SURCO sigue siendo SURCO).
// Los registros historicos de auditoria y de chat no se modifican.
const pool = require('../db/pool');

const PLACES = {
  area: [
    { table: 'mobile_devices', column: 'area', label: 'Celulares' },
    { table: 'employees', column: 'area', label: 'Empleados' },
    { table: 'mobile_device_assignments', column: 'area', label: 'Historial de asignaciones' },
    { table: 'mobile_device_area_audits', column: 'area', label: 'Checklist por área', key: true },
  ],
  sede: [
    { table: 'mobile_devices', column: 'sede', label: 'Celulares' },
    { table: 'employees', column: 'sede', label: 'Empleados' },
    { table: 'mobile_device_assignments', column: 'sede', label: 'Historial de asignaciones' },
  ],
  marca: [
    { table: 'mobile_devices', column: 'brand', label: 'Celulares' },
    { table: 'mobile_models', column: 'brand', label: 'Modelos por marca', unique: 'model' },
  ],
  operadora: [
    { table: 'mobile_devices', column: 'operadora', label: 'Celulares' },
    { table: 'mobile_lines', column: 'operadora', label: 'Chips' },
  ],
};

const clean = (v) => String(v === null || v === undefined ? '' : v).trim();

// Valores que existen hoy para ese tipo (en el catalogo y en los datos), con cuantos usos.
async function values(type) {
  const places = PLACES[type];
  if (!places) throw new Error('Tipo de catálogo no válido.');
  const map = new Map();
  const add = (v, n, where) => {
    const k = clean(v);
    if (!k) return;
    const e = map.get(k) || { value: k, total: 0, where: {}, catalog: false };
    if (where === 'catalogo') e.catalog = true;
    else { e.total += n; e.where[where] = (e.where[where] || 0) + n; }
    map.set(k, e);
  };
  for (const p of places) {
    const [rows] = await pool.query('SELECT ?? AS v, COUNT(*) AS n FROM ?? GROUP BY ??', [p.column, p.table, p.column]);
    rows.forEach((r) => add(r.v, Number(r.n), p.label));
  }
  const [cat] = await pool.query('SELECT value FROM catalog_items WHERE catalog_type = ?', [type]);
  cat.forEach((c) => add(c.value, 0, 'catalogo'));
  return [...map.values()].sort((a, b) => a.value.localeCompare(b.value, 'es'));
}

function validate(type, sources, target) {
  if (!PLACES[type]) throw new Error('Tipo de catálogo no válido.');
  const dest = clean(target);
  if (!dest || dest.length > 100) throw new Error('Indique el valor que queda (máximo 100 caracteres).');
  const list = [...new Set((Array.isArray(sources) ? sources : [sources]).map(clean).filter(Boolean))]
    .filter((s) => s.toLowerCase() !== dest.toLowerCase());
  if (!list.length) throw new Error('Elija al menos un valor distinto del que queda.');
  return { type, sources: list, target: dest };
}

// Cuantos registros cambiarian en cada lugar.
async function preview(type, sources, target) {
  const v = validate(type, sources, target);
  const counts = [];
  for (const p of PLACES[type]) {
    const [[r]] = await pool.query('SELECT COUNT(*) AS n FROM ?? WHERE ?? IN (?)', [p.table, p.column, v.sources]);
    counts.push({ label: p.label, n: Number(r.n) });
  }
  const [[c]] = await pool.query('SELECT COUNT(*) AS n FROM catalog_items WHERE catalog_type = ? AND value IN (?)', [type, v.sources]);
  const [[t]] = await pool.query('SELECT COUNT(*) AS n FROM catalog_items WHERE catalog_type = ? AND value = ?', [type, v.target]);
  return { ...v, counts, catalogRemoved: Number(c.n), catalogAddsTarget: !t.n, total: counts.reduce((s, x) => s + x.n, 0) };
}

async function apply(type, sources, target, userId) {
  const v = validate(type, sources, target);
  const conn = await pool.getConnection();
  const changed = [];
  try {
    await conn.beginTransaction();
    for (const p of PLACES[type]) {
      let n = 0;
      if (p.key) {
        // Tabla con el valor como clave (checklist por area): si el destino
        // ya tiene fila, la del origen sobra; si no, se renombra una.
        const [[has]] = await conn.query('SELECT COUNT(*) AS n FROM ?? WHERE ?? = ?', [p.table, p.column, v.target]);
        if (!has.n) {
          const [ren] = await conn.query('UPDATE ?? SET ?? = ? WHERE ?? IN (?) LIMIT 1', [p.table, p.column, v.target, p.column, v.sources]);
          n += ren.affectedRows;
        }
        const [del] = await conn.query('DELETE FROM ?? WHERE ?? IN (?)', [p.table, p.column, v.sources]);
        n += del.affectedRows;
      } else if (p.unique) {
        // Modelos: si la marca destino ya tiene ese modelo, el duplicado sobra.
        const [del] = await conn.query(
          `DELETE s FROM ?? s JOIN ?? t ON t.?? = s.?? AND t.?? = ? WHERE s.?? IN (?)`,
          [p.table, p.table, p.unique, p.unique, p.column, v.target, p.column, v.sources]
        );
        const [upd] = await conn.query('UPDATE ?? SET ?? = ? WHERE ?? IN (?)', [p.table, p.column, v.target, p.column, v.sources]);
        n += del.affectedRows + upd.affectedRows;
      } else {
        const [upd] = await conn.query('UPDATE ?? SET ?? = ? WHERE ?? IN (?)', [p.table, p.column, v.target, p.column, v.sources]);
        n += upd.affectedRows;
      }
      changed.push({ label: p.label, n });
    }
    const [[t]] = await conn.query('SELECT id FROM catalog_items WHERE catalog_type = ? AND value = ?', [type, v.target]);
    if (t) await conn.query('UPDATE catalog_items SET active = 1 WHERE id = ?', [t.id]);
    else await conn.query('INSERT INTO catalog_items (catalog_type, value, active, created_by) VALUES (?, ?, 1, ?)', [type, v.target, userId || null]);
    const [cat] = await conn.query('DELETE FROM catalog_items WHERE catalog_type = ? AND value IN (?)', [type, v.sources]);
    await conn.commit();
    return { ...v, changed, catalogRemoved: cat.affectedRows, catalogAddedTarget: !t };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { PLACES, values, preview, apply };
