// ============================================================================
//  SAVDO: BUYURTMA
//
//  Buyurtma — mijoz nima so'raganining yozuvi, qatorlari bilan. Zavod uni
//  ikki manbadan bajaradi: T/M omborda tayyor turgan konverdan yoki rang
//  kutayotgan zahiradan. Buyurtma uchun yangi konver OCHILMAYDI.
//
//  "Bajarilgan" degan belgi saqlanmaydi — u har safar konverlardan
//  hisoblanadi (v_sales_orders). Saqlangan belgi bir kun haqiqatdan
//  ajralib qoladi: konver qaytarildi, bekor qilindi yoki bo'lindi.
//
//  Huquq: ko'rish — sales.view, yozish — sales.manage.
//  Savdo yo'nalishi (`worker_roles.scope_channel`) chegara bo'lib qo'shiladi:
//  B2B menejeri eksport buyurtmasini ko'rmaydi ham, ocha ham olmaydi.
// ============================================================================
const express = require('express');
const { db, wrap, audit } = require('../db');
const { need } = require('../auth');
const { clonePart } = require('./units');

const router = express.Router();
const READ  = ['sales.view', 'sales.manage'];
const WRITE = ['sales.manage'];

const channelsOf = (req) => {
  const c = req.user?.scope_channels || [];
  return c.length ? c : null;
};

// Z26-0001. Konveyer raqami bilan bir xil shakl: yil + ketma-ket raqam.
async function nextOrderNo(client) {
  const prefix = `Z${String(new Date().getFullYear()).slice(-2)}-`;
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(SUBSTRING(order_no FROM '\\d+$')::int), 0) + 1 AS n
       FROM orders WHERE order_no LIKE $1`, [`${prefix}%`]);
  return prefix + String(rows[0].n).padStart(4, '0');
}

// Mijoz menejerning yo'nalishidami. Chegara serverda tekshiriladi:
// klient ro'yxatdan tanlamay, to'g'ridan-to'g'ri id yuborishi mumkin.
async function assertCustomer(client, req, customerId) {
  const chans = channelsOf(req);
  const { rows } = await client.query(
    `SELECT name, channel FROM customers WHERE id = $1`, [customerId]);
  if (!rows[0]) throw new Error('Mijoz topilmadi');
  if (chans && !chans.includes(rows[0].channel))
    throw new Error(`«${rows[0].name}» sizning yo'nalishingizda emas`);
}

//  Buyurtma yozish uchun mahsulot ro'yxati. Katalogdan alohida turadi:
//  savdo menejerida ishlab chiqarish huquqi bo'lmasligi mumkin, katalog
//  esa `production.view` so'raydi. Yonida bo'sh qoldiq ham keladi —
//  menejer nima sotayotganini yozayotganda ko'rib tursin.
router.get('/products', need(...READ), wrap(async (_req, res) => {
  const { rows } = await db.query(
    `SELECT p.id, p.name, p.sku, g.name AS product_type, g.uom,
            COALESCE(f.qty, 0)::int AS free_fg,
            COALESCE(f.stock, 0)::int AS free_stock
       FROM products p
       JOIN product_groups g ON g.id = p.group_id
       LEFT JOIN LATERAL (
         SELECT SUM(u.qty) FILTER (WHERE u.status = 'fg') AS qty,
                SUM(u.qty) FILTER (WHERE u.status = 'production') AS stock
           FROM production_units u
           LEFT JOIN sections s ON s.id = u.current_section_id
          WHERE u.product_id = p.id AND u.order_item_id IS NULL
            AND (u.status = 'fg'
                 OR (u.is_stock AND COALESCE(s.is_hold, false)))) f ON true
      WHERE p.active
      ORDER BY g.sort, g.name, p.name`);
  res.json({ rows });
}));

// ──────────────────────────────────────────────────────────────── RO'YXAT
router.get('/orders', need(...READ), wrap(async (req, res) => {
  const chans = channelsOf(req);
  const { rows } = await db.query(
    `SELECT * FROM v_sales_orders
      WHERE ($1::text[] IS NULL OR channel = ANY($1))
        AND ($2::text IS NULL OR status = $2)
        AND ($3::int  IS NULL OR customer_id = $3)
        AND ($4::int  IS NULL OR manager_id = $4)
        AND ($5::text IS NULL OR order_no ILIKE '%' || $5 || '%'
             OR customer_name ILIKE '%' || $5 || '%')
      ORDER BY ordered_on DESC, id DESC
      LIMIT 500`,
    [chans, req.query.status || null, req.query.customer_id || null,
     req.query.manager_id || null, req.query.q || null]);
  res.json({ rows });
}));

// Bitta buyurtma: sarlavha, qatorlar va har qatorga biriktirilgan konverlar
router.get('/orders/:id', need(...READ), wrap(async (req, res) => {
  const chans = channelsOf(req);
  const o = (await db.query(
    `SELECT * FROM v_sales_orders
      WHERE id = $1 AND ($2::text[] IS NULL OR channel = ANY($2))`,
    [req.params.id, chans])).rows[0];
  if (!o) return res.status(404).json({ error: 'Buyurtma topilmadi' });

  const items = (await db.query(
    `SELECT i.*, p.name AS product, p.sku, g.name AS product_type, g.uom,
            COALESCE(a.qty, 0)::int AS assigned_qty
       FROM order_items i
       JOIN products p       ON p.id = i.product_id
       JOIN product_groups g ON g.id = p.group_id
       LEFT JOIN LATERAL (
         SELECT SUM(u.qty) AS qty FROM production_units u
          WHERE u.order_item_id = i.id AND u.status <> 'cancelled') a ON true
      WHERE i.order_id = $1 ORDER BY i.sort, i.id`, [req.params.id])).rows;

  const units = (await db.query(
    `SELECT u.id, u.order_item_id, u.conveyor_no, u.qty, u.color, u.fabric,
            u.status, u.is_stock, s.name AS section
       FROM production_units u
       JOIN order_items i     ON i.id = u.order_item_id
       LEFT JOIN sections s   ON s.id = u.current_section_id
      WHERE i.order_id = $1 AND u.status <> 'cancelled'
      ORDER BY u.conveyor_no`, [req.params.id])).rows;

  res.json({ order: o, items, units });
}));

// ─────────────────────────────────────────────────────── YARATISH / TAHRIR
router.post('/orders', need(...WRITE), wrap(async (req, res) => {
  const { customer_id, manager_id, ordered_on, due_on, note, items = [] } = req.body;
  if (!customer_id) throw new Error('Mijoz tanlanmagan');

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await assertCustomer(client, req, customer_id);
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('order_no'))`);
    const no = await nextOrderNo(client);
    const o = (await client.query(
      `INSERT INTO orders (order_no, customer_id, manager_id, ordered_on, due_on,
                           note, created_by)
       VALUES ($1,$2,$3, COALESCE($4::date, CURRENT_DATE), $5,$6,$7) RETURNING id, order_no`,
      [no, customer_id, manager_id || req.user.id, ordered_on || null,
       due_on || null, note || null, req.user.id])).rows[0];

    await saveItems(client, o.id, items);
    await audit(req, { module: 'sales', action: 'create', entity: 'order',
                       entity_id: o.id, payload: { order_no: o.order_no } }, client);
    await client.query('COMMIT');
    res.json(o);
  } catch (e) {
    await client.query('ROLLBACK');
    return res.status(400).json({ error: e.message });
  } finally { client.release(); }
}));

//  Qatorlar butunligicha almashtiriladi: ro'yxat ekranda tahrirlanadi va
//  qaysi qator o'chirilgani, qaysisi qo'shilganini klient hisoblab
//  yubormasligi kerak — u bir kun adashadi. Biriktirilgan konveri bor
//  qator esa o'chirilmaydi: avval konver ajratiladi.
async function saveItems(client, orderId, items) {
  const keep = items.map((i) => i.id).filter(Boolean);
  const busy = (await client.query(
    `SELECT i.id, p.name FROM order_items i
       JOIN products p ON p.id = i.product_id
      WHERE i.order_id = $1 AND NOT (i.id = ANY($2::int[]))
        AND EXISTS (SELECT 1 FROM production_units u
                     WHERE u.order_item_id = i.id AND u.status <> 'cancelled')`,
    [orderId, keep])).rows;
  if (busy.length)
    throw new Error(`Konver biriktirilgan qatorni o'chirib bo'lmaydi: ` +
                    busy.map((b) => b.name).join(', '));

  await client.query(
    `DELETE FROM order_items WHERE order_id = $1 AND NOT (id = ANY($2::int[]))`,
    [orderId, keep]);

  let sort = 0;
  for (const it of items) {
    if (!it.product_id) throw new Error('Qatorda mahsulot tanlanmagan');
    const qty = Number(it.qty) || 1;
    if (!Number.isInteger(qty) || qty <= 0) throw new Error('Soni noto\'g\'ri');
    const price = it.unit_price === '' || it.unit_price == null ? null : Number(it.unit_price);
    if (it.id) {
      await client.query(
        `UPDATE order_items SET product_id=$2, qty=$3, color=$4, fabric=$5,
                unit_price=$6, note=$7, sort=$8
          WHERE id=$1 AND order_id=$9`,
        [it.id, it.product_id, qty, it.color || null, it.fabric || null,
         price, it.note || null, sort++, orderId]);
    } else {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, qty, color, fabric,
                                  unit_price, note, sort)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [orderId, it.product_id, qty, it.color || null, it.fabric || null,
         price, it.note || null, sort++]);
    }
  }
}

router.patch('/orders/:id', need(...WRITE), wrap(async (req, res) => {
  const { customer_id, manager_id, ordered_on, due_on, note, status, items } = req.body;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const cur = (await client.query(
      `SELECT o.*, c.channel FROM orders o JOIN customers c ON c.id = o.customer_id
        WHERE o.id = $1 FOR UPDATE OF o`, [req.params.id])).rows[0];
    if (!cur) throw new Error('Buyurtma topilmadi');
    const chans = channelsOf(req);
    if (chans && !chans.includes(cur.channel))
      throw new Error('Bu buyurtma sizning yo\'nalishingizda emas');
    if (customer_id) await assertCustomer(client, req, customer_id);

    //  Bekor qilishdan oldin konverlar ajratiladi: aks holda ombordagi
    //  mahsulot bekor qilingan buyurtmada band bo'lib qolardi va uni
    //  hech kim sota olmasdi.
    if (status === 'cancelled') {
      const busy = (await client.query(
        `SELECT COUNT(*)::int AS n FROM production_units u
           JOIN order_items i ON i.id = u.order_item_id
          WHERE i.order_id = $1 AND u.status <> 'cancelled'`,
        [req.params.id])).rows[0].n;
      if (busy) throw new Error(`Avval ${busy} ta konverni ajrating`);
    }

    await client.query(
      `UPDATE orders SET customer_id = COALESCE($2, customer_id),
              manager_id = COALESCE($3, manager_id),
              ordered_on = COALESCE($4::date, ordered_on),
              due_on     = COALESCE($5::date, due_on),
              note       = COALESCE($6, note),
              status     = COALESCE($7, status)
        WHERE id = $1`,
      [req.params.id, customer_id || null, manager_id || null, ordered_on || null,
       due_on || null, note ?? null, status || null]);

    if (Array.isArray(items)) await saveItems(client, Number(req.params.id), items);
    await audit(req, { module: 'sales', action: 'update', entity: 'order',
                       entity_id: Number(req.params.id),
                       payload: { order_no: cur.order_no } }, client);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    return res.status(400).json({ error: e.message });
  } finally { client.release(); }
}));

// ════════════════════════════════════════════ KONVERNI BUYURTMAGA BIRIKTIRISH
//
//  Ikki manba (zavod qarori, sql/sales.sql):
//    · T/M ombor — tayyor turgan konver (`status='fg'`);
//    · zahira    — buyurtma kutayotgan konver (`is_stock`, `sections.is_hold`).
//  Yangi konver ochilmaydi.
//
//  Biriktirilgan konver band bo'ladi: `order_item_id` to'lgani uchun u
//  boshqa buyurtmaning ro'yxatida umuman chiqmaydi. Ikki menejer bir vaqtda
//  bitta konverni olsa ham ikkinchisi xato oladi — tekshiruv qator
//  qulflangandan keyin (`FOR UPDATE`).

const CANDIDATE_WHERE = `
  u.order_item_id IS NULL
  AND u.status IN ('fg', 'production')
  AND (u.status = 'fg' OR (u.is_stock AND COALESCE(s.is_hold, false)))`;

router.get('/orders/:id/candidates', need(...READ), wrap(async (req, res) => {
  const chans = channelsOf(req);
  const it = (await db.query(
    `SELECT i.id, i.product_id, i.qty, i.color, i.fabric
       FROM order_items i
       JOIN orders o    ON o.id = i.order_id
       JOIN customers c ON c.id = o.customer_id
      WHERE i.id = $1 AND i.order_id = $2
        AND ($3::text[] IS NULL OR c.channel = ANY($3))`,
    [req.query.item_id, req.params.id, chans])).rows[0];
  if (!it) return res.status(404).json({ error: 'Qator topilmadi' });

  //  Rang va mato mos kelgani tepada turadi, lekin mos kelmagani ham
  //  ko'rsatiladi: zavodda «oq» va «Oq lak» bir xil narsa bo'lib chiqadi
  //  va tanlovni menejer qiladi, tizim emas.
  const { rows } = await db.query(
    `SELECT u.id, u.conveyor_no, u.part, u.qty, u.color, u.fabric, u.status,
            u.is_stock, u.fg_on, s.name AS section, sh.name AS shop,
            (LOWER(COALESCE(u.color, '')) = LOWER(COALESCE($2, ''))
             OR $2 IS NULL) AS color_ok,
            (LOWER(COALESCE(u.fabric, '')) = LOWER(COALESCE($3, ''))
             OR $3 IS NULL) AS fabric_ok
       FROM production_units u
       LEFT JOIN sections s ON s.id = u.current_section_id
       LEFT JOIN shops sh   ON sh.id = s.shop_id
      WHERE u.product_id = $1 AND ${CANDIDATE_WHERE}
      ORDER BY (u.status = 'fg') DESC, color_ok DESC, fabric_ok DESC,
               u.conveyor_no, u.part
      LIMIT 200`,
    [it.product_id, it.color || null, it.fabric || null]);
  res.json({ item: it, rows });
}));

router.post('/orders/:id/assign', need(...WRITE), wrap(async (req, res) => {
  const { item_id, unit_id, qty } = req.body;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const o = (await client.query(
      `SELECT o.*, c.channel FROM orders o JOIN customers c ON c.id = o.customer_id
        WHERE o.id = $1 FOR UPDATE OF o`, [req.params.id])).rows[0];
    if (!o) throw new Error('Buyurtma topilmadi');
    const chans = channelsOf(req);
    if (chans && !chans.includes(o.channel))
      throw new Error("Bu buyurtma sizning yo'nalishingizda emas");
    if (o.status === 'cancelled') throw new Error('Buyurtma bekor qilingan');
    if (o.status === 'shipped') throw new Error("Buyurtma jo'natilgan");

    const it = (await client.query(
      `SELECT * FROM order_items WHERE id = $1 AND order_id = $2`,
      [item_id, req.params.id])).rows[0];
    if (!it) throw new Error('Qator topilmadi');

    const u = (await client.query(
      `SELECT u.*, s.is_hold FROM production_units u
         LEFT JOIN sections s ON s.id = u.current_section_id
        WHERE u.id = $1 FOR UPDATE OF u`, [unit_id])).rows[0];
    if (!u) throw new Error('Konver topilmadi');
    if (u.order_item_id) throw new Error(`${u.conveyor_no}: boshqa buyurtmada band`);
    if (u.product_id !== it.product_id)
      throw new Error(`${u.conveyor_no}: boshqa mahsulot`);
    if (!(u.status === 'fg' || (u.status === 'production' && u.is_stock && u.is_hold)))
      throw new Error(`${u.conveyor_no}: faqat ombordagi yoki zahiradagi konver biriktiriladi`);

    const n = qty == null || qty === '' ? u.qty : Number(qty);
    if (!Number.isInteger(n) || n <= 0 || n > u.qty)
      throw new Error(`${u.conveyor_no}: soni 1..${u.qty} oralig'ida`);

    //  Bir qismi olinsa konver bo'linadi: biriktirilgani yangi qator
    //  bo'ladi, qolgani joyida bo'sh turaveradi.
    const id = n < u.qty
      ? await clonePart(client, req, u, n, { keepPlace: true })
      : u.id;

    //  Zakaz raqami va mijoz konverga ham yoziladi: jurnal, zavod
    //  ko'rinishi va ombor shu ustunlarga tayanadi (sql/sales.sql).
    await client.query(
      `UPDATE production_units
          SET order_item_id = $2, order_no = $3, customer_id = $4
        WHERE id = $1`, [id, it.id, o.order_no, o.customer_id]);

    if (o.status === 'new')
      await client.query(`UPDATE orders SET status = 'reserved' WHERE id = $1`, [o.id]);

    await audit(req, { module: 'sales', action: 'assign', entity: 'order',
                       entity_id: o.id,
                       payload: { order_no: o.order_no, conveyor_no: u.conveyor_no,
                                  qty: n } }, client);
    await client.query('COMMIT');
    res.json({ ok: true, unit_id: id, qty: n });
  } catch (e) {
    await client.query('ROLLBACK');
    return res.status(400).json({ error: e.message });
  } finally { client.release(); }
}));

//  Ajratish. Bo'lingan konver qaytadan yaxlitlanadi: shu bo'limda turgan,
//  bo'sh va bir xil raqamli qator bo'lsa donalar unga qo'shiladi va
//  bo'shagan qator o'chadi (tarixi qo'shilgan qatorga ko'chadi) — aks
//  holda biriktirib-ajratgan sayin ombor ro'yxati qator bilan to'lardi.
router.post('/orders/:id/unassign', need(...WRITE), wrap(async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const o = (await client.query(
      `SELECT o.*, c.channel FROM orders o JOIN customers c ON c.id = o.customer_id
        WHERE o.id = $1 FOR UPDATE OF o`, [req.params.id])).rows[0];
    if (!o) throw new Error('Buyurtma topilmadi');
    const chans = channelsOf(req);
    if (chans && !chans.includes(o.channel))
      throw new Error("Bu buyurtma sizning yo'nalishingizda emas");

    const u = (await client.query(
      `SELECT u.* FROM production_units u
         JOIN order_items i ON i.id = u.order_item_id
        WHERE u.id = $1 AND i.order_id = $2 FOR UPDATE OF u`,
      [req.body.unit_id, req.params.id])).rows[0];
    if (!u) throw new Error('Konver bu buyurtmada emas');

    await client.query(
      `UPDATE production_units SET order_item_id = NULL, order_no = NULL,
              customer_id = NULL WHERE id = $1`, [u.id]);

    const free = (await client.query(
      `SELECT id FROM production_units
        WHERE conveyor_no = $1 AND id <> $2 AND order_item_id IS NULL
          AND status = $3 AND current_section_id IS NOT DISTINCT FROM $4::int
        ORDER BY id LIMIT 1 FOR UPDATE`,
      [u.conveyor_no, u.id, u.status, u.current_section_id])).rows[0];
    if (free) {
      await client.query(`UPDATE production_units SET qty = qty + $2 WHERE id = $1`,
                         [free.id, u.qty]);
      await client.query(`UPDATE unit_moves SET unit_id = $2 WHERE unit_id = $1`,
                         [u.id, free.id]);
      await client.query(`DELETE FROM production_units WHERE id = $1`, [u.id]);
    }

    //  Biriktirilgani qolmasa buyurtma yana "yangi" bo'ladi: holat
    //  saqlangan belgi emas, konverlardan kelib chiqadi.
    await client.query(
      `UPDATE orders o SET status = 'new'
        WHERE o.id = $1 AND o.status = 'reserved'
          AND NOT EXISTS (SELECT 1 FROM production_units x
                            JOIN order_items i ON i.id = x.order_item_id
                           WHERE i.order_id = $1 AND x.status <> 'cancelled')`,
      [o.id]);

    await audit(req, { module: 'sales', action: 'unassign', entity: 'order',
                       entity_id: o.id,
                       payload: { order_no: o.order_no,
                                  conveyor_no: u.conveyor_no, qty: u.qty } }, client);
    await client.query('COMMIT');
    res.json({ ok: true, merged: !!free });
  } catch (e) {
    await client.query('ROLLBACK');
    return res.status(400).json({ error: e.message });
  } finally { client.release(); }
}));

module.exports = router;
