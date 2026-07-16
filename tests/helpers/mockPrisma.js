// ============================================================
// IN-MEMORY PRISMA-MOCK
// ============================================================
// Ersetzt den echten Prisma-Client für Tests.
// Speichert Daten in einfachen JS-Arrays, damit kein
// Datenbank-Setup nötig ist.
// ============================================================

const crypto = require('crypto');

function matchesWhere(record, where) {
  for (const [key, val] of Object.entries(where)) {
    if (val === undefined) continue;

    // Prisma-Composite-Key (z.B. userId_month_type)
    if (key.includes('_') && typeof val === 'object' && !val.gt && !val.lt) {
      // Composite key: jedes Feld im Objekt muss matchen
      for (const [subKey, subVal] of Object.entries(val)) {
        if (record[subKey] !== subVal) return false;
      }
      continue;
    }

    // Operatoren (gt, lt, gte, lte)
    if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
      if ('gt' in val && !(record[key] > val.gt)) return false;
      if ('lt' in val && !(record[key] < val.lt)) return false;
      if ('gte' in val && !(record[key] >= val.gte)) return false;
      if ('lte' in val && !(record[key] <= val.lte)) return false;
      if ('in' in val && !val.in.includes(record[key])) return false;
      continue;
    }

    // Einfacher Vergleich
    if (record[key] !== val) return false;
  }
  return true;
}

function applyInclude(record, include, store) {
  if (!include) return record;
  const result = { ...record };
  if (include.category && record.categoryId) {
    const cat = store.categories.find(c => c.id === record.categoryId);
    if (cat && include.category.select) {
      const selected = {};
      for (const field of Object.keys(include.category.select)) {
        selected[field] = cat[field];
      }
      result.category = selected;
    } else {
      result.category = cat || null;
    }
  }
  return result;
}

function createCollection(store, tableName) {
  return {
    findMany: async ({ where = {}, include } = {}) => {
      const results = store[tableName].filter(r => matchesWhere(r, where)).map(r => ({ ...r }));
      if (include) return results.map(r => applyInclude(r, include, store));
      return results;
    },

    findFirst: async ({ where = {}, include } = {}) => {
      const found = store[tableName].find(r => matchesWhere(r, where));
      if (!found) return null;
      const result = { ...found };
      if (include) return applyInclude(result, include, store);
      return result;
    },

    findUnique: async ({ where = {} }) => {
      // Composite keys: z.B. { userId_month_type: { userId, month, type } }
      const compositeKey = Object.keys(where).find(k => k.includes('_'));
      if (compositeKey) {
        const vals = where[compositeKey];
        return store[tableName].find(r => {
          for (const [k, v] of Object.entries(vals)) {
            if (r[k] !== v) return false;
          }
          return true;
        }) || null;
      }
      return store[tableName].find(r => matchesWhere(r, where)) || null;
    },

    create: async ({ data, include }) => {
      const record = {
        id: crypto.randomUUID(),
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };

      // Prisma nested create: z.B. user.create({ data: { categories: { create: [...] } } })
      // → Einträge landen in der passenden Tabelle mit gesetztem Fremdschlüssel
      for (const [key, val] of Object.entries(data)) {
        if (val && typeof val === 'object' && Array.isArray(val.create) && store[key]) {
          delete record[key];
          const fk = tableName === 'users' ? 'userId' : tableName.slice(0, -1) + 'Id';
          for (const child of val.create) {
            store[key].push({
              id: crypto.randomUUID(),
              createdAt: new Date(),
              updatedAt: new Date(),
              [fk]: record.id,
              ...child,
            });
          }
        }
      }

      store[tableName].push(record);
      if (include) return applyInclude(record, include, store);
      return record;
    },

    createMany: async ({ data: items }) => {
      for (const d of items) {
        store[tableName].push({
          id: crypto.randomUUID(),
          createdAt: new Date(),
          updatedAt: new Date(),
          ...d,
        });
      }
      return { count: items.length };
    },

    update: async ({ where, data, include }) => {
      const idx = store[tableName].findIndex(r => r.id === where.id);
      if (idx === -1) throw new Error(`${tableName}: Record not found`);
      Object.assign(store[tableName][idx], data, { updatedAt: new Date() });
      if (include) return applyInclude(store[tableName][idx], include, store);
      return store[tableName][idx];
    },

    updateMany: async ({ where = {}, data }) => {
      let count = 0;
      for (const r of store[tableName]) {
        if (matchesWhere(r, where)) {
          Object.assign(r, data);
          count++;
        }
      }
      return { count };
    },

    delete: async ({ where }) => {
      const idx = store[tableName].findIndex(r => r.id === where.id);
      if (idx === -1) throw new Error(`${tableName}: Record not found`);
      return store[tableName].splice(idx, 1)[0];
    },

    deleteMany: async ({ where = {} } = {}) => {
      const keep = store[tableName].filter(r => !matchesWhere(r, where));
      const count = store[tableName].length - keep.length;
      store[tableName].length = 0;
      store[tableName].push(...keep);
      return { count };
    },

    upsert: async ({ where, create, update }) => {
      // Composite key support
      const compositeKey = Object.keys(where).find(k => k.includes('_'));
      let existing;
      if (compositeKey) {
        const vals = where[compositeKey];
        existing = store[tableName].find(r => {
          for (const [k, v] of Object.entries(vals)) {
            if (r[k] !== v) return false;
          }
          return true;
        });
      } else {
        existing = store[tableName].find(r => matchesWhere(r, where));
      }

      if (existing) {
        Object.assign(existing, update);
        return existing;
      }
      const record = { id: crypto.randomUUID(), ...create };
      store[tableName].push(record);
      return record;
    },
  };
}

/**
 * Erstellt einen frischen Mock-Prisma-Client.
 * Jeder Test sollte createMockPrisma() aufrufen für einen sauberen Zustand.
 */
function createMockPrisma() {
  const store = {
    expenses: [],
    incomes: [],
    monthInits: [],
    categories: [],
    users: [],
    reminders: [],
    notes: [],
    storedPasswords: [],
    vaults: [],
    vaultMembers: [],
    servers: [],
    shares: [],
  };

  return {
    _store: store, // Für Test-Assertions direkt auf die Daten zugreifen
    expense: createCollection(store, 'expenses'),
    income: createCollection(store, 'incomes'),
    monthInit: createCollection(store, 'monthInits'),
    category: createCollection(store, 'categories'),
    user: createCollection(store, 'users'),
    reminder: createCollection(store, 'reminders'),
    note: createCollection(store, 'notes'),
    storedPassword: createCollection(store, 'storedPasswords'),
    vault: createCollection(store, 'vaults'),
    vaultMember: createCollection(store, 'vaultMembers'),
    server: createCollection(store, 'servers'),
    share: createCollection(store, 'shares'),
  };
}

module.exports = { createMockPrisma };
