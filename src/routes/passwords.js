// ============================================================
// PASSWORT-ROUTEN — Gespeicherte Zugangsdaten mit Verschlüsselung
// ============================================================
// Zwei Arten von Einträgen:
//   - Privat:  vaultId = null → verschlüsselt mit dem User-Key
//   - Geteilt: vaultId gesetzt → verschlüsselt mit dem Tresor-Schlüssel,
//              alle Tresor-Mitglieder können lesen/schreiben/löschen
// ============================================================

const express = require('express');
const prisma = require('../utils/prisma');
const { requireAuth } = require('../middleware/auth');
const { validateStoredPassword, sanitize } = require('../utils/validation');
const { encrypt, decrypt } = require('../utils/encryption');
const { getVaultKeyForUser, unwrapMembershipKey } = require('../utils/vaultKeys');

const router = express.Router();

router.use(requireAuth);

function decryptStoredPassword(entry, key) {
  return {
    id: entry.id,
    name: decrypt(entry.name, key),
    username: entry.username ? decrypt(entry.username, key) : '',
    password: decrypt(entry.password, key),
    website: entry.website ? decrypt(entry.website, key) : '',
    notes: entry.notes ? decrypt(entry.notes, key) : '',
    vaultId: entry.vaultId || null,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

// Eintrag laden, wenn der User Zugriff hat (eigener privater Eintrag
// oder Mitglied im Tresor des Eintrags). Sonst null.
async function findAccessibleEntry(id, req) {
  const entry = await prisma.storedPassword.findUnique({ where: { id } });
  if (!entry) return null;

  if (!entry.vaultId) {
    return entry.userId === req.userId ? entry : null;
  }
  const membership = await prisma.vaultMember.findUnique({
    where: { vaultId_userId: { vaultId: entry.vaultId, userId: req.userId } },
  });
  return membership ? entry : null;
}

// Passenden Schlüssel für ein Ziel ermitteln:
// vaultId null → User-Key, sonst Tresor-Schlüssel (null = kein Zugriff).
async function resolveKey(vaultId, req) {
  if (!vaultId) return req.encryptionKey;
  return getVaultKeyForUser(vaultId, req.userId, req.encryptionKey);
}

// GET /api/passwords — eigene private + alle Tresor-Einträge
router.get('/', async (req, res) => {
  try {
    // Tresor-Schlüssel aller Mitgliedschaften einmal entpacken
    const memberships = await prisma.vaultMember.findMany({
      where: { userId: req.userId },
      include: { vault: { select: { id: true, name: true } } },
    });

    const vaultKeys = {};
    const vaultNames = {};
    for (const m of memberships) {
      const k = await unwrapMembershipKey(m, req.userId, req.encryptionKey);
      if (k) {
        vaultKeys[m.vaultId] = k;
        vaultNames[m.vaultId] = decrypt(m.vault.name, k);
      }
    }

    const raw = await prisma.storedPassword.findMany({
      where: {
        OR: [
          { userId: req.userId, vaultId: null },
          ...(Object.keys(vaultKeys).length > 0
            ? [{ vaultId: { in: Object.keys(vaultKeys) } }]
            : []),
        ],
      },
      include: { user: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });

    const passwords = raw.map(p => ({
      ...decryptStoredPassword(p, p.vaultId ? vaultKeys[p.vaultId] : req.encryptionKey),
      vaultName: p.vaultId ? vaultNames[p.vaultId] : null,
      createdBy: p.vaultId ? p.user.name : null,
    }));

    res.json({ passwords });
  } catch (error) {
    console.error('Passwörter laden fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Passwörter konnten nicht geladen werden.' });
  }
});

// POST /api/passwords — neuer Eintrag (privat oder in einem Tresor)
router.post('/', async (req, res) => {
  try {
    const errors = validateStoredPassword(req.body);
    if (errors.length > 0) return res.status(400).json({ errors });

    const vaultId = req.body.vaultId || null;
    const key = await resolveKey(vaultId, req);
    if (!key) return res.status(403).json({ error: 'Kein Zugriff auf diesen Tresor.' });

    const name = sanitize(req.body.name);
    const { password, username, website, notes } = req.body;

    const entry = await prisma.storedPassword.create({
      data: {
        name: encrypt(name, key),
        username: encrypt(username || '', key),
        password: encrypt(password, key),
        website: encrypt(website || '', key),
        notes: encrypt(notes || '', key),
        userId: req.userId,
        vaultId,
      },
    });

    res.status(201).json({ password: decryptStoredPassword(entry, key) });
  } catch (error) {
    console.error('Passwort erstellen fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Passwort konnte nicht gespeichert werden.' });
  }
});

// PUT /api/passwords/:id — bearbeiten; vaultId im Body verschiebt den
// Eintrag (privat ↔ Tresor), sofern Zugriff auf Quelle UND Ziel besteht.
router.put('/:id', async (req, res) => {
  try {
    const existing = await findAccessibleEntry(req.params.id, req);
    if (!existing) return res.status(404).json({ error: 'Passwort nicht gefunden.' });

    const errors = validateStoredPassword(req.body);
    if (errors.length > 0) return res.status(400).json({ errors });

    // Ziel: mitgeschickte vaultId, sonst bleibt der Eintrag wo er ist
    const targetVaultId = req.body.vaultId !== undefined
      ? (req.body.vaultId || null)
      : existing.vaultId;

    const key = await resolveKey(targetVaultId, req);
    if (!key) return res.status(403).json({ error: 'Kein Zugriff auf diesen Tresor.' });

    const name = sanitize(req.body.name);
    const { password, username, website, notes } = req.body;

    const entry = await prisma.storedPassword.update({
      where: { id: req.params.id },
      data: {
        name: encrypt(name, key),
        username: encrypt(username || '', key),
        password: encrypt(password, key),
        website: encrypt(website || '', key),
        notes: encrypt(notes || '', key),
        vaultId: targetVaultId,
      },
    });

    res.json({ password: decryptStoredPassword(entry, key) });
  } catch (error) {
    console.error('Passwort bearbeiten fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Passwort konnte nicht geändert werden.' });
  }
});

// DELETE /api/passwords/:id
router.delete('/:id', async (req, res) => {
  try {
    const existing = await findAccessibleEntry(req.params.id, req);
    if (!existing) return res.status(404).json({ error: 'Passwort nicht gefunden.' });

    await prisma.storedPassword.delete({ where: { id: req.params.id } });
    res.json({ message: 'Passwort gelöscht.' });
  } catch (error) {
    console.error('Passwort löschen fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Passwort konnte nicht gelöscht werden.' });
  }
});

module.exports = router;
