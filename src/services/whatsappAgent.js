// Agente conversacional de WhatsApp: interpreta una pregunta en lenguaje
// natural, la traduce a UNA herramienta fija (nunca SQL libre generado
// por la IA - eso seria un riesgo real de fuga/inyeccion de datos) y
// devuelve una respuesta en texto plano.
//
// Solo pueden usarlo numeros de telefono vinculados a un usuario
// admin/editor activo (users.whatsapp_number) - cualquier otro numero
// recibe una respuesta generica de "sin acceso", sin tocar ninguna
// herramienta ni exponer que existe un asistente con datos de la empresa.
const pool = require('../db/pool');
const geminiClient = require('./geminiClient');
const employeeService = require('./employeeService');
const { daysUntil, statusFromDays } = require('./expirationService');

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
};

function buildPrompt(question) {
  const toolList = Object.entries(TOOLS)
    .map(([name, t]) => `- "${name}": ${t.description}`)
    .join('\n');
  return `Eres el asistente de WhatsApp de un sistema interno de gestión de licencias, dominios, contratos ISP, servidores, certificados, celulares y empleados.

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

async function findAuthorizedUser(phoneNumber) {
  const [rows] = await pool.query(
    `SELECT * FROM users WHERE whatsapp_number = ? AND active = 1 AND role IN ('admin','editor') LIMIT 1`,
    [phoneNumber]
  );
  return rows[0] || null;
}

async function logMessage(phoneNumber, userId, direction, text) {
  await pool.query(
    'INSERT INTO whatsapp_message_log (phone_number, user_id, direction, message_text) VALUES (?, ?, ?, ?)',
    [phoneNumber, userId || null, direction, text]
  );
}

// Punto de entrada: valida autorizacion, interpreta, ejecuta la
// herramienta y arma la respuesta. Nunca deja que un error interno
// llegue sin manejar - siempre devuelve un texto para responder.
async function answerQuestion(phoneNumber, question) {
  await logMessage(phoneNumber, null, 'entrante', question);

  const user = await findAuthorizedUser(phoneNumber);
  if (!user) {
    const reply = 'Este asistente no está disponible para este número.';
    await logMessage(phoneNumber, null, 'saliente', reply);
    return reply;
  }

  let reply;
  try {
    const { tool, args } = await interpretQuestion(question);
    const handler = TOOLS[tool];
    reply = handler
      ? await handler.run(args)
      : 'No entendí la pregunta. Puedo ayudarte con vencimientos, celulares (por IMEI) y empleados (por DNI o nombre).';
  } catch (err) {
    reply = `Ocurrió un error al procesar tu pregunta: ${err.message}`;
  }

  await logMessage(phoneNumber, user.id, 'saliente', reply);
  return reply;
}

module.exports = { TOOLS, interpretQuestion, answerQuestion, findAuthorizedUser };
