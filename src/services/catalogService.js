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

// Codigos de pais para el numero de linea de celulares. Tabla propia (no
// catalog_items) porque cada fila necesita 3 datos, no solo un texto:
// nombre, codigo de llamada y cantidad de digitos esperada del numero.
async function getActiveCountries() {
  const [rows] = await pool.query(
    'SELECT * FROM phone_country_codes WHERE active = 1 ORDER BY country_name'
  );
  return rows;
}

async function getAllCountries() {
  const [rows] = await pool.query('SELECT * FROM phone_country_codes ORDER BY country_name');
  return rows;
}

async function addCountry(countryName, callingCode, mobileLength, userId) {
  await pool.query(
    'INSERT INTO phone_country_codes (country_name, calling_code, mobile_length, created_by) VALUES (?, ?, ?, ?)',
    [countryName, callingCode, mobileLength, userId]
  );
}

async function setCountryActive(id, active) {
  await pool.query('UPDATE phone_country_codes SET active = ? WHERE id = ?', [active ? 1 : 0, id]);
}

async function removeCountry(id) {
  await pool.query('DELETE FROM phone_country_codes WHERE id = ?', [id]);
}

module.exports = {
  getActive, getAll, add, setActive, remove,
  getActiveCountries, getAllCountries, addCountry, setCountryActive, removeCountry,
};
