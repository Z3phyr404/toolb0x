// ============================================================
// AUTHENTIFIZIERUNGS-MIDDLEWARE — mit Session-Store
// ============================================================
// Das JWT enthält nur noch userId + sessionId.
// Der Encryption Key wird aus dem Session-Store geholt (RAM).
// ============================================================

const jwt = require('jsonwebtoken');
const sessionStore = require('../utils/sessionStore');

function requireAuth(req, res, next) {
  try {
    const token = req.cookies?.auth_token;

    if (!token) {
      return res.status(401).json({
        error: 'Nicht eingeloggt. Bitte melde dich an.',
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Session aus dem Store holen
    const session = sessionStore.get(decoded.sid);
    if (!session) {
      return res.status(401).json({
        error: 'Sitzung abgelaufen. Bitte melde dich erneut an.',
      });
    }

    // Sicherheitscheck: userId im JWT muss mit Session übereinstimmen
    if (session.userId !== decoded.userId) {
      return res.status(401).json({
        error: 'Ungültige Sitzung.',
      });
    }

    req.userId = decoded.userId;
    req.sessionId = decoded.sid;
    req.encryptionKey = session.encryptionKey; // Buffer aus dem RAM

    // Sliding Session: Token bei jeder Anfrage erneuern
    // → Die 20-Minuten-Uhr startet bei jeder Aktion neu
    const newToken = jwt.sign(
      { userId: decoded.userId, sid: decoded.sid },
      process.env.JWT_SECRET,
      { expiresIn: '20m' }
    );
    res.cookie('auth_token', newToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
    });

    next();

  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        error: 'Sitzung abgelaufen. Bitte melde dich erneut an.',
      });
    }
    return res.status(401).json({
      error: 'Ungültige Authentifizierung.',
    });
  }
}

module.exports = { requireAuth };