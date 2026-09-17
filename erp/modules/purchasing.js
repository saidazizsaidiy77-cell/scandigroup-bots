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

// ════════════════════════ QARZDORLIK — AYLANMA-SALDO QAYDNOMASI
//
//  Ta'minotchining bugungi qarzi bitta raqam, zavodga esa ORALIQ
//  kerak: «1-sentabrda qancha edi, oy ichida qancha qo'shildi,
//  30-sentabrda qancha bo'ldi». Mijozlarniki bilan bir xil shakl —
//  saldo boshiga, davr aylanmasi va saldo oxiriga, har biri IKKI
//  ustun bo'lib (izoh: modules/sales.js).
//
//  ★ TOMONI MIJOZNIKIGA TESKARI. Ta'minotchi — passiv hisob:
//  HAQDOR biz qarzdor ekanimizni, QARZDOR esa to'lovni (yoki
//  oldindan to'lovni) anglatadi. Saldo = kredit − debet.
const DEBT_SQL = `
  SELECT s.id, s.name, s.phone, s.region, s.category,
         sc.name AS category_name, w.name AS manager_name,
         COALESCE(SUM(l.credit - l.debit) FILTER (WHERE l.on_date <  $1), 0) AS opening,
         COALESCE(SUM(l.debit)  FILTER (WHERE l.on_date BETWEEN $1 AND $2), 0) AS debit,
         COALESCE(SUM(l.credit) FILTER (WHERE l.on_date BETWEEN $1 AND $2), 0) AS credit,
         COALESCE(SUM(l.credit - l.debit) FILTER (WHERE l.on_date <= $2), 0) AS closing
    FROM suppliers s
    LEFT JOIN supplier_categories sc ON sc.code = s.category
    LEFT JOIN workers w              ON w.id = s.manager_id
    LEFT JOIN v_supplier_ledger l    ON l.supplier_id = s.id
   WHERE s.active
     AND ($3::text IS NULL OR s.name ILIKE '%' || $3 || '%'
          OR s.region ILIKE '%' || $3 || '%' OR s.phone ILIKE '%' || $3 || '%')
   GROUP BY s.id, s.name, s.phone, s.region, s.category, sc.name, w.name
  HAVING COALESCE(SUM(l.credit - l.debit) FILTER (WHERE l.on_date <  $1), 0) <> 0
      OR COALESCE(SUM(l.debit)  FILTER (WHERE l.on_date BETWEEN $1 AND $2), 0) <> 0
      OR COALESCE(SUM(l.credit) FILTER (WHERE l.on_date BETWEEN $1 AND $2), 0) <> 0
      OR COALESCE(SUM(l.credit - l.debit) FILTER (WHERE l.on_date <= $2), 0) <> 0
   ORDER BY closing DESC, s.name`;

//  Oraliq berilmasa: shu oyning boshidan bugungacha. Sana noto'g'ri
//  yozilsa ham hisobot ochilishi kerak (izoh: modules/sales.js).
function period(q) {
  const bugun = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const ok = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null);
  const to = ok(q.to) || iso(bugun);
  const from = ok(q.from)
    || iso(new Date(Date.UTC(bugun.getUTCFullYear(), bugun.getUTCMonth(), 1)));
  return from <= to ? { from, to } : { from: to, to: from };
}

//  Ishorali saldoni ikki tomonga ajratadi. Musbat — BIZ qarzdormiz,
//  ya'ni HAQDOR tomonda: ta'minotchi passiv hisob. Yig'indi ham tomon
//  bo'yicha qo'shiladi, ishoralar QISQARTIRILMAYDI — biriga 1000
//  qarzmiz, boshqasi 1000 avans bo'lsa «0» ikkalasini ham yashirardi.
const yon = (v) => {
  const n = Number(v) || 0;
  return { credit: n > 0 ? n : 0, debit: n < 0 ? -n : 0 };
};

const SEE = ['purchasing.view', 'purchasing.manage'];

router.get('/debts', need(...SEE), wrap(async (req, res) => {
  const { from, to } = period(req.query);
  const { rows } = await db.query(DEBT_SQL, [from, to, req.query.q || null]);
  for (const r of rows) {
    const o = yon(r.opening), c = yon(r.closing);
    r.opening_debit = o.debit; r.opening_credit = o.credit;
    r.closing_debit = c.debit; r.closing_credit = c.credit;
  }
  const sum = (k) => rows.reduce((a, r) => a + Number(r[k] || 0), 0);
  res.json({ from, to, rows,
             total: { opening: sum('opening'), debit: sum('debit'),
                      credit: sum('credit'), closing: sum('closing'),
                      opening_debit: sum('opening_debit'),
                      opening_credit: sum('opening_credit'),
                      closing_debit: sum('closing_debit'),
                      closing_credit: sum('closing_credit') } });
}));

//  Bitta ta'minotchining harakatlari — qator ochilganda. «Qayerdan
//  chiqdi shu raqam» degan savolga javob: qaysi hujjat, qaysi kun.
router.get('/debts/:id', need(...SEE), wrap(async (req, res) => {
  const { from, to } = period(req.query);
  const s = (await db.query(
    `SELECT id, name FROM suppliers WHERE id = $1`, [req.params.id])).rows[0];
  if (!s) return res.status(404).json({ error: "Ta'minotchi topilmadi" });

  const opening = Number((await db.query(
    `SELECT COALESCE(SUM(credit - debit), 0) AS n FROM v_supplier_ledger
      WHERE supplier_id = $1 AND on_date < $2`, [s.id, from])).rows[0].n);
  const { rows } = await db.query(
    `SELECT on_date, kind, note, debit, credit, doc_no, op_id
       FROM v_supplier_ledger
      WHERE supplier_id = $1 AND on_date BETWEEN $2 AND $3
      ORDER BY on_date, op_id
      LIMIT 500`, [s.id, from, to]);
  const jami = rows.reduce((a, r) =>
    ({ debit: a.debit + Number(r.debit), credit: a.credit + Number(r.credit) }),
    { debit: 0, credit: 0 });
  res.json({ supplier: s, from, to, opening, rows,
             total: jami, closing: opening + jami.credit - jami.debit });
}));

module.exports = router;
