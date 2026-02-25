// ============================================================
// KATEGORIEN-ROUTEN — mit Verschlüsselung
// ============================================================

const express = require('express');
const prisma = require('../utils/prisma');
const { requireAuth } = require('../middleware/auth');
const { validateCategory, sanitize } = require('../utils/validation');
const { encrypt, decrypt } = require('../utils/encryption');

const router = express.Router();

router.use(requireAuth);

function decryptCategory(cat, key) {
  return {
    ...cat,
    name: decrypt(cat.name, key),
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
    const decrypted = existing.map(c => ({ ...c, decName: decrypt(c.name, req.encryptionKey) }));
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
    const dup = all.find(c => c.id !== req.params.id && decrypt(c.name, req.encryptionKey).toLowerCase() === name.toLowerCase());
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
router.delete('/:id', async (req, res) => {
  try {
    const category = await prisma.category.findFirst({
      where: { id: req.params.id, userId: req.userId },
      include: { _count: { select: { expenses: true } } },
    });
    if (!category) return res.status(404).json({ error: 'Kategorie nicht gefunden.' });

    if (category._count.expenses > 0) {
      const allCats = await prisma.category.findMany({ where: { userId: req.userId } });
      let fallback = allCats.find(c => decrypt(c.name, req.encryptionKey) === 'Sonstiges');

      if (!fallback) {
        fallback = await prisma.category.create({
          data: {
            name: encrypt('Sonstiges', req.encryptionKey),
            color: encrypt('#8E8E93', req.encryptionKey),
            userId: req.userId,
          },
        });
      }

      if (category.id === fallback.id) {
        return res.status(400).json({
          error: '"Sonstiges" kann nicht gelöscht werden, solange Ausgaben zugeordnet sind.',
        });
      }

      await prisma.expense.updateMany({
        where: { categoryId: category.id },
        data: { categoryId: fallback.id },
      });
    }

    await prisma.category.delete({ where: { id: req.params.id } });

    res.json({ message: 'Kategorie gelöscht.', movedExpenses: category._count.expenses });

  } catch (error) {
    console.error('Kategorie löschen fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Kategorie konnte nicht gelöscht werden.' });
  }
});

module.exports = router;
