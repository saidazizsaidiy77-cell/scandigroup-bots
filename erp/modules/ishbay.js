// ═══════════════════════════════════════════ ISHBAY NARXLARI
//
//  ★ BO'LIM NARXI VA MODEL NARXI (zavod qarori, 2026-11; izoh:
//  sql/cash.sql, `product_piece_rates`). Bo'lim narxi umumiy qoida
//  (`sections.piece_rate`), model narxi undan USTUN: Onix stulning
//  Zborkasi 2 $, qolgan stullarniki 3,8 $. Ikkalasi ham saytdan
//  qo'yiladi — kodga model nomi yozilmaydi.
//
//  ★ ESKI YOZUVLAR. Narx yozuv bilan QOTADI (`piece_work.rate`) — ertaga
//  narx o'zgarsa kechagi ish qayta hisoblanmaydi. Lekin narx XATO
//  kiritilgan bo'lsa (oylik hali berilmagan) eski yozuvlarni ham
//  to'g'rilash kerak: «qayta hisoblash» belgisi bilan shu model + shu
//  bo'limning HAMMA yozuvi yangi narxga o'tadi. Hisoblandi ish haqi
//  sahifasida O'ZI o'zgaradi (u `piece_work.amount` dan o'qiydi);
//  to'langani kassada — unga tegilmaydi. Eski va yangi summa auditda.
const express = require('express');
const { db, wrap, audit } = require('../db');
const { need } = require('../auth');

const router = express.Router();
const HUQUQ = ['production.manage'];

const narx = (v) => (v === '' || v == null ? null : Number(v));

router.get('/', need(...HUQUQ), wrap(async (req, res) => {
  const [bolim, model, mahsulot, tsex, xodim] = await Promise.all([
    db.query(
      `SELECT s.id, s.name, sh.name AS shop, s.piece_rate
         FROM sections s JOIN shops sh ON sh.id = s.shop_id
        WHERE s.piece_rate IS NOT NULL
           OR EXISTS (SELECT 1 FROM product_piece_rates p WHERE p.section_id = s.id)
        ORDER BY sh.name, s.sort, s.name`),
    db.query(
      `SELECT ppr.product_id, ppr.section_id, ppr.rate,
              p.name AS product, p.size_label, g.name AS group_name,
              s.name AS section, s.piece_rate AS section_rate,
              (SELECT COALESCE(SUM(qty), 0) FROM piece_work w
                WHERE w.product_id = ppr.product_id AND w.section_id = ppr.section_id
                  AND w.kind = 'bolim') AS dona,
              (SELECT COALESCE(SUM(amount), 0) FROM piece_work w
                WHERE w.product_id = ppr.product_id AND w.section_id = ppr.section_id
                  AND w.kind = 'bolim') AS summa,
              (SELECT COUNT(*) FROM piece_work w
                WHERE w.product_id = ppr.product_id AND w.section_id = ppr.section_id
                  AND w.kind = 'bolim' AND w.rate <> ppr.rate) AS boshqa_narx
         FROM product_piece_rates ppr
         JOIN products p ON p.id = ppr.product_id
         JOIN product_groups g ON g.id = p.group_id
         JOIN sections s ON s.id = ppr.section_id
        ORDER BY p.name, s.name`),
    //  Faqat marshrutida narxi bor bo'lim turgan mahsulotlar —
    //  boshqasiga model narxi qo'yish ma'nosiz
    db.query(
      `SELECT DISTINCT p.id, p.name, p.size_label, g.name AS group_name
         FROM products p
         JOIN product_groups g ON g.id = p.group_id
         JOIN v_product_route r ON r.product_id = p.id
         JOIN sections s ON s.id = r.section_id
        WHERE p.active AND s.piece_rate IS NOT NULL
        ORDER BY p.name`),
    //  Tsex boshlig'i — T/M omborga kirgan har donadan (izoh: sql/cash.sql)
    db.query(
      `SELECT sh.id, sh.name, sh.head_worker_id, sh.head_piece_rate, w.name AS head_name,
              (SELECT COALESCE(SUM(p.amount), 0) FROM piece_work p
                WHERE p.kind = 'boshliq' AND p.worker_id = sh.head_worker_id
                  AND p.work_date >= date_trunc('month', CURRENT_DATE)) AS shu_oy
         FROM shops sh LEFT JOIN workers w ON w.id = sh.head_worker_id
        WHERE EXISTS (SELECT 1 FROM sections s WHERE s.shop_id = sh.id AND s.is_exit)
        ORDER BY sh.name`),
    db.query(`SELECT id, name, shop_id FROM workers WHERE active ORDER BY name`),
  ]);
  res.json({ sections: bolim.rows, rates: model.rows, products: mahsulot.rows,
             shops: tsex.rows, workers: xodim.rows });
}));

//  Bo'lim narxi — faqat BUNDAN KEYINGI yozuvlarga (qotish qoidasi)
router.put('/section/:id', need(...HUQUQ), wrap(async (req, res) => {
  const rate = narx(req.body.rate);
  if (rate != null && !(rate > 0)) return res.status(400).json({ error: "Narx noto'g'ri" });
  const old = (await db.query(`SELECT piece_rate FROM sections WHERE id = $1`,
    [req.params.id])).rows[0];
  if (!old) return res.status(404).json({ error: "Bo'lim topilmadi" });
  await db.query(`UPDATE sections SET piece_rate = $2 WHERE id = $1`, [req.params.id, rate]);
  await audit(req, { module: 'payroll', action: 'piece-rate', entity: 'section',
    entity_id: req.params.id, payload: { edi: old.piece_rate, boldi: rate } });
  res.json({ ok: true });
}));

//  Model narxi. Bo'sh narx — model narxi olib tashlanadi (bo'limniki
//  qaytadi). `qayta` — eski yozuvlar ham shu narxga o'tadi.
router.put('/product', need(...HUQUQ), wrap(async (req, res) => {
  const product_id = Number(req.body.product_id), section_id = Number(req.body.section_id);
  const rate = narx(req.body.rate);
  if (!product_id || !section_id) return res.status(400).json({ error: "Mahsulot va bo'lim tanlang" });
  if (rate != null && !(rate > 0)) return res.status(400).json({ error: "Narx noto'g'ri" });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const sec = (await client.query(`SELECT piece_rate FROM sections WHERE id = $1`,
      [section_id])).rows[0];
    if (!sec) throw Object.assign(new Error("Bo'lim topilmadi"), { status: 404 });
    const eski = (await client.query(
      `SELECT rate FROM product_piece_rates WHERE product_id = $1 AND section_id = $2`,
      [product_id, section_id])).rows[0];
    if (rate == null)
      await client.query(
        `DELETE FROM product_piece_rates WHERE product_id = $1 AND section_id = $2`,
        [product_id, section_id]);
    else
      await client.query(
        `INSERT INTO product_piece_rates (product_id, section_id, rate) VALUES ($1,$2,$3)
         ON CONFLICT (product_id, section_id) DO UPDATE SET rate = EXCLUDED.rate`,
        [product_id, section_id, rate]);
    let qayta = null;
    const yangi = rate ?? (sec.piece_rate == null ? null : Number(sec.piece_rate));
    if (req.body.qayta && yangi != null) {
      const { rows: [r] } = await client.query(
        `WITH o AS (
           SELECT id, amount FROM piece_work
            WHERE product_id = $1 AND section_id = $2 AND kind = 'bolim'
              AND rate <> $3 FOR UPDATE),
         u AS (
           UPDATE piece_work w SET rate = $3 FROM o WHERE w.id = o.id
           RETURNING w.amount)
         SELECT (SELECT COUNT(*) FROM o)::int AS n,
                (SELECT COALESCE(SUM(amount), 0) FROM o) AS edi,
                (SELECT COALESCE(SUM(amount), 0) FROM u) AS boldi`,
        [product_id, section_id, yangi]);
      qayta = { n: r.n, edi: Number(r.edi), boldi: Number(r.boldi) };
    }
    await audit(req, { module: 'payroll', action: 'piece-rate', entity: 'product',
      entity_id: product_id,
      payload: { section_id, edi: eski ? eski.rate : null, boldi: rate, qayta } }, client);
    await client.query('COMMIT');
    res.json({ ok: true, qayta });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.status) return res.status(e.status).json({ error: e.message });
    throw e;
  } finally { client.release(); }
}));

//  ★ TSEX BOSHLIG'I. Narx va xodim tsexda; bo'sh — «yo'q». `from` —
//  shu kundan beri T/M omborga QABUL qilingan, hali boshliq haqi
//  yozilmagan donalar ham yoziladi (oylik berilmagan bo'lsa).
//  Raqam bo'yicha: konver bo'linadi (qisman qabul, qisman chiqim) va
//  allaqachon yozilgan dona ayiriladi — ikki marta to'lanmaydi.
router.put('/shop/:id', need(...HUQUQ), wrap(async (req, res) => {
  const shop = Number(req.params.id);
  const wid = Number(req.body.head_worker_id) || null;
  const rate = narx(req.body.rate);
  if (rate != null && !(rate > 0)) return res.status(400).json({ error: "Narx noto'g'ri" });
  if ((rate == null) !== (wid == null))
    return res.status(400).json({ error: "Xodim ham, narx ham tanlanishi kerak (yoki ikkalasi ham bo'sh)" });
  const from = req.body.from ? String(req.body.from).slice(0, 10) : null;
  if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from))
    return res.status(400).json({ error: "Sana noto'g'ri" });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const eski = (await client.query(
      `SELECT head_worker_id, head_piece_rate FROM shops WHERE id = $1`, [shop])).rows[0];
    if (!eski) throw Object.assign(new Error('Tsex topilmadi'), { status: 404 });
    await client.query(
      `UPDATE shops SET head_worker_id = $2, head_piece_rate = $3 WHERE id = $1`,
      [shop, wid, rate]);
    let qayta = null;
    if (from && wid) {
      const { rows: [r] } = await client.query(
        `WITH qabul AS (
           SELECT u.conveyor_no, MIN(u.product_id) AS product_id,
                  MIN(u.current_section_id) AS section_id,
                  SUM(u.qty)::int AS qty, MIN(u.fg_on) AS kun
             FROM production_units u
             JOIN sections s ON s.id = u.current_section_id AND s.is_exit
            WHERE s.shop_id = $1 AND u.status IN ('fg', 'shipped')
              AND u.fg_by IS NOT NULL AND u.fg_on >= $2::date
              AND NOT EXISTS (SELECT 1 FROM cust_return_items i WHERE i.new_unit_id = u.id)
            GROUP BY u.conveyor_no),
         farq AS (
           SELECT q.*, q.qty - COALESCE((SELECT SUM(p.qty) FROM piece_work p
                     WHERE p.kind = 'boshliq' AND p.conveyor_no = q.conveyor_no), 0) AS qoldi
             FROM qabul q),
         ins AS (
           INSERT INTO piece_work (kind, conveyor_no, product_id, section_id, worker_id,
                                   qty, rate, work_date, created_by)
           SELECT 'boshliq', conveyor_no, product_id, section_id, $3, qoldi, $4, kun, $5
             FROM farq WHERE qoldi > 0
           RETURNING qty, amount)
         SELECT COUNT(*)::int AS n, COALESCE(SUM(qty), 0)::int AS dona,
                COALESCE(SUM(amount), 0) AS summa FROM ins`,
        [shop, from, wid, rate, req.user.id]);
      qayta = { n: r.n, dona: r.dona, summa: Number(r.summa) };
    }
    await audit(req, { module: 'payroll', action: 'piece-rate', entity: 'shop',
      entity_id: shop, payload: { edi: eski, boldi: { head_worker_id: wid, rate }, from, qayta } },
      client);
    await client.query('COMMIT');
    res.json({ ok: true, qayta });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.status) return res.status(e.status).json({ error: e.message });
    throw e;
  } finally { client.release(); }
}));

module.exports = router;
