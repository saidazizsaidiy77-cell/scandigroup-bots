const { db } = require('./db');

// Xabar navbatga qo'yiladi, yuborish alohida jarayonda bo'ladi —
// shuning uchun API javobi Telegram javobini kutmaydi.
//   queue({ permission_code: 'production.view', title: '...', body: '...' })
//   queue({ worker_id: 12, ... })
//
// ★ TRANZAKSIYA ICHIDAN CHAQIRILSA `client` UZATILADI (3-qoida, izoh:
// erp/db.js): hovuzdan yangi ulanish so'ralsa u o'sha tranzaksiyani
// KO'RMAYDI — xabar navbatga tushib, keyin tranzaksiya qaytarilsa
// bo'lmagan so'rov haqida xabar yuborilardi.
async function queue({ worker_id, permission_code, module, title, body }, client) {
  await (client || db).query(
    `INSERT INTO notifications (worker_id, permission_code, module, title, body)
     VALUES ($1,$2,$3,$4,$5)`,
    [worker_id || null, permission_code || null, module, title, body || null]);
}

//  ★ KIMGA BORISHI NAVBAT BILAN BIR XIL (zavod qarori, 2026-09).
//
//  Menyudagi raqam va Telegram xabari BITTA savolga javob beradi —
//  «bu ish kimniki». Shart ikki joyda yozilsa bir kun ajralib ketardi:
//  menyuda tsex boshlig'i ko'radi, xabar esa boshqa odamga borardi va
//  buni hech narsa aytmasdi. Shuning uchun quyidagi ikki yordamchi
//  `modules/nav.js` dagi navbat shartlarini AYNAN takrorlaydi.
//
//  TSEX: faqat DOIRASI BOR xodim oladi — konver qabul qilish tsexning
//  ishi, direktorniki emas; unga butun zavodning topshirig'i kun bo'yi
//  keladigan xabar bo'lib qolardi (navbat 2 bilan bir xil sabab).
async function queueShop({ shop_id, perms, module, title, body }, client) {
  if (!shop_id) return 0;
  const c = client || db;
  const { rows } = await c.query(
    `SELECT DISTINCT w.id FROM workers w
       JOIN worker_roles wr        ON wr.worker_id = w.id
                                  AND wr.scope_shop_id = $1
       JOIN v_worker_permissions vp ON vp.worker_id = w.id
      WHERE w.active AND vp.permission_code = ANY($2)`, [shop_id, perms]);
  for (const r of rows)
    await queue({ worker_id: r.id, module, title, body }, c);
  return rows.length;
}

//  OMBOR: `warehouse_id` berilmasa doira umuman qaralmaydi (navbat 4
//  va 5 shunday — qabul qilish huquqining o'zi yetarli). Berilsa
//  vitrina doirasi CHEGARA bo'ladi: doirasi yo'q xodim hammasini
//  oladi, doirasi bor esa faqat o'zinikini (navbat 6).
//
//  `sees_warehouse` belgisi bu yerda ham o'qiladi: belgisi olib
//  tashlangan xodimda ombor bo'limi UMUMAN yopiladi (`erp/auth.js`)
//  va unga ombor xabari borishi ham yolg'on bo'lardi.
//  `scoped_only` — faqat O'SHA nuqtaga biriktirilgan xodim: vitrinaga
//  kelayotgan hujjatni o'sha do'kondagi odam qabul qiladi va doirasi
//  yo'q bosh ofis menejeriga u xabar emas (navbat 6 bilan bir xil).
async function queueWarehouse(
  { warehouse_id, perms, module, title, body, except, scoped_only }, client) {
  const c = client || db;
  const { rows } = await c.query(
    `SELECT DISTINCT w.id FROM workers w
       JOIN v_worker_permissions vp ON vp.worker_id = w.id
      WHERE w.active AND vp.permission_code = ANY($1)
        AND (w.sees_warehouse IS NOT FALSE
             OR vp.permission_code NOT LIKE 'warehouse.%')
        AND ($3::int IS NULL OR w.id <> $3)
        AND ($2::int IS NULL OR
             CASE WHEN $4::boolean THEN EXISTS (
                    SELECT 1 FROM worker_roles wr
                     WHERE wr.worker_id = w.id
                       AND wr.scope_warehouse_id = $2)
                  ELSE NOT EXISTS (
                    SELECT 1 FROM worker_roles wr
                     WHERE wr.worker_id = w.id
                       AND wr.scope_warehouse_id IS NOT NULL)
                    OR EXISTS (
                    SELECT 1 FROM worker_roles wr
                     WHERE wr.worker_id = w.id
                       AND wr.scope_warehouse_id = $2)
             END)`,
    [perms, warehouse_id || null, except || null, !!scoped_only]);
  for (const r of rows)
    await queue({ worker_id: r.id, module, title, body }, c);
  return rows.length;
}

// Bot jarayoni shuni chaqiradi. send(tg_id, text) — Telegram yuboruvchi funksiya.
async function sendPending(send, limit = 50) {
  const { rows } = await db.query(
    `SELECT n.id, n.title, n.body,
            COALESCE(
              ARRAY(SELECT w.tg_id FROM workers w WHERE w.id = n.worker_id AND w.tg_id IS NOT NULL),
              '{}'
            ) || ARRAY(
              SELECT w.tg_id FROM workers w
               JOIN v_worker_permissions vp ON vp.worker_id = w.id
               WHERE n.permission_code IS NOT NULL
                 AND vp.permission_code = n.permission_code
                 AND w.tg_id IS NOT NULL AND w.active
            ) AS targets
       FROM notifications n
      WHERE n.sent_at IS NULL
      ORDER BY n.id LIMIT $1`, [limit]);

  for (const n of rows) {
    const text = n.body ? `*${n.title}*\n${n.body}` : n.title;
    try {
      for (const tgId of [...new Set(n.targets)]) await send(tgId, text);
      await db.query(`UPDATE notifications SET sent_at = NOW() WHERE id = $1`, [n.id]);
    } catch (e) {
      await db.query(`UPDATE notifications SET error = $2 WHERE id = $1`, [n.id, e.message]);
    }
  }
  return rows.length;
}

module.exports = { queue, queueShop, queueWarehouse, sendPending };
