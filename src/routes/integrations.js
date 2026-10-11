// ============================================================
// INTEGRATIONS-VERWALTUNG — /api/integrations (angemeldet, in der App)
// ============================================================
// Hier erzeugt und widerruft der Nutzer seinen Hermes-Zugang. Nur über
// die normale Sitzung (requireAuth): nur hier liegt der entpackte
// User-Key vor, aus dem die Schlüsselkopie für den Zugang entsteht.
//
// GET    /            → eigene Zugänge (ohne Hash, ohne Schlüsselkopie)
// POST   /            → { password, name? } — neuer Zugang; Token NUR in
//                        dieser Antwort (danach nie wieder abrufbar)
// DELETE /:id         → Zugang widerrufen (sofort wirksam)
//
// Der Zugang selbst wird NICHT hier benutzt, sondern über den lokalen
// Listener (src/integration/app.js, 127.0.0.1:3001).
// ============================================================

const express = require('express');
const bcrypt = require('bcrypt');
const prisma = require('../utils/prisma');
const { requireAuth } = require('../middleware/auth');
const { sanitize } = require('../utils/validation');
const {
  MAX_ACTIVE_PER_USER, createCredential, revokeCredential, publicCredential,
} = require('../integration/credentials');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  try {
    const rows = await prisma.integrationCredential.findMany({ where: { userId: req.userId } });
    const credentials = rows
      .map(publicCredential)
      .sort((a, b) => (b.active - a.active) || (new Date(b.createdAt) - new Date(a.createdAt)));
    res.json({ credentials });
  } catch (error) {
    console.error('Integrationen laden fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Zugänge konnten nicht geladen werden.' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { password } = req.body || {};
    if (typeof password !== 'string' || !password) {
      return res.status(400).json({ errors: ['Bitte bestätige mit deinem Passwort.'] });
    }
    const rawName = typeof req.body.name === 'string' ? sanitize(req.body.name) : '';
    const name = rawName ? rawName.slice(0, 40) : 'Hermes';

    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ errors: ['Das Passwort ist falsch.'] });
    }

    const active = (await prisma.integrationCredential.findMany({ where: { userId: req.userId, revokedAt: null } }))
      .filter(c => c.wrappedKey);
    if (active.length >= MAX_ACTIVE_PER_USER) {
      return res.status(400).json({ errors: [`Höchstens ${MAX_ACTIVE_PER_USER} aktive Zugänge. Bitte zuerst einen widerrufen.`] });
    }

    const { credential, token } = await createCredential(prisma, {
      userId: req.userId,
      encryptionKey: req.encryptionKey,
      name,
    });
    console.log(`[integration] created cred=${credential.id.slice(0, 8)}`);
    res.status(201).json({ credential: publicCredential(credential), token });
  } catch (error) {
    console.error('Integration anlegen fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Zugang konnte nicht angelegt werden.' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const ok = await revokeCredential(prisma, { id: req.params.id, userId: req.userId });
    if (!ok) return res.status(404).json({ error: 'Zugang nicht gefunden oder schon widerrufen.' });
    console.log(`[integration] revoked cred=${req.params.id.slice(0, 8)}`);
    res.json({ message: 'Zugang widerrufen.' });
  } catch (error) {
    console.error('Integration widerrufen fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Zugang konnte nicht widerrufen werden.' });
  }
});

module.exports = router;
