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

module.exports = { queue, sendPending };
