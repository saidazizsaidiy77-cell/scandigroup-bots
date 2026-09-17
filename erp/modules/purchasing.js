// ============================================================================
//  TA'MINOT — ta'minotchilar spravochnigi
//
//  Savdodagi mijozlar bilan bir xil mantiq: nomi takrorlanmas, o'chirilmaydi
//  balki faolsizlantiriladi, ro'yxatni birdan import qilish mumkin.
//
//  Huquq: ko'rish — purchasing.view, o'zgartirish — purchasing.manage
// ============================================================================
const express = require('express');
const { db, wrap, audit } = require('../db');
const { need } = require('../auth');

const router = express.Router();

router.get('/suppliers', need('purchasing.view', 'purchasing.manage'), wrap(async (_req, res) => {
  const [suppliers, categories, managers] = await Promise.all([
    //  Qarzi yonida keladi: «kimga qancha qarzmiz» ta'minotchi
    //  ro'yxatidagi birinchi savol. Balans alohida view da, chunki u
    //  `cash_ops` ni o'qiydi (izoh: sql/cash.sql).
    db.query(`SELECT v.*, d.paid, d.balance
                FROM v_suppliers v
                LEFT JOIN v_supplier_debt d ON d.id = v.id
               WHERE v.active ORDER BY v.name`),
    db.query(`SELECT * FROM supplier_categories ORDER BY sort`),
    // Mas'ul sifatida biriktirish mumkin bo'lgan xodimlar: ta'minot roli
    // borlar birinchi turadi
    db.query(
      `SELECT w.id, w.name,
              EXISTS (SELECT 1 FROM v_worker_permissions vp
                       WHERE vp.worker_id = w.id AND vp.module = 'purchasing') AS is_supply
         FROM workers w WHERE w.active ORDER BY is_supply DESC, w.name`),
  ]);
  res.json({ suppliers: suppliers.rows, categories: categories.rows,
             managers: managers.rows });
}));

// Bitta ta'minotchi yoki ro'yxatni birdan qabul qiladi (import uchun)
router.post('/suppliers', need('purchasing.manage'), wrap(async (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [req.body];
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const saved = [];
    for (const it of items) {
      const name = String(it.name || '').trim();
      if (!name) throw new Error("Ta'minotchi nomi majburiy");
      // Takror kiritilsa yangi qator yaratmaydi — bo'sh maydonlarni to'ldiradi
      const { rows } = await client.query(
        `INSERT INTO suppliers (name, phone, country, region, category, manager_id,
                                inn, note, opening_debt, opening_debt_on)
         VALUES ($1,$2, COALESCE($3, 'O''zbekiston'), $4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (lower(name)) DO UPDATE SET
           phone      = COALESCE(EXCLUDED.phone,      suppliers.phone),
           country    = COALESCE(EXCLUDED.country,    suppliers.country),
           region     = COALESCE(EXCLUDED.region,     suppliers.region),
           category   = COALESCE(EXCLUDED.category,   suppliers.category),
           manager_id = COALESCE(EXCLUDED.manager_id, suppliers.manager_id),
           inn        = COALESCE(EXCLUDED.inn,        suppliers.inn),
           note       = COALESCE(EXCLUDED.note,       suppliers.note),
           --  Qarz bir marta: kiritilgani qayta yuklashda o'chmaydi
           --  (mijozlar bilan bir xil qoida). Kartochkadan esa
           --  tuzatiladi ham, tozalanadi ham.
           opening_debt    = COALESCE(suppliers.opening_debt, EXCLUDED.opening_debt),
           opening_debt_on = COALESCE(suppliers.opening_debt_on,
                                      EXCLUDED.opening_debt_on)
         RETURNING id, name`,
        [name, it.phone || null, it.country || null, it.region || null,
         it.category || null, it.manager_id || null, it.inn || null, it.note || null,
         it.opening_debt == null || it.opening_debt === '' ? null : Number(it.opening_debt),
         it.opening_debt_on || null]);
      saved.push(rows[0]);
    }
    // Tranzaksiya ichidamiz — audit o'sha ulanishda yozilsin, aks holda
    // hovuzdan yangi ulanish so'raladi (izoh: db.js).
    await audit(req, { module: 'purchasing', action: 'create', entity: 'supplier',
                       entity_id: saved.length, payload: { count: saved.length } }, client);
    await client.query('COMMIT');
    res.json(Array.isArray(req.body.items) ? { saved } : saved[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    return res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
}));

router.patch('/suppliers/:id', need('purchasing.manage'), wrap(async (req, res) => {
  const b = req.body || {};
  const { name, phone, country, region, category, manager_id, inn, note, active } = b;
  //  Qarz TOZALANISHI ham kerak: xato yozilgan raqam qolib ketmasin.
  //  COALESCE bilan bo'sh qiymat «tegma» degani bo'lardi, shuning uchun
  //  maydon yuborilgani ALOHIDA tekshiriladi.
  const qarzBor = 'opening_debt' in b;
  const qarz = b.opening_debt === '' || b.opening_debt == null
    ? null : Number(b.opening_debt);
  if (qarzBor && qarz !== null && !Number.isFinite(qarz))
    return res.status(400).json({ error: 'Qarz raqam emas' });
  const sanaBor = 'opening_debt_on' in b;
  const { rows } = await db.query(
    `UPDATE suppliers SET
       name       = COALESCE($2, name),
       phone      = COALESCE($3, phone),
       country    = COALESCE($4, country),
       region     = COALESCE($5, region),
       category   = COALESCE($6, category),
       manager_id = COALESCE($7, manager_id),
       inn        = COALESCE($8, inn),
       note       = COALESCE($9, note),
       active     = COALESCE($10, active),
       opening_debt    = CASE WHEN $11::boolean THEN $12::numeric ELSE opening_debt END,
       opening_debt_on = CASE WHEN $13::boolean THEN $14::date   ELSE opening_debt_on END
     WHERE id = $1 RETURNING id`,
    [req.params.id, name || null, phone || null, country || null, region || null,
     category || null, manager_id || null, inn || null, note || null,
     typeof active === 'boolean' ? active : null,
     qarzBor, qarz, sanaBor, b.opening_debt_on || null]);
  if (!rows[0]) return res.status(404).json({ error: "Ta'minotchi topilmadi" });
  await audit(req, { module: 'purchasing', action: 'update', entity: 'supplier',
                     entity_id: req.params.id, payload: req.body });
  res.json({ ok: true });
}));

module.exports = router;
