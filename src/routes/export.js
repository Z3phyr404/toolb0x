// ============================================================
// EXPORT-ROUTEN — PDF-Export für Monatsübersicht
// ============================================================

const express = require('express');
const PDFDocument = require('pdfkit');
const prisma = require('../utils/prisma');
const { requireAuth } = require('../middleware/auth');
const { decrypt } = require('../utils/encryption');

const router = express.Router();

router.use(requireAuth);

// --- Deutsche Monatsnamen ---
const MONTHS_DE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

// --- Währungsformatierung ---
function fmtEuro(n) {
  return Number(n).toLocaleString('de-DE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }) + ' €';
}

// --- Decrypt-Helfer (gleiche Logik wie expenses.js / income.js) ---
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

function decryptIncome(inc, key) {
  return {
    ...inc,
    name: decrypt(inc.name, key),
    amount: decrypt(inc.amount, key),
  };
}

// --- Vormonat berechnen ---
function prevMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  const newM = m === 1 ? 12 : m - 1;
  const newY = m === 1 ? y - 1 : y;
  return `${newY}-${String(newM).padStart(2, '0')}`;
}

// --- Hex-Farbe zu RGB ---
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.substring(0, 2), 16),
    parseInt(h.substring(2, 4), 16),
    parseInt(h.substring(4, 6), 16),
  ];
}

// --- Seitenumbruch-Prüfung ---
function checkPageBreak(doc, neededSpace = 80) {
  if (doc.y + neededSpace > doc.page.height - 60) {
    doc.addPage();
  }
}

// --- Trennlinie zeichnen ---
function drawLine(doc) {
  doc.strokeColor('#E0E0E0').lineWidth(0.5)
    .moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke();
}

// --- Abschnitts-Titel ---
function sectionTitle(doc, text) {
  checkPageBreak(doc, 100);
  doc.moveDown(1.2);
  doc.fontSize(14).font('Helvetica-Bold').fillColor('#1a1a1a')
    .text(text);
  doc.moveDown(0.4);
}

// ============================================================
// GET /api/export/pdf?month=YYYY-MM
// ============================================================
router.get('/pdf', async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return res.status(400).json({ error: 'Ungültiges Monatsformat.' });
    }

    const key = req.encryptionKey;
    const [y, m] = month.split('-');
    const monthName = MONTHS_DE[parseInt(m) - 1];

    // ---- Daten laden & entschlüsseln ----
    const [rawExpenses, rawIncomes] = await Promise.all([
      prisma.expense.findMany({
        where: { userId: req.userId, month },
        include: { category: { select: { id: true, name: true, color: true } } },
      }),
      prisma.income.findMany({
        where: { userId: req.userId, month },
      }),
    ]);

    const expenses = rawExpenses.map(e => decryptExpense(e, key));
    const incomes = rawIncomes.map(i => decryptIncome(i, key));

    // ---- Aggregationen ----
    const totalExpenses = expenses.reduce((s, e) => s + parseFloat(e.amount), 0);
    const totalIncome = incomes.reduce((s, i) => s + parseFloat(i.amount), 0);
    const remaining = totalIncome - totalExpenses;

    // Sparquote
    const sparExpenses = expenses.filter(e =>
      e.category?.name?.toLowerCase().includes('spar')
    );
    const sparAmount = sparExpenses.reduce((s, e) => s + parseFloat(e.amount), 0);
    const sparquote = totalIncome > 0 ? (sparAmount / totalIncome * 100) : 0;

    // Nach Kategorie
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
    const categoryGroups = Object.values(byCategory).sort((a, b) => b.total - a.total);

    // Nach Tags
    const byTag = {};
    for (const expense of expenses) {
      for (const tag of (expense.tags || [])) {
        if (!byTag[tag]) byTag[tag] = { tag, total: 0, count: 0 };
        byTag[tag].total += parseFloat(expense.amount);
        byTag[tag].count += 1;
      }
    }
    const tagGroups = Object.values(byTag).sort((a, b) => b.total - a.total);

    // Vormonatsvergleich
    const pm = prevMonth(month);
    const prevRaw = await prisma.expense.findMany({
      where: { userId: req.userId, month: pm },
    });
    const prevTotal = prevRaw.reduce((s, e) => {
      const num = parseFloat(decrypt(e.amount, key));
      return s + (isNaN(num) ? 0 : num);
    }, 0);
    const change = Math.round((totalExpenses - prevTotal) * 100) / 100;
    const changePercent = prevTotal > 0
      ? Math.round(((totalExpenses - prevTotal) / prevTotal) * 10000) / 100
      : null;

    // ---- PDF erstellen ----
    const filename = `Finanzuebersicht_${monthName}_${y}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);

    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 50, bottom: 50, left: 50, right: 50 },
      info: { Title: `Finanzübersicht ${monthName} ${y}`, Author: 'Toolb0x' },
      bufferPages: true,
    });

    doc.pipe(res);

    const pageWidth = doc.page.width - 100; // abzüglich Margins

    // ============ HEADER ============
    doc.fontSize(22).font('Helvetica-Bold').fillColor('#1a1a1a')
      .text('Finanzübersicht', { align: 'center' });
    doc.fontSize(13).font('Helvetica').fillColor('#666666')
      .text(`${monthName} ${y}`, { align: 'center' });
    doc.moveDown(1.5);

    // ============ KPI-BOXEN ============
    const kpis = [
      { label: 'Einnahmen', value: fmtEuro(totalIncome), color: '#30D158' },
      { label: 'Ausgaben', value: fmtEuro(totalExpenses), color: '#FF3B30' },
      { label: 'Verbleibend', value: fmtEuro(remaining), color: remaining >= 0 ? '#007AFF' : '#FF3B30' },
      { label: 'Sparquote', value: `${sparquote.toFixed(1)} %`, color: '#FFCC00' },
    ];

    const boxWidth = (pageWidth - 30) / 4;
    const boxHeight = 52;
    const startY = doc.y;

    for (let i = 0; i < kpis.length; i++) {
      const kpi = kpis[i];
      const xPos = 50 + i * (boxWidth + 10);

      // Hintergrund
      doc.save();
      doc.roundedRect(xPos, startY, boxWidth, boxHeight, 6)
        .fillColor('#F5F5F7').fill();

      // Label
      doc.fillColor('#888888').fontSize(9).font('Helvetica')
        .text(kpi.label, xPos + 10, startY + 10, { width: boxWidth - 20 });

      // Wert
      doc.fillColor(kpi.color).fontSize(15).font('Helvetica-Bold')
        .text(kpi.value, xPos + 10, startY + 26, { width: boxWidth - 20 });
      doc.restore();
    }

    doc.y = startY + boxHeight + 8;

    // ============ VORMONATSVERGLEICH ============
    if (prevTotal > 0 || totalExpenses > 0) {
      doc.fontSize(9).font('Helvetica').fillColor('#888888');
      const arrow = change > 0 ? '▲' : change < 0 ? '▼' : '—';
      const changeColor = change > 0 ? '#FF3B30' : change < 0 ? '#30D158' : '#888888';
      const pctText = changePercent !== null ? ` (${changePercent > 0 ? '+' : ''}${changePercent} %)` : '';
      doc.fillColor(changeColor)
        .text(`${arrow} ${fmtEuro(Math.abs(change))}${pctText} zum Vormonat`, { align: 'right' });
    }

    // ============ AUSGABEN NACH KATEGORIE ============
    if (categoryGroups.length > 0) {
      sectionTitle(doc, 'Ausgaben nach Kategorie');

      // Tabellen-Header
      const colCat = [50, 68, 350, 430];
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#999999');
      const headerY = doc.y;
      doc.text('', colCat[0], headerY);
      doc.text('Kategorie', colCat[1], headerY);
      doc.text('Betrag', colCat[2], headerY, { width: 70, align: 'right' });
      doc.text('Anteil', colCat[3], headerY, { width: 50, align: 'right' });
      doc.y = headerY + 14;
      drawLine(doc);
      doc.moveDown(0.3);

      for (const group of categoryGroups) {
        checkPageBreak(doc, 20);
        const pct = totalExpenses > 0 ? (group.total / totalExpenses * 100).toFixed(1) : '0.0';
        const rowY = doc.y;

        // Farbpunkt
        try {
          const rgb = hexToRgb(group.category.color);
          doc.circle(58, rowY + 5, 4).fillColor(rgb).fill();
        } catch { /* Fallback: kein Punkt */ }

        doc.fillColor('#333333').fontSize(10).font('Helvetica')
          .text(group.category.name, colCat[1], rowY, { width: 270 });
        doc.fillColor('#333333')
          .text(fmtEuro(group.total), colCat[2], rowY, { width: 70, align: 'right' });
        doc.fillColor('#999999')
          .text(`${pct} %`, colCat[3], rowY, { width: 50, align: 'right' });

        doc.y = rowY + 18;
      }

      // Gesamt-Zeile
      doc.moveDown(0.2);
      drawLine(doc);
      doc.moveDown(0.3);
      const totalRowY = doc.y;
      doc.font('Helvetica-Bold').fillColor('#1a1a1a')
        .text('Gesamt', colCat[1], totalRowY);
      doc.text(fmtEuro(totalExpenses), colCat[2], totalRowY, { width: 70, align: 'right' });
      doc.text('100 %', colCat[3], totalRowY, { width: 50, align: 'right' });
      doc.y = totalRowY + 18;
    }

    // ============ TOP 10 AUSGABEN ============
    if (expenses.length > 0) {
      sectionTitle(doc, 'Top 10 Ausgaben');

      const sorted = [...expenses]
        .sort((a, b) => parseFloat(b.amount) - parseFloat(a.amount))
        .slice(0, 10);

      const colTop = [50, 68, 280, 400];
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#999999');
      const thY = doc.y;
      doc.text('#', colTop[0], thY, { width: 18 });
      doc.text('Bezeichnung', colTop[1], thY);
      doc.text('Kategorie', colTop[2], thY, { width: 110 });
      doc.text('Betrag', colTop[3], thY, { width: 80, align: 'right' });
      doc.y = thY + 14;
      drawLine(doc);
      doc.moveDown(0.3);

      sorted.forEach((expense, i) => {
        checkPageBreak(doc, 20);
        const cat = expense.category || { name: '—', color: '#8E8E93' };
        const rowY = doc.y;

        doc.fontSize(10).font('Helvetica').fillColor('#999999')
          .text(`${i + 1}.`, colTop[0], rowY, { width: 18 });
        doc.fillColor('#333333')
          .text(expense.name, colTop[1], rowY, { width: 200 });
        doc.fillColor('#888888')
          .text(cat.name, colTop[2], rowY, { width: 110 });
        doc.fillColor('#333333').font('Helvetica-Bold')
          .text(fmtEuro(parseFloat(expense.amount)), colTop[3], rowY, { width: 80, align: 'right' });

        doc.y = rowY + 18;
      });
    }

    // ============ EINNAHMEN ============
    if (incomes.length > 0) {
      sectionTitle(doc, 'Einnahmen');

      const colInc = [50, 300, 400];
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#999999');
      const thY = doc.y;
      doc.text('Bezeichnung', colInc[0], thY);
      doc.text('Typ', colInc[1], thY, { width: 90 });
      doc.text('Betrag', colInc[2], thY, { width: 80, align: 'right' });
      doc.y = thY + 14;
      drawLine(doc);
      doc.moveDown(0.3);

      for (const income of incomes) {
        checkPageBreak(doc, 20);
        const typ = income.isRecurring ? 'Fest' : 'Einmalig';
        const rowY = doc.y;

        doc.fontSize(10).font('Helvetica').fillColor('#333333')
          .text(income.name, colInc[0], rowY, { width: 240 });
        doc.fillColor('#888888')
          .text(typ, colInc[1], rowY, { width: 90 });
        doc.fillColor('#30D158').font('Helvetica-Bold')
          .text(fmtEuro(parseFloat(income.amount)), colInc[2], rowY, { width: 80, align: 'right' });

        doc.y = rowY + 18;
      }

      // Gesamt
      doc.moveDown(0.2);
      drawLine(doc);
      doc.moveDown(0.3);
      const totalRowY = doc.y;
      doc.font('Helvetica-Bold').fillColor('#30D158')
        .text('Gesamt', colInc[0], totalRowY);
      doc.text(fmtEuro(totalIncome), colInc[2], totalRowY, { width: 80, align: 'right' });
      doc.y = totalRowY + 18;
    }

    // ============ TAG-ANALYSE ============
    if (tagGroups.length > 0) {
      sectionTitle(doc, 'Tag-Analyse');

      const colTag = [50, 300, 420];
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#999999');
      const thY = doc.y;
      doc.text('Tag', colTag[0], thY);
      doc.text('Betrag', colTag[1], thY, { width: 80, align: 'right' });
      doc.text('Anzahl', colTag[2], thY, { width: 60, align: 'right' });
      doc.y = thY + 14;
      drawLine(doc);
      doc.moveDown(0.3);

      for (const tag of tagGroups) {
        checkPageBreak(doc, 20);
        const rowY = doc.y;

        doc.fontSize(10).font('Helvetica').fillColor('#333333')
          .text(tag.tag, colTag[0], rowY, { width: 240 });
        doc.fillColor('#333333').font('Helvetica-Bold')
          .text(fmtEuro(tag.total), colTag[1], rowY, { width: 80, align: 'right' });
        doc.fillColor('#888888').font('Helvetica')
          .text(`${tag.count}×`, colTag[2], rowY, { width: 60, align: 'right' });

        doc.y = rowY + 18;
      }
    }

    // ============ LEERER MONAT ============
    if (expenses.length === 0 && incomes.length === 0) {
      doc.moveDown(2);
      doc.fontSize(12).font('Helvetica').fillColor('#999999')
        .text(`Keine Daten für ${monthName} ${y} vorhanden.`, { align: 'center' });
    }

    // ============ FOOTER (auf jeder Seite) ============
    const totalPages = doc.bufferedPageRange().count;
    for (let i = 0; i < totalPages; i++) {
      doc.switchToPage(i);
      doc.fontSize(7).font('Helvetica').fillColor('#BBBBBB');
      doc.text(
        `Erstellt am ${new Date().toLocaleDateString('de-DE')}  ·  Seite ${i + 1} von ${totalPages}  ·  Toolb0x`,
        50,
        doc.page.height - 35,
        { width: pageWidth, align: 'center' }
      );
    }

    doc.end();
  } catch (error) {
    console.error('PDF-Export fehlgeschlagen:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'PDF konnte nicht erstellt werden.' });
    }
  }
});

// ============================================================
// GET /api/export/pdf-all — Gesamtexport aller Finanzdaten
// ============================================================
router.get('/pdf-all', async (req, res) => {
  try {
    const key = req.encryptionKey;

    // ---- Alle Daten laden & entschlüsseln ----
    const [rawExpenses, rawIncomes] = await Promise.all([
      prisma.expense.findMany({
        where: { userId: req.userId },
        include: { category: { select: { id: true, name: true, color: true } } },
        orderBy: { month: 'desc' },
        take: 10000,
      }),
      prisma.income.findMany({
        where: { userId: req.userId },
        orderBy: { month: 'desc' },
        take: 10000,
      }),
    ]);

    const expenses = rawExpenses.map(e => decryptExpense(e, key));
    const incomes = rawIncomes.map(i => decryptIncome(i, key));

    // ---- Nach Monat gruppieren ----
    const expensesByMonth = {};
    for (const e of expenses) {
      if (!expensesByMonth[e.month]) expensesByMonth[e.month] = [];
      expensesByMonth[e.month].push(e);
    }
    const incomesByMonth = {};
    for (const i of incomes) {
      if (!incomesByMonth[i.month]) incomesByMonth[i.month] = [];
      incomesByMonth[i.month].push(i);
    }

    const allMonths = [...new Set([
      ...Object.keys(expensesByMonth),
      ...Object.keys(incomesByMonth),
    ])].sort().reverse();

    // ---- Gesamtsummen ----
    const grandTotalExpenses = expenses.reduce((s, e) => s + parseFloat(e.amount), 0);
    const grandTotalIncome = incomes.reduce((s, i) => s + parseFloat(i.amount), 0);
    const grandBalance = grandTotalIncome - grandTotalExpenses;

    // ---- PDF erstellen ----
    const filename = `Gesamtexport_Finanzen_${new Date().toISOString().slice(0, 10)}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);

    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 50, bottom: 50, left: 50, right: 50 },
      info: { Title: 'Gesamtexport — Alle Finanzdaten', Author: 'Toolb0x' },
      bufferPages: true,
    });

    doc.pipe(res);
    const pageWidth = doc.page.width - 100;

    // ============ TITELSEITE ============
    doc.fontSize(24).font('Helvetica-Bold').fillColor('#1a1a1a')
      .text('Gesamtexport', { align: 'center' });
    doc.fontSize(14).font('Helvetica').fillColor('#666666')
      .text('Alle Finanzdaten', { align: 'center' });
    doc.fontSize(10).fillColor('#999999')
      .text(`Erstellt am ${new Date().toLocaleDateString('de-DE')}`, { align: 'center' });
    doc.moveDown(1.5);

    // ============ GRAND KPI-BOXEN ============
    const kpis = [
      { label: 'Einnahmen gesamt', value: fmtEuro(grandTotalIncome), color: '#30D158' },
      { label: 'Ausgaben gesamt', value: fmtEuro(grandTotalExpenses), color: '#FF3B30' },
      { label: 'Bilanz', value: fmtEuro(grandBalance), color: grandBalance >= 0 ? '#007AFF' : '#FF3B30' },
      { label: 'Monate', value: `${allMonths.length}`, color: '#AF52DE' },
    ];

    const boxWidth = (pageWidth - 30) / 4;
    const boxHeight = 52;
    const startY = doc.y;

    for (let i = 0; i < kpis.length; i++) {
      const kpi = kpis[i];
      const xPos = 50 + i * (boxWidth + 10);

      doc.save();
      doc.roundedRect(xPos, startY, boxWidth, boxHeight, 6)
        .fillColor('#F5F5F7').fill();

      doc.fillColor('#888888').fontSize(9).font('Helvetica')
        .text(kpi.label, xPos + 10, startY + 10, { width: boxWidth - 20 });

      doc.fillColor(kpi.color).fontSize(15).font('Helvetica-Bold')
        .text(kpi.value, xPos + 10, startY + 26, { width: boxWidth - 20 });
      doc.restore();
    }

    doc.y = startY + boxHeight + 16;

    // ============ MONATSÜBERSICHT-TABELLE ============
    if (allMonths.length > 0) {
      sectionTitle(doc, 'Monatsübersicht');

      const colOv = [50, 200, 320, 420];
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#999999');
      const thY = doc.y;
      doc.text('Monat', colOv[0], thY);
      doc.text('Einnahmen', colOv[1], thY, { width: 80, align: 'right' });
      doc.text('Ausgaben', colOv[2], thY, { width: 80, align: 'right' });
      doc.text('Saldo', colOv[3], thY, { width: 60, align: 'right' });
      doc.y = thY + 14;
      drawLine(doc);
      doc.moveDown(0.3);

      for (const m of allMonths) {
        checkPageBreak(doc, 20);
        const [yy, mm] = m.split('-');
        const mExpenses = (expensesByMonth[m] || []).reduce((s, e) => s + parseFloat(e.amount), 0);
        const mIncome = (incomesByMonth[m] || []).reduce((s, i) => s + parseFloat(i.amount), 0);
        const mSaldo = mIncome - mExpenses;
        const rowY = doc.y;

        doc.fontSize(10).font('Helvetica').fillColor('#333333')
          .text(`${MONTHS_DE[parseInt(mm) - 1]} ${yy}`, colOv[0], rowY, { width: 140 });
        doc.fillColor('#30D158')
          .text(fmtEuro(mIncome), colOv[1], rowY, { width: 80, align: 'right' });
        doc.fillColor('#FF3B30')
          .text(fmtEuro(mExpenses), colOv[2], rowY, { width: 80, align: 'right' });
        doc.fillColor(mSaldo >= 0 ? '#007AFF' : '#FF3B30').font('Helvetica-Bold')
          .text(fmtEuro(mSaldo), colOv[3], rowY, { width: 60, align: 'right' });

        doc.y = rowY + 18;
      }

      // Gesamtzeile
      doc.moveDown(0.2);
      drawLine(doc);
      doc.moveDown(0.3);
      const totalRowY = doc.y;
      doc.font('Helvetica-Bold').fillColor('#1a1a1a')
        .text('Gesamt', colOv[0], totalRowY);
      doc.fillColor('#30D158')
        .text(fmtEuro(grandTotalIncome), colOv[1], totalRowY, { width: 80, align: 'right' });
      doc.fillColor('#FF3B30')
        .text(fmtEuro(grandTotalExpenses), colOv[2], totalRowY, { width: 80, align: 'right' });
      doc.fillColor(grandBalance >= 0 ? '#007AFF' : '#FF3B30')
        .text(fmtEuro(grandBalance), colOv[3], totalRowY, { width: 60, align: 'right' });
      doc.y = totalRowY + 18;
    }

    // ============ PRO MONAT: DETAILS ============
    for (const m of allMonths) {
      const [yy, mm] = m.split('-');
      const monthName = `${MONTHS_DE[parseInt(mm) - 1]} ${yy}`;
      const mExpenses = expensesByMonth[m] || [];
      const mIncomes = incomesByMonth[m] || [];
      const mTotalExp = mExpenses.reduce((s, e) => s + parseFloat(e.amount), 0);
      const mTotalInc = mIncomes.reduce((s, i) => s + parseFloat(i.amount), 0);
      const mRemaining = mTotalInc - mTotalExp;

      // Monatstitel
      doc.addPage();
      doc.fontSize(18).font('Helvetica-Bold').fillColor('#1a1a1a')
        .text(monthName, { align: 'center' });
      doc.moveDown(0.8);

      // Mini-KPIs
      const miniKpis = [
        { label: 'Einnahmen', value: fmtEuro(mTotalInc), color: '#30D158' },
        { label: 'Ausgaben', value: fmtEuro(mTotalExp), color: '#FF3B30' },
        { label: 'Verbleibend', value: fmtEuro(mRemaining), color: mRemaining >= 0 ? '#007AFF' : '#FF3B30' },
      ];

      const miniWidth = (pageWidth - 20) / 3;
      const miniStartY = doc.y;

      for (let i = 0; i < miniKpis.length; i++) {
        const kpi = miniKpis[i];
        const xPos = 50 + i * (miniWidth + 10);
        doc.save();
        doc.roundedRect(xPos, miniStartY, miniWidth, 46, 6)
          .fillColor('#F5F5F7').fill();
        doc.fillColor('#888888').fontSize(8).font('Helvetica')
          .text(kpi.label, xPos + 8, miniStartY + 8, { width: miniWidth - 16 });
        doc.fillColor(kpi.color).fontSize(14).font('Helvetica-Bold')
          .text(kpi.value, xPos + 8, miniStartY + 22, { width: miniWidth - 16 });
        doc.restore();
      }

      doc.y = miniStartY + 54;

      // Ausgaben nach Kategorie
      if (mExpenses.length > 0) {
        const byCategory = {};
        for (const expense of mExpenses) {
          const catId = expense.category?.id;
          if (!catId) continue;
          if (!byCategory[catId]) {
            byCategory[catId] = { category: expense.category, total: 0, count: 0 };
          }
          byCategory[catId].total += parseFloat(expense.amount);
          byCategory[catId].count += 1;
        }
        const categoryGroups = Object.values(byCategory).sort((a, b) => b.total - a.total);

        if (categoryGroups.length > 0) {
          sectionTitle(doc, 'Ausgaben nach Kategorie');

          const colCat = [50, 68, 350, 430];
          doc.fontSize(8).font('Helvetica-Bold').fillColor('#999999');
          const headerY = doc.y;
          doc.text('', colCat[0], headerY);
          doc.text('Kategorie', colCat[1], headerY);
          doc.text('Betrag', colCat[2], headerY, { width: 70, align: 'right' });
          doc.text('Anteil', colCat[3], headerY, { width: 50, align: 'right' });
          doc.y = headerY + 14;
          drawLine(doc);
          doc.moveDown(0.3);

          for (const group of categoryGroups) {
            checkPageBreak(doc, 20);
            const pct = mTotalExp > 0 ? (group.total / mTotalExp * 100).toFixed(1) : '0.0';
            const rowY = doc.y;

            try {
              const rgb = hexToRgb(group.category.color);
              doc.circle(58, rowY + 5, 4).fillColor(rgb).fill();
            } catch { /* kein Punkt */ }

            doc.fillColor('#333333').fontSize(10).font('Helvetica')
              .text(group.category.name, colCat[1], rowY, { width: 270 });
            doc.fillColor('#333333')
              .text(fmtEuro(group.total), colCat[2], rowY, { width: 70, align: 'right' });
            doc.fillColor('#999999')
              .text(`${pct} %`, colCat[3], rowY, { width: 50, align: 'right' });

            doc.y = rowY + 18;
          }

          doc.moveDown(0.2);
          drawLine(doc);
          doc.moveDown(0.3);
          const totalRowY = doc.y;
          doc.font('Helvetica-Bold').fillColor('#1a1a1a')
            .text('Gesamt', colCat[1], totalRowY);
          doc.text(fmtEuro(mTotalExp), colCat[2], totalRowY, { width: 70, align: 'right' });
          doc.text('100 %', colCat[3], totalRowY, { width: 50, align: 'right' });
          doc.y = totalRowY + 18;
        }
      }

      // Einnahmen
      if (mIncomes.length > 0) {
        sectionTitle(doc, 'Einnahmen');

        const colInc = [50, 300, 400];
        doc.fontSize(8).font('Helvetica-Bold').fillColor('#999999');
        const thY = doc.y;
        doc.text('Bezeichnung', colInc[0], thY);
        doc.text('Typ', colInc[1], thY, { width: 90 });
        doc.text('Betrag', colInc[2], thY, { width: 80, align: 'right' });
        doc.y = thY + 14;
        drawLine(doc);
        doc.moveDown(0.3);

        for (const income of mIncomes) {
          checkPageBreak(doc, 20);
          const typ = income.isRecurring ? 'Fest' : 'Einmalig';
          const rowY = doc.y;

          doc.fontSize(10).font('Helvetica').fillColor('#333333')
            .text(income.name, colInc[0], rowY, { width: 240 });
          doc.fillColor('#888888')
            .text(typ, colInc[1], rowY, { width: 90 });
          doc.fillColor('#30D158').font('Helvetica-Bold')
            .text(fmtEuro(parseFloat(income.amount)), colInc[2], rowY, { width: 80, align: 'right' });

          doc.y = rowY + 18;
        }

        doc.moveDown(0.2);
        drawLine(doc);
        doc.moveDown(0.3);
        const totalRowY = doc.y;
        doc.font('Helvetica-Bold').fillColor('#30D158')
          .text('Gesamt', colInc[0], totalRowY);
        doc.text(fmtEuro(mTotalInc), colInc[2], totalRowY, { width: 80, align: 'right' });
        doc.y = totalRowY + 18;
      }

      // Leerer Monat
      if (mExpenses.length === 0 && mIncomes.length === 0) {
        doc.moveDown(2);
        doc.fontSize(12).font('Helvetica').fillColor('#999999')
          .text(`Keine Daten für ${monthName} vorhanden.`, { align: 'center' });
      }
    }

    // ============ LEERE DATENBANK ============
    if (allMonths.length === 0) {
      doc.moveDown(3);
      doc.fontSize(12).font('Helvetica').fillColor('#999999')
        .text('Keine Finanzdaten vorhanden.', { align: 'center' });
    }

    // ============ FOOTER (auf jeder Seite) ============
    const totalPages = doc.bufferedPageRange().count;
    for (let i = 0; i < totalPages; i++) {
      doc.switchToPage(i);
      doc.fontSize(7).font('Helvetica').fillColor('#BBBBBB');
      doc.text(
        `Erstellt am ${new Date().toLocaleDateString('de-DE')}  ·  Seite ${i + 1} von ${totalPages}  ·  Toolb0x`,
        50,
        doc.page.height - 35,
        { width: pageWidth, align: 'center' }
      );
    }

    doc.end();
  } catch (error) {
    console.error('Gesamt-PDF-Export fehlgeschlagen:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'PDF konnte nicht erstellt werden.' });
    }
  }
});

module.exports = router;
