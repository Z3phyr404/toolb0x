// ============================================================
// PASSWORT-ROUTEN — Gespeicherte Zugangsdaten mit Verschlüsselung
// ============================================================

const express = require('express');
const prisma = require('../utils/prisma');
const { requireAuth } = require('../middleware/auth');
const { validateStoredPassword, sanitize } = require('../utils/validation');
const { encrypt, decrypt } = require('../utils/encryption');

const router = express.Router();

router.use(requireAuth);

function decryptStoredPassword(entry, key) {
  return {
    ...entry,
    name: decrypt(entry.name, key),
    username: entry.username ? decrypt(entry.username, key) : '',
    password: decrypt(entry.password, key),
    website: entry.website ? decrypt(entry.website, key) : '',
    notes: entry.notes ? decrypt(entry.notes, key) : '',
  };
}

// GET /api/passwords
router.get('/', async (req, res) => {
  try {
    const raw = await prisma.storedPassword.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: 'desc' },
    });

    const passwords = raw.map(p => decryptStoredPassword(p, req.encryptionKey));
    res.json({ passwords });
  } catch (error) {
    console.error('Passwörter laden fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Passwörter konnten nicht geladen werden.' });
  }
});

// POST /api/passwords
router.post('/', async (req, res) => {
  try {
    const errors = validateStoredPassword(req.body);
    if (errors.length > 0) return res.status(400).json({ errors });

    const name = sanitize(req.body.name);
    const { password, username, website, notes } = req.body;

    const entry = await prisma.storedPassword.create({
      data: {
        name: encrypt(name, req.encryptionKey),
        username: encrypt(username || '', req.encryptionKey),
        password: encrypt(password, req.encryptionKey),
        website: encrypt(website || '', req.encryptionKey),
        notes: encrypt(notes || '', req.encryptionKey),
        userId: req.userId,
      },
    });

    res.status(201).json({ password: decryptStoredPassword(entry, req.encryptionKey) });
  } catch (error) {
    console.error('Passwort erstellen fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Passwort konnte nicht gespeichert werden.' });
  }
});

// PUT /api/passwords/:id
router.put('/:id', async (req, res) => {
  try {
    const existing = await prisma.storedPassword.findFirst({
      where: { id: req.params.id, userId: req.userId },
    });
    if (!existing) return res.status(404).json({ error: 'Passwort nicht gefunden.' });

    const errors = validateStoredPassword(req.body);
    if (errors.length > 0) return res.status(400).json({ errors });

    const name = sanitize(req.body.name);
    const { password, username, website, notes } = req.body;

    const entry = await prisma.storedPassword.update({
      where: { id: req.params.id },
      data: {
        name: encrypt(name, req.encryptionKey),
        username: encrypt(username || '', req.encryptionKey),
        password: encrypt(password, req.encryptionKey),
        website: encrypt(website || '', req.encryptionKey),
        notes: encrypt(notes || '', req.encryptionKey),
      },
    });

    res.json({ password: decryptStoredPassword(entry, req.encryptionKey) });
  } catch (error) {
    console.error('Passwort bearbeiten fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Passwort konnte nicht geändert werden.' });
  }
});

// DELETE /api/passwords/:id
router.delete('/:id', async (req, res) => {
  try {
    const existing = await prisma.storedPassword.findFirst({
      where: { id: req.params.id, userId: req.userId },
    });
    if (!existing) return res.status(404).json({ error: 'Passwort nicht gefunden.' });

    await prisma.storedPassword.delete({ where: { id: req.params.id } });
    res.json({ message: 'Passwort gelöscht.' });
  } catch (error) {
    console.error('Passwort löschen fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Passwort konnte nicht gelöscht werden.' });
  }
});

module.exports = router;
