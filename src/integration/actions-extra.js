// ============================================================
// WEITERE INTEGRATIONS-AKTIONEN (Zephyr-Ausbau, 2026-10-12)
// ============================================================
// Gleiche Mechanik wie actions.js (prepare → Entwurf, execute → in der
// Bestätigungs-Transaktion). Neu sind:
//   scope  — welche Berechtigung die Aktion braucht
//   level  — "auto" | "chat" | "app" (siehe docs/hermes-integration.md)
//   external — Aktion wirkt außerhalb der Datenbank und läuft deshalb NACH
//              dem Commit (Server-SSH). Die Einmaligkeit sichert der Claim.
//
// Freigabestufen (Michaels Vorgabe):
//   auto: nur Finanzbuchhaltung (Zephyr bestätigt ohne Rückfrage)
//   chat: Zephyr muss vorher konkret im Chat fragen (Regel, nicht erzwingbar)
//   app:  nur Michael in toolb0x kann freigeben (technisch erzwungen) —
//         Löschungen außerhalb der Finanzen, Kategorien löschen, Foto-
//         Löschwünsche, alle Servereingriffe.
// ============================================================

const { encrypt, decrypt } = require('../utils/encryption');
const { entschaerfe } = require('../utils/legacyText');
const { sanitize, validateCategory, isValidDate } = require('../utils/validation');
const photos = require('../services/photos');
const serverOps = require('../services/servers');
const finance = require('../services/finance');

module.exports = function registerExtraActions(ACTIONS, h) {
  const { checkFields, invalid, fail, notFound, changed, verify, readBool, sha256, stableStringify } = h;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const isUuid = v => typeof v === 'string' && UUID.test(v);

  // ----------------------------------------------------------
  // Kategorien
  // ----------------------------------------------------------
  const decName = (c, key) => entschaerfe(decrypt(c.name, key));
  const fpCategory = c => sha256(stableStringify([c.name, c.color]));

  async function loadCategory(db, ctx, id) {
    return isUuid(id) ? db.category.findFirst({ where: { id, userId: ctx.userId } }) : null;
  }
  async function nameTaken(db, ctx, name, exceptId) {
    const all = await db.category.findMany({ where: { userId: ctx.userId } });
    return all.some(c => c.id !== exceptId && decName(c, ctx.key).toLowerCase() === name.toLowerCase());
  }

  ACTIONS['category.create'] = {
    scope: 'finance.categories', level: 'chat',
    async prepare(db, ctx, params) {
      checkFields(params, ['name', 'color'], ['name']);
      const errors = validateCategory(params);
      if (errors.length) invalid(errors);
      const name = sanitize(params.name);
      if (await nameTaken(db, ctx, name)) invalid(['Eine Kategorie mit diesem Namen existiert bereits.']);
      const p = { name, color: params.color || '#8E8E93' };
      return { params: p, version: null, summary: p };
    },
    async execute(tx, ctx, p) {
      if (await nameTaken(tx, ctx, p.name)) changed();
      const c = await tx.category.create({ data: { name: encrypt(p.name, ctx.key), color: encrypt(p.color, ctx.key), userId: ctx.userId } });
      verify(decName(c, ctx.key) === p.name);
      return { status: 201, targetType: 'category', targetId: c.id, entry: { id: c.id, name: p.name, color: p.color } };
    },
  };

  ACTIONS['category.update'] = {
    scope: 'finance.categories', level: 'chat',
    async prepare(db, ctx, params) {
      checkFields(params, ['id', 'name', 'color'], ['id']);
      const c = await loadCategory(db, ctx, params.id);
      if (!c) notFound('Kategorie');
      const before = { id: c.id, name: decName(c, ctx.key), color: decrypt(c.color, ctx.key) };
      const after = { ...before, ...(params.name !== undefined ? { name: params.name } : {}), ...(params.color !== undefined ? { color: params.color } : {}) };
      const errors = validateCategory(after);
      if (errors.length) invalid(errors);
      after.name = sanitize(after.name);
      if (await nameTaken(db, ctx, after.name, c.id)) invalid(['Eine Kategorie mit diesem Namen existiert bereits.']);
      return { params: { id: c.id, name: after.name, color: after.color }, version: fpCategory(c), summary: { before, after } };
    },
    async execute(tx, ctx, p, version) {
      const c = await loadCategory(tx, ctx, p.id);
      if (!c || fpCategory(c) !== version) changed();
      if (await nameTaken(tx, ctx, p.name, c.id)) changed();
      await tx.category.update({ where: { id: c.id }, data: { name: encrypt(p.name, ctx.key), color: encrypt(p.color, ctx.key) } });
      return { status: 200, targetType: 'category', targetId: c.id, entry: { id: c.id, name: p.name, color: p.color } };
    },
  };

  ACTIONS['category.delete'] = {
    scope: 'finance.categories', level: 'app',
    async prepare(db, ctx, params) {
      checkFields(params, ['id'], ['id']);
      const c = await loadCategory(db, ctx, params.id);
      if (!c) notFound('Kategorie');
      const count = (await db.expense.findMany({ where: { categoryId: c.id } })).length;
      return {
        params: { id: c.id },
        version: fpCategory(c),
        summary: { before: { id: c.id, name: decName(c, ctx.key) }, movesExpensesToSonstiges: count },
      };
    },
    async execute(tx, ctx, p, version) {
      const c = await loadCategory(tx, ctx, p.id);
      if (!c || fpCategory(c) !== version) changed();
      const result = await finance.deleteCategory(tx, ctx, c);
      if (result.error) fail(400, 'VALIDATION', result.error);
      return { status: 200, targetType: 'category', targetId: c.id, entry: null, deleted: true, movedExpenses: result.movedExpenses };
    },
  };

  // ----------------------------------------------------------
  // Kontostand (Finanzbuchhaltung → auto)
  // ----------------------------------------------------------
  const BALANCE_RE = /^(-)?(0|[1-9]\d{0,6})(?:[.,](\d{1,2}))?$/;
  ACTIONS['balance.set'] = {
    scope: 'finance.balance', level: 'auto',
    async prepare(db, ctx, params) {
      checkFields(params, ['amount'], []);
      if (params.amount === null) return { params: { amount: null }, version: null, summary: { amount: null, clears: true } };
      const m = typeof params.amount === 'string' ? BALANCE_RE.exec(params.amount.trim()) : null;
      if (!m) invalid(['amount: Kontostand als Text, z. B. "1234,56" oder "-50" (null entfernt ihn).']);
      const cents = (Number(m[2]) * 100 + Number((m[3] || '').padEnd(2, '0'))) * (m[1] ? -1 : 1);
      const amount = (cents / 100).toFixed(2);
      return { params: { amount }, version: null, summary: { amount } };
    },
    async execute(tx, ctx, p) {
      await tx.user.update({
        where: { id: ctx.userId },
        data: p.amount === null
          ? { accountBalance: null, accountBalanceAt: null }
          : { accountBalance: encrypt(String(Number(p.amount)), ctx.key), accountBalanceAt: new Date() },
      });
      return { status: 200, targetType: 'balance', targetId: null, entry: { amount: p.amount } };
    },
  };

  // ----------------------------------------------------------
  // Erinnerungen
  // ----------------------------------------------------------
  const STATUSES = ['pending', 'done', 'dismissed'];
  const fpReminder = r => sha256(stableStringify([r.note, new Date(r.reminderDate).toISOString(), r.daysBefore, r.status, r.expenseId || null]));

  async function loadReminder(db, ctx, id) {
    return isUuid(id) ? db.reminder.findFirst({ where: { id, userId: ctx.userId } }) : null;
  }
  async function checkExpenseLink(db, ctx, expenseId, errors) {
    if (expenseId === undefined || expenseId === null) return null;
    if (!isUuid(expenseId) || !(await db.expense.findFirst({ where: { id: expenseId, userId: ctx.userId } }))) {
      errors.push('expenseId: Ausgabe nicht gefunden.');
      return null;
    }
    return expenseId;
  }
  function readTitle(v, errors) {
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || v.length > 200) { errors.push('title: Text, höchstens 200 Zeichen.'); return ''; }
    return sanitize(v.trim());
  }
  function readDays(v, fallback, errors) {
    if (v === undefined) return fallback;
    if (!Number.isInteger(v) || v < 0 || v > 90) { errors.push('daysBefore: ganze Zahl 0–90.'); return fallback; }
    return v;
  }

  ACTIONS['reminder.create'] = {
    scope: 'reminders.write', level: 'chat',
    async prepare(db, ctx, params) {
      checkFields(params, ['title', 'dueDate', 'daysBefore', 'expenseId'], ['dueDate']);
      const errors = [];
      if (!isValidDate(params.dueDate)) errors.push('dueDate: Datum YYYY-MM-DD.');
      const title = readTitle(params.title, errors) || '';
      const daysBefore = readDays(params.daysBefore, 3, errors);
      const expenseId = await checkExpenseLink(db, ctx, params.expenseId, errors);
      if (errors.length) invalid(errors);
      const p = { title, dueDate: params.dueDate, daysBefore, expenseId };
      return { params: p, version: null, summary: p };
    },
    async execute(tx, ctx, p) {
      if (p.expenseId && !(await tx.expense.findFirst({ where: { id: p.expenseId, userId: ctx.userId } }))) changed();
      const r = await tx.reminder.create({
        data: {
          reminderDate: new Date(`${p.dueDate}T00:00:00.000Z`),
          daysBefore: p.daysBefore,
          status: 'pending',
          note: p.title ? encrypt(p.title, ctx.key) : '',
          expenseId: p.expenseId || null,
          userId: ctx.userId,
        },
      });
      return { status: 201, targetType: 'reminder', targetId: r.id, entry: { id: r.id, ...p, status: 'pending' } };
    },
  };

  ACTIONS['reminder.update'] = {
    scope: 'reminders.write', level: 'chat',
    async prepare(db, ctx, params) {
      checkFields(params, ['id', 'title', 'dueDate', 'daysBefore', 'status', 'expenseId'], ['id']);
      const r = await loadReminder(db, ctx, params.id);
      if (!r) notFound('Erinnerung');
      const errors = [];
      const cur = {
        title: r.note ? entschaerfe(decrypt(r.note, ctx.key)) : '',
        dueDate: new Date(r.reminderDate).toISOString().slice(0, 10),
        daysBefore: r.daysBefore,
        status: r.status,
        expenseId: r.expenseId || null,
      };
      const next = { ...cur };
      const t = readTitle(params.title, errors);
      if (t !== undefined) next.title = t;
      if (params.dueDate !== undefined) {
        if (!isValidDate(params.dueDate)) errors.push('dueDate: Datum YYYY-MM-DD.');
        else next.dueDate = params.dueDate;
      }
      next.daysBefore = readDays(params.daysBefore, cur.daysBefore, errors);
      if (params.status !== undefined) {
        if (!STATUSES.includes(params.status)) errors.push('status: pending, done oder dismissed.');
        else next.status = params.status;
      }
      if (params.expenseId !== undefined) next.expenseId = params.expenseId === null ? null : await checkExpenseLink(db, ctx, params.expenseId, errors);
      if (errors.length) invalid(errors);
      return { params: { id: r.id, ...next }, version: fpReminder(r), summary: { before: { id: r.id, ...cur }, after: { id: r.id, ...next } } };
    },
    async execute(tx, ctx, p, version) {
      const r = await loadReminder(tx, ctx, p.id);
      if (!r || fpReminder(r) !== version) changed();
      if (p.expenseId && !(await tx.expense.findFirst({ where: { id: p.expenseId, userId: ctx.userId } }))) changed();
      await tx.reminder.update({
        where: { id: r.id },
        data: {
          note: p.title ? encrypt(p.title, ctx.key) : '',
          reminderDate: new Date(`${p.dueDate}T00:00:00.000Z`),
          daysBefore: p.daysBefore,
          status: p.status,
          expenseId: p.expenseId || null,
        },
      });
      const { id, ...rest } = p;
      return { status: 200, targetType: 'reminder', targetId: id, entry: { id, ...rest } };
    },
  };

  ACTIONS['reminder.delete'] = {
    scope: 'reminders.write', level: 'app',
    async prepare(db, ctx, params) {
      checkFields(params, ['id'], ['id']);
      const r = await loadReminder(db, ctx, params.id);
      if (!r) notFound('Erinnerung');
      return {
        params: { id: r.id },
        version: fpReminder(r),
        summary: { before: { id: r.id, title: r.note ? entschaerfe(decrypt(r.note, ctx.key)) : '', dueDate: new Date(r.reminderDate).toISOString().slice(0, 10), status: r.status } },
      };
    },
    async execute(tx, ctx, p, version) {
      const r = await loadReminder(tx, ctx, p.id);
      if (!r || fpReminder(r) !== version) changed();
      await tx.reminder.delete({ where: { id: r.id } });
      return { status: 200, targetType: 'reminder', targetId: r.id, entry: null, deleted: true };
    },
  };

  // ----------------------------------------------------------
  // Notizen — Zephyr schreibt NUR Text. Er wird hier sicher in HTML
  // umgewandelt (escapen, Absätze, Zeilenumbrüche), damit über die
  // Integration kein Skript-HTML in den Editor gelangt.
  // ----------------------------------------------------------
  const escapeHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  function textToHtml(text) {
    return text.replace(/\r\n?/g, '\n').split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
      .map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
  }
  const fpNote = n => sha256(stableStringify([n.title, n.content, n.icon, n.parentId || null, n.sortOrder, n.isPinned, n.isArchived]));
  const MAX_TEXT = 100000;

  async function loadNote(db, ctx, id) {
    return isUuid(id) ? db.note.findFirst({ where: { id, userId: ctx.userId } }) : null;
  }
  function readNoteTitle(v, errors, required) {
    if (v === undefined) { if (required) errors.push('Pflichtfeld fehlt: title'); return undefined; }
    if (typeof v !== 'string' || !v.trim() || v.length > 200) { errors.push('title: Text, 1–200 Zeichen.'); return undefined; }
    return sanitize(v);
  }
  function readText(v, field, errors) {
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || v.length > MAX_TEXT) { errors.push(`${field}: Text, höchstens ${MAX_TEXT} Zeichen.`); return undefined; }
    return v;
  }
  function readIcon(v, errors) {
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || v.length > 10 || /[<>"'&]/.test(v)) { errors.push('icon: ein Emoji, höchstens 10 Zeichen.'); return undefined; }
    return v;
  }
  async function descendants(db, ctx, id) {
    let count = 0;
    const queue = [id];
    while (queue.length) {
      const kids = await db.note.findMany({ where: { parentId: queue.shift(), userId: ctx.userId } });
      count += kids.length;
      queue.push(...kids.map(k => k.id));
      if (count > 10000) break;
    }
    return count;
  }
  async function wouldCreateCycle(db, ctx, noteId, targetParentId) {
    if (!targetParentId) return false;
    let currentId = targetParentId;
    const seen = new Set();
    while (currentId) {
      if (currentId === noteId || seen.has(currentId)) return true;
      seen.add(currentId);
      const parent = await db.note.findFirst({ where: { id: currentId, userId: ctx.userId } });
      currentId = parent ? parent.parentId || null : null;
    }
    return false;
  }
  async function setArchivedRecursive(tx, ctx, id) {
    const kids = await tx.note.findMany({ where: { parentId: id, userId: ctx.userId } });
    for (const k of kids) {
      await tx.note.update({ where: { id: k.id }, data: { isArchived: true } });
      await setArchivedRecursive(tx, ctx, k.id);
    }
  }

  ACTIONS['note.create'] = {
    scope: 'notes.write', level: 'chat',
    async prepare(db, ctx, params) {
      checkFields(params, ['title', 'text', 'parentId', 'icon'], ['title']);
      const errors = [];
      const title = readNoteTitle(params.title, errors, true);
      const text = readText(params.text, 'text', errors) || '';
      const icon = readIcon(params.icon, errors) || '';
      let parentId = null;
      if (params.parentId !== undefined && params.parentId !== null) {
        if (!(await loadNote(db, ctx, params.parentId))) errors.push('parentId: Übergeordnete Seite nicht gefunden.');
        else parentId = params.parentId;
      }
      if (errors.length) invalid(errors);
      const p = { title, html: textToHtml(text), icon, parentId };
      return { params: p, version: null, summary: { title, text, icon, parentId } };
    },
    async execute(tx, ctx, p) {
      if (p.parentId && !(await loadNote(tx, ctx, p.parentId))) changed();
      const siblings = await tx.note.findMany({ where: { userId: ctx.userId, parentId: p.parentId } });
      const nextSort = siblings.reduce((m, n) => Math.max(m, n.sortOrder ?? 0), -1) + 1;
      const n = await tx.note.create({
        data: { title: encrypt(p.title, ctx.key), content: encrypt(p.html, ctx.key), icon: p.icon, parentId: p.parentId, sortOrder: nextSort, userId: ctx.userId },
      });
      return { status: 201, targetType: 'note', targetId: n.id, entry: { id: n.id, title: p.title, parentId: p.parentId } };
    },
  };

  ACTIONS['note.update'] = {
    scope: 'notes.write', level: 'chat',
    async prepare(db, ctx, params) {
      checkFields(params, ['id', 'title', 'text', 'appendText', 'icon', 'isPinned', 'isArchived'], ['id']);
      const n = await loadNote(db, ctx, params.id);
      if (!n) notFound('Notiz');
      const errors = [];
      const title = readNoteTitle(params.title, errors, false);
      const text = readText(params.text, 'text', errors);
      const appendText = readText(params.appendText, 'appendText', errors);
      if (text !== undefined && appendText !== undefined) errors.push('Entweder text (ersetzen) oder appendText (anhängen), nicht beides.');
      const icon = readIcon(params.icon, errors);
      const isPinned = readBool(params, 'isPinned', n.isPinned, errors);
      const isArchived = readBool(params, 'isArchived', n.isArchived, errors);
      if (errors.length) invalid(errors);
      const curHtml = n.content ? decrypt(n.content, ctx.key) : '';
      let html = curHtml;
      if (text !== undefined) html = textToHtml(text);
      if (appendText !== undefined) html = curHtml + textToHtml(appendText);
      if (html.length > MAX_TEXT) invalid([`Der Inhalt darf maximal ${MAX_TEXT} Zeichen lang sein.`]);
      const curTitle = entschaerfe(decrypt(n.title, ctx.key));
      const p = { id: n.id, title: title ?? curTitle, html, icon: icon ?? n.icon, isPinned, isArchived };
      return {
        params: p,
        version: fpNote(n),
        summary: {
          before: { id: n.id, title: curTitle, icon: n.icon, isPinned: n.isPinned, isArchived: n.isArchived },
          after: { id: n.id, title: p.title, icon: p.icon, isPinned, isArchived },
          contentChange: text !== undefined ? 'replace' : appendText !== undefined ? 'append' : 'none',
          ...(text !== undefined ? { text } : {}),
          ...(appendText !== undefined ? { appendText } : {}),
          archivesSubpages: isArchived && !n.isArchived ? await descendants(db, ctx, n.id) : 0,
        },
      };
    },
    async execute(tx, ctx, p, version) {
      const n = await loadNote(tx, ctx, p.id);
      if (!n || fpNote(n) !== version) changed();
      await tx.note.update({
        where: { id: n.id },
        data: { title: encrypt(p.title, ctx.key), content: encrypt(p.html, ctx.key), icon: p.icon, isPinned: p.isPinned, isArchived: p.isArchived },
      });
      // Wie in der App: Archivieren nimmt Unterseiten mit.
      if (p.isArchived && !n.isArchived) await setArchivedRecursive(tx, ctx, n.id);
      return { status: 200, targetType: 'note', targetId: n.id, entry: { id: n.id, title: p.title } };
    },
  };

  ACTIONS['note.move'] = {
    scope: 'notes.write', level: 'chat',
    async prepare(db, ctx, params) {
      checkFields(params, ['id', 'parentId', 'sortOrder'], ['id']);
      const n = await loadNote(db, ctx, params.id);
      if (!n) notFound('Notiz');
      const errors = [];
      let parentId = n.parentId || null;
      if (params.parentId !== undefined) {
        if (params.parentId === null) parentId = null;
        else if (!(await loadNote(db, ctx, params.parentId))) errors.push('parentId: Zielseite nicht gefunden.');
        else if (await wouldCreateCycle(db, ctx, n.id, params.parentId)) errors.push('Zirkelverweis: Eine Seite kann nicht in ihre eigene Unterseite verschoben werden.');
        else parentId = params.parentId;
      }
      let sortOrder = n.sortOrder;
      if (params.sortOrder !== undefined) {
        if (!Number.isInteger(params.sortOrder) || params.sortOrder < 0) errors.push('sortOrder: ganze Zahl ≥ 0.');
        else sortOrder = params.sortOrder;
      }
      if (errors.length) invalid(errors);
      return { params: { id: n.id, parentId, sortOrder }, version: fpNote(n), summary: { id: n.id, title: entschaerfe(decrypt(n.title, ctx.key)), from: n.parentId || null, to: parentId, sortOrder } };
    },
    async execute(tx, ctx, p, version) {
      const n = await loadNote(tx, ctx, p.id);
      if (!n || fpNote(n) !== version) changed();
      if (p.parentId && (!(await loadNote(tx, ctx, p.parentId)) || await wouldCreateCycle(tx, ctx, n.id, p.parentId))) changed();
      await tx.note.update({ where: { id: n.id }, data: { parentId: p.parentId, sortOrder: p.sortOrder } });
      return { status: 200, targetType: 'note', targetId: n.id, entry: { id: n.id, parentId: p.parentId, sortOrder: p.sortOrder } };
    },
  };

  ACTIONS['note.delete'] = {
    scope: 'notes.write', level: 'app',
    async prepare(db, ctx, params) {
      checkFields(params, ['id'], ['id']);
      const n = await loadNote(db, ctx, params.id);
      if (!n) notFound('Notiz');
      return {
        params: { id: n.id },
        version: fpNote(n),
        summary: { before: { id: n.id, title: entschaerfe(decrypt(n.title, ctx.key)) }, deletesSubpages: await descendants(db, ctx, n.id) },
      };
    },
    async execute(tx, ctx, p, version) {
      const n = await loadNote(tx, ctx, p.id);
      if (!n || fpNote(n) !== version) changed();
      // Unterseiten verschwinden per Kaskade (wie beim Löschen in der App).
      await tx.note.delete({ where: { id: n.id } });
      return { status: 200, targetType: 'note', targetId: n.id, entry: null, deleted: true };
    },
  };

  // ----------------------------------------------------------
  // Fotos (Warteschlangen für fotob0x — der PC bleibt die Wahrheit)
  // ----------------------------------------------------------
  function readIds(params, errors) {
    const ids = photos.cleanPhotoIds(params.ids);
    if (!Array.isArray(params.ids) || ids.length === 0 || ids.length !== params.ids.length) {
      errors.push('ids: Liste gültiger Foto-IDs (Zahlen), höchstens 500, ohne Duplikate.');
    }
    return ids;
  }
  function readTags(v, field, errors) {
    if (v === undefined) return [];
    const tags = photos.cleanEditTags(v);
    if (!Array.isArray(v) || tags.length !== v.length) errors.push(`${field}: Liste gültiger Tags (max. 60 Zeichen, keine / oder \\, ohne Duplikate).`);
    return tags;
  }

  ACTIONS['photo.edit'] = {
    scope: 'photos.edit', level: 'chat',
    async prepare(db, ctx, params) {
      checkFields(params, ['ids', 'rating', 'addTags', 'removeTags'], ['ids']);
      const errors = [];
      const ids = readIds(params, errors);
      let rating = null;
      if (params.rating !== undefined && params.rating !== null) {
        if (!Number.isInteger(params.rating) || params.rating < 0 || params.rating > 5) errors.push('rating: 0–5.');
        else rating = params.rating;
      }
      const addTags = readTags(params.addTags, 'addTags', errors);
      const removeTags = readTags(params.removeTags, 'removeTags', errors);
      if (rating === null && !addTags.length && !removeTags.length) errors.push('Keine Änderung angegeben.');
      if (errors.length) invalid(errors);
      const p = { ids, rating, addTags, removeTags };
      return { params: p, version: null, summary: { count: ids.length, ...p } };
    },
    async execute(tx, ctx, p) {
      const r = await photos.queueEdit(p);
      return { status: 200, targetType: 'photos', targetId: null, entry: { queued: r.queued } };
    },
  };

  ACTIONS['photo.delete'] = {
    scope: 'photos.edit', level: 'app',
    async prepare(db, ctx, params) {
      checkFields(params, ['ids'], ['ids']);
      const errors = [];
      const ids = readIds(params, errors);
      if (errors.length) invalid(errors);
      return { params: { ids }, version: null, summary: { count: ids.length, ids, note: 'fotob0x verschiebt die Fotos in den Papierkorb (wiederherstellbar).' } };
    },
    async execute(tx, ctx, p) {
      const r = await photos.queueDelete(p.ids);
      return { status: 200, targetType: 'photos', targetId: null, entry: { queued: r.queued } };
    },
  };

  // ----------------------------------------------------------
  // Server — immer App-Freigabe, laufen NACH dem Commit (external)
  // ----------------------------------------------------------
  function serverAction(kind) {
    return {
      scope: 'servers.actions', level: 'app', external: true,
      async prepare(db, ctx, params) {
        checkFields(params, kind === 'service-restart' ? ['id', 'service'] : ['id'], kind === 'service-restart' ? ['id', 'service'] : ['id']);
        const s = await serverOps.findServer(db, params.id, ctx.userId);
        if (!s) notFound('Server');
        if (kind === 'service-restart' && !serverOps.SERVICE_NAME_RE.test(params.service || '')) invalid(['service: ungültiger Dienstname.']);
        if (s.serverType === 'storage') invalid(['Für eine Storage Box gibt es diese Aktion nicht.']);
        const p = { id: s.id, ...(kind === 'service-restart' ? { service: params.service } : {}) };
        return { params: p, version: null, summary: { server: s.label, action: kind, ...(p.service ? { service: p.service } : {}) } };
      },
      async check(tx, ctx, p) {
        const s = await serverOps.findServer(tx, p.id, ctx.userId);
        if (!s) changed();
        return s;
      },
      async run(ctx, p, server) {
        if (kind === 'update') {
          const r = await serverOps.serverUpdate(server, ctx.key);
          // Ausgabe kürzen: nur das Ende ist für eine Rückmeldung sinnvoll.
          return { success: r.success, outputTail: String(r.output || '').slice(-2000) };
        }
        if (kind === 'restart') return serverOps.serverRestart(server, ctx.key);
        return serverOps.serviceRestart(server, ctx.key, p.service);
      },
    };
  }
  ACTIONS['server.update'] = serverAction('update');
  ACTIONS['server.restart'] = serverAction('restart');
  ACTIONS['server.service-restart'] = serverAction('service-restart');

};
