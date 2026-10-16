// Inventario GLPI: datos derivados para estadisticas, tablero y filtros por
// columna. Lee la copia local (glpi_assets, que externalSyncService renueva
// cada 30 minutos) y, de los textos que entrega GLPI, deduce:
//   - procesador: fabricante, familia (Core i5, Ryzen 5...), generacion o
//     serie, ano aproximado de la serie, antiguedad y si el procesador esta
//     en la lista de Windows 11;
//   - memoria: tipo (DDR3/DDR4/DDR5), formato (DIMM / SODIMM), velocidad y si
//     tiene modulos de distinta velocidad;
//   - marca normalizada ("Dell Inc." -> Dell, "Hewlett-Packard" -> HP) y sede
//     (la entidad sin "Root entity >").
// Solo lectura: nada de esto se escribe en GLPI.
const pool = require('../db/pool');
const externalSyncService = require('./externalSyncService');
const glpiClient = require('./glpiClient');

const NONE = 'Sin dato';
const YEAR_NOW = () => new Date().getFullYear();
// Ano de lanzamiento aproximado de cada generacion (escritorio) o serie.
const INTEL_YEAR = { 1: 2010, 2: 2011, 3: 2012, 4: 2013, 5: 2015, 6: 2015, 7: 2017, 8: 2017, 9: 2018, 10: 2020, 11: 2021, 12: 2021, 13: 2022, 14: 2023 };
const XEON_YEAR = { 1: 2012, 2: 2013, 3: 2014, 4: 2016 };
const RYZEN_YEAR = { 1: 2017, 2: 2018, 3: 2019, 4: 2020, 5: 2020, 7: 2022, 8: 2024, 9: 2024 };
const ORD = (n) => `${n}.ª`;

const clean = (v) => {
  const s = v === null || v === undefined ? '' : String(v).trim();
  return s && s.toLowerCase() !== 'null' ? s : '';
};

// "Intel(R) Core(TM) i7-8700 CPU @ 3.20GHz" -> { vendor, family, generation, model, year, win11 }
function cpuInfo(raw) {
  const s = clean(raw).replace(/\((R|TM)\)/gi, '').replace(/\s+/g, ' ').trim();
  const out = { vendor: NONE, family: NONE, generation: NONE, model: NONE, year: null, win11: NONE };
  if (!s) return out;
  if (/intel/i.test(s)) {
    out.vendor = 'Intel';
    const genWord = /(\d{1,2})th Gen/i.exec(s);
    let m = /Core\s+i([3579])-?(\d{4,5})([A-Z]{0,3})/i.exec(s);
    if (m) {
      const num = m[2];
      const gen = genWord ? Number(genWord[1]) : num.length === 5 ? Number(num.slice(0, 2)) : Number(num[0]);
      return { vendor: 'Intel', family: `Intel Core i${m[1]}`, generation: `Intel Core ${ORD(gen)} gen.`, model: `Core i${m[1]}-${num}${m[3].toUpperCase()}`,
        year: INTEL_YEAR[gen] || null, win11: gen >= 8 ? 'Sí' : 'No', genNum: gen };
    }
    m = /Core\s+Ultra\s+([579])\s*(\d{3})?/i.exec(s);
    if (m) return { vendor: 'Intel', family: `Intel Core Ultra ${m[1]}`, generation: 'Intel Core Ultra', model: `Core Ultra ${m[1]}${m[2] ? ` ${m[2]}` : ''}`, year: 2023, win11: 'Sí' };
    m = /Xeon.*?\b(E\d)-(\d{4})\s*v(\d)/i.exec(s);
    if (m) return { vendor: 'Intel', family: 'Intel Xeon', generation: `Intel Xeon ${m[1].toUpperCase()} v${m[3]}`, model: `Xeon ${m[1].toUpperCase()}-${m[2]} v${m[3]}`, year: XEON_YEAR[m[3]] || null, win11: 'No' };
    if (/Xeon/i.test(s)) return { ...out, family: 'Intel Xeon', generation: 'Intel Xeon (otra serie)', model: s.replace(/^Intel\s*/i, '').replace(/\s*CPU.*$/i, '') };
    m = /(Celeron|Pentium)\s*(?:Gold|Silver)?\s*(?:CPU\s*)?([A-Z])?(\d{4})/i.exec(s);
    if (m) {
      const fam = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
      const n = Number(m[3]);
      // Serie de bajo consumo: el primer digito da la plataforma (J3060 = 2016, J4005 = 2017...).
      const year = m[2] ? { 3: 2016, 4: 2018, 5: 2019, 6: 2021 }[m[3][0]] || null : null;
      return { vendor: 'Intel', family: `Intel ${fam}`, generation: `Intel ${fam}${m[2] ? ` serie ${m[2].toUpperCase()}` : ''}`, model: `${fam} ${m[2] ? m[2].toUpperCase() : ''}${m[3]}`,
        year, win11: n >= 4000 && m[2] ? 'Sí' : 'No' };
    }
    return { ...out, family: 'Intel (otra)', generation: 'Intel (otra)', model: s.replace(/\s*CPU.*$/i, '') };
  }
  if (/\bAMD\b/i.test(s)) {
    let m = /Ryzen\s+(Threadripper\s+)?([3579])\s+(?:PRO\s+)?(\d)(\d{3})([A-Z]{0,3})/i.exec(s);
    if (m) {
      const series = Number(m[3]);
      return { vendor: 'AMD', family: `AMD Ryzen ${m[2]}`, generation: `AMD Ryzen serie ${series}000`, model: `Ryzen ${m[2]} ${m[3]}${m[4]}${m[5].toUpperCase()}`,
        year: RYZEN_YEAR[series] || null, win11: series >= 2 ? 'Sí' : 'No' };
    }
    m = /\bA(\d{1,2})-(\d{4})/i.exec(s);
    if (m) return { vendor: 'AMD', family: 'AMD serie A', generation: `AMD serie A (${m[2][0]}000)`, model: `A${m[1]}-${m[2]}`, year: Number(m[2][0]) >= 9 ? 2016 : 2014, win11: 'No' };
    return { vendor: 'AMD', family: 'AMD (otra)', generation: 'AMD (otra)', model: s.replace(/\s*with Radeon.*$/i, ''), year: null, win11: NONE };
  }
  return { ...out, vendor: 'Otro', family: 'Otro', generation: 'Otro', model: s };
}

function ageBucket(year) {
  if (!year) return NONE;
  const age = YEAR_NOW() - year;
  if (age <= 3) return 'Hasta 3 años';
  if (age <= 6) return '4 a 6 años';
  if (age <= 9) return '7 a 9 años';
  return '10 años o más';
}

// "DDR4 - 2667 - DIMM, DDR4 - 2400 - DIMM" -> { type, form, speed, mixed }
function memInfo(raw) {
  const s = clean(raw);
  if (!s) return { type: NONE, form: NONE, speed: NONE, mixed: NONE };
  if (/hyper-?v|virtual/i.test(s)) return { type: 'Virtual (Hyper-V)', form: 'Virtual', speed: 'Virtual', mixed: 'No' };
  const mods = s.split(',').map((p) => /((?:LP)?DDR\d)\s*-\s*(\d+)\s*-\s*(\w+)/i.exec(p)).filter(Boolean);
  if (!mods.length) return { type: 'Otro', form: NONE, speed: NONE, mixed: NONE };
  const types = [...new Set(mods.map((m) => m[1].toUpperCase()))];
  const forms = [...new Set(mods.map((m) => m[3].toUpperCase()))];
  const speeds = [...new Set(mods.map((m) => Number(m[2])))].sort((a, b) => a - b);
  const form = forms.length > 1 ? 'Mixto' : forms[0] === 'SODIMM' ? 'SODIMM (portátil / mini PC)' : forms[0] === 'DIMM' ? 'DIMM (escritorio)' : forms[0];
  // El equipo trabaja a la velocidad del modulo mas lento.
  return { type: types.join(' + '), form, speed: `${types[0]}-${speeds[0]}`, mixed: speeds.length > 1 ? 'Sí' : 'No' };
}

const BRANDS = [[/^dell/i, 'Dell'], [/hewlett|^hp\b/i, 'HP'], [/^asus/i, 'ASUS'], [/micro-?star|^msi\b/i, 'MSI'], [/gigabyte/i, 'Gigabyte'], [/^lenovo/i, 'Lenovo'],
  [/asrock/i, 'ASRock'], [/microsoft/i, 'Microsoft'], [/^acer/i, 'Acer'], [/samsung/i, 'Samsung'], [/^lg\b|lg electronics/i, 'LG'], [/epson/i, 'Epson'],
  [/brother/i, 'Brother'], [/kyocera/i, 'Kyocera'], [/canon/i, 'Canon'], [/ricoh/i, 'Ricoh'], [/xerox/i, 'Xerox'], [/viewsonic/i, 'ViewSonic'], [/aoc/i, 'AOC'], [/benq/i, 'BenQ']];
function brandOf(raw) {
  const s = clean(raw);
  if (!s) return 'Sin marca';
  const hit = BRANDS.find(([re]) => re.test(s));
  return hit ? hit[1] : s.replace(/\s*(Inc\.?|Corporation|Corp\.?|Co\.,?\s*Ltd\.?|Ltd\.?|Technology|COMPUTER INC\.?)\s*/gi, ' ').trim() || s;
}
function sedeOf(raw) {
  const s = clean(raw);
  if (!s) return 'Sin entidad';
  const parts = s.split('>').map((p) => p.trim()).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] : /^root entity$/i.test(s) ? 'Entidad raíz' : s;
}
const gb = (raw) => { const m = /([\d.]+)\s*GB/i.exec(clean(raw)); return m ? Number(m[1]) : null; };

// Columnas que se pueden ver y filtrar en la lista (las de GLPI mas las derivadas).
// filter: 'lista' (casillas, valores pocos) | 'texto' (contiene).
const DERIVED = {
  computadoras: [
    { key: 'cpu_generation', label: 'Generación del procesador', filter: 'lista' },
    { key: 'mem_type', label: 'Tipo de memoria (DDR)', filter: 'lista' },
  ],
  monitores: [],
  impresoras: [],
};
const LIST_FILTER = new Set(['state', 'type', 'manufacturer', 'model', 'os', 'os_version', 'processor', 'memory', 'entity', 'location', 'cpu_generation', 'mem_type']);

// Filas de un tipo con los campos derivados. warnings: avisos de la copia (de otra fecha).
async function rows(tipo) {
  const source = `glpi_${tipo}`;
  const warnings = await externalSyncService.ensureFresh(source);
  const [list] = await pool.query('SELECT * FROM glpi_assets WHERE asset_type = ? ORDER BY name', [tipo]);
  const st = await externalSyncService.state(source);
  return {
    warnings, syncedAt: st && st.synced_at ? String(st.synced_at).slice(0, 16) : null,
    rows: list.map((r) => {
      const cpu = cpuInfo(r.processor);
      const mem = memInfo(r.memory_type);
      return {
        id: r.glpi_id, name: clean(r.name), state: clean(r.state), type: clean(r.type), manufacturer: clean(r.manufacturer), model: clean(r.model),
        serial: clean(r.serial), otherserial: clean(r.otherserial), location: clean(r.location), user: clean(r.user_name), entity: clean(r.entity),
        date_mod: clean(r.date_mod), os: clean(r.os), os_version: clean(r.os_version), processor: clean(r.processor), memory_type: clean(r.memory_type),
        memory: clean(r.memory), ip: clean(r.ip), mac: clean(r.mac),
        brand: brandOf(r.manufacturer), sede: sedeOf(r.entity), cpu, mem, mem_gb: gb(r.memory),
        cpu_generation: cpu.generation, mem_type: mem.type, cpu_age: ageBucket(cpu.year),
      };
    }),
  };
}

// Hay copia local de ese tipo? (si no, la lista se consulta en vivo a GLPI).
async function hasCopy(tipo) {
  const st = await externalSyncService.state(`glpi_${tipo}`);
  return !!(st && st.synced_at);
}

// --- lista con filtros por columna (como Excel), orden y paginacion ---
// Un valor de filtro no puede llevar coma (las casillas marcadas viajan unidas por comas).
const EMPTY = '(vacío)';
const keyOf = (v) => (v ? String(v).replace(/,/g, ';') : EMPTY);
function columnsOf(tipo) {
  return [...glpiClient.ASSET_TYPES[tipo].columns, ...DERIVED[tipo]].map((c) => ({ key: c.key, label: c.label, filter: LIST_FILTER.has(c.key) ? 'lista' : 'texto' }));
}
function filterList(tipo, all, query) {
  const cols = columnsOf(tipo);
  const fold = (s) => String(s || '').normalize('NFD').replace(/[^\x00-\x7f]/g, '').toLowerCase();
  const q = fold(query.q).trim();
  let out = all;
  if (q) out = out.filter((r) => ['name', 'serial', 'otherserial', 'user', 'ip', 'mac', 'model', 'processor'].some((k) => fold(r[k]).includes(q)));
  const active = {};
  for (const c of cols) {
    const raw = String(query[`f_${c.key}`] || '').trim();
    if (!raw) continue;
    active[c.key] = raw;
    if (c.filter === 'lista') {
      const wanted = new Set(raw.split(',').map((x) => x.trim()).filter(Boolean));
      out = out.filter((r) => wanted.has(keyOf(r[c.key])));
    } else {
      const t = fold(raw);
      out = out.filter((r) => fold(r[c.key]).includes(t));
    }
  }
  // Opciones de cada filtro de lista: de todas las filas (asi se puede cambiar de valor).
  const options = {};
  for (const c of cols.filter((x) => x.filter === 'lista')) {
    const counts = new Map();
    all.forEach((r) => { const k = keyOf(r[c.key]); counts.set(k, (counts.get(k) || 0) + 1); });
    options[c.key] = [...counts.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'es', { numeric: true })).map(([k, n]) => [k, `${k} (${n})`]);
  }
  return { rows: out, options, active, columns: cols };
}
function sortList(list, orden, dir) {
  if (!orden) return list;
  const s = dir === 'desc' ? -1 : 1;
  const num = orden === 'memory' ? (r) => gb(r.memory) || 0 : null;
  return [...list].sort((a, b) => (num ? num(a) - num(b) : String(a[orden] || '').localeCompare(String(b[orden] || ''), 'es', { numeric: true })) * s);
}

module.exports = { cpuInfo, memInfo, brandOf, sedeOf, ageBucket, rows, hasCopy, columnsOf, filterList, sortList, keyOf, NONE, EMPTY };
