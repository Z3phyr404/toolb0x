// ============================================================
// SERVER-ROUTEN — Remote-Server per SSH verwalten (Admin-only)
// ============================================================

const express = require('express');
const rateLimit = require('express-rate-limit');
const prisma = require('../utils/prisma');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { validateServer } = require('../utils/validation');
const { encrypt, decrypt } = require('../utils/encryption');
const serverOps = require('../services/servers');

const router = express.Router();

router.use(requireAuth);
router.use(requireAdmin);

const ENCRYPTED_FIELDS = ['host', 'port', 'username', 'password', 'privateKey', 'passphrase', 'notes'];

// Feste SSH-Befehle und deren Ausführung liegen seit 2026-10-12 in
// ../services/servers.js (gemeinsam mit der Zephyr-Integration).

const sshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: { error: 'Zu viele Server-Aktionen. Bitte warte einen Moment.' },
});

function decryptServerSafe(entry, key) {
  return {
    id: entry.id,
    label: entry.label,
    host: entry.host ? decrypt(entry.host, key) : '',
    port: entry.port ? decrypt(entry.port, key) : '22',
    username: entry.username ? decrypt(entry.username, key) : '',
    authType: entry.authType,
    serverType: entry.serverType || 'linux',
    notes: entry.notes ? decrypt(entry.notes, key) : '',
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function findServer(id, userId) {
  return serverOps.findServer(prisma, id, userId);
}

// ============================================================
// CRUD
// ============================================================

// GET /api/servers
router.get('/', async (req, res) => {
  try {
    var raw = await prisma.server.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: 'desc' },
    });
    var servers = raw.map(function (s) { return decryptServerSafe(s, req.encryptionKey); });
    res.json({ servers: servers });
  } catch (error) {
    console.error('Server laden fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Server konnten nicht geladen werden.' });
  }
});

// POST /api/servers
router.post('/', async (req, res) => {
  try {
    var errors = validateServer(req.body);
    if (errors.length > 0) return res.status(400).json({ errors: errors });

    var label = (req.body.label || '').trim();
    var key = req.encryptionKey;

    var entry = await prisma.server.create({
      data: {
        label: label,
        host: encrypt(req.body.host.trim(), key),
        port: encrypt(String(req.body.port || '22'), key),
        username: encrypt(req.body.username.trim(), key),
        authType: req.body.authType || 'password',
        serverType: req.body.serverType === 'storage' ? 'storage' : 'linux',
        password: encrypt(req.body.password || '', key),
        privateKey: encrypt(req.body.privateKey || '', key),
        passphrase: encrypt(req.body.passphrase || '', key),
        notes: encrypt(req.body.notes || '', key),
        userId: req.userId,
      },
    });

    res.status(201).json({ server: decryptServerSafe(entry, key) });
  } catch (error) {
    console.error('Server erstellen fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Server konnte nicht gespeichert werden.' });
  }
});

// PUT /api/servers/:id
router.put('/:id', async (req, res) => {
  try {
    var existing = await findServer(req.params.id, req.userId);
    if (!existing) return res.status(404).json({ error: 'Server nicht gefunden.' });

    var errors = validateServer(req.body);
    if (errors.length > 0) return res.status(400).json({ errors: errors });

    var label = (req.body.label || '').trim();
    var key = req.encryptionKey;

    var entry = await prisma.server.update({
      where: { id: req.params.id },
      data: {
        label: label,
        host: encrypt(req.body.host.trim(), key),
        port: encrypt(String(req.body.port || '22'), key),
        username: encrypt(req.body.username.trim(), key),
        authType: req.body.authType || 'password',
        serverType: req.body.serverType === 'storage' ? 'storage' : 'linux',
        password: encrypt(req.body.password || '', key),
        privateKey: encrypt(req.body.privateKey || '', key),
        passphrase: encrypt(req.body.passphrase || '', key),
        notes: encrypt(req.body.notes || '', key),
        // Beim Bearbeiten zurücksetzen — Host könnte sich geändert haben
        // oder der Server wurde neu installiert (neuer Host-Key).
        hostKeyFingerprint: '',
      },
    });

    res.json({ server: decryptServerSafe(entry, key) });
  } catch (error) {
    console.error('Server bearbeiten fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Server konnte nicht geändert werden.' });
  }
});

// DELETE /api/servers/:id
router.delete('/:id', async (req, res) => {
  try {
    var existing = await findServer(req.params.id, req.userId);
    if (!existing) return res.status(404).json({ error: 'Server nicht gefunden.' });

    await prisma.server.delete({ where: { id: req.params.id } });
    res.json({ message: 'Server gelöscht.' });
  } catch (error) {
    console.error('Server löschen fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Server konnte nicht gelöscht werden.' });
  }
});

// ============================================================
// SSH-AKTIONEN
// ============================================================

// Antwortet wie bisher: Fehler aus SSH/Validierung als 400 mit Meldung.
function sshAction(fn) {
  return async (req, res) => {
    try {
      const server = await findServer(req.params.id, req.userId);
      if (!server) return res.status(404).json({ error: 'Server nicht gefunden.' });
      res.json(await fn(server, req));
    } catch (error) {
      res.status(error.status || 400).json({ error: error.message });
    }
  };
}

router.post('/:id/test', sshLimiter, sshAction((s, req) => serverOps.testServer(s, req.encryptionKey)));
router.post('/:id/status', sshLimiter, sshAction((s, req) => serverOps.serverStatus(s, req.encryptionKey)));
router.post('/:id/stats', sshLimiter, sshAction((s, req) => serverOps.serverStats(s, req.encryptionKey)));
router.post('/:id/update', sshLimiter, sshAction((s, req) => serverOps.serverUpdate(s, req.encryptionKey)));
router.post('/:id/restart', sshLimiter, sshAction((s, req) => serverOps.serverRestart(s, req.encryptionKey)));
router.post('/:id/services', sshLimiter, sshAction((s, req) => serverOps.serverServices(s, req.encryptionKey)));
router.post('/:id/service-restart', sshLimiter, sshAction((s, req) => serverOps.serviceRestart(s, req.encryptionKey, req.body.service)));

module.exports = router;
