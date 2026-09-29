/* ============================================================================
 *  KPI — OYLIK REJA VA FAKT
 *
 *  ★ ZAVOD QARORI (2026-09). Panel «qancha qildik» degan savolga javob
 *  beradi, lekin javobning O'ZI yetarli emas: 76 ming dollar ko'pmi
 *  yoki ozmi — buni faqat REJA bilan solishtirganda bilinadi. Ilgari
 *  reja direktorning daftarida turardi va oy oxirida esdan chiqardi.
 *
 *  ★ FAKT SHU YERDA QAYTA HISOBLANMAYDI — u panellardagi AYNAN o'sha
 *  so'rovlardan chiqadi (`modules/sales.js`, `units.js`, `cash.js`,
 *  `warehouse.js`). Ikkinchi nusxa yozilsa bir kun ajralib ketardi:
 *  panelda bir raqam, KPI sahifasida boshqasi turardi va qaysi biriga
 *  ishonishni bilib bo'lmasdi (navbat belgisi bilan bir xil qoida).
 *
 *  Shuning uchun bu modul faqat IKKI ish qiladi: rejani saqlaydi va
 *  faktni o'sha view'lardan bitta so'rovda yig'ib beradi.
 * ========================================================================== */
const express = require('express');
const { db, wrap, audit } = require('../db');
const { need } = require('../auth');

const router = express.Router();

//  Rejani KIM qo'yadi: direktor va ishlab chiqarish boshlig'i
//  (`production.manage`), moliyaniki esa buxgalterga ham
//  (`cash.manage`). Ko'rish — panelni ko'radigan har kimga.
const WRITE = ['production.manage', 'cash.manage'];
const READ  = ['production.reports', 'production.manage',
               'sales.view', 'sales.manage',
               'cash.view', 'cash.manage',
               'warehouse.view', 'warehouse.manage'];

//  ★ KO'RSATKICH RO'YXATI KODDA, chunki u MA'LUMOT emas — har biri
//  aniq bir SQL javobiga bog'langan va uni bazadan o'qib bo'lmaydi.
//  Raqamni esa zavod qo'yadi va u bazada turadi (4-qoida buzilmaydi).
//
//  `yaxshi` — qaysi tomon yaxshi: `ko'p` (savdo, ishlab chiqarish)
//  yoki `kam` (harajat). Bajarilish foizi shunga qarab hisoblanadi,
//  aks holda harajat rejadan oshgani «yashil» bo'lib ko'rinardi.
const KPI = {
  sales: {
    nom: 'Savdo', perm: ['sales.view', 'sales.manage'],
    metrics: [
      { code: 'chiqdi',   nom: 'Chiqib ketgan savdo', birlik: 'usd', yaxshi: 'kop' },
      { code: 'buyurtma', nom: 'Buyurtma soni',       birlik: 'son', yaxshi: 'kop' },
    ],
  },
  production: {
    nom: 'Ishlab chiqarish', perm: ['production.reports', 'production.manage'],
    metrics: [
      { code: 'chiqarildi', nom: 'Chiqarilgan mahsulot', birlik: 'dona', yaxshi: 'kop' },
    ],
  },
  cash: {
    nom: 'Moliya', perm: ['cash.view', 'cash.manage'],
    metrics: [
      { code: 'tushum',  nom: 'Tushum',  birlik: 'usd', yaxshi: 'kop' },
      { code: 'harajat', nom: 'Harajat', birlik: 'usd', yaxshi: 'kam' },
      { code: 'foyda',   nom: 'Foyda',   birlik: 'usd', yaxshi: 'kop' },
    ],
  },
  warehouse: {
    nom: 'Ombor', perm: ['warehouse.view', 'warehouse.manage'],
    metrics: [
      { code: 'chiqdi', nom: 'Ombordan chiqqan', birlik: 'dona', yaxshi: 'kop' },
    ],
  },
};

const bor = (req, perms) => perms.some((p) => req.user.permissions.includes(p));

//  Yil bitta son bo'lib keladi: reja oylar bo'yicha qo'yiladi va
//  ekranda o'n ikki qator turadi.
const yilQ = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 2000 && n <= 2100 ? n : new Date().getFullYear();
};

/* ---------------------------------------------------------------- FAKT
 *  Har bo'lim uchun oy bo'yicha haqiqiy raqam. So'rovlar panellardagi
 *  bilan AYNAN bir xil shartdan chiqadi — izoh yuqorida.
 */
async function faktlar(yil) {
  const dan = `${yil}-01-01`;
  const gacha = `${yil}-12-31`;
  const [savdo, ishlab, moliya, ombor] = await Promise.all([
    db.query(
      `SELECT to_char(date_trunc('month', o.shipped_on), 'YYYY-MM') AS mon,
              COALESCE(SUM(o.amount), 0)::numeric AS chiqdi,
              COUNT(*)::int AS buyurtma
         FROM v_sales_orders o
        WHERE o.status = 'shipped' AND o.shipped_on BETWEEN $1::date AND $2::date
        GROUP BY 1`, [dan, gacha]),

    //  Tsexdan chiqqanda sanaladi, bo'limdan o'tganda emas (izoh:
    //  modules/units.js dagi CHIQDI).
    db.query(
      `SELECT to_char(oy, 'YYYY-MM') AS mon, SUM(qty)::int AS chiqarildi FROM (
         SELECT date_trunc('month', mv.moved_on)::date AS oy, mv.qty::int AS qty
           FROM unit_moves mv
           JOIN sections f ON f.id = mv.from_section_id
           JOIN sections t ON t.id = mv.section_id AND t.shop_id <> f.shop_id
           JOIN production_units u ON u.id = mv.unit_id AND u.status <> 'cancelled'
          WHERE mv.moved_on BETWEEN $1::date AND $2::date
         UNION ALL
         SELECT date_trunc('month', u.fg_on)::date, u.qty::int
           FROM production_units u
           JOIN sections s ON s.id = u.current_section_id
          WHERE u.fg_on BETWEEN $1::date AND $2::date AND u.status <> 'cancelled'
       ) x GROUP BY 1`, [dan, gacha]),

    db.query(
      `SELECT to_char(pl_month, 'YYYY-MM') AS mon,
              COALESCE(SUM(amount_usd) FILTER (WHERE kind = 'income'), 0)::numeric
                AS tushum,
              COALESCE(SUM(amount_usd) FILTER (WHERE kind <> 'income'), 0)::numeric
                AS harajat,
              (COALESCE(SUM(amount_usd) FILTER (WHERE kind = 'income'), 0)
               - COALESCE(SUM(amount_usd) FILTER (WHERE kind <> 'income'), 0)
              )::numeric AS foyda
         FROM v_pl_month
        WHERE pl_month BETWEEN $1::date AND $2::date
        GROUP BY 1`, [dan, gacha]),

    db.query(
      `SELECT to_char(date_trunc('month', on_date), 'YYYY-MM') AS mon,
              COALESCE(SUM(qty) FILTER (WHERE kind = 'out'), 0)::int AS chiqdi
         FROM v_fg_moves
        WHERE on_date BETWEEN $1::date AND $2::date
        GROUP BY 1`, [dan, gacha]),
  ]);

  const xarita = (rows) => Object.fromEntries(rows.map((r) => [r.mon, r]));
  return { sales: xarita(savdo.rows), production: xarita(ishlab.rows),
           cash: xarita(moliya.rows), warehouse: xarita(ombor.rows) };
}

//  ★ REJA VA FAKT BITTA JAVOBDA. Ikki so'rov bo'lsa ekranda reja
//  kelib, fakt kechikib chizilardi va bajarilish foizi bir lahza
//  yolg'on turardi.
router.get('/', need(...READ), wrap(async (req, res) => {
  const yil = yilQ(req.query.year);
  //  Ko'radigan bo'limlari: huquqi yo'q bo'limning REJASI ham
  //  ko'rinmaydi — u boshqa odamning raqami.
  const bolimlar = Object.entries(KPI)
    .filter(([, v]) => bor(req, v.perm))
    .map(([code, v]) => ({ code, nom: v.nom, metrics: v.metrics }));

  const [reja, fakt] = await Promise.all([
    db.query(
      `SELECT bolim, metric, to_char(mon, 'YYYY-MM') AS mon,
              target::numeric, note
         FROM kpi_targets
        WHERE EXTRACT(YEAR FROM mon) = $1`, [yil]),
    faktlar(yil),
  ]);

  res.json({
    year: yil, bolimlar,
    //  Yozish huquqi ekranga ham kerak: tugmani yashirish himoya
    //  emas, lekin ko'rmaydigan odamga katak ochilishi ham ortiqcha.
    yozadi: bor(req, WRITE),
    reja: reja.rows,
    fakt: Object.fromEntries(bolimlar.map((b) => [b.code, fakt[b.code] || {}])),
  });
}));

//  Reja BITTA katakcha bilan saqlanadi: ekranda o'n ikki qator va
//  uchta ustun bo'ladi, «Saqlash» tugmasi esa qaysi katak
//  o'zgarganini eslab turishni talab qilardi.
//
//  Bo'sh yuborilgani «tegma» emas, «yo'q» degani — reja olib
//  tashlanadi (muddat sanasi bilan bir xil idiom).
router.post('/', need(...WRITE), wrap(async (req, res) => {
  const b = KPI[req.body.bolim];
  if (!b) return res.status(400).json({ error: "Bo'lim topilmadi" });
  if (!bor(req, b.perm))
    return res.status(403).json({ error: "Bu bo'lim sizning doirangizda emas" });
  const m = b.metrics.find((x) => x.code === req.body.metric);
  if (!m) return res.status(400).json({ error: "Ko'rsatkich topilmadi" });
  if (!/^\d{4}-\d{2}$/.test(String(req.body.mon || '')))
    return res.status(400).json({ error: "Oy noto'g'ri" });
  const mon = req.body.mon + '-01';

  const v = req.body.target;
  const bosh = v == null || String(v).trim() === '';
  const son = Number(v);
  if (!bosh && (!Number.isFinite(son) || son < 0))
    return res.status(400).json({ error: "Raqam noto'g'ri" });

  if (bosh) {
    await db.query(
      `DELETE FROM kpi_targets WHERE bolim = $1 AND metric = $2 AND mon = $3::date`,
      [req.body.bolim, m.code, mon]);
  } else {
    await db.query(
      `INSERT INTO kpi_targets (bolim, metric, mon, target, created_by)
       VALUES ($1,$2,$3::date,$4,$5)
       ON CONFLICT (bolim, metric, mon) DO UPDATE
         SET target = $4, updated_by = $5, updated_at = NOW()`,
      [req.body.bolim, m.code, mon, son, req.user.id]);
  }
  await audit(req, { module: 'kpi', action: bosh ? 'kpi-clear' : 'kpi-set',
                     entity: 'kpi_targets',
                     payload: { bolim: req.body.bolim, metric: m.code,
                                mon, target: bosh ? null : son } });
  res.json({ ok: true });
}));

module.exports = router;
