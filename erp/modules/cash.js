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
//                  qo'lidagi puli ham unga ko'rinmaydi.
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
  const [accounts, groups, items, customers, suppliers, workers, payable,
         meniki, kurs] = await Promise.all([
    boss ? db.query(`SELECT id, code, name, kind FROM cash_accounts
                      WHERE is_active ORDER BY sort, name`) : { rows: [] },
    db.query(`SELECT code, name FROM expense_groups ORDER BY sort, name`),
    db.query(`SELECT id, group_code, name, needs_supplier FROM expense_items
               WHERE active ORDER BY sort, name`),
    db.query(`SELECT id, name, region FROM customers
               WHERE active AND ($1::text[] IS NULL OR channel = ANY($1))
               ORDER BY name`, [chans]),
    //  Ta'minotchi ro'yxati HAMMAGA: podotchyot olgan xodim ham
    //  ta'minotchiga to'lov qiladi (ombor mudiri bozorda naqd
    //  to'laydi) va uchinchi bosqichda uni tanlashi kerak. Ilgari
    //  ro'yxat faqat kassirga kelardi va xodimda bo'sh chiqardi.
    //  Bu SPRAVOCHNIK — qarz ham, to'lov ham unda yo'q.
    db.query(`SELECT id, name FROM suppliers WHERE active ORDER BY name`),
    //  Xodim ro'yxati — QO'LIDA KORXONA PULI BORLARI. Kassir uchun
    //  bu «kimdan pul olsam bo'ladi» degan savolning to'la javobi:
    //  qolgan xodimlar bu ro'yxatda turishi kerak emas, ular pul
    //  topshirmaydi. Qoldig'i ham birga keladi — kassir sanab olayotgan
    //  pulini ekrandagi raqam bilan solishtiradi.
    boss ? db.query(`SELECT c.id, c.name, c.uzs, c.usd, c.total_usd
                       FROM v_worker_cash c
                       JOIN workers w ON w.id = c.id
                      WHERE w.active AND (c.uzs <> 0 OR c.usd <> 0)
                      ORDER BY c.name`)
         : { rows: [] },
    //  Qo'liga pul BERILADIGAN xodimlar — belgisi bor bo'lganlari
    //  (izoh: sql/cash.sql). Yuqoridagi ro'yxat bilan ikki xil savol:
    //  u «kimdan pul olsam bo'ladi», bu «kimga berish mumkin».
    boss ? db.query(`SELECT id, name FROM workers
                      WHERE active AND can_hold_cash ORDER BY name`)
         : { rows: [] },
    //  ★ OXIRGI KURS. Zavod qoidasi o'zgarmaydi — kursni har
    //  operatsiyada odam yozadi — lekin uni har safar noldan terib
    //  o'tirish shart emas: oxirgi ishlatilgani katakda tayyor turadi
    //  va kerak bo'lsa ustidan yoziladi. Kurs kunda bir marta
    //  o'zgaradi, operatsiya esa kuniga o'nlab bo'ladi.
    //  O'zim haqimda: podotchyot olamanmi va qaysi guruhga sarflayman
    db.query(`SELECT w.can_hold_cash, g.group_code
                FROM workers w
                LEFT JOIN worker_expense_groups g ON g.worker_id = w.id
               WHERE w.id = $1`, [req.user.id]),
    db.query(`SELECT rate FROM cash_ops
               WHERE rate IS NOT NULL AND status = 'ok'
               ORDER BY op_date DESC, id DESC LIMIT 1`),
  ]);
  res.json({
    accounts: accounts.rows, groups: groups.rows, items: items.rows,
    customers: customers.rows, suppliers: suppliers.rows, workers: workers.rows,
    payable: payable.rows,
    //  O'ZIM: qo'limga pul beriladimi va qaysi guruhlarga sarflay
    //  olaman. Bo'sh ro'yxat — hamma guruh.
    my: { hold: !!(meniki.rows[0] || {}).can_hold_cash,
          groups: meniki.rows.map((r) => r.group_code).filter(Boolean) },
    rate: kurs.rows[0] ? Number(kurs.rows[0].rate) : null,
    me: { id: req.user.id, name: req.user.name }, boss,
  });
}));

// ────────────────────────────────────────────────────── KASSALAR RO'YXATI
//
//  Bo'limga kirilganda avval SHU ro'yxat chiqadi, kassa tanlangach uning
//  ichi ochiladi — omborlar bilan bir xil: zavodda ikkita pul joyi bor va
//  ular bir-biriga o'xshamaydi, qoldig'i ham alohida sanaladi.
//
//  Menejerda kassa yo'q: uning «joyi» — o'z qo'lidagi pul. Shuning uchun
//  unga bitta qator qaytadi va ro'yxat sahifasi to'g'ridan-to'g'ri
//  o'shanga o'tkazadi (bitta ombor qolganda ham shunday bo'ladi).
router.get('/list', need(...ANY), wrap(async (req, res) => {
  const boss = isBoss(req);
  const rows = boss ? (await db.query(
    `SELECT * FROM v_cash_balance WHERE is_active ORDER BY sort, name`)).rows : [];
  const me = (await db.query(
    `SELECT * FROM v_worker_cash WHERE id = $1`, [req.user.id])).rows[0]
    || { id: req.user.id, name: req.user.name, uzs: 0, usd: 0, total_usd: 0 };
  //  Xodimlarning qo'lidagi pul — kassaning yonidagi UCHINCHI joy:
  //  korxonaning puli, lekin kassada emas. Kassirga ro'yxat kerak,
  //  chunki boshlang'ich qoldiq aynan shu yerdan yoziladi.
  //
  //  Ro'yxatda qo'lida puli borlar VA belgisi bor xodimlar: birinchisi
  //  «kimdan pul olsam bo'ladi», ikkinchisi «kimga qoldiq yozishim
  //  kerak» degan savolning javobi. Zavodning yigirmata xodimini
  //  chiqarish ikkalasiga ham javob bermasdi.
  const workers = boss ? (await db.query(
    `SELECT c.*
       FROM v_worker_cash c
       JOIN workers w ON w.id = c.id
      WHERE w.active AND (w.can_hold_cash OR c.uzs <> 0 OR c.usd <> 0)
      ORDER BY c.total_usd DESC, c.name`)).rows : [];
  res.json({
    boss,
    workers: workers.map((w) => ({ ...w, href: `/kassa.html?a=w${w.id}` })),
    rows: rows.map((a) => ({ ...a, href: `/kassa.html?a=${encodeURIComponent(a.code)}` })),
    me: { ...me, href: '/kassa.html?a=me' },
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
//  Lenta bitta JOY haqida: kassa (`?a=MAIN`), xodimning o'z qo'li
//  (`?a=me`) yoki kassir ochgan xodimning qo'li (`?a=w12`). `dir` esa
//  o'sha joyga nisbatan yo'nalish — kirim unga kelgani, chiqim undan
//  ketgani. Shuning uchun bitta operatsiya ikki joyda ikki xil
//  ko'rinadi va bu to'g'ri: menejerdan kassaga o'tgan pul menejerda
//  chiqim, kassada kirim.
router.get('/ops', need(...ANY), wrap(async (req, res) => {
  const boss = isBoss(req);
  const kod = String(req.query.a || '').trim();
  let sideKind = null, sideId = null;
  const xodim = /^w[0-9]+$/.test(kod) ? Number(kod.slice(1)) : null;
  if (kod === 'me') { sideKind = 'worker'; sideId = req.user.id; }
  //  Boshqa xodimning qo'lidagi pul — kassirniki: u qancha pul
  //  kutayotganini bilishi kerak. Menejerga esa faqat o'ziniki.
  else if (xodim) {
    if (!boss) return res.status(403).json({ error: 'Ruxsat yo\'q' });
    sideKind = 'worker'; sideId = xodim;
  }
  else if (kod) {
    if (!boss) return res.status(403).json({ error: 'Ruxsat yo\'q' });
    const a = (await db.query(
      `SELECT id FROM cash_accounts WHERE code = $1`, [kod])).rows[0];
    if (!a) return res.status(404).json({ error: 'Kassa topilmadi' });
    sideKind = 'account'; sideId = a.id;
  } else if (!boss) { sideKind = 'worker'; sideId = req.user.id; }

  const dir = ['in', 'out'].includes(req.query.dir) ? req.query.dir : null;
  const { rows } = await db.query(
    `SELECT * FROM v_cash_ops
      WHERE ($1::text IS NULL
             OR (($6::text IS NULL OR $6 = 'out')
                 AND from_kind = $1 AND from_id = $2)
             OR (($6::text IS NULL OR $6 = 'in')
                 AND to_kind = $1 AND to_id = $2))
        AND ($3::date IS NULL OR op_date >= $3)
        AND ($4::date IS NULL OR op_date <= $4)
        AND ($5::text IS NULL OR doc_no ILIKE '%' || $5 || '%'
             OR from_name ILIKE '%' || $5 || '%' OR to_name ILIKE '%' || $5 || '%')
      ORDER BY op_date DESC, id DESC
      LIMIT 500`,
    [sideKind, sideId, req.query.from || null, req.query.to || null,
     req.query.q || null, dir]);
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
  //  ★ KASSIRSIZ XODIMNING IKKITA YO'LI BOR, boshqa hech nima:
  //
  //    1. savdo menejeri mijozdan pul oladi   mijoz → O'ZI
  //    2. podotchyot olgan xodim sarfini yozadi  O'ZI → harajat
  //
  //  Ikkalasida ham bir tomon MAJBURAN o'zi: boshqa xodimning qo'liga
  //  ham, kassaga ham yozib qo'yib bo'lmaydi. Klient boshqasini
  //  yuborsa e'tiborga olinmaydi — tekshiruv shu yerda.
  //  Sarf ikki xil bo'ladi va ikkalasi ham pulni xodimning qo'lidan
  //  chiqaradi: to'g'ridan-to'g'ri harajat va TA'MINOTCHIGA to'lov —
  //  ombor mudiri bozorda naqd to'laydi va o'sha odamning qarzi
  //  kamayishi kerak. Modda ikkalasida ham yoziladi, ya'ni harajat
  //  foyda-zarardan yo'qolmaydi.
  const sarf = !boss && (b.to_kind === 'expense' || b.to_kind === 'supplier');
  const from_kind = boss ? b.from_kind : (sarf ? 'worker' : 'customer');
  const to_kind   = boss ? b.to_kind   : (sarf ? b.to_kind : 'worker');
  const from_id   = boss ? (Number(b.from_id) || null)
                         : (sarf ? req.user.id : (Number(b.from_id) || null));
  const to_id     = boss ? (b.to_id == null ? null : Number(b.to_id))
                         : (sarf ? (b.to_kind === 'supplier'
                                    ? Number(b.to_id) || null : null)
                                 : req.user.id);

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
    //  ★ TA'MINOTCHIGA TO'LOVDA HAM MODDA. Pul ta'minotchining qarzidan
    //  ayriladi (tomon — `supplier`), lekin foyda-zararda o'z moddasida
    //  turishi kerak. Shuning uchun ikkalasi birga yoziladi.
    if (to_kind === 'supplier' && b.expense_item_id) {
      item_id = Number(b.expense_item_id) || null;
      const m = String(b.pl_month || '').slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(m)) throw new Error('Foyda-zarar oyi tanlanmagan');
      pl_month = m + '-01';
    }
    if (to_kind === 'expense') {
      item_id = Number(b.expense_item_id) || null;
      if (!item_id) throw new Error('Harajat moddasi tanlanmagan');
      const m = String(b.pl_month || '').slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(m))
        throw new Error('Foyda-zarar oyi tanlanmagan');
      pl_month = m + '-01';
    }

    //  ★ XODIM O'Z QO'LIDAGI PULDAN SARFLAYDI. Ikkita shart:
    //  qo'liga pul beriladigan xodim bo'lsin va modda unga ruxsat
    //  etilgan guruhdan bo'lsin (izoh: sql/cash.sql). Cheklov
    //  belgilanmagan bo'lsa — hamma guruh.
    if (sarf) {
      //  Ta'minotchiga to'lovda ham modda majburiy: xodim qaysi
      //  harajat guruhiga sarflay olishi shundan tekshiriladi va
      //  moddasiz to'lov foyda-zarardan yo'qolib ketardi.
      if (!item_id) throw new Error('Harajat moddasi tanlanmagan');
      const w = (await client.query(
        `SELECT can_hold_cash FROM workers WHERE id = $1 AND active`,
        [req.user.id])).rows[0];
      if (!w || !w.can_hold_cash)
        throw new Error('Sizga podotchyot berilmaydi — harajat yozib bo\'lmaydi');
      const ok = (await client.query(
        `SELECT 1 FROM expense_items i
          WHERE i.id = $1
            AND (NOT EXISTS (SELECT 1 FROM worker_expense_groups g
                              WHERE g.worker_id = $2)
                 OR EXISTS (SELECT 1 FROM worker_expense_groups g
                             WHERE g.worker_id = $2 AND g.group_code = i.group_code))`,
        [item_id, req.user.id])).rowCount;
      if (!ok) throw new Error('Bu harajat guruhi sizga ochilmagan');
    }

    await assertSide(client, from_kind, from_id, req);
    if (to_kind !== 'expense') await assertSide(client, to_kind, to_id, req);

    //  ★ PUL HAMMA XODIMGA BERILMAYDI. Kassadan xodimning qo'liga pul
    //  faqat belgisi qo'yilganlarga chiqadi (izoh: sql/cash.sql).
    //  Tekshiruv SERVERDA: tugmani yashirish himoya emas.
    //
    //  Faqat KASSADAN chiqqani tekshiriladi — menejer mijozdan olgan
    //  pul ham «xodimga» tushadi, lekin u berilgan pul emas, o'zi
    //  yig'ib olgani: unga belgi shart emas.
    if (to_kind === 'worker' && from_kind === 'account') {
      const ok = await client.query(
        `SELECT 1 FROM workers WHERE id = $1 AND active AND can_hold_cash`, [to_id]);
      if (!ok.rowCount)
        throw new Error('Bu xodimga pul berilmaydi — Xodimlar sahifasidan belgilang');
    }

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

//  ★ XODIM QO'LIDAGI BOSHLANG'ICH QOLDIQ.
//
//  Kassaniki bilan bitta yo'l, bitta qoida: bir martalik raqam,
//  operatsiya emas. Kassirniki — `cash.manage`: qo'lda qancha pul
//  borligini sanab olgan odam yozadi, xodimning o'zi emas.
router.patch('/workers/:id/opening', need(...MANAGE), wrap(async (req, res) => {
  const b = req.body || {};
  const uzsOp = Number(b.opening_uzs) || 0;
  const rate = Number(b.opening_rate) || null;
  if (uzsOp && !(rate > 0))
    return res.status(400).json({ error: 'So\'m qoldig\'i uchun kurs kerak' });
  const { rows } = await db.query(
    `UPDATE workers
        SET opening_uzs = $2, opening_usd = $3, opening_rate = $4,
            opening_on  = $5::date
      WHERE id = $1 AND active RETURNING name`,
    [req.params.id, uzsOp, Number(b.opening_usd) || 0, rate, b.opening_on || null]);
  if (!rows[0]) return res.status(404).json({ error: 'Xodim topilmadi' });
  await audit(req, { module: 'cash', action: 'opening', entity: 'worker',
                     entity_id: Number(req.params.id),
                     payload: { name: rows[0].name, ...b } });
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

// ═══════════════════════════════════════════════ FOYDA-ZARAR HISOBOTI
//
//  Oy bo'yicha tushum va harajat. Oraliq OY bilan beriladi (2026-01),
//  kun bilan emas: hisobot oylik va yarim oyning foydasi degan narsa
//  zavodda yo'q.
//
//  Qatorlar tayyor ko'rinishda emas, XOM holda qaytadi — sahifa ularni
//  oylar bo'yicha yoyadi. Server pivot qilsa har yangi ustun uchun
//  so'rov qayta yozilardi.
const oyQ = (v, def) => {
  const t = String(v || '').slice(0, 7);
  return /^\d{4}-\d{2}$/.test(t) ? t + '-01' : def;
};

router.get('/pl', need(...READ), wrap(async (req, res) => {
  const bugun = new Date();
  //  Sukut bo'yicha — joriy yil: direktor hisobotni «shu yil qanday»
  //  deb ochadi, oraliqni har safar terib o'tirmaydi.
  const from = oyQ(req.query.from, `${bugun.getFullYear()}-01-01`);
  const to   = oyQ(req.query.to,   `${bugun.getFullYear()}-12-01`);
  const { rows } = await db.query(
    `SELECT * FROM v_pl_month
      WHERE pl_month >= $1 AND pl_month <= $2
      ORDER BY kind DESC, group_sort, group_name, item_name`, [from, to]);
  res.json({ from: from.slice(0, 7), to: to.slice(0, 7), rows });
}));

// ═══════════════════════════════════════════════ PUL OQIMI HISOBOTI
//
//  Kirim, chiqim va ularning farqi — oy bo'yicha. Yonida BUGUNGI
//  qoldiq: kassalarda va xodimlarning qo'lida turgan pul. Oqim
//  o'sha qoldiqni hosil qiladi, shuning uchun ikkalasi bitta ekranda.
router.get('/flow', need(...READ), wrap(async (req, res) => {
  const bugun = new Date();
  const from = oyQ(req.query.from, `${bugun.getFullYear()}-01-01`);
  const to   = oyQ(req.query.to,   `${bugun.getFullYear()}-12-01`);
  const [rows, kassa, qol] = await Promise.all([
    db.query(
      `SELECT * FROM v_cash_month
        WHERE mon >= $1 AND mon <= $2
        ORDER BY mon, dir, group_sort NULLS FIRST, group_name, item_name`,
      [from, to]),
    db.query(`SELECT COALESCE(SUM(total_usd), 0)::numeric(16,2) AS usd
                FROM v_cash_balance`),
    db.query(`SELECT COALESCE(SUM(total_usd), 0)::numeric(16,2) AS usd
                FROM v_worker_cash`),
  ]);
  res.json({ from: from.slice(0, 7), to: to.slice(0, 7), rows: rows.rows,
             now: { accounts: kassa.rows[0].usd, workers: qol.rows[0].usd } });
}));

// ═══════════════════════ SOF AYLANMA KAPITAL (чистый оборотный капитал)
//
//  «Korxonada bugun nima bor va nimadan qarzmiz» — bitta ekranda,
//  oy bo'yicha emas, SANA HOLATIGA. Foyda-zarar «qancha ishladik»
//  degan savolga javob beradi, bu esa «qo'limizda nima qoldi»:
//  ikkalasi har xil narsa va bir-birini almashtirmaydi.
//
//  Ustun — OYNING 15-SANASI VA OXIRGI KUNI (zavod qarori). Oyiga
//  ikkita nuqta: oy o'rtasida va oy yopilganda. Kelajakdagi sana
//  ustun bo'lmaydi — u bugungi holatni boshqa kun deb yozib qo'yardi.
//
//  AKTIV — korxonaning puli va mol-mulki: tayyor mahsulot, kassa,
//  xodim qo'lidagi pul, mijozlarning qarzi va ta'minotchiga berilgan
//  avans. PASSIV — majburiyat: ta'minotchiga qarzimiz va mijozdan
//  olingan avans. Farqi — SOF AYLANMA KAPITAL.
const WC_SQL = `
WITH oy AS (
  SELECT generate_series(date_trunc('month', $1::date),
                         date_trunc('month', $2::date),
                         interval '1 month')::date AS m
), kunlar AS (
  SELECT (m + 14)::date AS on_date FROM oy
  UNION
  SELECT (m + interval '1 month' - interval '1 day')::date FROM oy
), d AS (
  SELECT on_date FROM kunlar WHERE on_date BETWEEN $1 AND $2
)
SELECT d.on_date, fg.som AS fg, wip.som AS wip, kas.som AS kassa, xod.som AS qolda,
       mij.qarz AS mijoz_qarz, mij.avans AS mijoz_avans,
       tam.qarz AS tamin_qarz, tam.avans AS tamin_avans
  FROM d
  --  TAYYOR MAHSULOT: o'sha kunda omborda TURGANI. Chiqib ketgan
  --  sanasi keyin bo'lsa o'sha kuni hali javonda edi.
  CROSS JOIN LATERAL (
    SELECT COALESCE(SUM(u.qty * COALESCE(u.unit_price, 0)), 0)::numeric(16,2) AS som
      FROM production_units u
     WHERE u.status <> 'cancelled' AND u.fg_on IS NOT NULL
       AND u.fg_on <= d.on_date
       AND (u.ship_on IS NULL OR u.ship_on > d.on_date)) fg
  --  ISHLAB CHIQARISHDA TURGANI — tugallanmagan ishlab chiqarish.
  --  Balansda u ham AYLANMA AKTIV: zaxira xom ashyodan tayyor
  --  mahsulotgacha uchta holatda turadi va o'rtadagisi ham korxonaniki.
  --  O'sha kunda: boshlangan, lekin hali omborga tushmagan.
  CROSS JOIN LATERAL (
    SELECT COALESCE(SUM(u.qty * COALESCE(u.unit_price, 0)), 0)::numeric(16,2) AS som
      FROM production_units u
     WHERE u.status <> 'cancelled' AND u.started_on <= d.on_date
       AND (u.fg_on IS NULL OR u.fg_on > d.on_date)) wip
  --  KASSA VA BANK: boshlang'ich qoldiq (sanasi kelgan bo'lsa) va
  --  o'sha kungacha bo'lgan harakat.
  CROSS JOIN LATERAL (
    SELECT (COALESCE((SELECT SUM(a.opening_usd + CASE WHEN a.opening_rate > 0
                        THEN ROUND(a.opening_uzs / a.opening_rate, 2) ELSE 0 END)
                        FROM cash_accounts a
                       WHERE a.is_active
                         AND (a.opening_on IS NULL OR a.opening_on <= d.on_date)), 0)
          + COALESCE((SELECT SUM(f.amount_usd) FROM v_cash_flow f
                       WHERE f.side_kind = 'account' AND f.op_date <= d.on_date), 0)
           )::numeric(16,2) AS som) kas
  --  XODIM QO'LIDAGI PUL ham AKTIV: u korxonaning puli, shunchaki
  --  javonda emas, odamning cho'ntagida.
  CROSS JOIN LATERAL (
    SELECT (COALESCE((SELECT SUM(w.opening_usd + CASE WHEN w.opening_rate > 0
                        THEN ROUND(w.opening_uzs / w.opening_rate, 2) ELSE 0 END)
                        FROM workers w
                       WHERE w.active
                         AND (w.opening_on IS NULL OR w.opening_on <= d.on_date)), 0)
          + COALESCE((SELECT SUM(f.amount_usd) FROM v_cash_flow f
                       WHERE f.side_kind = 'worker' AND f.op_date <= d.on_date), 0)
           )::numeric(16,2) AS som) xod
  --  MIJOZLAR: saldo HAR MIJOZ bo'yicha alohida sanaladi va keyin
  --  tomonga ajratiladi. Ishoralar qisqartirilmaydi — biri 1000
  --  qarzdor, boshqasi 1000 avans bo'lsa ikkalasi ham ko'rinishi
  --  kerak: biri aktiv, ikkinchisi passiv.
  CROSS JOIN LATERAL (
    SELECT COALESCE(SUM(GREATEST(x.s, 0)), 0)::numeric(16,2)  AS qarz,
           COALESCE(SUM(GREATEST(-x.s, 0)), 0)::numeric(16,2) AS avans
      FROM (SELECT SUM(l.debit - l.credit) AS s FROM v_customer_ledger l
             WHERE l.on_date <= d.on_date GROUP BY l.customer_id) x) mij
  --  TA'MINOTCHILAR: tomoni teskari — kredit − debet (izoh:
  --  modules/purchasing.js).
  CROSS JOIN LATERAL (
    SELECT COALESCE(SUM(GREATEST(x.s, 0)), 0)::numeric(16,2)  AS qarz,
           COALESCE(SUM(GREATEST(-x.s, 0)), 0)::numeric(16,2) AS avans
      FROM (SELECT SUM(l.credit - l.debit) AS s FROM v_supplier_ledger l
             WHERE l.on_date <= d.on_date GROUP BY l.supplier_id) x) tam
 ORDER BY d.on_date`;

//  ISHLAB CHIQARISHNING TSEX KESIMI. Konver o'sha kunda QAYSI tsexda
//  turganini tarixdan o'qiymiz (`unit_moves`), hozirgi joyidan emas —
//  aks holda avgust ustuni bugungi joylashuvni avgust deb yozib
//  qo'yardi. Hech qayerga ko'chmagan konverda esa harakat yo'q va
//  turgan joyi o'zgarmagan, shuning uchun kartochkasidagi bo'lim
//  olinadi.
const WIP_SHOP_SQL = `
WITH oy AS (
  SELECT generate_series(date_trunc('month', $1::date),
                         date_trunc('month', $2::date),
                         interval '1 month')::date AS m
), kunlar AS (
  SELECT (m + 14)::date AS on_date FROM oy
  UNION
  SELECT (m + interval '1 month' - interval '1 day')::date FROM oy
), d AS (
  SELECT on_date FROM kunlar WHERE on_date BETWEEN $1 AND $2
)
SELECT d.on_date,
       COALESCE(sh.name, 'Bo''limsiz') AS shop,
       SUM(u.qty * COALESCE(u.unit_price, 0))::numeric(16,2) AS som,
       SUM(u.qty)::int AS qty
  FROM d
  JOIN production_units u
    ON u.status <> 'cancelled' AND u.started_on <= d.on_date
   AND (u.fg_on IS NULL OR u.fg_on > d.on_date)
  LEFT JOIN LATERAL (
    SELECT m.section_id FROM unit_moves m
     WHERE m.unit_id = u.id AND m.moved_on <= d.on_date
     ORDER BY m.moved_at DESC LIMIT 1) mv ON true
  LEFT JOIN sections s ON s.id = COALESCE(mv.section_id, u.current_section_id)
  LEFT JOIN shops sh   ON sh.id = s.shop_id
 GROUP BY d.on_date, COALESCE(sh.name, 'Bo''limsiz')
HAVING SUM(u.qty) > 0
 ORDER BY d.on_date, 2`;

router.get('/working-capital', need(...READ), wrap(async (req, res) => {
  //  Oraliq berilmasa: shu yilning boshidan bugungacha.
  const bugun = new Date();
  const iso = (x) => x.toISOString().slice(0, 10);
  const ok = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null);
  const to = ok(req.query.to) || iso(bugun);
  const from = ok(req.query.from)
    || iso(new Date(Date.UTC(bugun.getUTCFullYear(), 0, 1)));
  const [a, b] = from <= to ? [from, to] : [to, from];

  const [asos, tsex] = await Promise.all([
    db.query(WC_SQL, [a, b]),
    db.query(WIP_SHOP_SQL, [a, b]),
  ]);
  const rows = asos.rows;
  //  Xom ashyo ombori HALI YO'Q: qatori turadi, lekin nol. Qator
  //  umuman chizilmasa hisobot to'la ko'rinardi, holbuki bitta
  //  aktivi yetishmaydi — bo'sh qator savol, yo'q qator esa yolg'on.
  const jadval = rows.map((r) => {
    const aktiv = ['fg', 'wip', 'kassa', 'qolda', 'mijoz_qarz', 'tamin_avans']
      .reduce((n, k) => n + Number(r[k] || 0), 0);
    const passiv = ['tamin_qarz', 'mijoz_avans']
      .reduce((n, k) => n + Number(r[k] || 0), 0);
    return { ...r, xom: 0, aktiv: +aktiv.toFixed(2), passiv: +passiv.toFixed(2),
             sof: +(aktiv - passiv).toFixed(2) };
  });
  res.json({ from: a, to: b, rows: jadval, wip_shops: tsex.rows });
}));

module.exports = router;
