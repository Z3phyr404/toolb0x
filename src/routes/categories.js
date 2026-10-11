// ============================================================
// KATEGORIEN-ROUTEN — mit Verschlüsselung
// ============================================================

const express = require('express');
const prisma = require('../utils/prisma');
const { requireAuth } = require('../middleware/auth');
const { validateCategory, sanitize } = require('../utils/validation');
const { encrypt, decrypt } = require('../utils/encryption');
const { entschaerfe, entschaerfeListe } = require('../utils/legacyText');

const finance = require('../services/finance');

const router = express.Router();

router.use(requireAuth);

function decryptCategory(cat, key) {
  return {
    ...cat,
    name: entschaerfe(decrypt(cat.name, key)),
    color: decrypt(cat.color, key),
  };
}

// GET /api/categories
router.get('/', async (req, res) => {
  try {
    const rawCategories = await prisma.category.findMany({
      where: { userId: req.userId },
      include: { _count: { select: { expenses: true } } },
    });

    const categories = rawCategories.map(c => decryptCategory(c, req.encryptionKey));
    categories.sort((a, b) => a.name.localeCompare(b.name));

    res.json({ categories });

  } catch (error) {
    console.error('Kategorien laden fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Kategorien konnten nicht geladen werden.' });
  }
});

// POST /api/categories
router.post('/', async (req, res) => {
  try {
    const errors = validateCategory(req.body);
    if (errors.length > 0) return res.status(400).json({ errors });

    const name = sanitize(req.body.name);
    const color = req.body.color || '#8E8E93';

    // Duplikat-Prüfung
    const existing = await prisma.category.findMany({ where: { userId: req.userId } });
    const decrypted = existing.map(c => ({ ...c, decName: entschaerfe(decrypt(c.name, req.encryptionKey)) }));
    if (decrypted.some(c => c.decName.toLowerCase() === name.toLowerCase())) {
      return res.status(400).json({ errors: ['Eine Kategorie mit diesem Namen existiert bereits.'] });
    }

    const category = await prisma.category.create({
      data: {
        name: encrypt(name, req.encryptionKey),
        color: encrypt(color, req.encryptionKey),
        userId: req.userId,
      },
    });

    res.status(201).json({ category: decryptCategory(category, req.encryptionKey) });

  } catch (error) {
    console.error('Kategorie erstellen fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Kategorie konnte nicht erstellt werden.' });
  }
});

// PUT /api/categories/:id
router.put('/:id', async (req, res) => {
  try {
    const errors = validateCategory(req.body);
    if (errors.length > 0) return res.status(400).json({ errors });

    const existing = await prisma.category.findFirst({
      where: { id: req.params.id, userId: req.userId },
    });
    if (!existing) return res.status(404).json({ error: 'Kategorie nicht gefunden.' });

    const name = sanitize(req.body.name);

    // Duplikat-Prüfung
    const all = await prisma.category.findMany({ where: { userId: req.userId } });
    const dup = all.find(c => c.id !== req.params.id && entschaerfe(decrypt(c.name, req.encryptionKey)).toLowerCase() === name.toLowerCase());
    if (dup) return res.status(400).json({ errors: ['Eine Kategorie mit diesem Namen existiert bereits.'] });

    // Fix #9: Nur neu verschlüsseln wenn sich der Wert ändert
    const updateData = {
      name: encrypt(name, req.encryptionKey),
    };
    if (req.body.color) {
      updateData.color = encrypt(req.body.color, req.encryptionKey);
    }
    // Wenn keine neue Farbe kommt → altes verschlüsseltes Feld behalten

    const category = await prisma.category.update({
      where: { id: req.params.id },
      data: updateData,
    });

    res.json({ category: decryptCategory(category, req.encryptionKey) });

  } catch (error) {
    console.error('Kategorie bearbeiten fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Kategorie konnte nicht geändert werden.' });
  }
});

// DELETE /api/categories/:id
// Logik (Ausgaben wandern nach "Sonstiges") seit 2026-10-12 in
// services/finance.js deleteCategory — gemeinsam mit der Zephyr-Integration.
router.delete('/:id', async (req, res) => {
  try {
    const category = await prisma.category.findFirst({
      where: { id: req.params.id, userId: req.userId },
    });
    if (!category) return res.status(404).json({ error: 'Kategorie nicht gefunden.' });

    const result = await finance.deleteCategory(prisma, { userId: req.userId, key: req.encryptionKey }, category);
    if (result.error) return res.status(400).json({ error: result.error });

    res.json({ message: 'Kategorie gelöscht.', movedExpenses: result.movedExpenses });

  } catch (error) {
    console.error('Kategorie löschen fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Kategorie konnte nicht gelöscht werden.' });
  }
});

module.exports = router;
