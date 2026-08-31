const nodemailer = require('nodemailer');
const settingsService = require('./settingsService');

async function getTransport() {
  const settings = await settingsService.getAll();
  if (!settings.smtp_host) {
    throw new Error('SMTP no esta configurado. Ve a Configuracion y completa los datos del servidor de correo.');
  }
  const transport = nodemailer.createTransport({
    host: settings.smtp_host,
    port: parseInt(settings.smtp_port || '587', 10),
    secure: String(settings.smtp_secure).toLowerCase() === 'true',
    auth: settings.smtp_user
      ? { user: settings.smtp_user, pass: settings.smtp_pass }
      : undefined,
  });
  return { transport, from: settings.smtp_from || settings.smtp_user };
}

async function sendMail({ to, subject, html, text }) {
  const { transport, from } = await getTransport();
  return transport.sendMail({
    from,
    to,
    subject,
    html,
    text: text || undefined,
  });
}

async function verifyConnection() {
  const { transport } = await getTransport();
  await transport.verify();
  return true;
}

module.exports = { sendMail, verifyConnection };
