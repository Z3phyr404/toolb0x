// ============================================================
// DATENBANK-SEED — mit Verschlüsselung
// ============================================================

const prisma = require('../src/utils/prisma');
const bcrypt = require('bcrypt');
const {
  generateEncryptionKey,
  wrapEncryptionKey,
  encrypt,
} = require('../src/utils/encryption');

async function main() {
  console.log('🌱 Seed: Erstelle verschlüsselte Testdaten...\n');

  const password = 'Test1234!';
  const hashedPassword = await bcrypt.hash(password, 12);

  const encKey = generateEncryptionKey();
  const wrappedKey = wrapEncryptionKey(encKey, password);

  const user = await prisma.user.upsert({
    where: { email: 'michael@test.de' },
    update: { encryptedKey: wrappedKey, password: hashedPassword },
    create: {
      email: 'michael@test.de',
      password: hashedPassword,
      name: 'Michael',
      encryptedKey: wrappedKey,
    },
  });

  console.log(`✅ Nutzer erstellt: ${user.email}`);

  await prisma.expense.deleteMany({ where: { userId: user.id } });
  await prisma.income.deleteMany({ where: { userId: user.id } });
  await prisma.category.deleteMany({ where: { userId: user.id } });

  const categoryData = [
    { name: 'Wohnen & Grund', color: '#FF9500' },
    { name: 'Lebensmittel', color: '#34C759' },
    { name: 'Auto & Transport', color: '#007AFF' },
    { name: 'Sparen', color: '#5856D6' },
    { name: 'Versicherungen', color: '#AF52DE' },
    { name: 'Abonnements', color: '#FF2D55' },
    { name: 'Handy & Internet', color: '#00C7BE' },
    { name: 'Persönliches', color: '#FF6B6B' },
    { name: 'Sonstiges', color: '#8E8E93' },
  ];

  const categories = {};
  for (const cat of categoryData) {
    const created = await prisma.category.create({
      data: {
        name: encrypt(cat.name, encKey),
        color: encrypt(cat.color, encKey),
        userId: user.id,
      },
    });
    categories[cat.name] = created;
    console.log(`   📁 Kategorie: ${cat.name} → (verschlüsselt gespeichert)`);
  }

  const incomeData = [
    { name: 'Nettolohn', amount: 2430 },
    { name: 'Kindergeld', amount: 300 },
  ];

  for (const inc of incomeData) {
    await prisma.income.create({
      data: {
        name: encrypt(inc.name, encKey),
        amount: encrypt(String(inc.amount), encKey),
        userId: user.id,
        month: '2026-02',
        isRecurring: true,
      },
    });
    console.log(`   💰 Einnahme: ${inc.name} → (verschlüsselt gespeichert)`);
  }

  const expenseData = [
    { name: 'Miete', amount: 640, category: 'Wohnen & Grund' },
    { name: 'Strom', amount: 85, category: 'Wohnen & Grund' },
    { name: 'Grundsteuer', amount: 18, category: 'Wohnen & Grund' },
    { name: 'Müllgebühren', amount: 18, category: 'Wohnen & Grund' },
    { name: 'GEZ', amount: 18.36, category: 'Wohnen & Grund' },
    { name: 'Lebensmittel', amount: 350, category: 'Lebensmittel' },
    { name: 'Tanken', amount: 200, category: 'Auto & Transport' },
    { name: 'KFZ Steuer', amount: 18.33, category: 'Auto & Transport' },
    { name: 'KFZ Versicherung', amount: 50.49, category: 'Auto & Transport' },
    { name: 'Bausparer', amount: 100, category: 'Sparen' },
    { name: 'Sparbuch', amount: 100, category: 'Sparen' },
    { name: 'Sparbuch 2', amount: 200, category: 'Sparen' },
    { name: 'Haftpflicht', amount: 8.58, category: 'Versicherungen' },
    { name: 'Zahnzusatzvers.', amount: 27, category: 'Versicherungen' },
    { name: 'Allianz Versicherung', amount: 10, category: 'Versicherungen' },
    { name: 'Hausratversicherung', amount: 11.05, category: 'Versicherungen' },
    { name: 'Paramount+', amount: 7.99, category: 'Abonnements' },
    { name: 'Disney+', amount: 5.99, category: 'Abonnements' },
    { name: 'Netflix', amount: 13.99, category: 'Abonnements' },
    { name: 'Amazon Prime', amount: 8.99, category: 'Abonnements' },
    { name: 'Crunchyroll', amount: 6.99, category: 'Abonnements' },
    { name: 'Spotify', amount: 10.99, category: 'Abonnements' },
    { name: 'Apple iCloud', amount: 2.99, category: 'Abonnements' },
    { name: 'Claude AI', amount: 20, category: 'Abonnements' },
    { name: 'ChatGPT', amount: 20, category: 'Abonnements' },
    { name: 'Audible', amount: 9.95, category: 'Abonnements' },
    { name: 'Xbox Gamepass', amount: 17.99, category: 'Abonnements' },
    { name: 'PlayStation Plus', amount: 8.99, category: 'Abonnements' },
    { name: 'Handy', amount: 37.99, category: 'Handy & Internet' },
    { name: 'Smartwatch', amount: 15, category: 'Handy & Internet' },
    { name: 'Internet', amount: 44.99, category: 'Handy & Internet' },
    { name: 'Taschengeld', amount: 80, category: 'Persönliches' },
  ];

  for (const exp of expenseData) {
    await prisma.expense.create({
      data: {
        name: encrypt(exp.name, encKey),
        amount: encrypt(String(exp.amount), encKey),
        categoryId: categories[exp.category].id,
        userId: user.id,
        month: '2026-02',
        isRecurring: true,
      },
    });
  }

  console.log(`\n   📊 ${expenseData.length} Ausgaben erstellt (alle verschlüsselt)`);
  console.log(`\n✅ Seed abgeschlossen!`);
  console.log(`\n📧 Login-Daten: michael@test.de / Test1234!`);
  console.log(`\n🔒 In der Datenbank sind ALLE Finanzdaten verschlüsselt.`);
  console.log(`   Als Betreiber siehst du nur Kauderwelsch.\n`);
}

main()
  .catch((e) => { console.error('❌ Seed fehlgeschlagen:', e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
