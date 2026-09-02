const { OTP } = require('otplib');
const QRCode = require('qrcode');

const totp = new OTP({ strategy: 'totp' });

// Tolera +-30s de desfase de reloj entre el servidor y el celular (1 paso).
const EPOCH_TOLERANCE = 30;

function generateSecret() {
  return totp.generateSecret();
}

function keyUri(email, secret, issuer) {
  return totp.generateURI({ issuer, label: email, secret });
}

async function verifyToken(secret, token) {
  if (!secret || !token) return false;
  try {
    const result = await totp.verify({
      secret,
      token: String(token).trim(),
      epochTolerance: EPOCH_TOLERANCE,
    });
    return result.valid;
  } catch (err) {
    return false;
  }
}

function qrDataUrl(otpauthUrl) {
  return QRCode.toDataURL(otpauthUrl);
}

module.exports = { generateSecret, keyUri, verifyToken, qrDataUrl };
