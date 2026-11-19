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
const KO = ['payroll.view', 'payroll.manage', 'payroll.shop'];
const YOZ = 'payroll.manage';

//  ★ TSEX BOSHLIG'I — FAQAT O'Z ODAMLARI (zavod qarori, 2026-11;
//  `payroll.shop`). To'liq huquqi (view/manage) bor odamda chegara yo'q
//  (null). Qolganida — ROLNING tsexi (`scope_shop_main`), QO'SHIMCHA
//  TSEXLARSIZ (zavod qarori, 2026-11): qo'shimcha tsex boshliqqa u
//  yerdagi O'Z mahsulotini ko'rish uchun beriladi (stul lak tsexida),
//  o'sha tsexning xodimlari esa uniki emas. Va xodimning shtatdagi tsexi (`workers.shop_id`, bo'sh
//  bo'lsa bo'limining tsexi).
//  Doirasi yo'q bo'lsa BO'SH massiv: hech kim ko'rinmaydi — butun
//  zavodning oyligini ochib qo'yish yo'l emas. Chegara SERVERDA.
const tsexlar = (req) => {
  const p = req.user.permissions;
  if (p.includes('payroll.view') || p.includes('payroll.manage')) return null;
  return req.user.scope_shop_main || [];
};

const oy = (v) => {
  const m = String(v || '').slice(0, 7);
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(m) ? m + '-01' : null;
};
//  ★ SANADAN SANAGACHA (zavod qarori, 2026-11). Bitta to'liq oy
//  tanlansa (1-kundan oxirgi kungacha) — eskicha OY rejimi: to'landi
//  foyda-zarar oyi bo'yicha. Boshqa har qanday oraliq — KUNLIK rejim:
//  to'landi KASSADAN berilgan KUN bo'yicha (`op_date`), ishbay ish
//  bajarilgan kun bo'yicha, hisoblangan oylik esa o'z oyining 1-kuniga
//  yoziladi. Qoidasi bitta: boshiga + hisoblandi − to'landi = oxiriga.
const sana = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null;
function oraliq(q) {
  const d1 = sana(q.from), d2 = sana(q.to);
  if (d1 && d2 && d1 <= d2) {
    const oyBosh = d1.slice(0, 8) + '01';
    const oxir = new Date(Date.UTC(+d1.slice(0, 4), +d1.slice(5, 7), 0))
      .toISOString().slice(0, 10);
    if (d1 === oyBosh && d2 === oxir) return { lo: d1, hi: d1, kunlik: false, month: d1 };
    return { lo: d1, hi: d2, kunlik: true, month: null };
  }
  const m = oy(q.month) || bugungiOy();
  return { lo: m, hi: m, kunlik: false, month: m };
}
const bugungiOy = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
};

//  To'langan pulning OYI: foyda-zarar oyi, u bo'lmasa to'lov kuni
//  (oy rejimi). ★ ISHBAY hisoblanganga O'ZI qo'shiladi (izoh:
//  sql/cash.sql), dollarda, ish bajarilgan kun bo'yicha.
router.get('/', need(...KO), wrap(async (req, res) => {
  const or = oraliq(req.query);
  const sh = tsexlar(req);
  //  `month` ustuni — yozuvning SANASI: oy rejimida oyning 1-kuni,
  //  kunlik rejimda ishbay va to'lovning o'z kuni ($3).
  const { rows } = await db.query(`
    WITH h AS (
      SELECT worker_id, currency, amount, month, 1 AS ishora FROM payroll_accruals
      UNION ALL
      SELECT worker_id, 'USD', amount,
             CASE WHEN $3 THEN work_date ELSE date_trunc('month', work_date)::date END, 1
        FROM piece_work
      UNION ALL
      SELECT o.staff_id, o.currency, o.amount,
             CASE WHEN $3 THEN o.op_date
                  ELSE COALESCE(o.pl_month, date_trunc('month', o.op_date)::date) END, -1
        FROM cash_ops o WHERE o.status = 'ok' AND o.staff_id IS NOT NULL
    ), s AS (
      SELECT worker_id,
        SUM(amount * ishora) FILTER (WHERE month < $1 AND currency = 'UZS') AS open_uzs,
        SUM(amount * ishora) FILTER (WHERE month < $1 AND currency = 'USD') AS open_usd,
        SUM(amount) FILTER (WHERE month >= $1 AND ishora = 1 AND currency = 'UZS') AS acc_uzs,
        SUM(amount) FILTER (WHERE month >= $1 AND ishora = 1 AND currency = 'USD') AS acc_usd,
        SUM(amount) FILTER (WHERE month >= $1 AND ishora = -1 AND currency = 'UZS') AS paid_uzs,
        SUM(amount) FILTER (WHERE month >= $1 AND ishora = -1 AND currency = 'USD') AS paid_usd
        FROM h WHERE month <= $2 GROUP BY worker_id
    )
    SELECT w.id, w.name, w.position, w.staff_group, w.active,
           COALESCE(sc.name, w.dept) AS dept, sh.name AS shop,
           (COALESCE(s.open_uzs, 0) + w.pay_open_uzs)::numeric(18,2) AS open_uzs,
           (COALESCE(s.open_usd, 0) + w.pay_open_usd)::numeric(18,2) AS open_usd,
           w.pay_open_uzs, w.pay_open_usd, w.pay_open_on::text AS pay_open_on, w.pay_open_note,
           COALESCE(s.acc_uzs, 0)::numeric(18,2)  AS acc_uzs,
           COALESCE(s.acc_usd, 0)::numeric(18,2)  AS acc_usd,
           COALESCE(s.paid_uzs, 0)::numeric(18,2) AS paid_uzs,
           COALESCE(s.paid_usd, 0)::numeric(18,2) AS paid_usd,
           (SELECT COALESCE(SUM(p.amount), 0) FROM piece_work p
             WHERE p.worker_id = w.id
               AND CASE WHEN $3 THEN p.work_date
                        ELSE date_trunc('month', p.work_date)::date END
                   BETWEEN $1 AND $2)::numeric(18,2) AS piece_usd,
           (SELECT note FROM payroll_accruals a
             WHERE a.worker_id = w.id AND a.month BETWEEN $1 AND $2
             ORDER BY a.month DESC, a.currency DESC LIMIT 1) AS note
      FROM workers w
      LEFT JOIN s ON s.worker_id = w.id
      LEFT JOIN sections sc ON sc.id = w.section_id
      LEFT JOIN shops    sh ON sh.id = w.shop_id
     --  Ishdan ketgan xodim ham turadi, agar hisobi yopilmagan bo'lsa:
     --  unga qarzimiz qolgan va u jimgina ro'yxatdan tushib ketmasin.
     WHERE (w.active OR s.worker_id IS NOT NULL
            OR w.pay_open_uzs <> 0 OR w.pay_open_usd <> 0)
       AND ($4::int[] IS NULL OR COALESCE(w.shop_id, sc.shop_id) = ANY($4))
     ORDER BY sh.name NULLS LAST, w.name`, [or.lo, or.hi, or.kunlik, sh]);
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
  res.json({ month: or.month ? or.month.slice(0, 7) : null,
             from: or.kunlik ? or.lo : null, to: or.kunlik ? or.hi : null,
             rows: list, total,
             can_edit: req.user.permissions.includes(YOZ) });
}));

//  Bitta xodim, bitta oy: nima hisoblandi va QAYSI hujjat bilan
//  to'landi. «Men oldim-ku» degan savolga raqam emas, hujjat javob.
router.get('/worker/:id', need(...KO), wrap(async (req, res) => {
  const or = oraliq(req.query);
  const id = Number(req.params.id) || 0;
  const sh = tsexlar(req);
  if (sh && !(await db.query(`SELECT 1 FROM workers w LEFT JOIN sections sc ON sc.id = w.section_id
      WHERE w.id = $1 AND COALESCE(w.shop_id, sc.shop_id) = ANY($2)`,
    [id, sh])).rowCount)
    return res.status(403).json({ error: 'Bu xodim sizning tsexingizda emas' });
  const [acc, paid, piece] = await Promise.all([
    db.query(`SELECT to_char(month, 'YYYY-MM') AS month, currency, amount, note FROM payroll_accruals
               WHERE worker_id = $1 AND month BETWEEN $2 AND $3
               ORDER BY month, currency DESC`, [id, or.lo, or.hi]),
    db.query(`SELECT o.id, o.doc_no, o.op_date, o.currency, o.amount, o.note,
                     i.name AS item
                FROM cash_ops o
                LEFT JOIN expense_items i ON i.id = o.expense_item_id
               WHERE o.status = 'ok' AND o.staff_id = $1
                 AND CASE WHEN $4 THEN o.op_date
                          ELSE COALESCE(o.pl_month, date_trunc('month', o.op_date)::date) END
                     BETWEEN $2 AND $3
               ORDER BY o.op_date, o.id`, [id, or.lo, or.hi, or.kunlik]),
    //  Ishbay — bo'lim va mahsulot bo'yicha jamlab: oyiga yuzlab
    //  o'tkazish bo'ladi va har biri alohida qator o'qilmasdi.
    db.query(`SELECT s.name AS section, pr.name AS product, p.rate,
                     SUM(p.qty)::int AS qty, SUM(p.amount)::numeric(14,2) AS amount,
                     string_agg(DISTINCT p.conveyor_no, ', ') AS konverlar
                FROM piece_work p
                JOIN sections s ON s.id = p.section_id
                LEFT JOIN products pr ON pr.id = p.product_id
               WHERE p.worker_id = $1
                 AND CASE WHEN $4 THEN p.work_date
                          ELSE date_trunc('month', p.work_date)::date END BETWEEN $2 AND $3
               GROUP BY s.name, s.sort, pr.name, p.rate
               ORDER BY s.sort, pr.name`, [id, or.lo, or.hi, or.kunlik]),
  ]);
  res.json({ accruals: acc.rows, payments: paid.rows, piece: piece.rows });
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

//  ★ BOSHLANG'ICH QOLDIQ (izoh: sql/cash.sql). ISHORALI: musbat —
//  berilmagan oylik (korxona qarzdor), manfiy — xodimga berilgan qarz.
//  Bo'sh — «yo'q» (nol), «tegma» emas.
const sonmi = (v) => (v === '' || v == null ? 0 : Number(v));
async function boshlangich(c, req, wid, b) {
  const uzs = sonmi(b.uzs), usd = sonmi(b.usd);
  if (!Number.isFinite(uzs) || !Number.isFinite(usd))
    throw Object.assign(new Error('Summa noto\'g\'ri'), { status: 400 });
  const eski = (await c.query(`SELECT pay_open_uzs, pay_open_usd, pay_open_on
      FROM workers WHERE id = $1`, [wid])).rows[0];
  if (!eski) throw Object.assign(new Error('Xodim topilmadi'), { status: 400 });
  const on = b.on ? String(b.on).slice(0, 10) : null;
  if (on && !/^\d{4}-\d{2}-\d{2}$/.test(on))
    throw Object.assign(new Error('Sana noto\'g\'ri'), { status: 400 });
  await c.query(`UPDATE workers SET pay_open_uzs = $2, pay_open_usd = $3,
      pay_open_on = $4, pay_open_note = $5 WHERE id = $1`,
    [wid, uzs, usd, on, b.note ? String(b.note).trim() || null : null]);
  await audit(req, { module: 'payroll', action: 'opening', entity: 'worker', entity_id: wid,
    payload: { edi: eski, boldi: { uzs, usd, on } } }, c);
}

router.put('/opening', need(YOZ), wrap(async (req, res) => {
  const b = req.body || {};
  await boshlangich(db, req, Number(b.worker_id) || 0, b);
  res.json({ ok: true });
}));

//  ★ FAYLDAN (zavod qarori, 2026-11): oltmish odamni qo'lda terish
//  yarim kunlik ish. Ustunlar: F.I.SH · «Berilmagan so'm» ·
//  «Berilmagan $» · «Qarz so'm» · «Qarz $» · «Sana». Har valyutada
//  qoldiq = berilmagan − qarz. Ikkala katagi bo'sh valyutaga TEGILMAYDI.
//  Avval TEKSHIRIB ko'rsatiladi (`?save=1` siz), xato qator bo'lsa hech
//  narsa saqlanmaydi — boshqa importlar bilan bir xil yo'l.
const OFIELDS = {
  name:     ['fish', 'fio', 'ism', 'ismi', 'xodim', 'hodim', 'nomi', 'фио', 'сотрудник'],
  unp_uzs:  ['berilmagan', 'berilmagansom', 'berilmaganoylik', 'berilmaganoyliksom',
             'korxonaqarzi', 'korxonaqarzisom', 'haqdor', 'haqdorsom'],
  unp_usd:  ['berilmagandollar', 'berilmaganusd', 'berilmaganoylikdollar',
             'berilmaganoylikusd', 'korxonaqarzidollar', 'haqdordollar', 'haqdorusd'],
  debt_uzs: ['qarz', 'qarzsom', 'qarzi', 'qarzisom', 'xodimqarzi', 'xodimqarzisom',
             'qarzdor', 'qarzdorsom', 'avans', 'avanssom'],
  debt_usd: ['qarzdollar', 'qarzusd', 'qarzidollar', 'qarziusd', 'xodimqarzidollar',
             'qarzdordollar', 'qarzdorusd', 'avansdollar', 'avansusd'],
  on:       ['sana', 'qarzsanasi', 'дата'],
};
router.post('/opening/import', need(YOZ),
  express.raw({ type: '*/*', limit: '10mb' }),
  wrap(async (req, res) => {
    const { readSheet } = require('../xlsx');
    const H = require('./import').helpers;
    const buf = req.body;
    if (!buf || !buf.length) throw Object.assign(new Error('Fayl bo\'sh'), { status: 400 });
    let table;
    try { table = H.isXlsx(buf) ? readSheet(buf) : H.parseCsv(buf.toString('utf8')); }
    catch (e) { throw Object.assign(new Error('Faylni o\'qib bo\'lmadi: ' + e.message), { status: 400 }); }
    const hi = table.findIndex((r) => r.some((c) => String(c).trim()));
    if (hi < 0) throw Object.assign(new Error('Fayl bo\'sh'), { status: 400 });
    const map = {};
    table[hi].forEach((h, i) => {
      const n = H.norm(String(h ?? '').replace(/\$/g, 'dollar'));
      const f = Object.keys(OFIELDS).find((k) => OFIELDS[k].includes(n));
      if (f && map[f] == null) map[f] = i;
    });
    if (map.name == null)
      throw Object.assign(new Error('Xodim ismi ustuni topilmadi («F.I.SH»). Topilgan: ' +
        table[hi].filter(Boolean).join(', ')), { status: 400 });
    if (!['unp_uzs', 'unp_usd', 'debt_uzs', 'debt_usd'].some((k) => map[k] != null))
      throw Object.assign(new Error('Summa ustuni topilmadi: «Berilmagan so\'m», ' +
        '«Berilmagan $», «Qarz so\'m» yoki «Qarz $»'), { status: 400 });
    const ws = (await db.query(`SELECT id, name, pay_open_uzs, pay_open_usd FROM workers`)).rows;
    const byName = new Map(ws.map((w) => [H.norm(w.name), w]));
    const rows = [], seen = new Set();
    for (let i = hi + 1; i < table.length; i++) {
      const cells = table[i];
      if (!cells.some((c) => String(c).trim())) continue;
      const at = (f) => (map[f] == null ? '' : String(cells[map[f]] ?? '').trim());
      const errors = [];
      const name = at('name');
      const w = byName.get(H.norm(name));
      if (!name) errors.push('Ism bo\'sh');
      else if (!w) errors.push(`Xodim topilmadi: «${name}» — avval Xodimlar sahifasida kiriting`);
      else if (seen.has(w.id)) errors.push(`Faylda takrorlangan: «${name}»`);
      else seen.add(w.id);
      const it = { name, worker_id: w && w.id };
      for (const cur of ['uzs', 'usd']) {
        const a = at('unp_' + cur), d = at('debt_' + cur);
        if (!a && !d) continue;
        const na = a ? H.toNum(a) : 0, nd = d ? H.toNum(d) : 0;
        if (na === undefined || nd === undefined) errors.push(`Summa tushunarsiz: «${a || d}»`);
        else it[cur] = Math.round((Math.abs(na) - Math.abs(nd)) * 100) / 100;
      }
      const sana = at('on');
      if (sana) {
        const dt = H.toDate(sana);
        if (dt === undefined) errors.push(`Sana tushunarsiz: «${sana}»`); else it.on = dt;
      }
      rows.push({ line: i + 1, it, errors });
    }
    if (!rows.length) throw Object.assign(new Error('Faylda qator yo\'q'), { status: 400 });
    const bad = rows.filter((r) => r.errors.length);
    if (req.query.save !== '1')
      return res.json({ preview: true, total: rows.length, bad: bad.length, rows: rows.slice(0, 200) });
    if (bad.length)
      throw Object.assign(new Error(`${bad.length} ta qatorda xato bor — saqlanmadi`), { status: 400 });
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      for (const r of rows) {
        const w = ws.find((x) => x.id === r.it.worker_id);
        const cur = (await c.query(`SELECT pay_open_on::text AS on, pay_open_note
            FROM workers WHERE id = $1`, [w.id])).rows[0];
        await boshlangich(c, req, w.id, {
          uzs: r.it.uzs ?? w.pay_open_uzs, usd: r.it.usd ?? w.pay_open_usd,
          on: r.it.on || cur.on,
          note: cur.pay_open_note });
      }
      await c.query('COMMIT');
      res.json({ saved: rows.length });
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }));

module.exports = router;
