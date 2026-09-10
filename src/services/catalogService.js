// Catalogos genericos (sede, area, marca, modelo, etc.) gestionables desde
// Configuracion. Los modulos que los usan guardan el valor como texto
// libre (no FK) — el catalogo sugiere/estandariza la carga, no restringe
// a nivel de base de datos.
const pool = require('../db/pool');

async function getActive(catalogType) {
  const [rows] = await pool.query(
    'SELECT value FROM catalog_items WHERE catalog_type = ? AND active = 1 ORDER BY value',
    [catalogType]
  );
  return rows.map((r) => r.value);
}

async function getAll(catalogType) {
  const [rows] = await pool.query(
    'SELECT * FROM catalog_items WHERE catalog_type = ? ORDER BY value',
    [catalogType]
  );
  return rows;
}

async function add(catalogType, value, userId) {
  await pool.query(
    'INSERT INTO catalog_items (catalog_type, value, created_by) VALUES (?, ?, ?)',
    [catalogType, value, userId]
  );
}

async function setActive(id, active) {
  await pool.query('UPDATE catalog_items SET active = ? WHERE id = ?', [active ? 1 : 0, id]);
}

async function remove(id) {
  await pool.query('DELETE FROM catalog_items WHERE id = ?', [id]);
}

module.exports = { getActive, getAll, add, setActive, remove };
