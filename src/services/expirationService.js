// Calculo centralizado de "dias para vencer" y estado, usado por
// el dashboard, los listados y el job de recordatorios.

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr);
  target.setHours(0, 0, 0, 0);
  const diffMs = target.getTime() - today.getTime();
  return Math.round(diffMs / (1000 * 60 * 60 * 24));
}

function statusFromDays(days) {
  if (days === null || days === undefined) return 'sin_fecha';
  if (days < 0) return 'vencido';
  if (days <= 30) return 'por_vencer';
  return 'activo';
}

function badgeClass(status) {
  switch (status) {
    case 'vencido':
      return 'bg-danger';
    case 'por_vencer':
      return 'bg-warning text-dark';
    case 'activo':
      return 'bg-success';
    default:
      return 'bg-secondary';
  }
}

module.exports = { daysUntil, statusFromDays, badgeClass };
