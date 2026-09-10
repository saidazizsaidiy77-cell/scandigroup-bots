// ============================================================================
//  ISHLAB CHIQARISH MODULI
//  Yo'llar /api ostiga ulanadi (server.js). Huquqlar:
//    production.view   — ko'rish
//    production.entry  — dona o'tkazish, brak, to'xtash, partiya
//    production.manage — smena yopish, spravochnik
// ============================================================================
const express = require('express');
const { db, wrap, today, daysAgo } = require('../db');
const { need } = require('../auth');
const { resolveShift } = require('./shift');

const router = express.Router();



// ────────────────────────────────────────────────────────────── SPRAVOCHNIKLAR
router.get('/ref', need('production.view', 'production.entry'), wrap(async (_req, res) => {
  const [lines, shops, sections, products, chambers, defectReasons, downtimeReasons] =
    await Promise.all([
      db.query(`SELECT * FROM lines WHERE active ORDER BY sort`),
      db.query(`SELECT * FROM shops ORDER BY sort, name`),
      db.query(`SELECT sc.*, sh.line_id, sh.is_shared, sh.name AS shop
                  FROM sections sc JOIN shops sh ON sh.id = sc.shop_id
                 WHERE sc.active ORDER BY sh.sort, sc.sort`),
      db.query(`SELECT p.*, g.name AS group_name, g.line_id
                  FROM products p JOIN product_groups g ON g.id = p.group_id
                 -- Guruh tartibi saytdan qo'yiladi (product_groups.sort),
                 -- shuning uchun ro'yxat kod bo'yicha emas, shu tartibda
                 -- chiqadi: Penal · Kamod · Sp · Stol · Stul
                 WHERE p.active ORDER BY g.sort, g.code, p.name`),
      db.query(`SELECT * FROM chambers WHERE active ORDER BY name`),
      db.query(`SELECT * FROM defect_reasons ORDER BY sort`),
      db.query(`SELECT * FROM downtime_reasons ORDER BY sort`),
    ]);
  res.json({
    lines: lines.rows, shops: shops.rows, sections: sections.rows,
    products: products.rows, chambers: chambers.rows,
    defectReasons: defectReasons.rows, downtimeReasons: downtimeReasons.rows,
  });
}));

// Bo'lim konteksti. Umumiy tsexda ikkala yo'nalish mahsuloti chiqadi —
// shuning uchun har mahsulot yonida yo'nalish nomi ko'rsatiladi.
router.get('/section/:id/context', need('production.view', 'production.entry'), wrap(async (req, res) => {
  const sectionId = Number(req.params.id);
  const section = (await db.query(
    `SELECT sc.*, sh.name AS shop, sh.kind, sh.line_id, sh.is_shared
       FROM sections sc JOIN shops sh ON sh.id = sc.shop_id
      WHERE sc.id = $1`, [sectionId])).rows[0];
  if (!section) return res.status(404).json({ error: 'Bo\'lim topilmadi' });

  // Faqat marshruti shu bo'limdan o'tadigan mahsulotlar —
  // operator noto'g'ri SKU tanlay olmaydi.
  const products = (await db.query(
    `SELECT p.id, p.sku, p.name, pl.line_name, r.step_no,
            COALESCE(w.queue_qty, 0) AS queue_qty
       FROM v_product_route r
       JOIN products p        ON p.id = r.product_id
       JOIN v_product_line pl ON pl.product_id = p.id
       LEFT JOIN v_wip w      ON w.product_id = p.id AND w.section_id = r.section_id
      WHERE r.section_id = $1
      ORDER BY pl.line_name, p.name`, [sectionId])).rows;

  const openDowntime = (await db.query(
    `SELECT * FROM downtime WHERE section_id = $1 AND ended_at IS NULL
      ORDER BY started_at DESC LIMIT 1`, [sectionId])).rows[0] || null;

  const openBatches = section.kind === 'batch' ? (await db.query(
    `SELECT b.*, c.name AS chamber, p.name AS product
       FROM paint_batches b
       LEFT JOIN chambers c ON c.id = b.chamber_id
       JOIN products p      ON p.id = b.product_id
      WHERE b.section_id = $1 AND b.ended_at IS NULL
      ORDER BY b.started_at`, [sectionId])).rows : [];

  res.json({ section, products, openDowntime, openBatches });
}));

// ──────────────────────────────────────────────────────────────────── SMENA
router.get('/shift/current', need('production.view', 'production.entry'), wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT * FROM shifts
      WHERE work_date = $1 AND line_id = $2 AND shift_no = $3 AND closed_at IS NULL`,
    [today(), req.query.line_id, req.query.shift_no || 1]);
  res.json(rows[0] || null);
}));

router.post('/shift/:id/close', need('production.manage'), wrap(async (req, res) => {
  const { rows } = await db.query(
    `UPDATE shifts SET closed_at = NOW() WHERE id = $1 RETURNING *`, [req.params.id]);
  res.json(rows[0] || null);
}));

// ─────────────────────────────────────────────── ★ ASOSIY: bo'limdan o'tkazish
router.post('/flow', need('production.entry'), wrap(async (req, res) => {
  const {
    section_id, product_id, shift_no = 1,
    qty_ok = 0, qty_defect = 0,
    defect_reason, origin_section_id, note,
  } = req.body;
  // Kim yozgani — sessiyadan. Klient boshqa xodim nomidan yoza olmaydi.
  const worker_id = req.user.id;

  if (!section_id || !product_id)
    return res.status(400).json({ error: 'section_id va product_id majburiy' });
  if (qty_defect > 0 && !defect_reason)
    return res.status(400).json({ error: 'Brak uchun sabab kodi majburiy' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const shiftId = await resolveShift(client, product_id, shift_no, worker_id);

    const flow = (await client.query(
      `INSERT INTO flow_log (shift_id, section_id, product_id, qty_ok, qty_defect, worker_id, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [shiftId, section_id, product_id, qty_ok, qty_defect, worker_id, note || null]
    )).rows[0];

    if (qty_defect > 0) {
      await client.query(
        `INSERT INTO defects (flow_log_id, section_id, product_id, reason_code, qty, origin_section_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [flow.id, section_id, product_id, defect_reason, qty_defect, origin_section_id || null]);
    }

    // Chiqish bo'limi → tayyor mahsulot qoldig'i (komplektlilik shundan hisoblanadi)
    const isExit = (await client.query(
      `SELECT is_exit FROM sections WHERE id = $1`, [section_id])).rows[0]?.is_exit;
    if (isExit && qty_ok > 0) {
      await client.query(
        `INSERT INTO fg_stock (product_id, qty, updated_at) VALUES ($1,$2,NOW())
         ON CONFLICT (product_id) DO UPDATE
           SET qty = fg_stock.qty + EXCLUDED.qty, updated_at = NOW()`,
        [product_id, qty_ok]);
    }

    await client.query('COMMIT');
    res.json(flow);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// Oxirgi yozuvni bekor qilish (operator xato kiritsa)
router.delete('/flow/:id', need('production.entry'), wrap(async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query(
      `DELETE FROM flow_log WHERE id = $1 RETURNING *`, [req.params.id])).rows[0];
    // Chiqish bo'limi bo'lsa ombor qoldig'i ham qaytariladi
    if (row && row.qty_ok > 0) {
      const isExit = (await client.query(
        `SELECT is_exit FROM sections WHERE id = $1`, [row.section_id])).rows[0]?.is_exit;
      if (isExit) await client.query(
        `UPDATE fg_stock SET qty = GREATEST(qty - $2, 0), updated_at = NOW()
          WHERE product_id = $1`, [row.product_id, row.qty_ok]);
    }
    await client.query('COMMIT');
    res.json(row || null);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// ─────────────────────────────────────────────────────────────────── PROSTOY
// To'xtash bo'limga bog'langan, smenaga emas: umumiy bo'yoqlash tsexi
// to'xtaganda u bitta yo'nalishga tegishli bo'lmaydi.
router.post('/downtime/start', need('production.entry'), wrap(async (req, res) => {
  const { section_id, reason_code, note, shift_no = 1 } = req.body;
  const worker_id = req.user.id;
  const { rows } = await db.query(
    `INSERT INTO downtime (section_id, reason_code, worker_id, note, shift_no)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [section_id, reason_code, worker_id, note || null, shift_no]);
  res.json(rows[0]);
}));

router.post('/downtime/:id/stop', need('production.entry'), wrap(async (req, res) => {
  const { rows } = await db.query(
    `UPDATE downtime SET ended_at = NOW() WHERE id = $1 AND ended_at IS NULL RETURNING *`,
    [req.params.id]);
  res.json(rows[0] || null);
}));

// ────────────────────────────────────────────────────── BO'YOQLASH PARTIYASI
router.post('/paint/start', need('production.entry'), wrap(async (req, res) => {
  const { section_id, chamber_id, product_id, qty, shift_no = 1 } = req.body;
  const worker_id = req.user.id;
  const { rows } = await db.query(
    `INSERT INTO paint_batches (section_id, chamber_id, product_id, qty, worker_id, shift_no)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [section_id, chamber_id || null, product_id, qty, worker_id, shift_no]);
  res.json(rows[0]);
}));

router.post('/paint/:id/finish', need('production.entry'), wrap(async (req, res) => {
  const { rows } = await db.query(
    `UPDATE paint_batches SET ended_at = NOW(), repaint_qty = $2 WHERE id = $1 RETURNING *`,
    [req.params.id, req.body.repaint_qty || 0]);
  res.json(rows[0] || null);
}));

// ─────────────────────────────────────────────────────────────────── HISOBOT
router.get('/dashboard', need('production.view'), wrap(async (req, res) => {
  const date = req.query.date || today();
  // Brak va prostoy Pareto'si bir kun uchun ma'nosiz — davr bo'yicha olinadi.
  const from = req.query.from || daysAgo(30);

  const [planFact, shopWip, sharedLoad, bottleneck, defects, downtime,
         completeness, blockers, sectionDaily, chamberLoad] =
    await Promise.all([
      db.query(`SELECT * FROM v_plan_fact WHERE work_date = $1 ORDER BY product`, [date]),
      db.query(`SELECT * FROM v_shop_wip ORDER BY sort, shop, line_name`),
      db.query(`SELECT * FROM v_shared_load ORDER BY queue_qty DESC`),
      db.query(
        `SELECT sc.name AS section, sh.name AS shop, sh.is_shared,
                SUM(GREATEST(w.queue_qty,0)) AS queue_qty
           FROM v_wip w
           JOIN sections sc ON sc.id = w.section_id
           JOIN shops sh    ON sh.id = sc.shop_id
          GROUP BY sc.name, sh.name, sh.is_shared
         HAVING SUM(GREATEST(w.queue_qty,0)) > 0
          ORDER BY queue_qty DESC LIMIT 5`),
      db.query(
        `SELECT dr.code, dr.name AS reason, SUM(d.qty) AS qty,
                COALESCE(os.name, sc.name) AS origin_section
           FROM defects d
           JOIN defect_reasons dr ON dr.code = d.reason_code
           JOIN sections sc       ON sc.id = d.section_id
           LEFT JOIN sections os  ON os.id = d.origin_section_id
          WHERE d.work_date BETWEEN $1 AND $2
          GROUP BY dr.code, dr.name, COALESCE(os.name, sc.name)
          ORDER BY qty DESC LIMIT 8`, [from, date]),
      db.query(
        `SELECT r.code, r.name AS reason, sc.name AS section,
                ROUND(SUM(EXTRACT(EPOCH FROM (COALESCE(dt.ended_at, NOW()) - dt.started_at))/60)) AS minutes
           FROM downtime dt
           JOIN downtime_reasons r ON r.code = dt.reason_code
           JOIN sections sc        ON sc.id = dt.section_id
          WHERE dt.work_date BETWEEN $1 AND $2
          GROUP BY r.code, r.name, sc.name
          ORDER BY minutes DESC LIMIT 8`, [from, date]),
      db.query(`SELECT * FROM v_set_completeness ORDER BY complete_sets`),
      db.query(`SELECT * FROM v_set_blockers`),
      db.query(`SELECT * FROM v_section_daily WHERE work_date = $1
                 ORDER BY line, shop, section`, [date]),
      db.query(`SELECT * FROM v_chamber_load WHERE work_date = $1`, [date]),
    ]);

  res.json({
    date, from,
    planFact: planFact.rows,
    shopWip: shopWip.rows,
    // Umumiy bo'yoqlash tsexi quvvatini qaysi yo'nalish qancha yeyapti
    sharedLoad: sharedLoad.rows,
    bottleneck: bottleneck.rows,
    defects: defects.rows,
    downtime: downtime.rows,
    completeness: completeness.rows,
    blockers: blockers.rows,
    sectionDaily: sectionDaily.rows,
    chamberLoad: chamberLoad.rows,
  });
}));

// ═════════════════════════════════════════════ SOZLAMALAR: BO'LIM QUVVATI
// Muddat bashorati real fakt yig'ilmaguncha shu qiymatlarga tayanadi.
router.get('/sections/capacity', need('production.manage'), wrap(async (_req, res) => {
  const { rows } = await db.query(
    `SELECT sc.id, sc.code, sc.name, sc.sort, sc.capacity_per_day,
            sh.id AS shop_id, sh.name AS shop, sh.sort AS shop_sort,
            r.rate_per_day, r.rate_source
       FROM sections sc
       JOIN shops sh          ON sh.id = sc.shop_id
       JOIN v_section_rate r  ON r.section_id = sc.id
      WHERE sc.active
      ORDER BY sh.sort, sc.sort`);
  res.json(rows);
}));

router.patch('/sections/capacity', need('production.manage'), wrap(async (req, res) => {
  const { items = [] } = req.body;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const it of items) {
      await client.query(`UPDATE sections SET capacity_per_day = $2 WHERE id = $1`,
        [it.id, it.capacity_per_day === '' || it.capacity_per_day == null
                ? null : Number(it.capacity_per_day)]);
    }
    await client.query('COMMIT');
    res.json({ saved: items.length });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}));

// ═══════════════════════════════════ TSEX BOSHLIG'I: SMENA KIRITISH
// Bitta tsexning barcha bo'limlari bo'yicha kiritish jadvali.
// Faqat marshruti shu bo'limdan o'tadigan mahsulotlar chiqadi.
router.get('/shop/:id/entry', need('production.entry'), wrap(async (req, res) => {
  const shopId = Number(req.params.id);
  const date = req.query.date || today();
  const shiftNo = Number(req.query.shift_no || 1);

  const shop = (await db.query(`SELECT * FROM shops WHERE id = $1`, [shopId])).rows[0];
  if (!shop) return res.status(404).json({ error: 'Tsex topilmadi' });

  // Usta o'z tsexidan boshqasiga yoza olmaydi (worker_roles.scope_shop_id)
  const scope = req.user.scope_shop_ids;
  if (scope.length && !scope.includes(shopId))
    return res.status(403).json({ error: 'Bu tsex sizning doirangizda emas' });

  const rows = (await db.query(
    `SELECT sc.id AS section_id, sc.name AS section, sc.sort AS section_sort,
            p.id AS product_id, p.sku, p.name AS product, pl.line_name,
            r.step_no,
            COALESCE(GREATEST(w.queue_qty, 0), 0) AS queue_qty,
            COALESCE(e.qty_ok, 0)     AS entered_ok,
            COALESCE(e.qty_defect, 0) AS entered_defect
       FROM sections sc
       JOIN v_product_route r ON r.section_id = sc.id
       JOIN products p        ON p.id = r.product_id
       JOIN v_product_line pl ON pl.product_id = p.id
       LEFT JOIN v_wip w ON w.product_id = p.id AND w.section_id = sc.id
       LEFT JOIN (
         SELECT f.section_id, f.product_id,
                SUM(f.qty_ok) AS qty_ok, SUM(f.qty_defect) AS qty_defect
           FROM flow_log f JOIN shifts s ON s.id = f.shift_id
          WHERE s.work_date = $2::date AND s.shift_no = $3
          GROUP BY f.section_id, f.product_id
       ) e ON e.section_id = sc.id AND e.product_id = p.id
      WHERE sc.shop_id = $1 AND sc.active
      ORDER BY sc.sort, pl.line_name, p.name`, [shopId, date, shiftNo])).rows;

  res.json({ shop, date, shift_no: shiftNo, rows });
}));

// Ommaviy saqlash: bitta smenaning barcha yozuvlari bitta tranzaksiyada
router.post('/flow/bulk', need('production.entry'), wrap(async (req, res) => {
  const { entries = [], shift_no = 1, work_date = null } = req.body;
  if (!Array.isArray(entries) || !entries.length)
    return res.status(400).json({ error: 'Kiritilgan qator yo\'q' });

  const bad = entries.find((e) => Number(e.qty_defect) > 0 && !e.defect_reason);
  if (bad) return res.status(400).json({ error: 'Brak uchun sabab kodi majburiy' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    let saved = 0;
    for (const e of entries) {
      const qtyOk = Number(e.qty_ok) || 0;
      const qtyDef = Number(e.qty_defect) || 0;
      if (!qtyOk && !qtyDef) continue;

      const shiftId = await resolveShift(client, e.product_id, shift_no, req.user.id, work_date);
      const flow = (await client.query(
        `INSERT INTO flow_log (shift_id, section_id, product_id, qty_ok, qty_defect, worker_id)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [shiftId, e.section_id, e.product_id, qtyOk, qtyDef, req.user.id])).rows[0];

      if (qtyDef > 0) {
        await client.query(
          `INSERT INTO defects (flow_log_id, work_date, section_id, product_id,
                                reason_code, qty, origin_section_id)
           VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3,$4,$5,$6,$7)`,
          [flow.id, work_date, e.section_id, e.product_id, e.defect_reason, qtyDef,
           e.origin_section_id || null]);
      }

      const isExit = (await client.query(
        `SELECT is_exit FROM sections WHERE id = $1`, [e.section_id])).rows[0]?.is_exit;
      if (isExit && qtyOk > 0) {
        await client.query(
          `INSERT INTO fg_stock (product_id, qty, updated_at) VALUES ($1,$2,NOW())
           ON CONFLICT (product_id) DO UPDATE
             SET qty = fg_stock.qty + EXCLUDED.qty, updated_at = NOW()`,
          [e.product_id, qtyOk]);
      }
      saved++;
    }
    await client.query('COMMIT');
    res.json({ saved });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// ══════════════════════════════════════ ZAVOD KO'RINISHI
// "Hozir nima qayerda, qachon keyingi tsexga o'tadi, qachon omborga kiradi"
router.get('/factory', need('production.view'), wrap(async (req, res) => {
  const { line_id, group_id, q } = req.query;

  const [shopLoad, positions, movements, fgStock, rateHealth] = await Promise.all([
    db.query(`SELECT * FROM v_shop_load ORDER BY sort`),
    db.query(
      `SELECT ps.product_id, ps.sku, ps.product, ps.group_name, ps.line_name,
              ps.shop, ps.shop_sort, ps.section, ps.section_sort, ps.step_no, ps.qty,
              e.next_shop, e.eta_next_shop_days, e.eta_fg_days, e.rate_missing,
              (SELECT MAX(f.ts) FROM flow_log f
                WHERE f.product_id = ps.product_id
                  AND f.section_id IN (SELECT section_id FROM v_product_route r2
                                        WHERE r2.product_id = ps.product_id
                                          AND r2.step_no = ps.step_no - 1)) AS arrived_at
         FROM v_position ps
         LEFT JOIN v_position_eta e
                ON e.product_id = ps.product_id AND e.at_section_id = ps.section_id
        WHERE ($1::int IS NULL OR ps.line_name = (SELECT name FROM lines WHERE id = $1))
          AND ($2::int IS NULL OR ps.group_name = (SELECT name FROM product_groups WHERE id = $2))
          AND ($3::text IS NULL OR ps.product ILIKE '%' || $3 || '%' OR ps.sku ILIKE '%' || $3 || '%')
        ORDER BY ps.shop_sort, ps.section_sort, ps.qty DESC`,
      [line_id || null, group_id || null, q || null]),
    db.query(`SELECT * FROM v_movements ORDER BY ts DESC LIMIT 30`),
    db.query(
      `SELECT p.sku, p.name AS product, g.name AS group_name, s.qty, s.updated_at
         FROM fg_stock s
         JOIN products p       ON p.id = s.product_id
         JOIN product_groups g ON g.id = p.group_id
        WHERE s.qty > 0 ORDER BY s.qty DESC`),
    // Bashorat ishonchliligi: nechta bo'limda real fakt bor, nechtasida yo'q
    db.query(`SELECT rate_source, COUNT(*) AS n FROM v_section_rate GROUP BY rate_source`),
  ]);

  res.json({
    shopLoad: shopLoad.rows,
    positions: positions.rows,
    movements: movements.rows,
    fgStock: fgStock.rows,
    rateHealth: rateHealth.rows,
  });
}));

// Bitta SKU: marshrut bo'ylab to'liq holat
router.get('/product/:id/progress', need('production.view'), wrap(async (req, res) => {
  const [product, progress] = await Promise.all([
    db.query(
      `SELECT p.id, p.sku, p.name, p.is_set, g.name AS group_name, pl.line_name,
              rt.name AS route_name
         FROM products p
         JOIN product_groups g   ON g.id = p.group_id
         JOIN v_product_line pl  ON pl.product_id = p.id
         LEFT JOIN route_templates rt ON rt.id = p.route_template_id
        WHERE p.id = $1`, [req.params.id]),
    db.query(`SELECT * FROM v_product_progress WHERE product_id = $1 ORDER BY step_no`,
      [req.params.id]),
  ]);
  if (!product.rows[0]) return res.status(404).json({ error: 'Mahsulot topilmadi' });
  res.json({ product: product.rows[0], progress: progress.rows });
}));

router.get('/wip', need('production.view'), wrap(async (_req, res) => {
  const { rows } = await db.query(
    `SELECT p.name AS product, pl.line_name, sc.name AS section, sh.name AS shop,
            w.step_no, w.queue_qty
       FROM v_wip w
       JOIN products p        ON p.id = w.product_id
       JOIN v_product_line pl ON pl.product_id = w.product_id
       JOIN sections sc       ON sc.id = w.section_id
       JOIN shops sh          ON sh.id = sc.shop_id
      WHERE w.queue_qty <> 0
      ORDER BY w.queue_qty DESC`);
  res.json(rows);
}));

module.exports = router;
