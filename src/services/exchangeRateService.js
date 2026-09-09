// Tipo de cambio USD -> PEN, desde la API publica y gratuita del BCRP
// (Banco Central de Reserva del Peru), sin API key. Serie PD04640PD =
// "Tipo de cambio - TC Sistema bancario SBS (S/ por US$) - Venta", la
// referencia comercial estandar en Peru. Se cachea en la tabla `settings`
// para no llamar al BCRP en cada request.
const axios = require('axios');
const settingsService = require('./settingsService');

const SERIE = 'PD04640PD';
const BCRP_URL = `https://estadisticas.bcrp.gob.pe/estadisticas/series/api/${SERIE}/json`;

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function formatDateForBcrp(date) {
  return date.toISOString().slice(0, 10);
}

async function fetchFromBcrp() {
  const to = new Date();
  const from = new Date(to.getTime() - 10 * 24 * 60 * 60 * 1000); // ultimos 10 dias, por si hay feriados/fin de semana
  const url = `${BCRP_URL}/${formatDateForBcrp(from)}/${formatDateForBcrp(to)}/esp`;
  const { data } = await axios.get(url, { timeout: 5000 });
  const periods = (data && data.periods) || [];
  for (let i = periods.length - 1; i >= 0; i--) {
    const raw = periods[i].values && periods[i].values[0];
    const value = parseFloat(raw);
    if (!Number.isNaN(value)) {
      return value;
    }
  }
  throw new Error('El BCRP no devolvio ningun valor numerico reciente.');
}

// Devuelve { rate, date, stale } o null si nunca se pudo obtener un valor.
async function getUsdPenRate() {
  const settings = await settingsService.getAll();
  const cachedRate = parseFloat(settings.fx_usd_pen_rate);
  const cachedDate = settings.fx_usd_pen_date;
  const hasCached = !Number.isNaN(cachedRate) && !!cachedDate;

  if (hasCached && cachedDate === todayStr()) {
    return { rate: cachedRate, date: cachedDate, stale: false };
  }

  try {
    const rate = await fetchFromBcrp();
    const date = todayStr();
    await settingsService.setMany({ fx_usd_pen_rate: rate, fx_usd_pen_date: date });
    return { rate, date, stale: false };
  } catch (err) {
    if (hasCached) {
      return { rate: cachedRate, date: cachedDate, stale: true };
    }
    return null;
  }
}

module.exports = { getUsdPenRate };
