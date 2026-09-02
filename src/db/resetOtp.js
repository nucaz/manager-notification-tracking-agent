// Restablece el 2FA (TOTP) de un usuario por correo, para el caso en que
// pierda su dispositivo y no haya otro admin disponible para hacerlo desde
// la UI (Usuarios -> Restablecer 2FA).
// Uso: npm run reset-2fa -- correo@ejemplo.com
const pool = require('./pool');

async function resetOtp() {
  const email = process.argv[2];
  if (!email) {
    console.error('Uso: npm run reset-2fa -- correo@ejemplo.com');
    process.exit(1);
  }

  const [result] = await pool.query(
    'UPDATE users SET otp_secret = NULL, otp_enabled = 0, otp_confirmed_at = NULL WHERE email = ?',
    [email]
  );

  if (result.affectedRows === 0) {
    console.error(`No se encontro ningun usuario con el correo: ${email}`);
    process.exit(1);
  }

  console.log(`2FA restablecido para ${email}. Debera configurarlo de nuevo en su proximo inicio de sesion.`);
  process.exit(0);
}

resetOtp().catch((err) => {
  console.error('Error al restablecer el 2FA:', err.message);
  process.exit(1);
});
