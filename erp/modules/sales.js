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

module.exports = router;
