#!/usr/bin/env node
/* Bazani yaratadi va yangilaydi. Qayta-qayta ishga tushirish xavfsiz —
   barcha fayllar IF NOT EXISTS / ON CONFLICT bilan yozilgan.
     npm run erp:migrate                 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { db } = require('./db');
const pin = require('./pin');

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
  'routes.sql',          // marshrut: qaysi bo'limdan qaysi tartibda o'tadi
  'sales.sql',           // savdo: buyurtma va uning qatorlari
  //  Ombor OXIRIDA: `v_fg_units` konver qaysi buyurtmaga biriktirilganini
  //  ham ko'rsatadi (`order_item_id`, sales.sql da qo'shiladi). Toza
  //  bazada tartib buzilsa migratsiya birinchi ishga tushishdayoq
  //  yiqiladi — ya'ni sayt umuman ko'tarilmaydi.
  'warehouse.sql',       // ombor: qoldiq va harakat, konveyer raqami bo'yicha
  //  Kassa ENG OXIRIDA: mijoz balansi va qarzdorlik lentasi endi
  //  to'lovlarni ham o'qiydi, ya'ni `cash_ops` dan keyin qurilishi
  //  kerak. Shuning uchun o'sha ikki view ham shu faylda.
  'cash.sql',            // kassa: hisoblar, harajat moddalari, pul harakati
  //  Xom ashyo KASSADAN KEYIN: tsex omborlari `warehouses` ga qator
  //  qo'shadi va u `warehouse.sql` da yaratiladi. Spravochnikning
  //  o'zi hech kimga bog'liq emas, lekin ikkalasi bitta faylda
  //  turgani ma'qul: modul bitta joydan o'qiladi.
  'materials.sql',       // xom ashyo: spravochnik va tsex omborlari
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
  const pins = await hashPins();
  if (!quiet && pins) console.log(`  ${'PIN izlari'.padEnd(22)}${pins} ta ko'chirildi`);
  const { rows } = await db.query(
    `SELECT (SELECT COUNT(*) FROM shops)    AS tsexlar,
            (SELECT COUNT(*) FROM sections) AS bolimlar,
            (SELECT COUNT(*) FROM products) AS sku,
            (SELECT COUNT(*) FROM workers)  AS xodimlar,
            (SELECT COUNT(*) FROM customers) AS mijozlar,
            (SELECT COUNT(*) FROM production_units) AS birliklar`);
  return rows[0];
}

/*  ★ PIN'NI OCHIQ USTUNDAN IZGA KO'CHIRISH.
 *
 *  SQL buni qila olmaydi: iz maxfiy kalit bilan hisoblanadi va kalit
 *  bazada emas, server sozlamasida turadi (izoh: `erp/pin.js`).
 *
 *  `migration_flags` ISHLATILMAYDI — bu bir martalik ko'chirish emas,
 *  doimiy qoida: kalit keyinroq qo'yilsa o'sha kuni ko'chadi, eski
 *  bazadan ochiq PIN bilan kelgan qator bo'lsa keyingi migratsiyada
 *  o'zi tozalanadi. Kalit yo'q bo'lsa hech narsa qilinmaydi va sayt
 *  eskicha ko'tariladi.
 */
async function hashPins() {
  if (!pin.ready) return 0;
  const { rows } = await db.query(`SELECT id, pin FROM workers WHERE pin IS NOT NULL`);
  for (const w of rows)
    await db.query(
      `UPDATE workers SET pin_hash = COALESCE(pin_hash, $2), pin = NULL WHERE id = $1`,
      [w.id, pin.hash(w.pin)]);
  return rows.length;
}

module.exports = { migrate };

// To'g'ridan-to'g'ri ishga tushirilganda: npm run erp:migrate
if (require.main === module) {
  migrate()
    .then(async (stat) => { console.log('\nBaza tayyor:', stat); await db.end(); })
    .catch((e) => { console.error('\nXATO:', e.message); process.exit(1); });
}
