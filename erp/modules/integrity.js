// ============================================================================
//  TIZIM TEKSHIRUVI — HUJJAT, QOLDIQ VA QARZ BIR XIL RAQAMNI AYTADIMI
//
//  ★ ZAVOD QARORI (2026-10). Z26-0849 da yuk xatida 10 ta stul turardi,
//  mijozning qarzida esa 8 tasi: bron konverning eski qatorida qolib,
//  qolgan donadan ko'p bo'lib ketgan edi va chiqarish uni sezmadi.
//  Xato faqat mijoz bilan solishtirishda bilindi. Qoida esa faqat
//  stulga emas, BUTUN tizimga tegishli: yuk xati, kirim, talabnoma,
//  omborlar aro hujjat — har hujjat qoldiq va qarz bilan BIR XIL
//  raqamni aytishi shart.
//
//  Shuning uchun har soha uchun bitta savol, hammasi BITTA ro'yxatda.
//  Tekshiruv faqat O'QIYDI: hech narsani tuzatmaydi — qaysi hujjat
//  to'g'ri ekanini tizim taxmin qilmaydi (`sotilgan-narx` bilan bir
//  xil qoida). Har xatoning yonida tuzatish yo'li yoziladi.
//
//  Ikki eshik:
//    GET /api/integrity        — administrator (`sales.fix`), saytdan
//    GET /api/integrity/diag   — `X-Diag-Token` = ERP_DIAG_TOKEN,
//                                sessiyasiz; kalit qo'yilmagan bo'lsa
//                                UMUMAN yopiq (404)
//
//  Javobda mijoz va xodim ISMI yo'q (4-qoida): hujjat raqami, konver
//  raqami, mahsulot va son — xatoni topish uchun shu yetarli.
// ============================================================================
const express = require('express');
const crypto = require('crypto');
const { db, wrap } = require('../db');
const { need } = require('../auth');

const router = express.Router();

const CHEGARA = 200;

const TEKSHIRUVLAR = [
  // ── SAVDO: bron va yuk xati ─────────────────────────────────────────
  {
    key: 'bron_konverdan_kop', soha: 'Savdo',
    title: "Konverga undagi donadan ko'p bron ilingan",
    fix: "Buyurtmani oching → «Konver» → shu konverni qaytaring va mavjud konverga qaytadan biriktiring",
    sql: `SELECT u.conveyor_no, p.name || ' · ' || g.name AS mahsulot,
                 u.status, u.qty AS konverda, b.jami AS bron,
                 (SELECT string_agg(o.order_no || ':' || r.qty, ', ' ORDER BY o.order_no)
                    FROM unit_reservations r
                    JOIN order_items i ON i.id = r.order_item_id
                    JOIN orders o      ON o.id = i.order_id
                   WHERE r.unit_id = u.id) AS buyurtmalar
            FROM (SELECT unit_id, SUM(qty)::int AS jami FROM unit_reservations
                   GROUP BY unit_id) b
            JOIN production_units u ON u.id = b.unit_id
            JOIN products p         ON p.id = u.product_id
            JOIN product_groups g   ON g.id = p.group_id
           WHERE b.jami > u.qty
           ORDER BY u.conveyor_no`,
  },
  {
    key: 'bron_tirik_emas', soha: 'Savdo',
    title: 'Chiqib ketgan yoki bekor qilingan konverda bron qolgan',
    fix: "Buyurtmani oching → «Konver» → bronni qaytaring",
    sql: `SELECT u.conveyor_no, u.status, o.order_no, r.qty AS bron
            FROM unit_reservations r
            JOIN production_units u ON u.id = r.unit_id
            JOIN order_items i      ON i.id = r.order_item_id
            JOIN orders o           ON o.id = i.order_id
           WHERE u.status IN ('shipped', 'cancelled')
           ORDER BY o.order_no`,
  },
  {
    key: 'bron_qatordan_kop', soha: 'Savdo',
    title: "Qatorga so'ralganidan ko'p konver biriktirilgan",
    fix: "Buyurtmani oching → ortiqcha konverni qaytaring",
    sql: `SELECT o.order_no, o.status, p.name || ' · ' || g.name AS mahsulot,
                 i.qty AS soralgan, SUM(r.qty)::int AS biriktirilgan
            FROM unit_reservations r
            JOIN order_items i      ON i.id = r.order_item_id
            JOIN orders o           ON o.id = i.order_id
            JOIN products p         ON p.id = i.product_id
            JOIN product_groups g   ON g.id = p.group_id
            JOIN production_units u ON u.id = r.unit_id
           WHERE u.status <> 'cancelled' AND o.status <> 'cancelled'
           GROUP BY o.order_no, o.status, p.name, g.name, i.id, i.qty
          HAVING SUM(r.qty) > i.qty
           ORDER BY o.order_no`,
  },
  {
    key: 'yukxati_dona', soha: 'Savdo',
    title: "Chiqib ketgan buyurtma: yuk xatidagi dona ≠ chiqqan konverlar",
    fix: "Kam chiqqan: konver pasportida «+ hujjat» yoki konver oynasida «Chiqarish». Ko'p chiqqan: ortiqcha konverni tekshiring",
    sql: `WITH qator AS (
            SELECT o.order_no, i.product_id, SUM(i.qty)::int AS qty
              FROM orders o JOIN order_items i ON i.order_id = o.id
             WHERE o.status = 'shipped'
             GROUP BY o.order_no, i.product_id
          ), chiqdi AS (
            SELECT order_no, product_id, SUM(qty)::int AS qty
              FROM production_units
             WHERE status = 'shipped' AND order_no IS NOT NULL
             GROUP BY order_no, product_id
          )
          SELECT COALESCE(q.order_no, c.order_no) AS order_no,
                 p.name || ' · ' || g.name AS mahsulot,
                 COALESCE(q.qty, 0) AS yuk_xatida, COALESCE(c.qty, 0) AS chiqdi
            FROM qator q
            FULL JOIN chiqdi c ON c.order_no = q.order_no AND c.product_id = q.product_id
            JOIN products p       ON p.id = COALESCE(q.product_id, c.product_id)
            JOIN product_groups g ON g.id = p.group_id
           WHERE COALESCE(q.qty, 0) <> COALESCE(c.qty, 0)
             AND COALESCE(q.order_no, c.order_no) IN (SELECT order_no FROM orders
                                                       WHERE status = 'shipped')
           ORDER BY 1`,
  },
  {
    key: 'yukxati_summa', soha: 'Savdo',
    title: "Chiqib ketgan buyurtma: yuk xati summasi ≠ mijoz qarziga yozilgani",
    fix: "Administrator buyurtmani ochib qator narxini tuzatadi — narx konverga ham ko'chadi",
    sql: `WITH qator AS (
            SELECT o.order_no, SUM(i.qty * COALESCE(i.unit_price, 0))::numeric(16,2) AS summa
              FROM orders o JOIN order_items i ON i.order_id = o.id
             WHERE o.status = 'shipped'
             GROUP BY o.order_no
          ), qarz AS (
            SELECT order_no, SUM(COALESCE(total_amount, 0))::numeric(16,2) AS summa
              FROM production_units
             WHERE status = 'shipped' AND order_no IS NOT NULL
             GROUP BY order_no
          )
          SELECT q.order_no, q.summa AS yuk_xatida, COALESCE(z.summa, 0) AS qarzda,
                 (COALESCE(z.summa, 0) - q.summa)::numeric(16,2) AS farq
            FROM qator q LEFT JOIN qarz z ON z.order_no = q.order_no
           WHERE ABS(COALESCE(z.summa, 0) - q.summa) >= 0.01
           ORDER BY q.order_no`,
  },
  {
    key: 'chiqqan_egasiz', soha: 'Savdo',
    title: "Chiqib ketgan konverning mijozi yoki hujjati yo'q",
    fix: "Konver pasportida «+ hujjat» (biriktirish) yoki «↩ omborga»",
    sql: `SELECT u.conveyor_no, p.name || ' · ' || g.name AS mahsulot, u.qty,
                 u.ship_on, u.order_no,
                 (u.customer_id IS NULL) AS mijozsiz
            FROM production_units u
            JOIN products p       ON p.id = u.product_id
            JOIN product_groups g ON g.id = p.group_id
           WHERE u.status = 'shipped' AND (u.customer_id IS NULL OR u.order_no IS NULL)
           ORDER BY u.ship_on DESC NULLS LAST`,
  },
  {
    key: 'chiqqan_narxsiz', soha: 'Savdo',
    title: "Chiqib ketgan konverda narx yo'q — mijoz qarziga nol bo'lib tushgan",
    fix: "Administrator buyurtma qatoriga narx yozadi — u konverga ko'chadi",
    sql: `SELECT u.conveyor_no, u.order_no, p.name || ' · ' || g.name AS mahsulot,
                 u.qty, u.ship_on
            FROM production_units u
            JOIN products p       ON p.id = u.product_id
            JOIN product_groups g ON g.id = p.group_id
           WHERE u.status = 'shipped' AND u.customer_id IS NOT NULL
             AND COALESCE(u.unit_price, 0) = 0
           ORDER BY u.ship_on DESC NULLS LAST`,
  },
  {
    key: 'mijoz_ozgacha', soha: 'Savdo',
    title: "Chiqqan konverning mijozi buyurtmanikidan boshqa",
    fix: "Administrator buyurtmada mijozni qayta saqlaydi — konverlar ko'chadi",
    sql: `SELECT u.conveyor_no, u.order_no, u.customer_id AS konverda,
                 o.customer_id AS buyurtmada
            FROM production_units u
            JOIN orders o ON o.order_no = u.order_no
           WHERE u.status = 'shipped' AND u.customer_id IS DISTINCT FROM o.customer_id
           ORDER BY u.order_no`,
  },

  {
    key: 'chiqqan_buyurtma_ochiq', soha: 'Savdo',
    title: "Konver chiqib ketgan, buyurtmasi esa chiqmagan — qarz bor, yuk xati yo'q",
    fix: "Konver pasportida «+ hujjat» (mahsulot boshqa buyurtma bilan chiqqan), «↩ omborga» (mahsulot javonda) yoki buyurtmani chiqarish",
    sql: `SELECT u.conveyor_no, u.order_no, u.qty, u.ship_on, o.status AS buyurtma
            FROM production_units u
            JOIN orders o ON o.order_no = u.order_no
           WHERE u.status = 'shipped' AND o.status <> 'shipped'
           ORDER BY u.ship_on`,
  },

  // ── ISHLAB CHIQARISH VA T/M OMBOR ───────────────────────────────────
  {
    key: 'konver_soni', soha: 'Ombor',
    title: "Konver qatorida soni nol yoki manfiy",
    fix: "Jurnalda konverni oching — sonini to'g'rilang yoki bekor qiling",
    sql: `SELECT conveyor_no, part, status, qty FROM production_units
           WHERE qty <= 0 AND status <> 'cancelled' ORDER BY conveyor_no`,
  },
  {
    key: 'fg_stock', soha: 'Ombor',
    title: "T/M ombor jamlanma qoldig'i konverlardan farq qiladi",
    fix: "Tizim o'zi tuzatadi: shu mahsulotning istalgan konverini qabul qilish yoki sanoq qayta hisoblaydi",
    sql: `WITH k AS (SELECT product_id, SUM(qty)::int AS qty FROM production_units
                      WHERE status = 'fg' GROUP BY product_id)
          SELECT p.name || ' · ' || g.name AS mahsulot,
                 COALESCE(s.qty, 0) AS jamlanmada, COALESCE(k.qty, 0) AS konverlarda
            FROM k FULL JOIN fg_stock s ON s.product_id = k.product_id
            JOIN products p       ON p.id = COALESCE(k.product_id, s.product_id)
            JOIN product_groups g ON g.id = p.group_id
           WHERE COALESCE(s.qty, 0) <> COALESCE(k.qty, 0)
           ORDER BY 1`,
  },
  {
    key: 'raqam_takror', soha: 'Ombor',
    title: "Bitta konver raqami ikki xil mahsulotda",
    fix: "Jurnalda konver raqami yoki mahsulotini to'g'rilang",
    sql: `SELECT conveyor_no, COUNT(DISTINCT product_id)::int AS mahsulotlar
            FROM production_units WHERE status <> 'cancelled'
           GROUP BY conveyor_no HAVING COUNT(DISTINCT product_id) > 1
           ORDER BY conveyor_no`,
  },

  // ── MATRAS KIRIMI ───────────────────────────────────────────────────
  {
    key: 'fg_kirim_konversiz', soha: "Ta'minot",
    title: "Tayyor mahsulot kirim hujjati bor, konverlari yo'q yoki bekor",
    fix: "Hujjatni bekor qiling yoki qaytadan yozing",
    sql: `SELECT r.doc_no, r.doc_on,
                 COUNT(u.id) FILTER (WHERE u.status <> 'cancelled')::int AS tirik_konver
            FROM fg_receipts r
            LEFT JOIN production_units u ON u.fg_receipt_id = r.id
           WHERE r.status = 'ok'
           GROUP BY r.id, r.doc_no, r.doc_on
          HAVING COUNT(u.id) FILTER (WHERE u.status <> 'cancelled') = 0
           ORDER BY r.doc_on`,
  },
  {
    key: 'fg_kirim_bolak', soha: "Ta'minot",
    title: "Kirim hujjatli konverning bo'lagi hujjatdan tushib qolgan",
    fix: "Migratsiya tiklaydi (matras-bolak-kirim); qolgan bo'lsa xabar bering",
    sql: `SELECT u.conveyor_no, u.part, u.status, u.qty, r.doc_no
            FROM production_units u
            JOIN LATERAL (SELECT x.fg_receipt_id FROM production_units x
                           WHERE x.conveyor_no = u.conveyor_no
                             AND x.fg_receipt_id IS NOT NULL LIMIT 1) k ON true
            JOIN fg_receipts r ON r.id = k.fg_receipt_id
           WHERE u.fg_receipt_id IS NULL
             AND NOT EXISTS (SELECT 1 FROM cust_return_items ci
                              WHERE ci.new_unit_id = u.id)
           ORDER BY u.conveyor_no, u.part`,
  },
  {
    key: 'fg_kirim_bekor', soha: "Ta'minot",
    title: "Bekor qilingan kirimning konveri omborda turibdi",
    fix: "Konverni ombor qoldig'ida bekor qiling",
    sql: `SELECT r.doc_no, u.conveyor_no, u.status, u.qty
            FROM fg_receipts r JOIN production_units u ON u.fg_receipt_id = r.id
           WHERE r.status = 'cancelled' AND u.status NOT IN ('cancelled')
           ORDER BY r.doc_no`,
  },

  // ── XOM ASHYO ───────────────────────────────────────────────────────
  {
    key: 'xom_minus', soha: 'Xom ashyo',
    title: "Xom ashyo qoldig'i minusda",
    fix: "Kirim hujjati, boshlang'ich qoldiq yoki «⚖ Sanoq» bilan tuzating",
    sql: `SELECT warehouse, material, uom, qty FROM v_material_stock
           WHERE qty < 0 ORDER BY warehouse, material`,
  },
  {
    key: 'xom_kirim_qatorsiz', soha: 'Xom ashyo',
    title: "Xom ashyo kirim hujjati bor, qatorlari yo'q",
    fix: "Hujjatni bekor qiling yoki qaytadan yozing",
    sql: `SELECT r.doc_no, r.doc_on FROM mat_receipts r
           WHERE r.status = 'ok'
             AND NOT EXISTS (SELECT 1 FROM material_moves m
                              WHERE m.doc_kind = 'receipt' AND m.doc_id = r.id
                                AND m.status = 'ok')
           ORDER BY r.doc_on`,
  },
  {
    key: 'xom_kirim_bekor_qator', soha: 'Xom ashyo',
    title: "Bekor qilingan kirim hujjatining qatori qoldiqda turibdi",
    fix: "Harakat tabida o'sha qatorni bekor qiling",
    sql: `SELECT r.doc_no, mt.name AS material, m.qty
            FROM mat_receipts r
            JOIN material_moves m ON m.doc_kind = 'receipt' AND m.doc_id = r.id
            JOIN materials mt     ON mt.id = m.material_id
           WHERE r.status = 'cancelled' AND m.status = 'ok'
           ORDER BY r.doc_no`,
  },
  {
    key: 'xom_kurssiz', soha: 'Xom ashyo',
    title: "So'mdagi kirim qatorida kurs yo'q — dollar qiymati bo'sh",
    fix: "Hujjatni bekor qilib, kurs bilan qaytadan yozing",
    sql: `SELECT m.id, mt.name AS material, m.moved_on, m.price
            FROM material_moves m JOIN materials mt ON mt.id = m.material_id
           WHERE m.status = 'ok' AND m.price IS NOT NULL
             AND m.ccy = 'UZS' AND m.rate IS NULL
           ORDER BY m.moved_on`,
  },

  // ── OMBORLAR ARO ────────────────────────────────────────────────────
  {
    key: 'yolda_qolgan', soha: 'Omborlar aro',
    title: "Omborlar aro hujjat 3 kundan ortiq yo'lda turibdi",
    fix: "Qabul qiluvchi omborda qabul qiling yoki hujjatni rad eting",
    sql: `SELECT doc_no, status, confirmed_on, created_at::date AS yozilgan
            FROM wh_returns
           WHERE status IN ('new', 'confirmed')
             AND COALESCE(confirmed_on, created_at::date) < CURRENT_DATE - 3
           ORDER BY created_at`,
  },
  {
    key: 'yolda_konver_yoq', soha: 'Omborlar aro',
    title: "Yo'ldagi hujjatdagi konver manba omborda emas",
    fix: "Hujjatni rad eting va qaytadan yozing",
    sql: `SELECT r.doc_no, it.conveyor_no, it.qty AS hujjatda, u.qty AS konverda,
                 u.status
            FROM wh_returns r
            JOIN wh_return_items it ON it.return_id = r.id
            JOIN production_units u ON u.id = it.unit_id
           WHERE r.status IN ('new', 'confirmed')
             AND (u.status <> 'fg' OR u.qty < it.qty
                  OR COALESCE(u.warehouse_id, 0) <> COALESCE(r.from_warehouse_id, 0))
           ORDER BY r.doc_no`,
  },

  // ── MIJOZDAN QAYTARISH ──────────────────────────────────────────────
  {
    key: 'qaytgan_kop', soha: 'Qaytarish',
    title: "Konverdan chiqqanidan ko'p qaytarilgan",
    fix: "Qaytarish hujjatini tekshiring",
    sql: `SELECT conveyor_no, qty AS chiqqan, returned_qty AS qaytgan
            FROM production_units
           WHERE returned_qty > qty ORDER BY conveyor_no`,
  },

  // ── KASSA ───────────────────────────────────────────────────────────
  {
    key: 'kassa_minus', soha: 'Kassa',
    title: "Kassa qoldig'i minusda",
    fix: "Boshlang'ich qoldiqni kiriting yoki ortiqcha chiqimni bekor qiling",
    sql: `SELECT a.name AS kassa, x.ccy,
                 (x.opening + COALESCE(SUM(f.amount), 0))::numeric(18,2) AS qoldiq
            FROM cash_accounts a
            CROSS JOIN LATERAL (VALUES ('UZS', a.opening_uzs), ('USD', a.opening_usd))
                 AS x(ccy, opening)
            LEFT JOIN v_cash_flow f ON f.side_kind = 'account' AND f.side_id = a.id
                                   AND f.currency = x.ccy
           GROUP BY a.id, a.name, x.ccy, x.opening
          HAVING x.opening + COALESCE(SUM(f.amount), 0) < -0.005
           ORDER BY a.name, x.ccy`,
  },
  {
    key: 'kassa_kurssiz', soha: 'Kassa',
    title: "So'mdagi operatsiyada kurs yo'q — dollar qiymati bo'sh",
    fix: "Administrator «✎» bilan kursni yozadi",
    sql: `SELECT doc_no, op_date, amount FROM cash_ops
           WHERE status = 'ok' AND currency = 'UZS'
             AND (rate IS NULL OR rate = 0) AND to_currency IS NULL
           ORDER BY op_date`,
  },
  {
    key: 'kassa_kutmoqda', soha: 'Kassa',
    title: "Kassirga topshirilgan pul 2 kundan ortiq qabul qilinmagan",
    fix: "Kassir qabul qiladi yoki rad etadi",
    sql: `SELECT doc_no, op_date, currency, amount FROM cash_ops
           WHERE status = 'pending' AND op_date < CURRENT_DATE - 2
           ORDER BY op_date`,
  },

  // ── QARZLAR: hisobot ↔ ro'yxat ──────────────────────────────────────
  {
    key: 'mijoz_balans', soha: 'Qarz',
    title: "Mijoz balansi qarzdorlik lentasidan farq qiladi",
    fix: "Dasturdagi hisob xatosi — dasturchiga ayting",
    sql: `WITH l AS (SELECT customer_id, SUM(debit - credit)::numeric(16,2) AS saldo
                      FROM v_customer_ledger GROUP BY customer_id)
          SELECT s.id AS customer_id, s.balance AS balansda,
                 COALESCE(l.saldo, 0) AS lentada
            FROM v_customer_sales s LEFT JOIN l ON l.customer_id = s.id
           WHERE ABS(s.balance - COALESCE(l.saldo, 0)) >= 0.01
           ORDER BY s.id`,
  },
  {
    key: 'taminot_balans', soha: 'Qarz',
    title: "Ta'minotchi qarzi qarzdorlik lentasidan farq qiladi",
    fix: "Dasturdagi hisob xatosi — dasturchiga ayting",
    sql: `WITH l AS (SELECT supplier_id, SUM(credit - debit)::numeric(16,2) AS saldo
                      FROM v_supplier_ledger GROUP BY supplier_id)
          SELECT s.id AS supplier_id, s.balance AS royxatda,
                 COALESCE(l.saldo, 0) AS lentada
            FROM v_supplier_debt s LEFT JOIN l ON l.supplier_id = s.id
           WHERE ABS(s.balance - COALESCE(l.saldo, 0)) >= 0.01
           ORDER BY s.id`,
  },
];

//  Har tekshiruv ALOHIDA: bittasining xatosi (masalan eski bazada
//  ustun hali yo'q) qolganini to'xtatmasin — u ham javobda turadi.
async function tekshir() {
  const natija = [];
  for (const t of TEKSHIRUVLAR) {
    try {
      const { rows } = await db.query(t.sql);
      natija.push({ key: t.key, soha: t.soha, title: t.title, fix: t.fix,
                    count: rows.length, rows: rows.slice(0, CHEGARA) });
    } catch (e) {
      natija.push({ key: t.key, soha: t.soha, title: t.title, fix: t.fix,
                    count: null, error: e.message, rows: [] });
    }
  }
  return { at: new Date().toISOString(),
           xato: natija.filter((x) => x.count).length, checks: natija };
}

router.get('/', need('sales.fix'), wrap(async (req, res) => {
  res.json(await tekshir());
}));

//  Sessiyasiz eshik — faqat kalit bilan. Kalit qo'yilmagan bo'lsa
//  yo'lning O'ZI yo'qdek javob beradi: borligini ham aytmaydi.
router.get('/diag', wrap(async (req, res) => {
  const kalit = process.env.ERP_DIAG_TOKEN || '';
  const keldi = String(req.headers['x-diag-token'] || '');
  const teng = kalit.length >= 24 && keldi.length === kalit.length
    && crypto.timingSafeEqual(Buffer.from(keldi), Buffer.from(kalit));
  if (!teng) return res.status(404).json({ error: 'Topilmadi' });
  res.json(await tekshir());
}));

module.exports = router;
module.exports.TEKSHIRUVLAR = TEKSHIRUVLAR;
