// Cifra/descifra los valores "secretos" guardados en la tabla `settings`
// (API keys, tokens, contraseña SMTP) con AES-256-GCM, para que un dump
// de la base de datos no los exponga en texto plano. La clave sale de
// CREDENTIALS_ENC_KEY (64 caracteres hex = 32 bytes) en .env.
//
// Si esa variable no esta configurada, encrypt()/decrypt() se comportan
// como una funcion identidad (devuelven el valor tal cual) en vez de
// reventar - asi una instalacion ya en produccion sigue funcionando
// igual despues de un `git pull` aunque todavia no le hayan agregado la
// clave nueva al .env; en cuanto la agreguen y reinicien, empieza a
// cifrar solo.
const crypto = require('crypto');
const env = require('../config/env');

const ALGORITHM = 'aes-256-gcm';
const PREFIX = 'enc:v1:';

function getKey() {
  const hex = env.credentialsEncKey;
  if (!hex || hex.length !== 64) return null;
  return Buffer.from(hex, 'hex');
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

function encrypt(text) {
  const key = getKey();
  if (!key || text === undefined || text === null || text === '') return text;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

function decrypt(value) {
  if (!isEncrypted(value)) return value; // legado en texto plano, o vacio
  const key = getKey();
  if (!key) return value; // sin clave configurada: no se puede descifrar

  const rest = value.slice(PREFIX.length); // "<ivHex>:<authTagHex>:<cipherHex>"
  const [ivHex, tagHex, dataHex] = rest.split(':');
  if (!ivHex || !tagHex || dataHex === undefined) return value; // formato inesperado

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const plain = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
    return plain.toString('utf8');
  } catch (err) {
    // Clave rotada/incorrecta o dato corrupto - mejor devolver el valor
    // cifrado que reventar toda la app por un solo campo ilegible.
    return value;
  }
}

module.exports = { encrypt, decrypt, isEncrypted };
