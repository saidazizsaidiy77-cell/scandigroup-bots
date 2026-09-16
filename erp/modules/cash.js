// ============================================================================
//  KASSA
//
//  Har operatsiya — QAYERDAN → QAYERGA (izoh: sql/cash.sql). Shu yerda
//  faqat kim nima qila olishi va qaysi qoida buzilmasligi yoziladi.
//
//  ★ IKKI XIL ODAM, IKKI XIL EKRAN
//
//  `cash.entry`  — SAVDO MENEJERI. U mijozdan pul oladi, xolos: bitta
//                  yo'l (`mijoz → o'zi`), o'z qo'lidagi pul va o'z
//                  kirimlari. Kassa qoldig'i ham, boshqa xodimning
//                  podotchyoti ham unga ko'rinmaydi.
//  `cash.manage` — KASSIR va BUXGALTER. Hammasi: qabul qilish, chiqim,
//                  kassalar aro ko'chirish, bekor qilish.
//  `cash.view`   — faqat o'qish (rahbariyat).
//
//  Tekshiruv SERVERDA: tugmani yashirish himoya emas.
// ============================================================================
const express = require('express');
const { db, wrap, audit } = require('../db');
const { need } = require('../auth');

const router = express.Router();
const READ  = ['cash.view', 'cash.manage'];
const MANAGE = ['cash.manage'];
//  Menejer ham kiradi: uning ekrani ichkarida toraytiriladi.
const ANY = ['cash.view', 'cash.entry', 'cash.manage'];

const can = (req, ...p) => p.some((x) => (req.user?.permissions || []).includes(x));
const isBoss = (req) => can(req, 'cash.manage');

//  Savdo yo'nalishi chegarasi — savdo moduli bilan bir xil: B2B
//  menejeri eksport mijozidan to'lov yozib qo'ya olmaydi.
const channelsOf = (req) => {
  const c = req.user?.scope_channels || [];
  return c.length ? c : null;
};

//  Hujjat raqami: P26-0001 — «pul». Konver `K`, zakaz `Z`, pul `P`.
//  Raqam bitta joyda beriladi, tranzaksiya qulfi bilan: ikki kassir
//  bir vaqtda yozsa ham raqam takrorlanmaydi.
async function nextDocNo(client) {
  const prefix = `P${String(new Date().getFullYear()).slice(-2)}-`;
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(SUBSTRING(doc_no FROM '\\d+$')::int), 0) + 1 AS n
       FROM cash_ops WHERE doc_no LIKE $1`, [`${prefix}%`]);
  return prefix + String(rows[0].n).padStart(4, '0');
}

// ──────────────────────────────────────────────────────── SPRAVOCHNIKLAR
//
//  Bitta so'rovda: kassalar, harajat moddalari va tomon bo'la oladigan
//  ro'yxatlar. Menejerga faqat mijozlar keladi — qolganini u tanlay
//  olmaydi va ro'yxatni yuklash ham ortiqcha.
router.get('/refs', need(...ANY), wrap(async (req, res) => {
  const boss = isBoss(req);
  const chans = channelsOf(req);
  const [accounts, groups, items, customers, suppliers, workers] = await Promise.all([
    boss ? db.query(`SELECT id, code, name, kind FROM cash_accounts
                      WHERE is_active ORDER BY sort, name`) : { rows: [] },
    db.query(`SELECT code, name FROM expense_groups ORDER BY sort, name`),
    db.query(`SELECT id, group_code, name FROM expense_items
               WHERE active ORDER BY sort, name`),
    db.query(`SELECT id, name, region FROM customers
               WHERE active AND ($1::text[] IS NULL OR channel = ANY($1))
               ORDER BY name`, [chans]),
    boss ? db.query(`SELECT id, name FROM suppliers WHERE active ORDER BY name`)
         : { rows: [] },
    boss ? db.query(`SELECT id, name FROM workers WHERE active ORDER BY name`)
         : { rows: [] },
  ]);
  res.json({
    accounts: accounts.rows, groups: groups.rows, items: items.rows,
    customers: customers.rows, suppliers: suppliers.rows, workers: workers.rows,
    me: { id: req.user.id, name: req.user.name }, boss,
  });
}));

// ──────────────────────────────────────────────────────────── QOLDIQLAR
//
//  Kassalar va xodimlar qo'lidagi pul. Menejerga faqat O'ZINIKI:
//  kassada qancha pul turgani uning ishi emas.
router.get('/balance', need(...ANY), wrap(async (req, res) => {
  const boss = isBoss(req);
  const accounts = boss ? (await db.query(
    `SELECT * FROM v_cash_balance WHERE is_active ORDER BY sort, name`)).rows : [];
  const workers = (await db.query(
    `SELECT * FROM v_worker_cash
      WHERE (total_usd <> 0 OR uzs <> 0 OR usd <> 0)
        AND ($1::boolean OR id = $2)
      ORDER BY total_usd DESC, name`, [boss, req.user.id])).rows;
  res.json({ accounts, workers, boss });
}));

// ─────────────────────────────────────────────────── OPERATSIYALAR LENTASI
router.get('/ops', need(...ANY), wrap(async (req, res) => {
  const boss = isBoss(req);
  const { rows } = await db.query(
    `SELECT * FROM v_cash_ops
      WHERE ($1::boolean OR (from_kind = 'worker' AND from_id = $2)
                         OR (to_kind   = 'worker' AND to_id   = $2))
        AND ($3::date IS NULL OR op_date >= $3)
        AND ($4::date IS NULL OR op_date <= $4)
        AND ($5::text IS NULL OR doc_no ILIKE '%' || $5 || '%'
             OR from_name ILIKE '%' || $5 || '%' OR to_name ILIKE '%' || $5 || '%')
        AND ($6::int IS NULL OR (from_kind = 'account' AND from_id = $6)
                             OR (to_kind   = 'account' AND to_id   = $6))
      ORDER BY op_date DESC, id DESC
      LIMIT 500`,
    [boss, req.user.id, req.query.from || null, req.query.to || null,
     req.query.q || null, req.query.account_id || null]);
  res.json({ rows, boss });
}));

// ═══════════════════════════════════════════════════ OPERATSIYA YOZISH
//
//  ★ MENEJER FAQAT BITTA YO'LNI YOZA OLADI: mijoz → O'ZI. Boshqa hamma
//  narsa (chiqim, qabul qilish, kassalar aro) kassirniki. Bu chegara
//  serverda: klient boshqa tomon yuborsa ham qabul qilinmaydi.
const SIDES = {
  account:  'cash_accounts', worker: 'workers',
  customer: 'customers',     supplier: 'suppliers',
};

async function assertSide(client, kind, id, req) {
  if (kind === 'expense') return;
  const tbl = SIDES[kind];
  if (!tbl) throw new Error('Noto\'g\'ri tomon: ' + kind);
  const { rowCount } = await client.query(
    `SELECT 1 FROM ${tbl} WHERE id = $1`, [id]);
  if (!rowCount) throw new Error('Tomon topilmadi');
  //  Mijoz menejerning yo'nalishida bo'lishi kerak — savdo chegarasi
  //  bu yerda ham ishlaydi.
  if (kind === 'customer') {
    const chans = channelsOf(req);
    if (chans) {
      const ok = await client.query(
        `SELECT 1 FROM customers WHERE id = $1 AND channel = ANY($2)`, [id, chans]);
      if (!ok.rowCount) throw new Error('Bu mijoz sizning yo\'nalishingizda emas');
    }
  }
}

router.post('/ops', need('cash.entry', 'cash.manage'), wrap(async (req, res) => {
  const b = req.body || {};
  const boss = isBoss(req);
  //  Menejerning yagona yo'li. `to_id` ham o'zi: boshqa xodimning
  //  podotchyotiga pul yozib qo'yib bo'lmaydi.
  const from_kind = boss ? b.from_kind : 'customer';
  const to_kind   = boss ? b.to_kind   : 'worker';
  const from_id   = Number(b.from_id) || null;
  const to_id     = boss ? (b.to_id == null ? null : Number(b.to_id)) : req.user.id;

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    if (!SIDES[from_kind]) throw new Error('«Qayerdan» tanlanmagan');
    if (to_kind !== 'expense' && !SIDES[to_kind]) throw new Error('«Qayerga» tanlanmagan');
    if (!from_id) throw new Error('«Qayerdan» tanlanmagan');
    if (to_kind !== 'expense' && !to_id) throw new Error('«Qayerga» tanlanmagan');
    if (from_kind === to_kind && from_id === to_id)
      throw new Error('Bir joyning o\'ziga ko\'chirib bo\'lmaydi');

    const currency = b.currency === 'USD' ? 'USD' : 'UZS';
    const amount = Number(b.amount);
    if (!(amount > 0)) throw new Error('Summa kiritilmagan');
    //  Kurs har operatsiyada: pulni kiritayotgan odam o'sha to'lovning
    //  kursini yozadi va u operatsiya bilan birga qotib qoladi.
    const rate = currency === 'USD' ? null : Number(b.rate);
    if (currency === 'UZS' && !(rate > 0)) throw new Error('Kurs kiritilmagan');

    //  ★ HARAJAT QAYSI OYNING FOYDA-ZARARIDA. To'lov bugun ketadi,
    //  harajat esa boshqa oyniki bo'lishi mumkin — shuning uchun
    //  so'raladi va bo'sh qoldirilmaydi.
    let pl_month = null, item_id = null;
    if (to_kind === 'expense') {
      item_id = Number(b.expense_item_id) || null;
      if (!item_id) throw new Error('Harajat moddasi tanlanmagan');
      const m = String(b.pl_month || '').slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(m))
        throw new Error('Foyda-zarar oyi tanlanmagan');
      pl_month = m + '-01';
    }

    await assertSide(client, from_kind, from_id, req);
    if (to_kind !== 'expense') await assertSide(client, to_kind, to_id, req);

    await client.query(`SELECT pg_advisory_xact_lock(hashtext('cash_doc_no'))`);
    const doc_no = await nextDocNo(client);
    const { rows } = await client.query(
      `INSERT INTO cash_ops (doc_no, op_date, from_kind, from_id, to_kind, to_id,
                             currency, amount, rate, pl_month, expense_item_id,
                             order_id, note, created_by)
       VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3, $4, $5, $6,
               $7, $8, $9, $10::date, $11, $12, $13, $14)
       RETURNING id, doc_no, amount_usd`,
      [doc_no, b.op_date || null, from_kind, from_id, to_kind, to_id,
       currency, amount, rate, pl_month, item_id,
       b.order_id || null, (b.note || '').trim() || null, req.user.id]);

    await audit(req, { module: 'cash', action: 'create', entity: 'cash_op',
                       entity_id: rows[0].id,
                       payload: { doc_no, from_kind, from_id, to_kind, to_id,
                                  currency, amount, rate } }, client);
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    return res.status(400).json({ error: e.message });
  } finally { client.release(); }
}));

// ────────────────────────────────────────────────────────── BEKOR QILISH
//
//  Operatsiya O'CHMAYDI — bekor qilinadi va tarixda qoladi. Qoldiqdan
//  chiqib ketadi, lekin «kim, qachon, nechani yozgan edi» ko'rinib
//  turadi: pulda o'chirilgan qator eng yomon narsa.
router.patch('/ops/:id', need(...MANAGE), wrap(async (req, res) => {
  const { rows } = await db.query(
    `UPDATE cash_ops SET status = 'cancelled'
      WHERE id = $1 AND status = 'ok' RETURNING doc_no`, [req.params.id]);
  if (!rows[0]) return res.status(400).json({ error: 'Operatsiya topilmadi yoki allaqachon bekor' });
  await audit(req, { module: 'cash', action: 'cancel', entity: 'cash_op',
                     entity_id: Number(req.params.id),
                     payload: { doc_no: rows[0].doc_no } });
  res.json({ ok: true });
}));

// ──────────────────────────────────────────────── BOSHLANG'ICH QOLDIQ
//
//  Tizim ishga tushgan kundagi pul. Bir martalik raqam: undan keyingi
//  hamma narsa operatsiyalardan chiqadi. Shusiz kassa birinchi
//  kundanoq minusda turardi — chiqim bor, kirimning boshi yo'q.
router.patch('/accounts/:id', need(...MANAGE), wrap(async (req, res) => {
  const b = req.body || {};
  const uzsOp = Number(b.opening_uzs) || 0;
  const rate = Number(b.opening_rate) || null;
  if (uzsOp && !(rate > 0))
    return res.status(400).json({ error: 'So\'m qoldig\'i uchun kurs kerak' });
  const { rows } = await db.query(
    `UPDATE cash_accounts
        SET opening_uzs = $2, opening_usd = $3, opening_rate = $4,
            opening_on  = $5::date
      WHERE id = $1 RETURNING code, name`,
    [req.params.id, uzsOp, Number(b.opening_usd) || 0, rate, b.opening_on || null]);
  if (!rows[0]) return res.status(404).json({ error: 'Kassa topilmadi' });
  await audit(req, { module: 'cash', action: 'opening', entity: 'cash_account',
                     entity_id: Number(req.params.id),
                     payload: { code: rows[0].code, ...b } });
  res.json({ ok: true });
}));

// ─────────────────────────────────────── HARAJAT: FOYDA-ZARAR KESIMIDA
router.get('/expenses', need(...READ), wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT * FROM v_expenses
      WHERE ($1::date IS NULL OR pl_month >= $1)
        AND ($2::date IS NULL OR pl_month <= $2)
      ORDER BY pl_month DESC, group_sort, group_name, item_name`,
    [req.query.from || null, req.query.to || null]);
  res.json({ rows });
}));

module.exports = router;
