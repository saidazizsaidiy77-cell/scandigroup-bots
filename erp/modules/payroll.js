// ═════════════════════════════════════════════════════════ ISH HAQI
//
//  ★ BITTA RO'YXAT, OYMA-OY: HISOBLANDI · TO'LANDI (zavod qarori,
//  2026-10; `/ish-haqi.html`). Har xodim bitta qatorda, ОСВ shaklida:
//
//      boshiga + hisoblandi − to'landi = oxiriga
//
//  HISOBLANDI — `payroll_accruals` (buxgalter qo'yadi, oyma-oy).
//  TO'LANDI — kassaning O'ZIDAN: `staff_id` bilan yozilgan har ok
//  operatsiya (oylik, avans, sarmoya — xodimga berilgan HAMMA pul),
//  foyda-zarar oyi bo'yicha. Ikkinchi nusxa yozilmaydi: kassir
//  «Oylik korpus · Abubakirov» deb yozgan zahoti bu yerda ko'rinadi.
//
//  Valyuta bo'yicha ALOHIDA (izoh: sql/cash.sql) — kurs yo'q.
const express = require('express');
const { db, wrap, audit } = require('../db');
const { need } = require('../auth');

const router = express.Router();
const KO = ['payroll.view', 'payroll.manage'];
const YOZ = 'payroll.manage';

const oy = (v) => {
  const m = String(v || '').slice(0, 7);
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(m) ? m + '-01' : null;
};
const bugungiOy = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
};

//  To'langan pulning OYI: foyda-zarar oyi, u bo'lmasa to'lov kuni.
//  Oylikda `pl_month` majburiy (harajat), ta'minotchiga to'lovda esa
//  `staff_id` umuman bo'lmaydi.
const TOLOV = `
  SELECT o.staff_id AS worker_id, o.currency, o.amount,
         COALESCE(o.pl_month, date_trunc('month', o.op_date)::date) AS month
    FROM cash_ops o
   WHERE o.status = 'ok' AND o.staff_id IS NOT NULL`;

router.get('/', need(...KO), wrap(async (req, res) => {
  const m = oy(req.query.month) || bugungiOy();
  const { rows } = await db.query(`
    WITH h AS (
      SELECT worker_id, currency, amount, month, 1 AS ishora FROM payroll_accruals
      UNION ALL
      SELECT worker_id, currency, amount, month, -1 FROM (${TOLOV}) t
    ), s AS (
      SELECT worker_id,
        SUM(amount * ishora) FILTER (WHERE month < $1 AND currency = 'UZS') AS open_uzs,
        SUM(amount * ishora) FILTER (WHERE month < $1 AND currency = 'USD') AS open_usd,
        SUM(amount) FILTER (WHERE month = $1 AND ishora = 1 AND currency = 'UZS') AS acc_uzs,
        SUM(amount) FILTER (WHERE month = $1 AND ishora = 1 AND currency = 'USD') AS acc_usd,
        SUM(amount) FILTER (WHERE month = $1 AND ishora = -1 AND currency = 'UZS') AS paid_uzs,
        SUM(amount) FILTER (WHERE month = $1 AND ishora = -1 AND currency = 'USD') AS paid_usd
        FROM h WHERE month <= $1 GROUP BY worker_id
    )
    SELECT w.id, w.name, w.position, w.staff_group, w.active,
           COALESCE(sc.name, w.dept) AS dept, sh.name AS shop,
           COALESCE(s.open_uzs, 0)::numeric(18,2) AS open_uzs,
           COALESCE(s.open_usd, 0)::numeric(18,2) AS open_usd,
           COALESCE(s.acc_uzs, 0)::numeric(18,2)  AS acc_uzs,
           COALESCE(s.acc_usd, 0)::numeric(18,2)  AS acc_usd,
           COALESCE(s.paid_uzs, 0)::numeric(18,2) AS paid_uzs,
           COALESCE(s.paid_usd, 0)::numeric(18,2) AS paid_usd,
           (SELECT note FROM payroll_accruals a
             WHERE a.worker_id = w.id AND a.month = $1
             ORDER BY a.currency DESC LIMIT 1) AS note
      FROM workers w
      LEFT JOIN s ON s.worker_id = w.id
      LEFT JOIN sections sc ON sc.id = w.section_id
      LEFT JOIN shops    sh ON sh.id = w.shop_id
     --  Ishdan ketgan xodim ham turadi, agar hisobi yopilmagan bo'lsa:
     --  unga qarzimiz qolgan va u jimgina ro'yxatdan tushib ketmasin.
     WHERE w.active OR s.worker_id IS NOT NULL
     ORDER BY sh.name NULLS LAST, w.name`, [m]);
  for (const r of rows) {
    r.close_uzs = (Number(r.open_uzs) + Number(r.acc_uzs) - Number(r.paid_uzs)).toFixed(2);
    r.close_usd = (Number(r.open_usd) + Number(r.acc_usd) - Number(r.paid_usd)).toFixed(2);
  }
  //  Ishdan ketgan va hisobi nolga yopilgan xodim — keraksiz qator.
  const list = rows.filter((r) => r.active || ['open_uzs', 'open_usd', 'acc_uzs',
    'acc_usd', 'paid_uzs', 'paid_usd'].some((k) => Number(r[k])));
  const total = {};
  for (const k of ['open_uzs', 'open_usd', 'acc_uzs', 'acc_usd', 'paid_uzs',
                   'paid_usd', 'close_uzs', 'close_usd'])
    total[k] = list.reduce((a, r) => a + Number(r[k]), 0).toFixed(2);
  res.json({ month: m.slice(0, 7), rows: list, total,
             can_edit: req.user.permissions.includes(YOZ) });
}));

//  Bitta xodim, bitta oy: nima hisoblandi va QAYSI hujjat bilan
//  to'landi. «Men oldim-ku» degan savolga raqam emas, hujjat javob.
router.get('/worker/:id', need(...KO), wrap(async (req, res) => {
  const m = oy(req.query.month) || bugungiOy();
  const id = Number(req.params.id) || 0;
  const [acc, paid] = await Promise.all([
    db.query(`SELECT currency, amount, note FROM payroll_accruals
               WHERE worker_id = $1 AND month = $2 ORDER BY currency DESC`, [id, m]),
    db.query(`SELECT o.id, o.doc_no, o.op_date, o.currency, o.amount, o.note,
                     i.name AS item
                FROM cash_ops o
                LEFT JOIN expense_items i ON i.id = o.expense_item_id
               WHERE o.status = 'ok' AND o.staff_id = $1
                 AND COALESCE(o.pl_month, date_trunc('month', o.op_date)::date) = $2
               ORDER BY o.op_date, o.id`, [id, m]),
  ]);
  res.json({ accruals: acc.rows, payments: paid.rows });
}));

//  Hisoblanganini yozish. Bo'sh yoki nol — «yo'q» degani: o'sha oyning
//  qatori o'chadi (kartochkadagi «bo'sh — tegma emas, yo'q» bilan bir
//  xil qoida).
router.put('/accrual', need(YOZ), wrap(async (req, res) => {
  const b = req.body || {};
  const m = oy(b.month);
  const wid = Number(b.worker_id) || 0;
  const cur = b.currency === 'USD' ? 'USD' : 'UZS';
  const amt = b.amount === '' || b.amount == null ? 0 : Number(b.amount);
  if (!m) throw Object.assign(new Error('Oy tanlanmagan'), { status: 400 });
  if (!(amt >= 0)) throw Object.assign(new Error('Summa noto\'g\'ri'), { status: 400 });
  const w = await db.query(`SELECT 1 FROM workers WHERE id = $1`, [wid]);
  if (!w.rowCount) throw Object.assign(new Error('Xodim topilmadi'), { status: 400 });
  const eski = (await db.query(`SELECT amount FROM payroll_accruals
     WHERE worker_id = $1 AND month = $2 AND currency = $3`, [wid, m, cur])).rows[0];
  if (amt === 0) {
    await db.query(`DELETE FROM payroll_accruals
      WHERE worker_id = $1 AND month = $2 AND currency = $3`, [wid, m, cur]);
  } else {
    await db.query(`
      INSERT INTO payroll_accruals (worker_id, month, currency, amount, note, created_by)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (worker_id, month, currency)
      DO UPDATE SET amount = EXCLUDED.amount,
                    note = COALESCE(EXCLUDED.note, payroll_accruals.note),
                    created_by = EXCLUDED.created_by, updated_at = now()`,
      [wid, m, cur, amt, b.note ? String(b.note).trim() || null : null, req.user.id]);
  }
  await audit(req, { module: 'payroll', action: 'accrual', entity: 'worker', entity_id: wid,
    payload: { month: m, currency: cur, edi: eski ? eski.amount : null, boldi: amt || null } });
  res.json({ ok: true });
}));

//  ★ O'TGAN OYDAN KO'CHIRISH. Oyliklarning ko'pi har oy bir xil — oltmish
//  qatorni har oy qaytadan terish kerak emas. Faqat SHU OYDA HALI
//  YOZILMAGAN qatorlar to'ladi: qo'lda tuzatilgani ustiga yozilmaydi.
router.post('/copy', need(YOZ), wrap(async (req, res) => {
  const m = oy((req.body || {}).month);
  if (!m) throw Object.assign(new Error('Oy tanlanmagan'), { status: 400 });
  const r = await db.query(`
    INSERT INTO payroll_accruals (worker_id, month, currency, amount, note, created_by)
    SELECT a.worker_id, $1::date, a.currency, a.amount, a.note, $2
      FROM payroll_accruals a
      JOIN workers w ON w.id = a.worker_id AND w.active
     WHERE a.month = ($1::date - interval '1 month')::date
    ON CONFLICT (worker_id, month, currency) DO NOTHING`, [m, req.user.id]);
  await audit(req, { module: 'payroll', action: 'copy', entity: 'month', entity_id: m,
    payload: { qator: r.rowCount } });
  res.json({ ok: true, count: r.rowCount });
}));

module.exports = router;
