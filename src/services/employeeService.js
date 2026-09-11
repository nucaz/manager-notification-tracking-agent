// Directorio de empleados (DNI, nombres, apellidos, area/sede/cargo).
// Reutilizado al asignar celulares para no retipear y mantener el dato
// de la persona estandarizado.
const pool = require('../db/pool');

async function findByDni(dni) {
  const [rows] = await pool.query('SELECT * FROM employees WHERE dni = ? LIMIT 1', [dni]);
  return rows[0] || null;
}

async function get(id) {
  const [rows] = await pool.query('SELECT * FROM employees WHERE id = ? LIMIT 1', [id]);
  return rows[0] || null;
}

async function list(q) {
  let sql = 'SELECT * FROM employees WHERE 1=1';
  const params = [];
  if (q) {
    sql += ' AND (dni LIKE ? OR first_name LIKE ? OR last_name LIKE ?)';
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  sql += ' ORDER BY last_name, first_name';
  const [rows] = await pool.query(sql, params);
  return rows;
}

// Crea el empleado si el DNI es nuevo, o actualiza sus datos si ya
// existia (por si cambio de area/sede/cargo). Devuelve el id.
async function upsert({ dni, first_name, last_name, area, sede, cargo }, userId) {
  const existing = await findByDni(dni);
  if (existing) {
    await pool.query(
      'UPDATE employees SET first_name = ?, last_name = ?, area = ?, sede = ?, cargo = ? WHERE id = ?',
      [first_name, last_name, area || null, sede || null, cargo || null, existing.id]
    );
    return existing.id;
  }
  const [result] = await pool.query(
    `INSERT INTO employees (dni, first_name, last_name, area, sede, cargo, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [dni, first_name, last_name, area || null, sede || null, cargo || null, userId]
  );
  return result.insertId;
}

async function update(id, data) {
  await pool.query(
    'UPDATE employees SET dni = ?, first_name = ?, last_name = ?, area = ?, sede = ?, cargo = ?, notes = ? WHERE id = ?',
    [data.dni, data.first_name, data.last_name, data.area || null, data.sede || null, data.cargo || null, data.notes || null, id]
  );
}

async function remove(id) {
  await pool.query('DELETE FROM employees WHERE id = ?', [id]);
}

module.exports = { findByDni, get, list, upsert, update, remove };
