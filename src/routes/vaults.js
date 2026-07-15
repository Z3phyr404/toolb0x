// ============================================================
// TRESOR-ROUTEN — Geteilte Passwort-Tresore
// ============================================================
// Ein Tresor gehört einem Owner und kann weitere Mitglieder haben.
// Der Tresor-Schlüssel (AES-256) liegt pro Mitglied RSA-verschlüsselt
// in VaultMember.wrappedKey — der Server kann ihn at rest nicht lesen.
//
// Einladen: Der Einladende entpackt seinen Tresor-Schlüssel und
// verschlüsselt ihn mit dem Public Key des neuen Mitglieds. Das
// Mitglied muss sich dafür seit dem Feature-Deploy einmal eingeloggt
// haben (dann existiert sein Schlüsselpaar).
//
// Hinweis: Beim Entfernen eines Mitglieds wird der Tresor-Schlüssel
// NICHT rotiert — wer Einträge gesehen hat, kann sie kopiert haben.
// Nach dem Entfernen sollten sensible Passwörter geändert werden.
// ============================================================

const express = require('express');
const crypto = require('crypto');
const validator = require('validator');
const prisma = require('../utils/prisma');
const { requireAuth } = require('../middleware/auth');
const { encrypt, decrypt, wrapKeyWithPublicKey } = require('../utils/encryption');
const { getVaultKeyForUser } = require('../utils/vaultKeys');

const router = express.Router();

router.use(requireAuth);

const MAX_VAULTS_PER_USER = 20;
const MAX_MEMBERS_PER_VAULT = 10;

// ============================================================
// POST /api/vaults — Tresor anlegen
// ============================================================
router.post('/', async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name || name.length > 50) {
      return res.status(400).json({ error: 'Bitte gib einen Namen ein (max. 50 Zeichen).' });
    }

    const me = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { publicKey: true },
    });
    if (!me || !me.publicKey) {
      return res.status(400).json({
        error: 'Kein Schlüsselpaar vorhanden. Bitte einmal ab- und wieder anmelden.',
      });
    }

    const count = await prisma.vault.count({ where: { ownerId: req.userId } });
    if (count >= MAX_VAULTS_PER_USER) {
      return res.status(400).json({ error: 'Maximale Anzahl an Tresoren erreicht.' });
    }

    // Frischer Tresor-Schlüssel, für den Owner gewrappt
    const vaultKey = crypto.randomBytes(32);

    const vault = await prisma.vault.create({
      data: {
        name: encrypt(name, vaultKey),
        ownerId: req.userId,
        members: {
          create: {
            userId: req.userId,
            wrappedKey: wrapKeyWithPublicKey(me.publicKey, vaultKey),
            role: 'owner',
          },
        },
      },
    });

    res.status(201).json({ vault: { id: vault.id, name, role: 'owner', memberCount: 1 } });
  } catch (error) {
    console.error('Tresor erstellen fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Tresor konnte nicht erstellt werden.' });
  }
});

// ============================================================
// GET /api/vaults — Eigene Tresore (als Owner oder Mitglied)
// ============================================================
router.get('/', async (req, res) => {
  try {
    const memberships = await prisma.vaultMember.findMany({
      where: { userId: req.userId },
      include: {
        vault: {
          include: {
            members: {
              include: { user: { select: { id: true, name: true, email: true } } },
              orderBy: { createdAt: 'asc' },
            },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const vaults = [];
    for (const m of memberships) {
      const vaultKey = await getVaultKeyForUser(m.vaultId, req.userId, req.encryptionKey);
      vaults.push({
        id: m.vault.id,
        name: vaultKey ? decrypt(m.vault.name, vaultKey) : '[Kein Zugriff]',
        role: m.role,
        isOwner: m.vault.ownerId === req.userId,
        members: m.vault.members.map(mm => ({
          userId: mm.user.id,
          name: mm.user.name,
          email: mm.user.email,
          role: mm.role,
        })),
        createdAt: m.vault.createdAt,
      });
    }

    res.json({ vaults });
  } catch (error) {
    console.error('Tresore laden fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Tresore konnten nicht geladen werden.' });
  }
});

// ============================================================
// POST /api/vaults/:id/members — Mitglied per E-Mail einladen (nur Owner)
// ============================================================
router.post('/:id/members', async (req, res) => {
  try {
    const vault = await prisma.vault.findFirst({
      where: { id: req.params.id, ownerId: req.userId },
      include: { members: true },
    });
    if (!vault) {
      return res.status(404).json({ error: 'Tresor nicht gefunden.' });
    }

    const email = (req.body.email || '').toLowerCase().trim();
    if (!validator.isEmail(email)) {
      return res.status(400).json({ error: 'Bitte gib eine gültige E-Mail-Adresse ein.' });
    }

    if (vault.members.length >= MAX_MEMBERS_PER_VAULT) {
      return res.status(400).json({ error: 'Maximale Mitgliederzahl erreicht.' });
    }

    const invitee = await prisma.user.findUnique({
      where: { email },
      select: { id: true, name: true, publicKey: true, suspended: true },
    });
    // Bewusst dieselbe Meldung für "existiert nicht" und "gesperrt"
    if (!invitee || invitee.suspended) {
      return res.status(404).json({ error: 'Kein Konto mit dieser E-Mail gefunden.' });
    }
    if (vault.members.some(m => m.userId === invitee.id)) {
      return res.status(400).json({ error: 'Diese Person ist bereits Mitglied.' });
    }
    if (!invitee.publicKey) {
      return res.status(400).json({
        error: 'Diese Person muss sich einmal neu anmelden, bevor sie eingeladen werden kann.',
      });
    }

    // Eigenen Tresor-Schlüssel entpacken und für das neue Mitglied wrappen
    const vaultKey = await getVaultKeyForUser(vault.id, req.userId, req.encryptionKey);
    if (!vaultKey) {
      return res.status(500).json({ error: 'Tresor-Schlüssel konnte nicht geladen werden.' });
    }

    await prisma.vaultMember.create({
      data: {
        vaultId: vault.id,
        userId: invitee.id,
        wrappedKey: wrapKeyWithPublicKey(invitee.publicKey, vaultKey),
        role: 'member',
      },
    });

    res.status(201).json({ message: `${invitee.name} wurde hinzugefügt.` });
  } catch (error) {
    console.error('Mitglied einladen fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Mitglied konnte nicht hinzugefügt werden.' });
  }
});

// ============================================================
// DELETE /api/vaults/:id/members/:userId — Mitglied entfernen / verlassen
// ============================================================
// Owner darf jedes Mitglied entfernen, Mitglieder nur sich selbst.
// Der Owner kann nicht austreten (stattdessen Tresor löschen).
// ============================================================
router.delete('/:id/members/:userId', async (req, res) => {
  try {
    const vault = await prisma.vault.findUnique({
      where: { id: req.params.id },
      select: { id: true, ownerId: true },
    });
    if (!vault) {
      return res.status(404).json({ error: 'Tresor nicht gefunden.' });
    }

    const isOwner = vault.ownerId === req.userId;
    const isSelf = req.params.userId === req.userId;

    if (!isOwner && !isSelf) {
      return res.status(403).json({ error: 'Keine Berechtigung.' });
    }
    if (req.params.userId === vault.ownerId) {
      return res.status(400).json({
        error: 'Der Besitzer kann nicht entfernt werden. Lösche stattdessen den Tresor.',
      });
    }

    const result = await prisma.vaultMember.deleteMany({
      where: { vaultId: vault.id, userId: req.params.userId },
    });
    if (result.count === 0) {
      return res.status(404).json({ error: 'Mitglied nicht gefunden.' });
    }

    res.json({
      message: isSelf ? 'Du hast den Tresor verlassen.' : 'Mitglied entfernt.',
      hint: 'Der Tresor-Schlüssel wird nicht rotiert — ändere sensible Passwörter, wenn nötig.',
    });
  } catch (error) {
    console.error('Mitglied entfernen fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Mitglied konnte nicht entfernt werden.' });
  }
});

// ============================================================
// DELETE /api/vaults/:id — Tresor löschen (nur Owner)
// ============================================================
// Cascade löscht Mitgliedschaften UND alle Einträge im Tresor.
// ============================================================
router.delete('/:id', async (req, res) => {
  try {
    const result = await prisma.vault.deleteMany({
      where: { id: req.params.id, ownerId: req.userId },
    });
    if (result.count === 0) {
      return res.status(404).json({ error: 'Tresor nicht gefunden.' });
    }
    res.json({ message: 'Tresor und alle Einträge darin gelöscht.' });
  } catch (error) {
    console.error('Tresor löschen fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Tresor konnte nicht gelöscht werden.' });
  }
});

module.exports = router;
