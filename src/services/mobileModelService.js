// Catalogo de modelos de celular, cada uno ligado a su marca (tabla
// mobile_models). Las marcas siguen en el catalogo generico (catalog_items,
// tipo "marca"); un modelo sin marca no sirve para elegir en el formulario,
// por eso tiene tabla propia (ver skill endurecer-validacion-de-campos,
// regla 4).
const pool = require('../db/pool');
const { MODEL_REGEX } = require('./mobileDeviceService');

const fold = (v) => String(v || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

async function list({ activeOnly = false } = {}) {
  const [rows] = await pool.query(
    `SELECT m.*, (SELECT COUNT(*) FROM mobile_devices d WHERE d.brand = m.brand AND d.model = m.model) AS en_uso
     FROM mobile_models m ${activeOnly ? 'WHERE m.active = 1' : ''} ORDER BY m.brand, m.model`
  );
  return rows;
}

async function add(brand, model, userId) {
  const b = String(brand || '').trim();
  const m = String(model || '').trim();
  if (!b) throw new Error('Elija la marca.');
  if (!m || !MODEL_REGEX.test(m)) throw new Error('El modelo es alfanumérico (se permiten espacios y guion), máximo 20 caracteres.');
  const [[dup]] = await pool.query('SELECT id FROM mobile_models WHERE brand = ? AND model = ?', [b, m]);
  if (dup) throw new Error(`${b} ${m} ya está en el catálogo.`);
  await pool.query('INSERT INTO mobile_models (brand, model, created_by) VALUES (?, ?, ?)', [b, m, userId || null]);
}

async function setActive(id, active) {
  await pool.query('UPDATE mobile_models SET active = ? WHERE id = ?', [active ? 1 : 0, id]);
}

async function remove(id) {
  await pool.query('DELETE FROM mobile_models WHERE id = ?', [id]);
}

// Marca y modelo a partir de la descripcion del equipo en el recibo
// (ej. "ZTE BLADE A76 256GB BK 5G" -> ZTE / A76). Solo reconoce modelos
// que ya estan en el catalogo: se elige el mas largo que aparece como
// palabras completas en la descripcion, de una marca que tambien aparece.
function matchDescription(description, models) {
  const text = ` ${fold(description).replace(/[^a-z0-9]+/g, ' ')} `;
  let best = null;
  for (const m of models) {
    const brandWord = ` ${fold(m.brand).replace(/[^a-z0-9]+/g, ' ')} `;
    const modelWords = ` ${fold(m.model).replace(/[^a-z0-9]+/g, ' ')} `;
    if (!text.includes(brandWord) || !text.includes(modelWords)) continue;
    if (!best || m.model.length > best.model.length) best = m;
  }
  return best ? { brand: best.brand, model: best.model } : null;
}

module.exports = { list, add, setActive, remove, matchDescription, fold };
