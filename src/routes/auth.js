// ============================================================
// AUTH-ROUTEN — mit Session-Store + Zero-Knowledge Encryption
// ============================================================

const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const prisma = require('../utils/prisma');
const { validateRegistration, validateLogin, sanitize } = require('../utils/validation');
const { requireAuth } = require('../middleware/auth');
const sessionStore = require('../utils/sessionStore');
const crypto = require('crypto');
const {
  generateEncryptionKey,
  wrapEncryptionKey,
  unwrapEncryptionKey,
  encrypt,
  generateUserKeypair,
  generateRecoveryCode,
  normalizeRecoveryCode,
} = require('../utils/encryption');

const router = express.Router();

// Fix #2: Gültiger Dummy-Hash für Timing-Attack-Schutz.
// Synchron beim Modul-Load: ein Login in den ersten Millisekunden nach
// Serverstart darf nie auf einen noch fehlenden Hash treffen (→ 500).
const dummyHash = bcrypt.hashSync('dummy-password-for-timing-protection', 12);

const DEFAULT_CATEGORIES = [
  { name: 'Wohnen & Grund', color: '#FF9500' },
  { name: 'Lebensmittel', color: '#34C759' },
  { name: 'Auto & Transport', color: '#007AFF' },
  { name: 'Sparen', color: '#5856D6' },
  { name: 'Versicherungen', color: '#AF52DE' },
  { name: 'Abonnements', color: '#FF2D55' },
  { name: 'Handy & Internet', color: '#00C7BE' },
  { name: 'Persönliches', color: '#FF6B6B' },
  { name: 'Sonstiges', color: '#8E8E93' },
];

// Passwort-Regeln (Registrierung, Passwort ändern, Reset)
function validatePasswordRules(password) {
  const errors = [];
  if (!password || password.length < 8) {
    errors.push('Das neue Passwort muss mindestens 8 Zeichen lang sein.');
  }
  if (password && !/[A-Z]/.test(password)) {
    errors.push('Das neue Passwort braucht mindestens einen Großbuchstaben.');
  }
  if (password && !/[0-9]/.test(password)) {
    errors.push('Das neue Passwort braucht mindestens eine Zahl.');
  }
  return errors;
}

function getCookieOptions() {
  const isProduction = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    path: '/',
  };
}

// JWT enthält jetzt nur noch userId + sessionId — KEIN Encryption Key mehr!
function createToken(userId, sessionId) {
  return jwt.sign(
    { userId, sid: sessionId },
    process.env.JWT_SECRET,
    { expiresIn: '20m' }
  );
}

// ============================================================
// POST /api/auth/register
// ============================================================
router.post('/register', async (req, res) => {
  try {
    const errors = validateRegistration(req.body);
    if (errors.length > 0) {
      return res.status(400).json({ errors });
    }

    const email = req.body.email.toLowerCase().trim();
    // Fix #8: Name wird NICHT sanitized — er wird nicht in HTML eingefügt
    // und soll korrekt gespeichert werden (z.B. "O'Brien" statt "O&#x27;Brien")
    const name = req.body.name.trim();
    const password = req.body.password;

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      // code: Frontend wechselt damit automatisch in den Anmelde-Modus.
      // Klartext statt vager Meldung: /profile verrät die Existenz ohnehin schon.
      return res.status(400).json({
        code: 'EMAIL_EXISTS',
        errors: ['Diese E-Mail-Adresse ist bereits registriert. Melde dich stattdessen an.'],
      });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const encKey = generateEncryptionKey();
    const wrappedKey = wrapEncryptionKey(encKey, password);

    // Schlüsselpaar für geteilte Tresore (Private Key mit User-Key verschlüsselt)
    const keypair = generateUserKeypair();

    // Recovery-Code: wrappt den Encryption Key ein zweites Mal —
    // damit ist ein Passwort-Reset OHNE Datenverlust möglich.
    // Wird nur EINMAL im Klartext zurückgegeben (Frontend zeigt ihn an).
    const recoveryCode = generateRecoveryCode();
    const recoveryKey = wrapEncryptionKey(encKey, normalizeRecoveryCode(recoveryCode));

    const encryptedCategories = DEFAULT_CATEGORIES.map(cat => ({
      name: encrypt(cat.name, encKey),
      color: encrypt(cat.color, encKey),
    }));

    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        name,
        encryptedKey: wrappedKey,
        publicKey: keypair.publicKey,
        encryptedPrivateKey: encrypt(keypair.privateKey, encKey),
        recoveryKey,
        categories: {
          create: encryptedCategories,
        },
      },
      select: {
        id: true,
        email: true,
        name: true,
        createdAt: true,
      },
    });

    // Fix #1: Key im Session-Store speichern statt im JWT
    const sessionId = sessionStore.create(user.id, encKey);
    const token = createToken(user.id, sessionId);
    res.cookie('auth_token', token, getCookieOptions());

    res.status(201).json({
      message: 'Konto erfolgreich erstellt!',
      user,
      recoveryCode,
    });

  } catch (error) {
    console.error('Registrierung fehlgeschlagen:', error.message);
    res.status(500).json({
      errors: ['Ein unerwarteter Fehler ist aufgetreten.'],
    });
  }
});

// ============================================================
// POST /api/auth/login
// ============================================================
router.post('/login', async (req, res) => {
  try {
    const errors = validateLogin(req.body);
    if (errors.length > 0) {
      return res.status(400).json({ errors });
    }

    const email = req.body.email.toLowerCase().trim();
    const password = req.body.password;

    const user = await prisma.user.findUnique({ where: { email } });

    // Fix #2: Gültiger Dummy-Hash für echten Timing-Attack-Schutz
    const passwordToCompare = user ? user.password : dummyHash;
    const isValidPassword = await bcrypt.compare(password, passwordToCompare);

    if (!user || !isValidPassword) {
      return res.status(401).json({
        errors: ['E-Mail oder Passwort ist falsch.'],
      });
    }

    // Gesperrte Nutzer können sich nicht einloggen
    if (user.suspended) {
      return res.status(403).json({
        errors: ['Dein Konto wurde gesperrt. Bitte kontaktiere den Administrator.'],
      });
    }

    const encKey = unwrapEncryptionKey(user.encryptedKey, password);
    if (!encKey) {
      return res.status(500).json({
        errors: ['Verschlüsselungs-Fehler. Bitte kontaktiere den Support.'],
      });
    }

    // Bestandsnutzer ohne Schlüsselpaar: jetzt provisionieren (für geteilte
    // Tresore). Nur beim Login möglich, weil nur hier der User-Key vorliegt.
    if (!user.publicKey || !user.encryptedPrivateKey) {
      const keypair = generateUserKeypair();
      await prisma.user.update({
        where: { id: user.id },
        data: {
          publicKey: keypair.publicKey,
          encryptedPrivateKey: encrypt(keypair.privateKey, encKey),
        },
      });
    }

    // Alte Sessions invalidieren (verhindert Session-Akkumulation)
    sessionStore.deleteAllForUser(user.id);

    // Fix #1: Key im Session-Store statt im JWT
    const sessionId = sessionStore.create(user.id, encKey);
    const token = createToken(user.id, sessionId);
    res.cookie('auth_token', token, getCookieOptions());

    res.json({
      message: 'Erfolgreich eingeloggt!',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
    });

  } catch (error) {
    console.error('Login fehlgeschlagen:', error.message);
    res.status(500).json({
      errors: ['Ein unerwarteter Fehler ist aufgetreten.'],
    });
  }
});

// ============================================================
// POST /api/auth/reset-password — Reset per Recovery-Code (ÖFFENTLICH)
// ============================================================
// KEIN Datenverlust: Der Recovery-Code entschlüsselt den Encryption
// Key (User.recoveryKey), der dann mit dem neuen Passwort neu
// gewrappt wird. Falscher Code → GCM-Auth-Tag schlägt fehl.
router.post('/reset-password', async (req, res) => {
  try {
    const { email, recoveryCode, newPassword } = req.body;

    if (!email || !recoveryCode || !newPassword) {
      return res.status(400).json({
        errors: ['E-Mail, Recovery-Code und neues Passwort sind erforderlich.'],
      });
    }

    const pwErrors = validatePasswordRules(newPassword);
    if (pwErrors.length > 0) {
      return res.status(400).json({ errors: pwErrors });
    }

    const user = await prisma.user.findUnique({
      where: { email: String(email).toLowerCase().trim() },
    });

    // Einheitliche Fehlermeldung (kein User-Enumeration über diesen Weg,
    // ob die E-Mail existiert oder der Code falsch ist)
    const genericError = () => res.status(401).json({
      errors: ['E-Mail oder Recovery-Code ist falsch.'],
    });

    if (!user || !user.recoveryKey || user.suspended) {
      return genericError();
    }

    const encKey = unwrapEncryptionKey(user.recoveryKey, normalizeRecoveryCode(recoveryCode));
    if (!encKey) {
      return genericError();
    }

    // Neues Passwort setzen, Key neu wrappen — Daten bleiben erhalten
    const hashedPassword = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        encryptedKey: wrapEncryptionKey(encKey, newPassword),
      },
    });

    // Alle Sessions beenden — Login mit dem neuen Passwort
    sessionStore.deleteAllForUser(user.id);

    res.json({
      message: 'Passwort zurückgesetzt. Melde dich mit dem neuen Passwort an.',
    });

  } catch (error) {
    console.error('Passwort-Reset fehlgeschlagen:', error.message);
    res.status(500).json({
      errors: ['Ein unerwarteter Fehler ist aufgetreten.'],
    });
  }
});

// ============================================================
// POST /api/auth/reset-with-token — Admin-Reset-Link (ÖFFENTLICH)
// ============================================================
// MIT Datenverlust: Ohne Passwort/Recovery-Code ist der Encryption
// Key unwiederbringlich. Alle verschlüsselten Daten werden gelöscht,
// das Konto (E-Mail, Name, Rolle) bleibt bestehen und bekommt einen
// frischen Key + Keypair + Recovery-Code + Standard-Kategorien.
router.post('/reset-with-token', async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res.status(400).json({
        errors: ['Token und neues Passwort sind erforderlich.'],
      });
    }

    const pwErrors = validatePasswordRules(newPassword);
    if (pwErrors.length > 0) {
      return res.status(400).json({ errors: pwErrors });
    }

    const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
    const user = await prisma.user.findUnique({ where: { resetToken: tokenHash } });

    if (!user || !user.resetTokenExpires || user.resetTokenExpires < new Date()) {
      return res.status(401).json({
        errors: ['Der Reset-Link ist ungültig oder abgelaufen.'],
      });
    }

    // Alle mit dem alten Key verschlüsselten Daten löschen.
    // Reihenfolge beachtet FK-Beziehungen (Expenses vor Categories).
    // Eigene Tresore kaskadieren (Mitglieder + Einträge). Tresor-Einträge
    // ANDERER Tresore bleiben (mit Tresor-Schlüssel verschlüsselt), nur
    // die eigene Mitgliedschaft fällt weg (gewrappter Schlüssel ist verloren).
    await prisma.reminder.deleteMany({ where: { userId: user.id } });
    await prisma.expense.deleteMany({ where: { userId: user.id } });
    await prisma.income.deleteMany({ where: { userId: user.id } });
    await prisma.monthInit.deleteMany({ where: { userId: user.id } });
    await prisma.category.deleteMany({ where: { userId: user.id } });
    await prisma.note.deleteMany({ where: { userId: user.id } });
    await prisma.storedPassword.deleteMany({ where: { userId: user.id, vaultId: null } });
    await prisma.vault.deleteMany({ where: { ownerId: user.id } });
    await prisma.vaultMember.deleteMany({ where: { userId: user.id } });
    await prisma.server.deleteMany({ where: { userId: user.id } });

    // Frischer Key, frisches Keypair, frischer Recovery-Code
    const encKey = generateEncryptionKey();
    const keypair = generateUserKeypair();
    const recoveryCode = generateRecoveryCode();
    const hashedPassword = await bcrypt.hash(newPassword, 12);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        encryptedKey: wrapEncryptionKey(encKey, newPassword),
        publicKey: keypair.publicKey,
        encryptedPrivateKey: encrypt(keypair.privateKey, encKey),
        recoveryKey: wrapEncryptionKey(encKey, normalizeRecoveryCode(recoveryCode)),
        resetToken: null,
        resetTokenExpires: null,
      },
    });

    // Standard-Kategorien mit dem neuen Key anlegen
    await prisma.category.createMany({
      data: DEFAULT_CATEGORIES.map(cat => ({
        name: encrypt(cat.name, encKey),
        color: encrypt(cat.color, encKey),
        userId: user.id,
      })),
    });

    sessionStore.deleteAllForUser(user.id);

    res.json({
      message: 'Passwort zurückgesetzt. Melde dich mit dem neuen Passwort an.',
      recoveryCode,
    });

  } catch (error) {
    console.error('Token-Reset fehlgeschlagen:', error.message);
    res.status(500).json({
      errors: ['Ein unerwarteter Fehler ist aufgetreten.'],
    });
  }
});

// ============================================================
// POST /api/auth/logout
// ============================================================
router.post('/logout', (req, res) => {
  // Fix #1: Session sofort ungültig machen
  try {
    const token = req.cookies?.auth_token;
    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
      sessionStore.delete(decoded.sid);
    }
  } catch {
    // Token ungültig — egal, Cookie wird sowieso gelöscht
  }

  res.cookie('auth_token', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 0,
    path: '/',
  });
  res.json({ message: 'Erfolgreich ausgeloggt.' });
});

// ============================================================
// GET /api/auth/me
// ============================================================
router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
        recoveryKey: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'Nutzer nicht gefunden.' });
    }

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        createdAt: user.createdAt,
        hasRecoveryCode: !!user.recoveryKey,
      },
    });

  } catch (error) {
    console.error('Nutzerabfrage fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Ein unerwarteter Fehler ist aufgetreten.' });
  }
});

// ============================================================
// PUT /api/auth/password — Fix #3: Passwort ändern
// ============================================================
router.put('/password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        errors: ['Altes und neues Passwort sind erforderlich.'],
      });
    }

    // Neues Passwort validieren
    if (newPassword.length < 8) {
      return res.status(400).json({
        errors: ['Das neue Passwort muss mindestens 8 Zeichen lang sein.'],
      });
    }
    if (!/[A-Z]/.test(newPassword)) {
      return res.status(400).json({
        errors: ['Das neue Passwort braucht mindestens einen Großbuchstaben.'],
      });
    }
    if (!/[0-9]/.test(newPassword)) {
      return res.status(400).json({
        errors: ['Das neue Passwort braucht mindestens eine Zahl.'],
      });
    }

    // Aktuellen User laden
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
    });

    // Altes Passwort prüfen
    const isValid = await bcrypt.compare(currentPassword, user.password);
    if (!isValid) {
      return res.status(401).json({
        errors: ['Das aktuelle Passwort ist falsch.'],
      });
    }

    // Encryption Key mit altem Passwort entschlüsseln
    const encKey = unwrapEncryptionKey(user.encryptedKey, currentPassword);
    if (!encKey) {
      return res.status(500).json({
        errors: ['Verschlüsselungs-Fehler. Bitte kontaktiere den Support.'],
      });
    }

    // Encryption Key mit neuem Passwort neu verschlüsseln
    const newHashedPassword = await bcrypt.hash(newPassword, 12);
    const newWrappedKey = wrapEncryptionKey(encKey, newPassword);

    // Beides speichern
    await prisma.user.update({
      where: { id: req.userId },
      data: {
        password: newHashedPassword,
        encryptedKey: newWrappedKey,
      },
    });

    // ALLE Sessions des Users ungültig machen (Sicherheit!)
    // Der User muss sich mit dem neuen Passwort neu einloggen
    sessionStore.deleteAllForUser(req.userId);

    // Cookie löschen
    res.cookie('auth_token', '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 0,
      path: '/',
    });

    res.json({
      message: 'Passwort erfolgreich geändert. Bitte melde dich erneut an.',
    });

  } catch (error) {
    console.error('Passwort-Änderung fehlgeschlagen:', error.message);
    res.status(500).json({
      errors: ['Ein unerwarteter Fehler ist aufgetreten.'],
    });
  }
});

// ============================================================
// POST /api/auth/recovery-code — Recovery-Code (neu) erzeugen
// ============================================================
// Für Bestandsnutzer ohne Code und zum Rotieren (z.B. Code verloren
// oder kompromittiert). Braucht das aktuelle Passwort, weil nur damit
// der Encryption Key entschlüsselt werden kann. Der Code wird nur
// EINMAL im Klartext zurückgegeben.
router.post('/recovery-code', requireAuth, async (req, res) => {
  try {
    const { currentPassword } = req.body;

    if (!currentPassword) {
      return res.status(400).json({
        errors: ['Bitte gib dein aktuelles Passwort zur Bestätigung ein.'],
      });
    }

    const user = await prisma.user.findUnique({ where: { id: req.userId } });

    const isValid = await bcrypt.compare(currentPassword, user.password);
    if (!isValid) {
      return res.status(401).json({
        errors: ['Das aktuelle Passwort ist falsch.'],
      });
    }

    const encKey = unwrapEncryptionKey(user.encryptedKey, currentPassword);
    if (!encKey) {
      return res.status(500).json({
        errors: ['Verschlüsselungs-Fehler. Bitte kontaktiere den Support.'],
      });
    }

    const recoveryCode = generateRecoveryCode();
    await prisma.user.update({
      where: { id: req.userId },
      data: {
        recoveryKey: wrapEncryptionKey(encKey, normalizeRecoveryCode(recoveryCode)),
      },
    });

    res.json({
      message: 'Neuer Recovery-Code erstellt. Der alte Code ist ab sofort ungültig.',
      recoveryCode,
    });

  } catch (error) {
    console.error('Recovery-Code-Erstellung fehlgeschlagen:', error.message);
    res.status(500).json({
      errors: ['Ein unerwarteter Fehler ist aufgetreten.'],
    });
  }
});

// ============================================================
// PUT /api/auth/profile — Profil aktualisieren (Name/E-Mail)
// ============================================================
router.put('/profile', requireAuth, async (req, res) => {
  try {
    const { name, email, currentPassword } = req.body;

    // Passwort zur Re-Authentifizierung erforderlich
    if (!currentPassword) {
      return res.status(400).json({
        errors: ['Bitte gib dein aktuelles Passwort zur Bestätigung ein.'],
      });
    }

    // Name validieren
    const trimmedName = name?.trim();
    if (!trimmedName || trimmedName.length < 2) {
      return res.status(400).json({
        errors: ['Der Name muss mindestens 2 Zeichen lang sein.'],
      });
    }
    if (trimmedName.length > 50) {
      return res.status(400).json({
        errors: ['Der Name darf maximal 50 Zeichen lang sein.'],
      });
    }

    // E-Mail validieren
    const validator = require('validator');
    const newEmail = email?.toLowerCase().trim();
    if (!newEmail || !validator.isEmail(newEmail)) {
      return res.status(400).json({
        errors: ['Bitte gib eine gültige E-Mail-Adresse ein.'],
      });
    }

    // Aktuellen User laden
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
    });

    // Passwort prüfen
    const isValid = await bcrypt.compare(currentPassword, user.password);
    if (!isValid) {
      return res.status(401).json({
        errors: ['Das aktuelle Passwort ist falsch.'],
      });
    }

    // E-Mail-Eindeutigkeit prüfen (nur wenn geändert)
    if (newEmail !== user.email) {
      const existingUser = await prisma.user.findUnique({
        where: { email: newEmail },
      });
      if (existingUser) {
        return res.status(400).json({
          errors: ['Diese E-Mail-Adresse wird bereits verwendet.'],
        });
      }
    }

    // Profil aktualisieren
    const updatedUser = await prisma.user.update({
      where: { id: req.userId },
      data: {
        name: trimmedName,
        email: newEmail,
      },
      select: { id: true, email: true, name: true, createdAt: true },
    });

    res.json({
      message: 'Profil erfolgreich aktualisiert.',
      user: updatedUser,
    });

  } catch (error) {
    console.error('Profil-Aktualisierung fehlgeschlagen:', error.message);
    res.status(500).json({
      errors: ['Ein unerwarteter Fehler ist aufgetreten.'],
    });
  }
});

// ============================================================
// DELETE /api/auth/account — Konto und alle Daten löschen
// ============================================================
router.delete('/account', requireAuth, async (req, res) => {
  try {
    const { currentPassword } = req.body;

    if (!currentPassword) {
      return res.status(400).json({
        errors: ['Bitte gib dein Passwort zur Bestätigung ein.'],
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.userId },
    });

    const isValid = await bcrypt.compare(currentPassword, user.password);
    if (!isValid) {
      return res.status(401).json({
        errors: ['Das Passwort ist falsch.'],
      });
    }

    // User löschen — Kaskade löscht Categories, Expenses, Incomes
    await prisma.user.delete({
      where: { id: req.userId },
    });

    // ALLE Sessions des Users ungültig machen
    sessionStore.deleteAllForUser(req.userId);

    // Cookie löschen
    res.cookie('auth_token', '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 0,
      path: '/',
    });

    res.json({ message: 'Konto und alle Daten wurden gelöscht.' });

  } catch (error) {
    console.error('Konto-Löschung fehlgeschlagen:', error.message);
    res.status(500).json({
      errors: ['Ein unerwarteter Fehler ist aufgetreten.'],
    });
  }
});

module.exports = router;
