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
  const [bolim, model, mahsulot] = await Promise.all([
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
                WHERE w.product_id = ppr.product_id AND w.section_id = ppr.section_id) AS dona,
              (SELECT COALESCE(SUM(amount), 0) FROM piece_work w
                WHERE w.product_id = ppr.product_id AND w.section_id = ppr.section_id) AS summa,
              (SELECT COUNT(*) FROM piece_work w
                WHERE w.product_id = ppr.product_id AND w.section_id = ppr.section_id
                  AND w.rate <> ppr.rate) AS boshqa_narx
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
  ]);
  res.json({ sections: bolim.rows, rates: model.rows, products: mahsulot.rows });
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
            WHERE product_id = $1 AND section_id = $2 AND rate <> $3 FOR UPDATE),
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

module.exports = router;
