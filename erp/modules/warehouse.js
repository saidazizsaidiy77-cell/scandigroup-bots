// ============================================================================
//  OMBOR MODULI — omborlar ro'yxati va T/M ombor qoldig'i
//
//  Zavodda bitta emas, bir nechta ombor bor: tayyor mahsulot, xom ashyo,
//  listlar, furnitura, vitrina. Shuning uchun modulga kirilganda avval
//  OMBORLAR ro'yxati chiqadi, ombor tanlangach uning qoldig'i ochiladi.
//
//  Bu yerda faqat ro'yxat va JAMLANMA qoldiq. Konverning o'zi bilan
//  bo'ladigan ish — qabul qilish, qaytarish, kirim/chiqim tarixi —
//  `modules/units.js` da: u yerda konver holati o'zgaradi, bu yerda esa
//  faqat o'qiladi.
//
//  Huquq: ko'rish — warehouse.view (ombor mudiri), production.view
//  (ishlab chiqarish boshlig'i va direktor ham qoldiqni ko'radi).
// ============================================================================
const express = require('express');
const { db, wrap } = require('../db');
const { need } = require('../auth');

const router = express.Router();
const READ = ['warehouse.view', 'production.view'];

// ──────────────────────────────────────────────────────── OMBORLAR RO'YXATI
//
//  Har ombor yonida qoldig'i turadi — mudir ro'yxatdan o'tayotganda
//  qaysi biriga kirish kerakligini shundan ko'radi. Hozircha faqat
//  tayyor mahsulot ombori sanaladi; `material` omborlar ochilganda
//  o'sha yerda o'z hisobi qo'shiladi.
router.get('/list', need(...READ), wrap(async (_req, res) => {
  const [houses, fg] = await Promise.all([
    db.query(`SELECT w.id, w.code, w.name, w.kind, w.note, w.is_active, s.name AS shop_name
                FROM warehouses w
                LEFT JOIN shops s ON s.id = w.shop_id
               ORDER BY w.is_active DESC, w.sort, w.name`),
    db.query(`SELECT COUNT(*)::int AS units, COALESCE(SUM(qty), 0)::int AS qty,
                     COALESCE(SUM(total_amount), 0) AS amount
                FROM v_fg_units`),
  ]);
  const totals = fg.rows[0];
  res.json({
    rows: houses.rows.map((w) => ({
      ...w,
      href: w.kind === 'fg' && w.is_active ? '/ombor.html' : null,
      units: w.kind === 'fg' && w.is_active ? totals.units : null,
      qty: w.kind === 'fg' && w.is_active ? totals.qty : null,
      amount: w.kind === 'fg' && w.is_active ? totals.amount : null,
    })),
  });
}));

// ─────────────────────────────────────────── T/M OMBOR QOLDIG'I — JAMLANMA
//
//  Mudirning birinchi savoli «nimadan nechta bor»: mahsulot turi, rangi,
//  matosi bo'yicha bitta jadval. Konver raqamlari ostida — qatorni
//  ochganda chiqadi (/fg/units), chunki shikoyat kelganda javob aynan
//  raqamdan topiladi.
//
//  SANA ORALIG'I — omborga QABUL QILINGAN kun bo'yicha (fg_on), ya'ni
//  «shu oraliqda omborga kirgan va hozir ham turganlari». Bu konverlar
//  ro'yxatidagi filtr bilan bir xil, shunda ikki jadval bir-biriga
//  qarama-qarshi javob bermaydi.
const FROM_TO = `($1::date IS NULL OR fg_on >= $1)
             AND ($2::date IS NULL OR fg_on <= $2)`;

// Rang va mato bo'sh bo'lishi mumkin. Guruhlashda bo'sh satr va NULL
// bitta qatorga tushsin: aks holda bitta mahsulot ikki qator bo'lib
// ko'rinadi va «nechta qoldi» degan savolga ikki xil javob chiqadi.
const NORM = (col) => `NULLIF(TRIM(COALESCE(${col}, '')), '')`;

router.get('/fg/summary', need(...READ), wrap(async (req, res) => {
  const params = [req.query.from || null, req.query.to || null, req.query.q || null];
  const search = `($3::text IS NULL OR product ILIKE '%' || $3 || '%'
                   OR product_type ILIKE '%' || $3 || '%'
                   OR color ILIKE '%' || $3 || '%'
                   OR fabric ILIKE '%' || $3 || '%'
                   OR conveyor_no ILIKE '%' || $3 || '%')`;

  const [rows, total] = await Promise.all([
    db.query(
      `SELECT product_type, product_id, product, sku,
              ${NORM('color')}  AS color,
              ${NORM('fabric')} AS fabric,
              COUNT(*)::int          AS units,
              COALESCE(SUM(qty), 0)::int AS qty,
              COALESCE(SUM(total_amount), 0) AS amount,
              MIN(fg_on) AS first_on,
              MAX(days_in_stock)::int AS oldest_days
         FROM v_fg_units
        WHERE ${FROM_TO} AND ${search}
        GROUP BY product_type, product_id, product, sku, ${NORM('color')}, ${NORM('fabric')}
        ORDER BY product_type, product, color NULLS FIRST, fabric NULLS FIRST`,
      params),
    db.query(
      `SELECT COUNT(*)::int AS units, COALESCE(SUM(qty), 0)::int AS qty,
              COALESCE(SUM(total_amount), 0) AS amount
         FROM v_fg_units WHERE ${FROM_TO} AND ${search}`, params),
  ]);
  res.json({ rows: rows.rows, total: total.rows[0] });
}));

// Jamlanma qatorini ochish: aynan shu mahsulot + rang + mato bo'yicha
// qaysi konverlar turganini ko'rsatadi.
router.get('/fg/units', need(...READ), wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, conveyor_no, order_no, qty, fg_on, days_in_stock,
            customer_name, is_stock, total_amount
       FROM v_fg_units
      WHERE product_id = $3
        AND ${NORM('color')}  IS NOT DISTINCT FROM $4
        AND ${NORM('fabric')} IS NOT DISTINCT FROM $5
        AND ${FROM_TO}
      ORDER BY fg_on, conveyor_no
      LIMIT 500`,
    [req.query.from || null, req.query.to || null, req.query.product_id,
     req.query.color || null, req.query.fabric || null]);
  res.json({ rows });
}));

module.exports = router;
