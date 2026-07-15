// ============================================================
// NOTIZEN-ROUTEN — Hierarchische Seiten mit Verschlüsselung
// ============================================================

const express = require('express');
const prisma = require('../utils/prisma');
const { requireAuth } = require('../middleware/auth');
const { validateNote, sanitize } = require('../utils/validation');
const { encrypt, decrypt } = require('../utils/encryption');

const router = express.Router();

router.use(requireAuth);

// Body-Parser mit höherem Limit für Notizen (global: 10kb, hier: 500kb)
const largeBody = express.json({ limit: '500kb' });

// --------------------------------------------------------
// Decrypt-Helfer
// --------------------------------------------------------
function decryptNote(note, key) {
  return {
    ...note,
    title: decrypt(note.title, key),
    content: note.content ? decrypt(note.content, key) : '',
  };
}

function decryptNoteMeta(note, key) {
  return {
    ...note,
    title: decrypt(note.title, key),
  };
}

// --------------------------------------------------------
// Zirkelverweis-Prüfung
// --------------------------------------------------------
// Stellt sicher, dass beim Verschieben einer Notiz
// der Ziel-Parent kein Kind (oder Enkel) der Notiz ist.
async function wouldCreateCycle(noteId, targetParentId, userId) {
  if (!targetParentId) return false;
  if (targetParentId === noteId) return true;

  let currentId = targetParentId;
  const visited = new Set();

  while (currentId) {
    if (visited.has(currentId)) return true;
    visited.add(currentId);

    if (currentId === noteId) return true;

    const parent = await prisma.note.findFirst({
      where: { id: currentId, userId },
      select: { parentId: true },
    });
    currentId = parent?.parentId || null;
  }

  return false;
}

// ============================================================
// GET /api/notes — Alle Notizen (nur Metadaten, kein Content)
// ============================================================
router.get('/', async (req, res) => {
  try {
    const notes = await prisma.note.findMany({
      where: { userId: req.userId },
      select: {
        id: true,
        title: true,
        icon: true,
        parentId: true,
        sortOrder: true,
        isPinned: true,
        isArchived: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });

    const decrypted = notes.map(n => decryptNoteMeta(n, req.encryptionKey));
    res.json({ notes: decrypted });
  } catch (err) {
    console.error('Fehler beim Laden der Notizen:', err);
    res.status(500).json({ error: 'Notizen konnten nicht geladen werden.' });
  }
});

// ============================================================
// GET /api/notes/search — Volltextsuche (VOR /:id!)
// ============================================================
router.get('/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    if (!q) return res.json({ results: [] });

    const notes = await prisma.note.findMany({
      where: { userId: req.userId, isArchived: false },
      select: {
        id: true,
        title: true,
        content: true,
        icon: true,
        parentId: true,
      },
    });

    const results = [];
    for (const note of notes) {
      const title = decrypt(note.title, req.encryptionKey);
      const content = note.content ? decrypt(note.content, req.encryptionKey) : '';
      // HTML-Tags entfernen für Textsuche
      const plainContent = content.replace(/<[^>]*>/g, '');

      const titleMatch = title.toLowerCase().includes(q);
      const contentMatch = plainContent.toLowerCase().includes(q);

      if (titleMatch || contentMatch) {
        // Snippet erstellen
        let snippet = '';
        if (contentMatch) {
          const idx = plainContent.toLowerCase().indexOf(q);
          const start = Math.max(0, idx - 60);
          const end = Math.min(plainContent.length, idx + q.length + 60);
          snippet = (start > 0 ? '…' : '') +
            plainContent.slice(start, end) +
            (end < plainContent.length ? '…' : '');
        }

        results.push({
          id: note.id,
          title,
          icon: note.icon,
          parentId: note.parentId,
          snippet,
        });
      }

      if (results.length >= 20) break;
    }

    res.json({ results });
  } catch (err) {
    console.error('Fehler bei der Suche:', err);
    res.status(500).json({ error: 'Suche fehlgeschlagen.' });
  }
});

// ============================================================
// GET /api/notes/:id — Einzelne Notiz mit Content
// ============================================================
router.get('/:id', async (req, res) => {
  try {
    const note = await prisma.note.findFirst({
      where: { id: req.params.id, userId: req.userId },
    });

    if (!note) {
      return res.status(404).json({ error: 'Notiz nicht gefunden.' });
    }

    res.json({ note: decryptNote(note, req.encryptionKey) });
  } catch (err) {
    console.error('Fehler beim Laden der Notiz:', err);
    res.status(500).json({ error: 'Notiz konnte nicht geladen werden.' });
  }
});

// ============================================================
// POST /api/notes — Neue Notiz erstellen
// ============================================================
router.post('/', largeBody, async (req, res) => {
  try {
    const errors = validateNote(req.body);
    if (errors.length > 0) {
      return res.status(400).json({ errors });
    }

    const key = req.encryptionKey;

    // Parent prüfen (falls gesetzt)
    if (req.body.parentId) {
      const parent = await prisma.note.findFirst({
        where: { id: req.body.parentId, userId: req.userId },
      });
      if (!parent) {
        return res.status(400).json({ errors: ['Übergeordnete Seite nicht gefunden.'] });
      }
    }

    // Höchste sortOrder unter Geschwistern ermitteln
    const maxSort = await prisma.note.aggregate({
      where: {
        userId: req.userId,
        parentId: req.body.parentId || null,
      },
      _max: { sortOrder: true },
    });
    const nextSort = (maxSort._max.sortOrder ?? -1) + 1;

    const note = await prisma.note.create({
      data: {
        title: encrypt(sanitize(req.body.title), key),
        content: encrypt(req.body.content || '', key),
        icon: req.body.icon || '',
        parentId: req.body.parentId || null,
        sortOrder: nextSort,
        userId: req.userId,
      },
    });

    res.status(201).json({ note: decryptNote(note, key) });
  } catch (err) {
    console.error('Fehler beim Erstellen der Notiz:', err);
    res.status(500).json({ error: 'Notiz konnte nicht erstellt werden.' });
  }
});

// ============================================================
// PUT /api/notes/:id — Notiz aktualisieren
// ============================================================
router.put('/:id', largeBody, async (req, res) => {
  try {
    const existing = await prisma.note.findFirst({
      where: { id: req.params.id, userId: req.userId },
    });
    if (!existing) {
      return res.status(404).json({ error: 'Notiz nicht gefunden.' });
    }

    const errors = validateNote(req.body);
    if (errors.length > 0) {
      return res.status(400).json({ errors });
    }

    const key = req.encryptionKey;

    const data = {};
    if (req.body.title !== undefined) data.title = encrypt(sanitize(req.body.title), key);
    if (req.body.content !== undefined) data.content = encrypt(req.body.content, key);
    if (req.body.icon !== undefined) data.icon = req.body.icon;

    const note = await prisma.note.update({
      where: { id: req.params.id },
      data,
    });

    res.json({ note: decryptNote(note, key) });
  } catch (err) {
    console.error('Fehler beim Aktualisieren der Notiz:', err);
    res.status(500).json({ error: 'Notiz konnte nicht aktualisiert werden.' });
  }
});

// ============================================================
// DELETE /api/notes/:id — Notiz löschen (Cascade löscht Kinder)
// ============================================================
router.delete('/:id', async (req, res) => {
  try {
    const existing = await prisma.note.findFirst({
      where: { id: req.params.id, userId: req.userId },
    });
    if (!existing) {
      return res.status(404).json({ error: 'Notiz nicht gefunden.' });
    }

    await prisma.note.delete({ where: { id: req.params.id } });
    res.json({ message: 'Notiz gelöscht.' });
  } catch (err) {
    console.error('Fehler beim Löschen der Notiz:', err);
    res.status(500).json({ error: 'Notiz konnte nicht gelöscht werden.' });
  }
});

// ============================================================
// PUT /api/notes/:id/move — Notiz verschieben
// ============================================================
router.put('/:id/move', async (req, res) => {
  try {
    const existing = await prisma.note.findFirst({
      where: { id: req.params.id, userId: req.userId },
    });
    if (!existing) {
      return res.status(404).json({ error: 'Notiz nicht gefunden.' });
    }

    const { parentId, sortOrder } = req.body;

    // Zirkelverweis prüfen
    if (parentId !== undefined) {
      const cycle = await wouldCreateCycle(req.params.id, parentId, req.userId);
      if (cycle) {
        return res.status(400).json({ error: 'Zirkelverweis: Eine Seite kann nicht in ihre eigene Unterseite verschoben werden.' });
      }

      // Parent muss dem User gehören (falls gesetzt)
      if (parentId) {
        const parent = await prisma.note.findFirst({
          where: { id: parentId, userId: req.userId },
        });
        if (!parent) {
          return res.status(400).json({ error: 'Zielseite nicht gefunden.' });
        }
      }
    }

    const data = {};
    if (parentId !== undefined) data.parentId = parentId || null;
    if (sortOrder !== undefined) {
      const parsed = parseInt(sortOrder);
      if (isNaN(parsed)) {
        return res.status(400).json({ error: 'Ungültige Sortierposition.' });
      }
      data.sortOrder = parsed;
    }

    const note = await prisma.note.update({
      where: { id: req.params.id },
      data,
    });

    res.json({ note: decryptNoteMeta(note, req.encryptionKey) });
  } catch (err) {
    console.error('Fehler beim Verschieben der Notiz:', err);
    res.status(500).json({ error: 'Notiz konnte nicht verschoben werden.' });
  }
});

// ============================================================
// PUT /api/notes/:id/pin — Pinned togglen
// ============================================================
router.put('/:id/pin', async (req, res) => {
  try {
    const existing = await prisma.note.findFirst({
      where: { id: req.params.id, userId: req.userId },
    });
    if (!existing) {
      return res.status(404).json({ error: 'Notiz nicht gefunden.' });
    }

    const note = await prisma.note.update({
      where: { id: req.params.id },
      data: { isPinned: !existing.isPinned },
    });

    res.json({ note: decryptNoteMeta(note, req.encryptionKey) });
  } catch (err) {
    console.error('Fehler beim Pinnen:', err);
    res.status(500).json({ error: 'Pin-Status konnte nicht geändert werden.' });
  }
});

// ============================================================
// PUT /api/notes/:id/archive — Archivieren/Wiederherstellen
// ============================================================
router.put('/:id/archive', async (req, res) => {
  try {
    const existing = await prisma.note.findFirst({
      where: { id: req.params.id, userId: req.userId },
    });
    if (!existing) {
      return res.status(404).json({ error: 'Notiz nicht gefunden.' });
    }

    const newArchived = !existing.isArchived;

    // Notiz selbst archivieren/wiederherstellen
    await prisma.note.update({
      where: { id: req.params.id },
      data: { isArchived: newArchived },
    });

    // Kinder rekursiv mit-archivieren
    if (newArchived) {
      await archiveChildren(req.params.id, req.userId, true);
    }

    res.json({ message: newArchived ? 'Archiviert.' : 'Wiederhergestellt.' });
  } catch (err) {
    console.error('Fehler beim Archivieren:', err);
    res.status(500).json({ error: 'Archivierung fehlgeschlagen.' });
  }
});

// Rekursiv alle Kinder archivieren
async function archiveChildren(parentId, userId, isArchived) {
  const children = await prisma.note.findMany({
    where: { parentId, userId },
    select: { id: true },
  });

  for (const child of children) {
    await prisma.note.update({
      where: { id: child.id },
      data: { isArchived },
    });
    await archiveChildren(child.id, userId, isArchived);
  }
}

module.exports = router;
