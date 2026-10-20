// ============================================================================
//  TANNARX — konver bo'yicha (zavod qarori, 2026-10)
//
//  Alohida modul emas, «Hisobotlar» ichidagi sahifa: tannarx o'zi
//  ma'lumot yaratmaydi — u xom ashyo sarfidan (keyin ish haqi va oy
//  yopishdagi umumiy harajatdan) O'QIYDI. Ikkinchi nusxa bir kun
//  manbadan ajralib ketardi.
//
//  ★ 1-BOSQICH — MATERIAL. Ish haqi (ishbay hali yozilmagan) va
//  kommunal (oy yopishda, tannarxga proporsional) keyingi bosqichlar.
//
//  ★ RAQAM BO'YICHA, qator bo'yicha emas: konver bo'linadi va sarf
//  qaysi bo'lakda turgani tasodif (CLAUDE.md, «TANNARX QATOR BO'YICHA
//  EMAS»). Dona — konver pasportidagi «Jami yasalgan» bilan BIR XIL
//  qoida: bekor qilingani yo'q, mijozdan qaytgani ikki marta sanalmaydi.
//
//  ★ BRAK TANNARXGA KIRADI (zavod qarori, 2026-10): material
//  SARFLANGAN donaga emas, CHIQQAN (bekor qilinmagan) donaga
//  bo'linadi — brakning puli qolganlarning ustiga tushadi.
//
//  Narx — material olingan omborning O'RTACHA kirim narxi
//  (`v_material_stock` formulasi); harakat qatorida narx qotgan
//  bo'lsa (`price_usd`) o'sha ustun. Oy yopilmaguncha o'rtacha
//  yangi kirim bilan siljiydi — qotishi oy yopishning ishi.
// ============================================================================
const express = require('express');
const { db, wrap } = require('../db');
const { need } = require('../auth');

const router = express.Router();

//  Tannarx — PUL hisoboti: rahbariyat, buxgalter, ishlab chiqarish
//  boshlig'i, xom ashyo mudiri va ta'minot. Tsex boshlig'ida
//  `materials.view` bor, lekin unga ochilmaydi.
const HUQUQ = ['cash.view', 'cash.manage', 'production.manage',
               'materials.manage', 'purchasing.view'];

//  Material qatorlari — har konver raqami × material. Ikkala yo'l
//  ham shundan o'qiydi: ro'yxat (jami) va ochilgan qator (tafsilot).
const SARF = `
  ortacha AS (
    SELECT place_id, material_id,
           SUM(qty * price_usd) FILTER (WHERE qty > 0 AND price_usd IS NOT NULL)
           / NULLIF(SUM(qty) FILTER (WHERE qty > 0 AND price_usd IS NOT NULL), 0)
             AS price
      FROM v_material_flow WHERE kind = 'warehouse'
     GROUP BY place_id, material_id),
  sarf AS (
    SELECT u.conveyor_no, mv.material_id,
           SUM(mv.qty) AS qty,
           SUM(mv.qty * COALESCE(mv.price_usd, o.price)) AS summa,
           COUNT(*) FILTER (WHERE COALESCE(mv.price_usd, o.price) IS NULL)::int
             AS narxsiz
      FROM material_moves mv
      JOIN production_units u ON u.id = mv.to_id
      LEFT JOIN ortacha o ON o.place_id = mv.from_id
                         AND o.material_id = mv.material_id
                         AND mv.from_kind = 'warehouse'
     WHERE mv.to_kind = 'unit' AND mv.status = 'ok'
     GROUP BY u.conveyor_no, mv.material_id),
  konv AS (
    SELECT u.conveyor_no,
           (array_agg(u.product_id ORDER BY u.id))[1] AS product_id,
           COALESCE(SUM(CASE WHEN u.status = 'shipped'
                             THEN u.qty - COALESCE(u.returned_qty, 0)
                             ELSE u.qty END)
                    FILTER (WHERE u.status <> 'cancelled'), 0)::int AS soni,
           MIN(u.fg_on) AS kirgan,
           MIN(u.started_on) AS boshlangan,
           bool_or(u.status = 'production') AS yolda,
           bool_and(u.is_opening) AS opening
      FROM production_units u
     GROUP BY u.conveyor_no),
  jam AS (
    SELECT conveyor_no, SUM(summa) AS summa, SUM(narxsiz)::int AS narxsiz,
           COUNT(*)::int AS nom
      FROM sarf GROUP BY conveyor_no),
  k AS (
    SELECT konv.*, jam.summa, COALESCE(jam.narxsiz, 0) AS narxsiz,
           COALESCE(jam.nom, 0) AS nom,
           jam.summa / NULLIF(konv.soni, 0) AS dona
      FROM konv LEFT JOIN jam USING (conveyor_no)),
  --  Oldingi konver — SHU mahsulotning, sarfi bor, omborga oldin
  --  kirgani. Sarfsiz konver solishtirishga olinmaydi: nol bilan
  --  solishtirish «+100%» degan yolg'on javob berardi.
  oldin AS (
    SELECT conveyor_no,
           LAG(conveyor_no) OVER w AS prev_no,
           LAG(dona)        OVER w AS prev_dona
      FROM k
     WHERE dona IS NOT NULL
    WINDOW w AS (PARTITION BY product_id
                 ORDER BY kirgan NULLS LAST, boshlangan NULLS LAST, conveyor_no))`;

//  Ro'yxat — omborga KIRGAN kuni bo'yicha, ketma-ket. Ishlab
//  chiqarishdagi konver (`yolda=1`) ham qo'shilishi mumkin: uning
//  sarfi hali to'liq emas va ekran buni yozib turadi.
router.get('/', need(...HUQUQ), wrap(async (req, res) => {
  const from = req.query.from || null, to = req.query.to || null;
  const yolda = req.query.yolda === '1';
  const { rows } = await db.query(
    `WITH ${SARF}
     SELECT k.conveyor_no, k.soni, k.kirgan, k.boshlangan, k.yolda,
            k.summa::NUMERIC(16,2) AS summa, k.dona::NUMERIC(16,2) AS dona,
            k.narxsiz, k.nom,
            o.prev_no, o.prev_dona::NUMERIC(16,2) AS prev_dona,
            p.id AS product_id, p.name AS product, g.name AS product_type, g.uom
       FROM k
       JOIN products p ON p.id = k.product_id
       LEFT JOIN product_groups g ON g.id = p.group_id
       LEFT JOIN oldin o ON o.conveyor_no = k.conveyor_no
      WHERE p.route_template_id IS NOT NULL
        AND NOT k.opening AND k.soni > 0
        AND (  (k.kirgan IS NOT NULL
                AND ($1::date IS NULL OR k.kirgan >= $1)
                AND ($2::date IS NULL OR k.kirgan <= $2))
            OR ($3 AND k.kirgan IS NULL))
      ORDER BY k.kirgan NULLS LAST, k.boshlangan NULLS LAST, k.conveyor_no`,
    [from, to, yolda]);
  res.json({ rows });
}));

//  Ochilgan qator — material bo'yicha, OLDINGI konver bilan yonma-yon:
//  «nega 1 $ oshdi» degan savolga javob shu yerda — qaysi material
//  ko'p ketgan yoki qimmatlashgan.
router.get('/:no', need(...HUQUQ), wrap(async (req, res) => {
  const no = String(req.params.no || '').trim();
  const { rows: [k] } = await db.query(
    `WITH ${SARF}
     SELECT k.conveyor_no, k.soni, o.prev_no,
            (SELECT soni FROM k k2 WHERE k2.conveyor_no = o.prev_no) AS prev_soni
       FROM k LEFT JOIN oldin o USING (conveyor_no)
      WHERE k.conveyor_no = $1`, [no]);
  if (!k) return res.status(404).json({ error: 'Konver topilmadi' });
  const { rows } = await db.query(
    `WITH ${SARF}
     SELECT s.conveyor_no, s.material_id, m.name AS material, m.code, m.uom,
            s.qty::NUMERIC(14,3) AS qty, s.summa::NUMERIC(16,2) AS summa,
            s.narxsiz
       FROM sarf s JOIN materials m ON m.id = s.material_id
      WHERE s.conveyor_no = ANY($1)
      ORDER BY s.summa DESC NULLS LAST, m.name`,
    [[k.conveyor_no, k.prev_no].filter(Boolean)]);
  const bu = rows.filter((r) => r.conveyor_no === k.conveyor_no);
  const ol = new Map(rows.filter((r) => r.conveyor_no === k.prev_no)
    .map((r) => [r.material_id, r]));
  const dona = (v, n) => (v == null || !n ? null : Number(v) / n);
  const out = bu.map((r) => {
    const p = ol.get(r.material_id);
    ol.delete(r.material_id);
    return { material: r.material, code: r.code, uom: r.uom, narxsiz: r.narxsiz,
             qty: dona(r.qty, k.soni), summa: dona(r.summa, k.soni),
             prev_qty: p ? dona(p.qty, k.prev_soni) : null,
             prev_summa: p ? dona(p.summa, k.prev_soni) : null };
  });
  //  Oldingisida bo'lib, bunisida YO'Q material ham yoziladi —
  //  tannarx kamaygan bo'lsa sababi ko'pincha shu (sarf yozilmagan).
  for (const p of ol.values()) out.push({ material: p.material, code: p.code,
    uom: p.uom, qty: null, summa: null,
    prev_qty: dona(p.qty, k.prev_soni), prev_summa: dona(p.summa, k.prev_soni) });
  res.json({ conveyor_no: k.conveyor_no, soni: k.soni, prev_no: k.prev_no,
             prev_soni: k.prev_soni, rows: out });
}));

module.exports = router;
