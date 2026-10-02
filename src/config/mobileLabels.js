// Etiquetas y colores del modulo Celulares (equipos, incidentes y chips),
// en un solo lugar: antes cada vista repetia su propio ternario de colores y
// un estado nuevo caia en "rojo" sin que nadie lo notara. Las vistas lo
// reciben como `mobileLabels` (ver src/app.js).
const DEVICE_STATUS = {
  en_stock: { label: 'En stock', badge: 'bg-secondary' },
  asignado: { label: 'Asignado', badge: 'bg-success' },
  en_reparacion: { label: 'En reparación', badge: 'bg-warning text-dark' },
  en_decomiso: { label: 'En decomiso', badge: 'bg-dark' },
  de_baja: { label: 'De baja', badge: 'bg-danger' },
};

const INCIDENT_TIPO = {
  reparacion: { label: 'Reparación', badge: 'bg-warning text-dark' },
  accidente: { label: 'Accidente', badge: 'bg-secondary' },
  decomiso: { label: 'Decomiso', badge: 'bg-dark' },
  baja: { label: 'Baja', badge: 'bg-danger' },
};

const DECOMISO_MOTIVO = {
  denuncia: 'Denuncia',
  investigacion: 'Investigación',
  observado: 'Observado',
};

const LINE_ESTADO = {
  activo: { label: 'Activo', badge: 'bg-success' },
  suspendido: { label: 'Suspendido / bloqueado', badge: 'bg-warning text-dark' },
  de_baja: { label: 'De baja', badge: 'bg-danger' },
};

// "Donde esta" un chip: se deduce, no se guarda (ver mobileLineService).
const LINE_UBICACION = {
  en_celular: { label: 'En un celular', badge: 'bg-primary' },
  personal: { label: 'Asignado sin celular', badge: 'bg-info text-dark' },
  emergencia: { label: 'Número de emergencia', badge: 'bg-warning text-dark' },
  en_stock: { label: 'En stock', badge: 'bg-secondary' },
};

// Resultado del cruce de un recibo contra el inventario.
const BILL_RESULT = {
  coincide: { label: 'Coincide', badge: 'bg-success' },
  observado: { label: 'Observado', badge: 'bg-warning text-dark' },
  faltante: { label: 'Faltante', badge: 'bg-danger' },
};

function pick(map, key) {
  return map[key] || { label: key || '—', badge: 'bg-light text-dark' };
}

module.exports = {
  DEVICE_STATUS, INCIDENT_TIPO, DECOMISO_MOTIVO, LINE_ESTADO, LINE_UBICACION, BILL_RESULT,
  deviceStatus: (k) => pick(DEVICE_STATUS, k),
  incidentTipo: (k) => pick(INCIDENT_TIPO, k),
  lineEstado: (k) => pick(LINE_ESTADO, k),
  lineUbicacion: (k) => pick(LINE_UBICACION, k),
  billResult: (k) => pick(BILL_RESULT, k),
};
