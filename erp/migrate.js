#!/usr/bin/env node
/* Bazani yaratadi va yangilaydi. Qayta-qayta ishga tushirish xavfsiz —
   barcha fayllar IF NOT EXISTS / ON CONFLICT bilan yozilgan.
     npm run erp:migrate                 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { db } = require('./db');

const FILES = [
  'core.sql',            // xodim, rol, huquq, sessiya, audit, bildirishnoma
  'core-seed.sql',       // huquqlar va rollar
  'production.sql',      // ishlab chiqarish jadvallari va view'lari
  'production-seed.sql', // tsexlar, bo'limlar, marshrutlar
  'catalog-groups.sql',  // mahsulot guruhlari: penal, kamod, sp, stol, stul
  'production-sku.sql',  // fason va SKU katalogi
  'units.sql',           // konveyer jurnali: birlik, mijoz, harakat
  'register.sql',        // jurnal ustunlari: rang, mato, lak/qadoqlash sanalari
  'catalog.sql',         // katalogni saytdan boshqarish: guruh, fason, SKU
  'purchasing.sql',      // ta'minot: ta'minotchilar spravochnigi
];

// server.js ham shu funksiyani chaqiradi (ERP_AUTO_MIGRATE=1 bo'lsa),
// shuning uchun quiet rejimi bor.
async function migrate({ quiet = false } = {}) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL kiritilmagan');
  for (const f of FILES) {
    const sql = fs.readFileSync(path.join(__dirname, 'sql', f), 'utf8');
    if (!quiet) process.stdout.write(`  ${f.padEnd(22)}`);
    await db.query(sql);
    if (!quiet) console.log('OK');
  }
  const { rows } = await db.query(
    `SELECT (SELECT COUNT(*) FROM shops)    AS tsexlar,
            (SELECT COUNT(*) FROM sections) AS bolimlar,
            (SELECT COUNT(*) FROM products) AS sku,
            (SELECT COUNT(*) FROM workers)  AS xodimlar,
            (SELECT COUNT(*) FROM customers) AS mijozlar,
            (SELECT COUNT(*) FROM production_units) AS birliklar`);
  return rows[0];
}

module.exports = { migrate };

// To'g'ridan-to'g'ri ishga tushirilganda: npm run erp:migrate
if (require.main === module) {
  migrate()
    .then(async (stat) => { console.log('\nBaza tayyor:', stat); await db.end(); })
    .catch((e) => { console.error('\nXATO:', e.message); process.exit(1); });
}
