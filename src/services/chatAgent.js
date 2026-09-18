// Agente conversacional generico (WhatsApp y Telegram comparten la misma
// logica): interpreta una pregunta en lenguaje natural, la traduce a UNA
// herramienta fija (nunca SQL libre generado por la IA - eso seria un
// riesgo real de fuga/inyeccion de datos) y devuelve una respuesta en
// texto plano.
//
// Solo pueden usarlo contactos (numero de WhatsApp o chat_id de Telegram)
// vinculados a un usuario admin/editor activo - cualquier otro contacto
// recibe una respuesta generica de "sin acceso", sin tocar ninguna
// herramienta ni exponer que existe un asistente con datos de la empresa.
const pool = require('../db/pool');
const geminiClient = require('./geminiClient');
const employeeService = require('./employeeService');
const { daysUntil, statusFromDays } = require('./expirationService');
const devopsSidecarClient = require('./devopsSidecarClient');

const CHANNEL_COLUMNS = {
  whatsapp: 'whatsapp_number',
  telegram: 'telegram_chat_id',
};

// Normaliza tildes/diacriticos antes de comparar nombres de repos: la IA
// interpreta la pregunta del usuario y puede devolver "biométrico" con
// acento aunque el nombre real del repo sea "biometrico" sin el, o
// viceversa - sin esto, una busqueda por nombre podia fallar por una sola
// tilde de diferencia.
function normalizar(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

function encontrarRepoDevops(repos, query) {
  const q = normalizar(query);
  return repos.find((r) => normalizar(r.name).includes(q));
}

const EXPIRATION_MODULES = [
  { table: 'software_licenses', dateField: 'expiration_date', nameField: 'product_name', label: 'Licencia' },
  { table: 'domains', dateField: 'expiration_date', nameField: 'domain_name', label: 'Dominio' },
  { table: 'isp_contracts', dateField: 'end_date', nameField: 'provider', label: 'Contrato ISP' },
  { table: 'servers', dateField: 'support_expiration_date', nameField: 'name', label: 'Soporte de servidor/activo' },
  { table: 'certificates', dateField: 'expiration_date', nameField: 'common_name', label: 'Certificado TLS' },
];

async function findExpiringItems(maxDays) {
  const items = [];
  for (const mod of EXPIRATION_MODULES) {
    const [rows] = await pool.query(
      `SELECT ${mod.nameField} AS name, ${mod.dateField} AS due_date FROM ${mod.table} WHERE ${mod.dateField} IS NOT NULL`
    );
    for (const row of rows) {
      const days = daysUntil(row.due_date);
      if (days !== null && days <= maxDays) {
        items.push({ label: mod.label, name: row.name, days, status: statusFromDays(days) });
      }
    }
  }
  items.sort((a, b) => a.days - b.days);
  return items;
}

// Cada herramienta: { description, run(args) -> string de respuesta }
const TOOLS = {
  contar_vencimientos: {
    description:
      'Cuenta cuantos elementos (licencias, dominios, contratos ISP, servidores, certificados) vencen dentro de N dias. Argumentos: { "dias": numero, por defecto 30 }.',
    async run(args) {
      const dias = Number.isFinite(args.dias) ? args.dias : 30;
      const items = await findExpiringItems(dias);
      if (items.length === 0) return `No hay nada por vencer en los próximos ${dias} días.`;
      const vencidos = items.filter((i) => i.status === 'vencido').length;
      return `Hay ${items.length} elemento(s) por vencer en los próximos ${dias} días (${vencidos} ya vencido(s)).`;
    },
  },
  listar_vencimientos: {
    description:
      'Lista (hasta 10) los elementos que vencen antes de N dias, con nombre y dias restantes. Argumentos: { "dias": numero, por defecto 30 }.',
    async run(args) {
      const dias = Number.isFinite(args.dias) ? args.dias : 30;
      const items = await findExpiringItems(dias);
      if (items.length === 0) return `No hay nada por vencer en los próximos ${dias} días.`;
      const lineas = items
        .slice(0, 10)
        .map((i) => `• ${i.label}: ${i.name} — ${i.days < 0 ? `vencido hace ${-i.days} día(s)` : `${i.days} día(s)`}`);
      const extra = items.length > 10 ? `\n(y ${items.length - 10} más...)` : '';
      return `Vencimientos próximos:\n${lineas.join('\n')}${extra}`;
    },
  },
  buscar_celular_por_imei: {
    description: 'Busca un celular por IMEI (o parte de el) y dice quien lo tiene asignado. Argumentos: { "imei": texto }.',
    async run(args) {
      const imei = String(args.imei || '').trim();
      if (!imei) return 'Indica el IMEI (o parte de el) que quieres buscar.';
      const [rows] = await pool.query(
        `SELECT d.*, a.holder_name, a.cargo, e.dni
         FROM mobile_devices d
         LEFT JOIN mobile_device_assignments a ON a.device_id = d.id AND a.returned_date IS NULL
         LEFT JOIN employees e ON e.id = a.employee_id
         WHERE d.imei LIKE ? LIMIT 5`,
        [`%${imei}%`]
      );
      if (rows.length === 0) return `No encontré ningún celular con IMEI que contenga "${imei}".`;
      return rows
        .map((d) => {
          const asignado = d.holder_name
            ? `asignado a ${d.holder_name}${d.dni ? ` (DNI ${d.dni})` : ''}${d.cargo ? `, ${d.cargo}` : ''}`
            : 'en stock (sin asignar)';
          return `• IMEI ${d.imei} (${d.area}${d.sede ? `, ${d.sede}` : ''}): ${asignado}`;
        })
        .join('\n');
    },
  },
  buscar_empleado: {
    description: 'Busca un empleado por DNI o nombre. Argumentos: { "query": texto }.',
    async run(args) {
      const q = String(args.query || '').trim();
      if (!q) return 'Indica el DNI o nombre del empleado que quieres buscar.';
      const rows = await employeeService.list(q);
      if (rows.length === 0) return `No encontré ningún empleado que coincida con "${q}".`;
      return rows
        .slice(0, 10)
        .map((e) => `• ${e.first_name} ${e.last_name} — DNI ${e.dni}${e.area ? `, ${e.area}` : ''}${e.sede ? `/${e.sede}` : ''}${e.cargo ? ` (${e.cargo})` : ''}`)
        .join('\n');
    },
  },
  resumen_celulares_por_area: {
    description: 'Da el conteo de celulares por area (total y asignados). Sin argumentos.',
    async run() {
      const [rows] = await pool.query(
        'SELECT area, COUNT(*) AS total, SUM(status = "asignado") AS asignados FROM mobile_devices GROUP BY area ORDER BY area'
      );
      if (rows.length === 0) return 'No hay celulares registrados todavía.';
      return rows.map((r) => `• ${r.area}: ${r.total} equipo(s), ${r.asignados} asignado(s)`).join('\n');
    },
  },

  // --- DevOps Sidecar (repositorios de GitHub, otro servicio - ver
  // devopsSidecarClient.js). Solo herramientas de LECTURA + disparar una
  // auditoria de IA (no destructiva): rollback/revert/push/restaurar
  // quedan a proposito fuera del chat, son acciones irreversibles que
  // exigen confirmacion explicita en la interfaz web, no un mensaje de
  // texto que alguien pudo escribir sin querer.
  listar_repos_devops: {
    description: 'Lista los repositorios de GitHub registrados en DevOps Sidecar, con su estado de sincronizacion. Sin argumentos.',
    async run() {
      const repos = await devopsSidecarClient.listRepos();
      if (repos.length === 0) return 'No hay repositorios registrados en DevOps Sidecar todavía.';
      return repos
        .map((r) => `• ${r.name}: ${r.last_sync_status || 'sin sincronizar aún'}${r.active ? '' : ' (auto-sync PAUSADO)'}`)
        .join('\n');
    },
  },
  estado_repo_devops: {
    description: 'Da el estado detallado de UN repositorio de DevOps Sidecar por nombre (o parte del nombre). Argumentos: { "repo": texto }.',
    async run(args) {
      const query = String(args.repo || '').trim();
      if (!query) return 'Indica el nombre (o parte del nombre) del repositorio.';
      const repos = await devopsSidecarClient.listRepos();
      const match = encontrarRepoDevops(repos, query);
      if (!match) return `No encontré ningún repositorio de DevOps Sidecar que coincida con "${query}".`;
      const ultimoSync = match.last_synced_at ? new Date(match.last_synced_at).toLocaleString('es-PE') : 'nunca';
      return (
        `Repositorio: ${match.name}\n` +
        `Último sync: ${ultimoSync}\n` +
        `Resultado: ${match.last_sync_status || '—'}\n` +
        `Auto-sync: ${match.active ? 'activo' : 'PAUSADO (rollback/restore en curso)'}\n` +
        `Sincroniza cada: ${match.sync_interval_minutes} min`
      );
    },
  },
  leaderboard_devops: {
    description: 'Ranking de desarrolladores por actividad en los repositorios de DevOps Sidecar. Argumentos: { "periodo": "day"|"week"|"month"|"year"|"all", por defecto "week" }.',
    async run(args) {
      const periodo = ['day', 'week', 'month', 'year', 'all'].includes(args.periodo) ? args.periodo : 'week';
      const rows = await devopsSidecarClient.leaderboard(periodo);
      if (rows.length === 0) return `Sin actividad registrada en el período "${periodo}".`;
      return rows
        .slice(0, 10)
        .map((r, i) => `${i + 1}. ${r.author}: ${r.commits} commit(s), +${r.lines_added}/-${r.lines_deleted} líneas, ${r.score} pts`)
        .join('\n');
    },
  },
  ultima_auditoria_devops: {
    description: 'Resumen de la última auditoría de IA de UN repositorio de DevOps Sidecar. Argumentos: { "repo": texto }.',
    async run(args) {
      const query = String(args.repo || '').trim();
      if (!query) return 'Indica el nombre (o parte del nombre) del repositorio.';
      const repos = await devopsSidecarClient.listRepos();
      const match = encontrarRepoDevops(repos, query);
      if (!match) return `No encontré ningún repositorio de DevOps Sidecar que coincida con "${query}".`;
      const data = await devopsSidecarClient.latestReport(match.id);
      if (!data.found) return `Todavía no hay ninguna auditoría de IA para "${match.name}".`;
      const resumen = data.report_markdown.slice(0, 900).replace(/[#*_`]/g, '');
      const recortado = data.report_markdown.length > 900 ? '…' : '';
      return `Auditoría de "${match.name}" (${data.report_date}, ${data.ai_provider_used || 'IA'}):\n\n${resumen}${recortado}`;
    },
  },
  commits_hoy_devops: {
    description: 'Verifica/lista los commits de HOY de UN repositorio de DevOps Sidecar (autor, cantidad de commits, líneas +/-), sin correr un análisis de IA — rápido, para chequear actividad del día. Argumentos: { "repo": texto }.',
    async run(args) {
      const query = String(args.repo || '').trim();
      if (!query) return 'Indica el nombre (o parte del nombre) del repositorio.';
      const repos = await devopsSidecarClient.listRepos();
      const match = encontrarRepoDevops(repos, query);
      if (!match) return `No encontré ningún repositorio de DevOps Sidecar que coincida con "${query}".`;
      const data = await devopsSidecarClient.commitsHoy(match.id);
      if (data.authors.length === 0) return `Sin commits registrados hoy en "${match.name}".`;
      const lineas = data.authors.map((a) => `• ${a.author}: ${a.commits} commit(s), +${a.lines_added}/-${a.lines_deleted} líneas`);
      return `Commits de hoy en "${match.name}":\n${lineas.join('\n')}`;
    },
  },
  ejecutar_auditoria_devops: {
    description: 'Ejecuta AHORA MISMO una auditoría de IA sobre UN repositorio de DevOps Sidecar (no destructivo, solo analiza y genera un reporte). Argumentos: { "repo": texto }.',
    async run(args) {
      const query = String(args.repo || '').trim();
      if (!query) return 'Indica el nombre (o parte del nombre) del repositorio.';
      const repos = await devopsSidecarClient.listRepos();
      const match = encontrarRepoDevops(repos, query);
      if (!match) return `No encontré ningún repositorio de DevOps Sidecar que coincida con "${query}".`;
      await devopsSidecarClient.auditNow(match.id);
      return `Listo — auditoría de IA ejecutada para "${match.name}". Pregúntame por "la última auditoría de ${match.name}" para ver el resultado.`;
    },
  },
  ultimos_despliegues_devops: {
    description: 'Últimos despliegues recibidos de Coolify (webhook de DevOps Sidecar). Sin argumentos.',
    async run() {
      const deployments = await devopsSidecarClient.listDeployments(10);
      if (deployments.length === 0) return 'Todavía no llegó ningún webhook de despliegue de Coolify.';
      return deployments
        .map((d) => `• ${d.project || '?'} (${d.environment || '?'}): ${d.status || '?'}`)
        .join('\n');
    },
  },
  respaldos_devops: {
    description: 'Cuántos respaldos existen y lista los más recientes de DevOps Sidecar (diferenciales, mirror git, archivos completos). Argumentos opcionales: { "repo": texto (opcional, filtra por repositorio) }.',
    async run(args) {
      let repoId = null;
      if (args.repo) {
        const repos = await devopsSidecarClient.listRepos();
        const match = encontrarRepoDevops(repos, args.repo);
        if (!match) return `No encontré ningún repositorio de DevOps Sidecar que coincida con "${args.repo}".`;
        repoId = match.id;
      }
      const data = await devopsSidecarClient.listBackups(10, repoId);
      if (data.total === 0) return 'Todavía no se ha generado ningún respaldo.';
      const detalle = data.items
        .map((b) => `• ${b.created_at.slice(0, 16).replace('T', ' ')} — ${b.repo} (${b.backup_type}), ${(b.size_bytes / 1024).toFixed(1)} KB`)
        .join('\n');
      return `Hay ${data.total} respaldo(s) en total. Los más recientes:\n${detalle}`;
    },
  },
  resumen_devops: {
    description: 'Resumen general de DevOps Sidecar: cantidad de repositorios, despliegues (éxito/fallo), respaldos, y si hubo auditorías de IA HOY. Sin argumentos. Úsalo para preguntas amplias como "cómo va todo en DevOps" o "hay auditorías del día".',
    async run() {
      const r = await devopsSidecarClient.resumenGeneral();
      const partes = [
        `Repositorios registrados: ${r.total_repos}`,
        `Despliegues: ${r.deployments.total} total (${r.deployments.exitosos} exitosos, ${r.deployments.fallidos} fallidos)`,
        `Respaldos: ${r.backups.total} total` + (r.backups.ultimo ? ` — el último fue ${r.backups.ultimo.fecha.slice(0, 16).replace('T', ' ')} (${r.backups.ultimo.repo}, ${r.backups.ultimo.tipo})` : ''),
      ];
      if (r.auditorias_hoy.length > 0) {
        partes.push(`Auditorías de HOY: ${r.auditorias_hoy.map((a) => `${a.repo} (${a.provider || '?'})`).join(', ')}`);
      } else {
        partes.push('Auditorías de HOY: ninguna todavía (corren automáticamente a las 18:00, o se pueden pedir al instante por repo).');
      }
      return partes.join('\n');
    },
  },
};

// Contexto general de "casi todo el sistema", usado SOLO como respaldo
// cuando la pregunta no calzo con ninguna herramienta especifica (ver
// answerGenerically). Son resumenes/agregados, no un volcado de la base
// de datos completa - mantiene acotado el tamano del prompt y evita
// mandarle a la IA (y de paso, a un proveedor externo) mas datos
// personales detallados de los necesarios; para el detalle puntual de
// una persona/equipo especifico siguen existiendo las herramientas
// especificas de arriba (buscar_celular_por_imei, buscar_empleado, etc.).
async function buildGeneralContext() {
  const partes = [];

  try {
    const items90 = await findExpiringItems(90);
    const vencidos = items90.filter((i) => i.status === 'vencido').length;
    partes.push(
      `VENCIMIENTOS (licencias/dominios/ISP/servidores/certificados): ${items90.length} elemento(s) vencen en los próximos 90 días (${vencidos} ya vencido(s)).`
    );
  } catch (err) {
    partes.push('VENCIMIENTOS: no se pudo consultar.');
  }

  try {
    const [celulares] = await pool.query(
      'SELECT area, COUNT(*) AS total, SUM(status = "asignado") AS asignados FROM mobile_devices GROUP BY area ORDER BY area'
    );
    const totalCelulares = celulares.reduce((acc, r) => acc + r.total, 0);
    partes.push(
      `CELULARES: ${totalCelulares} equipo(s) en total.\n` +
        celulares.map((r) => `  - ${r.area}: ${r.total} equipo(s), ${r.asignados} asignado(s)`).join('\n')
    );
  } catch (err) {
    partes.push('CELULARES: no se pudo consultar.');
  }

  try {
    const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM employees');
    partes.push(`EMPLEADOS: ${total} registrado(s).`);
  } catch (err) {
    partes.push('EMPLEADOS: no se pudo consultar.');
  }

  try {
    const repos = await devopsSidecarClient.listRepos();
    if (repos.length === 0) {
      partes.push('DEVOPS SIDECAR: no hay repositorios registrados.');
    } else {
      const lb = await devopsSidecarClient.leaderboard('week').catch(() => []);
      const lbTexto = lb.length
        ? lb.slice(0, 5).map((r) => `${r.author}: ${r.commits} commits`).join(', ')
        : 'sin actividad esta semana';
      const r = await devopsSidecarClient.resumenGeneral().catch(() => null);
      let resumenTexto = '';
      if (r) {
        resumenTexto =
          `\nDespliegues: ${r.deployments.total} total (${r.deployments.exitosos} exitosos, ${r.deployments.fallidos} fallidos).` +
          `\nRespaldos: ${r.backups.total} total` +
          (r.backups.ultimo ? ` (último: ${r.backups.ultimo.fecha.slice(0, 16).replace('T', ' ')}, ${r.backups.ultimo.repo}, ${r.backups.ultimo.tipo}).` : '.') +
          `\nAuditorías de HOY: ${r.auditorias_hoy.length > 0 ? r.auditorias_hoy.map((a) => a.repo).join(', ') : 'ninguna todavía'}.`;
      }
      partes.push(
        `DEVOPS SIDECAR - Repositorios:\n` +
          repos.map((r2) => `  - ${r2.name}: ${r2.last_sync_status || 'sin sincronizar'}${r2.active ? '' : ' (PAUSADO)'}`).join('\n') +
          `\nLeaderboard (semana): ${lbTexto}` +
          resumenTexto
      );
    }
  } catch (err) {
    partes.push('DEVOPS SIDECAR: no está conectado o no responde (ver Configuración).');
  }

  return partes.join('\n\n');
}

async function answerGenerically(question) {
  const contexto = await buildGeneralContext();
  const prompt = `Eres el asistente de un sistema interno (gestión de licencias/dominios/ISP/servidores/certificados/celulares/empleados, y un módulo aparte llamado DevOps Sidecar que audita repositorios de GitHub). Te preguntan por WhatsApp/Telegram algo que no calzó con ninguna herramienta específica del sistema.

Responde EN ESPAÑOL, breve y directo, basándote SOLO en este resumen general real del sistema - si no alcanza para responder con certeza, dilo explícitamente y sugiere una pregunta más específica en vez de inventar datos:

${contexto}

Pregunta del usuario: "${question}"`;
  return geminiClient.askText(prompt);
}

function buildPrompt(question) {
  const toolList = Object.entries(TOOLS)
    .map(([name, t]) => `- "${name}": ${t.description}`)
    .join('\n');
  return `Eres el asistente de un sistema interno de gestión de licencias, dominios, contratos ISP, servidores, certificados, celulares, empleados y de un módulo aparte (DevOps Sidecar) que audita con IA los repositorios de GitHub del equipo. Te consultan por WhatsApp o Telegram.

Herramientas disponibles:
${toolList}

Dada la pregunta del usuario, responde EXCLUSIVAMENTE con un objeto JSON (sin texto adicional, sin markdown) con esta forma:
{ "tool": "<nombre_exacto_de_la_herramienta_o_'desconocido'>", "args": { ... } }

Si la pregunta no calza claramente con ninguna herramienta, responde { "tool": "desconocido", "args": {} }.

Pregunta del usuario: "${question}"`;
}

async function interpretQuestion(question) {
  const text = await geminiClient.askText(buildPrompt(question));
  const parsed = geminiClient.extractJson(text);
  return { tool: parsed.tool || 'desconocido', args: parsed.args || {} };
}

function columnFor(channel) {
  const column = CHANNEL_COLUMNS[channel];
  if (!column) throw new Error(`Canal desconocido: ${channel}`);
  return column;
}

async function findAuthorizedUser(channel, contact) {
  const column = columnFor(channel);
  const [rows] = await pool.query(
    `SELECT * FROM users WHERE ${column} = ? AND active = 1 AND role IN ('admin','editor') LIMIT 1`,
    [contact]
  );
  return rows[0] || null;
}

async function logMessage(channel, contact, userId, direction, text) {
  await pool.query(
    'INSERT INTO agent_message_log (channel, contact, user_id, direction, message_text) VALUES (?, ?, ?, ?, ?)',
    [channel, contact, userId || null, direction, text]
  );
}

// Punto de entrada: valida autorizacion, interpreta, ejecuta la
// herramienta y arma la respuesta. Nunca deja que un error interno
// llegue sin manejar - siempre devuelve un texto para responder.
async function answerQuestion(channel, contact, question) {
  await logMessage(channel, contact, null, 'entrante', question);

  const user = await findAuthorizedUser(channel, contact);
  if (!user) {
    const reply = 'Este asistente no está disponible para este contacto.';
    await logMessage(channel, contact, null, 'saliente', reply);
    return reply;
  }

  let reply;
  try {
    const { tool, args } = await interpretQuestion(question);
    const handler = TOOLS[tool];
    reply = handler ? await handler.run(args) : await answerGenerically(question);
  } catch (err) {
    reply = `Ocurrió un error al procesar tu pregunta: ${err.message}`;
  }

  await logMessage(channel, contact, user.id, 'saliente', reply);
  return reply;
}

module.exports = {
  TOOLS,
  interpretQuestion,
  answerQuestion,
  findAuthorizedUser,
  buildGeneralContext,
  answerGenerically,
};
