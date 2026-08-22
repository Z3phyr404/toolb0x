// ============================================================
// AUSGABEN-ROUTEN — mit Verschlüsselung
// ============================================================

const express = require('express');
const prisma = require('../utils/prisma');
const { requireAuth } = require('../middleware/auth');
const { validateExpense, sanitize } = require('../utils/validation');
const { encrypt, decrypt } = require('../utils/encryption');

const router = express.Router();

router.use(requireAuth);

function decryptExpense(exp, key) {
  let tags = [];
  if (exp.tags) {
    try { tags = JSON.parse(decrypt(exp.tags, key)); } catch { tags = []; }
  }
  return {
    ...exp,
    name: decrypt(exp.name, key),
    amount: decrypt(exp.amount, key),
    tags,
    category: exp.category ? {
      ...exp.category,
      name: decrypt(exp.category.name, key),
      color: decrypt(exp.category.color, key),
    } : undefined,
  };
}

// Hilfsfunktion: Vormonat berechnen
function prevMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  const newM = m === 1 ? 12 : m - 1;
  const newY = m === 1 ? y - 1 : y;
  return `${newY}-${String(newM).padStart(2, '0')}`;
}

// Tagesdatum in einen anderen Monat übertragen (Tag beibehalten, auf die
// Monatslänge gekappt — aus "…-31" wird im Februar "…-28"/"…-29").
function carryDay(spentOn, targetMonth) {
  if (!spentOn) return null;
  const day = Number(spentOn.slice(8, 10));
  const [y, m] = targetMonth.split('-').map(Number);
  const maxDay = new Date(y, m, 0).getDate();
  return `${targetMonth}-${String(Math.min(day, maxDay)).padStart(2, '0')}`;
}

// spentOn aus dem Request lesen: leer/fehlend -> null (Validierung lief schon).
function readSpentOn(body) {
  return body.spentOn ? body.spentOn : null;
}

// GET /api/expenses/summary — MUSS vor /:id stehen!
router.get('/summary', async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return res.status(400).json({ error: 'Ungültiges Monatsformat.' });
    }

    const rawExpenses = await prisma.expense.findMany({
      where: { userId: req.userId, month },
      include: { category: { select: { id: true, name: true, color: true } } },
    });

    const rawIncomes = await prisma.income.findMany({
      where: { userId: req.userId, month },
    });

    const key = req.encryptionKey;
    const expenses = rawExpenses.map(e => decryptExpense(e, key));
    const incomes = rawIncomes.map(i => ({
      ...i,
      name: decrypt(i.name, key),
      amount: decrypt(i.amount, key),
    }));

    const totalExpenses = expenses.reduce((s, e) => s + parseFloat(e.amount), 0);
    const totalIncome = incomes.reduce((s, i) => s + parseFloat(i.amount), 0);

    const byCategory = {};
    for (const expense of expenses) {
      const catId = expense.category?.id;
      if (!catId) continue;
      if (!byCategory[catId]) {
        byCategory[catId] = { category: expense.category, total: 0, count: 0 };
      }
      byCategory[catId].total += parseFloat(expense.amount);
      byCategory[catId].count += 1;
    }

    const byTag = {};
    for (const expense of expenses) {
      const tags = expense.tags || [];
      for (const tag of tags) {
        if (!byTag[tag]) byTag[tag] = { tag, total: 0, count: 0 };
        byTag[tag].total += parseFloat(expense.amount);
        byTag[tag].count += 1;
      }
    }

    const pm = prevMonth(month);
    const prevRaw = await prisma.expense.findMany({
      where: { userId: req.userId, month: pm },
    });
    const prevTotal = prevRaw.reduce((s, e) => {
      const decrypted = decrypt(e.amount, key);
      const num = parseFloat(decrypted);
      return s + (isNaN(num) ? 0 : num);
    }, 0);

    res.json({
      month,
      totalExpenses: Math.round(totalExpenses * 100) / 100,
      totalIncome: Math.round(totalIncome * 100) / 100,
      remaining: Math.round((totalIncome - totalExpenses) * 100) / 100,
      byCategory: Object.values(byCategory).sort((a, b) => b.total - a.total),
      byTag: Object.values(byTag).sort((a, b) => b.total - a.total),
      comparison: {
        previousMonth: pm,
        previousTotal: Math.round(prevTotal * 100) / 100,
        change: Math.round((totalExpenses - prevTotal) * 100) / 100,
        changePercent: prevTotal > 0
          ? Math.round(((totalExpenses - prevTotal) / prevTotal) * 10000) / 100
          : null,
      },
    });
  } catch (error) {
    console.error('Summary fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Zusammenfassung konnte nicht geladen werden.' });
  }
});

// ============================================================
// GET /api/expenses/history?months=12 — Monatsverlauf (MUSS vor /:id stehen!)
// ============================================================
// Aggregiert die letzten N Monate (Ende = ?month oder aktueller Monat):
// je Monat Ausgaben- und Einnahmensumme, dazu Kategoriesummen über das
// ganze Fenster. Beträge sind verschlüsselt — die Aggregation entschlüsselt
// serverseitig (Einzelnutzer-Datenmengen, unkritisch). Es werden KEINE
// Einzelposten zurückgegeben, nur Summen.
router.get('/history', async (req, res) => {
  try {
    const n = Math.min(24, Math.max(3, parseInt(req.query.months, 10) || 12));
    const endMonth = req.query.month || new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(endMonth)) {
      return res.status(400).json({ error: 'Ungültiges Monatsformat.' });
    }
    const monthList = [endMonth];
    while (monthList.length < n) monthList.unshift(prevMonth(monthList[0]));

    const [rawExpenses, rawIncomes] = await Promise.all([
      prisma.expense.findMany({
        where: { userId: req.userId, month: { in: monthList } },
        include: { category: { select: { id: true, name: true, color: true } } },
      }),
      prisma.income.findMany({
        where: { userId: req.userId, month: { in: monthList } },
      }),
    ]);

    const key = req.encryptionKey;
    const parseAmount = (enc) => {
      const num = parseFloat(decrypt(enc, key));
      return isNaN(num) ? 0 : num;
    };

    const perMonth = {};
    for (const m of monthList) perMonth[m] = { month: m, expenses: 0, income: 0 };
    const byCategory = {};
    const catNames = {}; // Kategorie nur EINMAL entschlüsseln

    for (const e of rawExpenses) {
      const amount = parseAmount(e.amount);
      perMonth[e.month].expenses += amount;
      if (e.category) {
        if (!catNames[e.category.id]) {
          catNames[e.category.id] = {
            id: e.category.id,
            name: decrypt(e.category.name, key),
            color: decrypt(e.category.color, key),
          };
        }
        const cat = catNames[e.category.id];
        if (!byCategory[cat.id]) byCategory[cat.id] = { ...cat, total: 0, count: 0 };
        byCategory[cat.id].total += amount;
        byCategory[cat.id].count += 1;
      }
    }
    for (const i of rawIncomes) perMonth[i.month].income += parseAmount(i.amount);

    const round2 = (v) => Math.round(v * 100) / 100;
    res.json({
      months: monthList.map((m) => ({
        month: m,
        expenses: round2(perMonth[m].expenses),
        income: round2(perMonth[m].income),
      })),
      byCategory: Object.values(byCategory)
        .map((c) => ({ ...c, total: round2(c.total) }))
        .sort((a, b) => b.total - a.total),
    });
  } catch (error) {
    console.error('Verlauf fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Der Verlauf konnte nicht geladen werden.' });
  }
});

// ============================================================
// GET /api/expenses
// Lädt Ausgaben für den Monat.
// Falls keine existieren: wiederkehrende aus dem letzten
// bekannten Monat automatisch kopieren.
// ============================================================
router.get('/', async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return res.status(400).json({ error: 'Ungültiges Monatsformat.' });
    }

    let rawExpenses = await prisma.expense.findMany({
      where: { userId: req.userId, month },
      include: { category: { select: { id: true, name: true, color: true } } },
    });

    // Wenn keine Ausgaben: nur kopieren wenn der Monat noch NICHT initialisiert wurde
    // (d.h. der User hat noch NICHTS für diesen Monat gemacht — kein Löschen, kein Hinzufügen)
    if (rawExpenses.length === 0) {
      const alreadyInit = await prisma.monthInit.findUnique({
        where: { userId_month_type: { userId: req.userId, month, type: 'expense' } },
      });

      if (alreadyInit) {
        // Monat wurde bereits initialisiert → nicht neu kopieren, leer lassen
        return res.json({ expenses: [], total: 0, month });
      }

      // Letzten Monat mit Ausgaben finden (max. 24 Monate zurück).
      // Stoppt wenn ein Monat gefunden wird, der vom User explizit bearbeitet
      // wurde (monthInit vorhanden) — auch wenn er leer ist. Das verhindert,
      // dass absichtlich gelöschte Einträge aus noch älteren Monaten zurückkommen.
      let sourceMonth = prevMonth(month);
      let sourceExpenses = [];

      for (let i = 0; i < 24; i++) {
        const found = await prisma.expense.findMany({
          where: { userId: req.userId, month: sourceMonth, isRecurring: true },
        });
        if (found.length > 0) {
          sourceExpenses = found;
          break;
        }
        const wasModified = await prisma.monthInit.findUnique({
          where: { userId_month_type: { userId: req.userId, month: sourceMonth, type: 'expense' } },
        });
        if (wasModified) break;
        sourceMonth = prevMonth(sourceMonth);
      }

      // Wiederkehrende in den neuen Monat kopieren
      if (sourceExpenses.length > 0) {
        await prisma.expense.createMany({
          data: sourceExpenses.map(e => ({
            name: e.name,           // bleibt verschlüsselt
            amount: e.amount,       // bleibt verschlüsselt
            categoryId: e.categoryId,
            tags: e.tags,           // bleibt verschlüsselt
            userId: e.userId,
            month,
            spentOn: carryDay(e.spentOn, month), // gleicher Tag im neuen Monat
            isRecurring: true,
          })),
        });

        // Neu erstellte laden
        rawExpenses = await prisma.expense.findMany({
          where: { userId: req.userId, month },
          include: { category: { select: { id: true, name: true, color: true } } },
        });
      }

      // Monat als initialisiert markieren (egal ob Daten kopiert wurden oder nicht)
      await prisma.monthInit.upsert({
        where: { userId_month_type: { userId: req.userId, month, type: 'expense' } },
        create: { userId: req.userId, month, type: 'expense' },
        update: {},
      });
    }

    const expenses = rawExpenses.map(e => decryptExpense(e, req.encryptionKey));
    expenses.sort((a, b) => parseFloat(b.amount) - parseFloat(a.amount));
    const total = expenses.reduce((s, e) => s + parseFloat(e.amount), 0);

    res.json({ expenses, total, month });

  } catch (error) {
    console.error('Ausgaben laden fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Ausgaben konnten nicht geladen werden.' });
  }
});

// GET /api/expenses/:id
router.get('/:id', async (req, res) => {
  try {
    const expense = await prisma.expense.findFirst({
      where: { id: req.params.id, userId: req.userId },
      include: { category: { select: { id: true, name: true, color: true } } },
    });

    if (!expense) return res.status(404).json({ error: 'Ausgabe nicht gefunden.' });

    res.json({ expense: decryptExpense(expense, req.encryptionKey) });

  } catch (error) {
    console.error('Ausgabe laden fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Ausgabe konnte nicht geladen werden.' });
  }
});

// POST /api/expenses
router.post('/', async (req, res) => {
  try {
    const errors = validateExpense(req.body);
    if (errors.length > 0) return res.status(400).json({ errors });

    const category = await prisma.category.findFirst({
      where: { id: req.body.categoryId, userId: req.userId },
    });
    if (!category) return res.status(400).json({ errors: ['Ungültige Kategorie.'] });

    const month = req.body.month || new Date().toISOString().slice(0, 7);
    const key = req.encryptionKey;

    const tags = Array.isArray(req.body.tags)
      ? req.body.tags.map(t => sanitize(t.trim())).filter(Boolean)
      : [];
    const encryptedTags = tags.length > 0 ? encrypt(JSON.stringify(tags), key) : '';

    const expense = await prisma.expense.create({
      data: {
        name: encrypt(sanitize(req.body.name), key),
        amount: encrypt(String(parseFloat(req.body.amount)), key),
        categoryId: req.body.categoryId,
        tags: encryptedTags,
        userId: req.userId,
        month,
        spentOn: readSpentOn(req.body),
        isRecurring: req.body.isRecurring !== false,
      },
      include: { category: { select: { id: true, name: true, color: true } } },
    });

    // Neue wiederkehrende Ausgabe in bereits initialisierte Zukunftsmonate kopieren,
    // damit sie dort nicht fehlt, wenn der Monat schon mal besucht wurde.
    if (expense.isRecurring) {
      const futureInits = await prisma.monthInit.findMany({
        where: { userId: req.userId, type: 'expense', month: { gt: month } },
      });
      if (futureInits.length > 0) {
        await prisma.expense.createMany({
          data: futureInits.map(fi => ({
            name: expense.name,
            amount: expense.amount,
            categoryId: expense.categoryId,
            tags: expense.tags,
            userId: expense.userId,
            month: fi.month,
            spentOn: carryDay(expense.spentOn, fi.month),
            isRecurring: true,
          })),
        });
      }
    }

    res.status(201).json({ expense: decryptExpense(expense, key) });

  } catch (error) {
    console.error('Ausgabe erstellen fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Ausgabe konnte nicht erstellt werden.' });
  }
});

// PUT /api/expenses/:id
router.put('/:id', async (req, res) => {
  try {
    const errors = validateExpense(req.body);
    if (errors.length > 0) return res.status(400).json({ errors });

    const existing = await prisma.expense.findFirst({
      where: { id: req.params.id, userId: req.userId },
    });
    if (!existing) return res.status(404).json({ error: 'Ausgabe nicht gefunden.' });

    if (req.body.categoryId !== existing.categoryId) {
      const cat = await prisma.category.findFirst({
        where: { id: req.body.categoryId, userId: req.userId },
      });
      if (!cat) return res.status(400).json({ errors: ['Ungültige Kategorie.'] });
    }

    const key = req.encryptionKey;

    const tags = Array.isArray(req.body.tags)
      ? req.body.tags.map(t => sanitize(t.trim())).filter(Boolean)
      : [];
    const encryptedTags = tags.length > 0 ? encrypt(JSON.stringify(tags), key) : '';

    const expense = await prisma.expense.update({
      where: { id: req.params.id },
      data: {
        name: encrypt(sanitize(req.body.name), key),
        amount: encrypt(String(parseFloat(req.body.amount)), key),
        categoryId: req.body.categoryId,
        tags: encryptedTags,
        month: req.body.month || existing.month,
        spentOn: req.body.spentOn !== undefined ? readSpentOn(req.body) : existing.spentOn,
        isRecurring: req.body.isRecurring ?? existing.isRecurring,
      },
      include: { category: { select: { id: true, name: true, color: true } } },
    });

    // Änderungen an wiederkehrenden Ausgaben in Zukunftsmonate propagieren.
    // Kopien werden anhand des alten verschlüsselten Namens gefunden
    // (beim Kopieren werden die verschlüsselten Werte 1:1 übernommen).
    if (expense.isRecurring && existing.isRecurring) {
      await prisma.expense.updateMany({
        where: {
          userId: req.userId,
          name: existing.name,
          isRecurring: true,
          month: { gt: existing.month },
        },
        data: {
          name: expense.name,
          amount: expense.amount,
          categoryId: expense.categoryId,
          tags: expense.tags,
        },
      });
    }

    res.json({ expense: decryptExpense(expense, key) });

  } catch (error) {
    console.error('Ausgabe bearbeiten fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Ausgabe konnte nicht geändert werden.' });
  }
});

// DELETE /api/expenses/:id
router.delete('/:id', async (req, res) => {
  try {
    const existing = await prisma.expense.findFirst({
      where: { id: req.params.id, userId: req.userId },
    });
    if (!existing) return res.status(404).json({ error: 'Ausgabe nicht gefunden.' });

    await prisma.expense.delete({ where: { id: req.params.id } });

    // Monat als initialisiert markieren → verhindert Auto-Copy beim nächsten Laden
    await prisma.monthInit.upsert({
      where: { userId_month_type: { userId: req.userId, month: existing.month, type: 'expense' } },
      create: { userId: req.userId, month: existing.month, type: 'expense' },
      update: {},
    });

    res.json({ message: 'Ausgabe gelöscht.' });

  } catch (error) {
    console.error('Ausgabe löschen fehlgeschlagen:', error.message);
    res.status(500).json({ error: 'Ausgabe konnte nicht gelöscht werden.' });
  }
});

module.exports = router;