// ══════════════════════════════════════════ MIJOZDAN QAYTARISH
//
//  ★ ZAVOD QARORI (2026-10). Chiqib ketgan mahsulot qaytadi — brak,
//  o'lcham, mijoz fikrini o'zgartirdi — va buning yo'li yo'q edi:
//  mijozning qarzi ham, ombor ham yolg'on bo'lib qolardi.
//
//  Ikki odam, ikki bosqich (vitrinadan qaytarish bilan bir xil idiom):
//      savdo menejeri  hujjatni yozadi                 new
//      ombor mudiri    mahsulotni ko'rib qabul qiladi  accepted
//  Qarz ham, ombor ham FAQAT qabul qilinganda o'zgaradi: yo'lda turgan
//  mahsulot hali mijozniki va uning qarzida.
//
//  Qabulda har konver uchun QAYERGA ketishi so'raladi — butun bo'lsa
//  T/M omborga (qayta sotiladi), brak bo'lsa tsexga tuzatishga yoki
//  hisobdan chiqariladi. Konverning BIR QISMI qaytadi: 10 talikdan 2
//  tasi.
//
//  ★ CHIQIB KETGAN QATOR TARIXDA O'Z HOLICHA QOLADI (izoh:
//  sql/warehouse.sql): unga faqat `returned_qty` qo'shiladi, qaytgan
//  dona esa YANGI bo'lak bo'lib tug'iladi. Mijoz imzolagan yuk xati
//  10 ta degan — dalolatnomada chiqim ham, qaytarish ham o'z kunida
//  turadi.
//
//  ★ SUMMA — SOTILGAN NARX (yuk xatidan, `unit_price`), hujjat
//  yozilganda qotadi: mijoz qancha to'lagan bo'lsa shuncha qaytadi.
const express = require('express');
const { db, wrap, audit } = require('../db');
const { need, ownOf } = require('../auth');
const notify = require('../notify');
const { refreshStock } = require('./units');

const router = express.Router();
const READ   = ['sales.view', 'sales.manage', 'warehouse.view',
                'warehouse.move', 'warehouse.manage'];
const WRITE  = ['sales.manage'];
const ACCEPT = ['warehouse.move', 'warehouse.manage', 'production.manage'];
const bor = (req, ...p) => p.some((x) => req.user.permissions.includes(x));

//  ★ SAVDO DOIRASI — CHEGARA (`channelsOf`, `ownOf`): menejer faqat o'z
//  mijozining qaytarishini ko'radi va yozadi. Ombor mudirida savdo
//  doirasi yo'q — u qabul qiladi va hammasini ko'rishi kerak.
const chans = (req) => {
  const c = req.user?.scope_channels || [];
  return c.length ? c : null;
};
async function mijoz(c, req, id) {
  const m = (await c.query(
    `SELECT id, name, channel, manager_id FROM customers WHERE id = $1`, [id])).rows[0];
  if (!m) throw Object.assign(new Error('Mijoz topilmadi'), { status: 404 });
  const ch = chans(req), own = ownOf(req);
  if ((ch && !ch.includes(m.channel)) || (own && m.manager_id !== own))
    throw Object.assign(new Error('Bu mijoz sizning doirangizda emas'), { status: 403 });
  return m;
}

//  Hujjat raqami: R26-0001. Konver `K`, zakaz `Z`, pul `P`, vitrina `V`.
//  Tranzaksiya qulfi bilan — ikki odam bir vaqtda yozsa ham takrorlanmaydi.
async function nextNo(c) {
  await c.query(`SELECT pg_advisory_xact_lock(hashtext('cust_returns'))`);
  const prefix = `R${String(new Date().getFullYear()).slice(-2)}-`;
  const { rows } = await c.query(
    `SELECT COALESCE(MAX(SUBSTRING(doc_no FROM '\\d+$')::int), 0) + 1 AS n
       FROM cust_returns WHERE doc_no LIKE $1`, [`${prefix}%`]);
  return prefix + String(rows[0].n).padStart(4, '0');
}

//  Qaytarsa bo'ladigan dona: chiqqani − qaytib bo'lgani − yozilgan,
//  lekin hali qabul qilinmagan hujjatlarda turgani (ikki hujjat bitta
//  donani ikki marta qaytarmasin).
const BOSH = `(u.qty - u.returned_qty - COALESCE((
    SELECT SUM(i.qty) FROM cust_return_items i
      JOIN cust_returns r ON r.id = i.return_id AND r.status = 'new'
     WHERE i.unit_id = u.id), 0))::int`;

router.get('/units', need(...WRITE), wrap(async (req, res) => {
  const m = await mijoz(db, req, Number(req.query.customer_id));
  const { rows } = await db.query(
    `SELECT u.id, u.conveyor_no, u.part, u.qty, u.returned_qty, u.unit_price,
            u.ship_on, u.order_no, u.color, u.fabric,
            p.name AS product, g.name AS product_type, g.uom,
            ${BOSH} AS available
       FROM production_units u
       JOIN products p       ON p.id = u.product_id
       JOIN product_groups g ON g.id = p.group_id
      WHERE u.status = 'shipped' AND u.customer_id = $1 AND ${BOSH} > 0
      ORDER BY u.ship_on DESC NULLS LAST, u.conveyor_no`, [m.id]);
  res.json({ customer: m, rows });
}));

router.get('/', need(...READ), wrap(async (req, res) => {
  const ombor = bor(req, ...ACCEPT);
  const { rows } = await db.query(
    `SELECT r.*, c.name AS customer_name, cw.name AS created_by_name,
            aw.name AS accepted_by_name,
            COALESCE(SUM(i.qty * COALESCE(i.price, 0)), 0)::numeric(16,2) AS amount,
            COALESCE(SUM(i.qty), 0)::int AS qty,
            JSON_AGG(JSON_BUILD_OBJECT(
              'id', i.id, 'unit_id', i.unit_id, 'conveyor_no', u.conveyor_no,
              'order_no', u.order_no, 'product', p.name, 'product_type', g.name,
              'uom', g.uom, 'color', u.color, 'qty', i.qty, 'price', i.price,
              'dest', i.dest, 'section', s.name, 'new_unit_id', i.new_unit_id,
              'product_id', u.product_id,
              --  Tuzatishga qaytarishda bo'lim shu marshrutdan tanlanadi
              'route', (SELECT JSON_AGG(JSON_BUILD_OBJECT('id', s2.id, 'name', s2.name)
                                        ORDER BY rs.sort)
                          FROM route_steps rs JOIN sections s2 ON s2.id = rs.section_id
                         WHERE rs.template_id = p.route_template_id))
              ORDER BY i.id) AS items
       FROM cust_returns r
       JOIN customers c          ON c.id = r.customer_id
       LEFT JOIN workers cw      ON cw.id = r.created_by
       LEFT JOIN workers aw      ON aw.id = r.accepted_by
       JOIN cust_return_items i  ON i.return_id = r.id
       JOIN production_units u   ON u.id = i.unit_id
       JOIN products p           ON p.id = u.product_id
       JOIN product_groups g     ON g.id = p.group_id
       LEFT JOIN sections s      ON s.id = i.section_id
      WHERE ($1::text IS NULL OR r.status = $1)
        AND ($2::boolean OR (($3::text[] IS NULL OR c.channel = ANY($3))
                             AND ($4::int IS NULL OR c.manager_id = $4)))
      GROUP BY r.id, c.name, cw.name, aw.name
      ORDER BY (r.status = 'new') DESC, r.id DESC
      LIMIT 500`,
    [req.query.status || null, ombor, chans(req), ownOf(req)]);
  res.json({ rows, can: { write: bor(req, ...WRITE), accept: ombor } });
}));

router.post('/', need(...WRITE), wrap(async (req, res) => {
  const note = String(req.body.note || '').trim();
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!note) return res.status(400).json({ error: 'Sababi yozilmagan' });
  if (!items.length) return res.status(400).json({ error: 'Konver tanlanmagan' });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const m = await mijoz(client, req, Number(req.body.customer_id));
    const qatorlar = [];
    for (const it of items) {
      const n = Number(it.qty);
      const u = (await client.query(
        `SELECT u.*, ${BOSH} AS available FROM production_units u
          WHERE u.id = $1 FOR UPDATE`, [it.unit_id])).rows[0];
      if (!u) throw new Error('Konver topilmadi');
      if (u.status !== 'shipped' || u.customer_id !== m.id)
        throw new Error(`${u.conveyor_no}: bu mijozga chiqib ketmagan`);
      if (!Number.isInteger(n) || n <= 0)
        throw new Error(`${u.conveyor_no}: soni noto'g'ri`);
      if (n > u.available)
        throw new Error(`${u.conveyor_no}: ko'pi bilan ${u.available} ta qaytarish mumkin`);
      qatorlar.push({ u, n });
    }
    const docNo = await nextNo(client);
    const r = (await client.query(
      `INSERT INTO cust_returns (doc_no, customer_id, note, created_by)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [docNo, m.id, note, req.user.id])).rows[0];
    for (const { u, n } of qatorlar)
      await client.query(
        `INSERT INTO cust_return_items (return_id, unit_id, qty, price)
         VALUES ($1,$2,$3,$4)`, [r.id, u.id, n, u.unit_price]);
    //  Ombor mudiri sayt ochiq bo'lmaganda ham bilsin — mashina
    //  ertalab keladi va u eshik oldida kutib olishi kerak.
    await notify.queueWarehouse({
      perms: ACCEPT, module: 'warehouse', kind: 'cust_return',
      title: `Mijozdan qaytarish — ${docNo}`,
      body: `${m.name} · ${qatorlar.reduce((a, x) => a + x.n, 0)} dona\n`
          + qatorlar.map(({ u, n }) => `${u.conveyor_no} — ${n} ta`).join('\n')
          + `\nSabab: ${note}`,
      except: req.user.id }, client);
    await audit(req, { module: 'sales', action: 'return-create', entity: 'cust_returns',
                       entity_id: r.id, payload: { doc_no: docNo, lines: qatorlar.length } },
                client);
    await client.query('COMMIT');
    res.json({ id: r.id, doc_no: docNo });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(e.status || 400).json({ error: e.message });
  } finally { client.release(); }
}));

router.post('/:id/accept', need(...ACCEPT), wrap(async (req, res) => {
  const on = /^\d{4}-\d{2}-\d{2}$/.test(req.body.on || '') ? req.body.on : null;
  const tanlov = new Map((Array.isArray(req.body.items) ? req.body.items : [])
    .map((x) => [Number(x.id), x]));
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const r = (await client.query(
      `SELECT * FROM cust_returns WHERE id = $1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!r) throw Object.assign(new Error('Hujjat topilmadi'), { status: 404 });
    if (r.status !== 'new') throw new Error('Hujjat allaqachon yopilgan');
    const bugun = (await client.query(`SELECT CURRENT_DATE::text AS d`)).rows[0].d;
    if (on && on > bugun) throw new Error('Kelajakdagi sana bo\'lmaydi');
    //  Sana BAZADAN (mahalliy kun) — `toISOString()` UTC beradi va
    //  ertalab kechagi kunni qaytarardi (izoh: erp/db.js).
    const kun = on || bugun;
    const tm = (await client.query(`SELECT id FROM warehouses WHERE code = 'TM'`)).rows[0];
    const items = (await client.query(
      `SELECT * FROM cust_return_items WHERE return_id = $1 ORDER BY id`, [r.id])).rows;

    for (const it of items) {
      const t = tanlov.get(it.id) || {};
      const dest = ['fg', 'shop', 'writeoff'].includes(t.dest) ? t.dest : null;
      const u = (await client.query(
        `SELECT * FROM production_units WHERE id = $1 FOR UPDATE`, [it.unit_id])).rows[0];
      if (!dest) throw new Error(`${u.conveyor_no}: qayerga ketishi tanlanmagan`);
      if (u.status !== 'shipped' || u.qty - u.returned_qty < it.qty)
        throw new Error(`${u.conveyor_no}: qaytaradigan dona qolmagan`);
      //  Tuzatishga — marshrutdagi bo'limga yoki «boshlanmagan»
      let sec = null;
      if (dest === 'shop' && t.section_id) {
        sec = Number(t.section_id);
        const ok = (await client.query(
          `SELECT 1 FROM route_steps rs
             JOIN products p ON p.route_template_id = rs.template_id
            WHERE p.id = $1 AND rs.section_id = $2`, [u.product_id, sec])).rowCount;
        if (!ok) throw new Error(`${u.conveyor_no}: bu bo'lim mahsulot marshrutida yo'q`);
      }
      await client.query(
        `UPDATE production_units SET returned_qty = returned_qty + $2 WHERE id = $1`,
        [u.id, it.qty]);
      const holat = dest === 'fg' ? 'fg' : dest === 'shop' ? 'production' : 'cancelled';
      const yangi = (await client.query(
        `INSERT INTO production_units
           (conveyor_no, part, product_id, qty, started_on, current_section_id,
            entered_section_on, unit_price, status, note, created_by, color, fabric,
            lak_on, pack_on, fg_on, fg_by, warehouse_id)
         VALUES ($1, (SELECT MAX(part) + 1 FROM production_units WHERE conveyor_no = $1),
                 $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         RETURNING id`,
        [u.conveyor_no, u.product_id, it.qty, u.started_on,
         dest === 'shop' ? sec : u.current_section_id,
         dest === 'shop' ? kun : u.entered_section_on,
         u.unit_price, holat, `Mijozdan qaytdi · ${r.doc_no}`, req.user.id,
         u.color, u.fabric, u.lak_on, dest === 'shop' ? null : u.pack_on,
         dest === 'fg' ? kun : null,
         dest === 'fg' ? req.user.id : null,
         dest === 'fg' ? tm.id : null])).rows[0].id;
      if (dest === 'shop' && sec)
        await client.query(
          `INSERT INTO unit_moves (unit_id, section_id, moved_on, qty, worker_id, note)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [yangi, sec, kun, it.qty, req.user.id, `Mijozdan qaytdi · ${r.doc_no}`]);
      await client.query(
        `UPDATE cust_return_items SET dest = $2, section_id = $3, new_unit_id = $4
          WHERE id = $1`, [it.id, dest, sec, yangi]);
      await refreshStock(client, u.product_id);
    }
    await client.query(
      `UPDATE cust_returns SET status = 'accepted', accepted_by = $2,
              accepted_on = $3, ret_on = $3
        WHERE id = $1`, [r.id, req.user.id, kun]);
    await audit(req, { module: 'warehouse', action: 'return-accept', entity: 'cust_returns',
                       entity_id: r.id, payload: { doc_no: r.doc_no, lines: items.length } },
                client);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(e.status || 400).json({ error: e.message });
  } finally { client.release(); }
}));

//  Rad etish ham, yozgan odamning bekor qilishi ham bitta yo'ldan,
//  holati boshqa: `rejected` — mudirniki, `cancelled` — o'zinikidir.
//  Sabab ikkalasida ham so'raladi.
router.post('/:id/reject', need(...WRITE, ...ACCEPT), wrap(async (req, res) => {
  const sabab = String(req.body.note || '').trim();
  if (!sabab) return res.status(400).json({ error: 'Sabab yozilmagan' });
  const r = (await db.query(`SELECT * FROM cust_returns WHERE id = $1`, [req.params.id])).rows[0];
  if (!r) return res.status(404).json({ error: 'Hujjat topilmadi' });
  if (r.status !== 'new') return res.status(400).json({ error: 'Hujjat allaqachon yopilgan' });
  const ozi = r.created_by === req.user.id;
  if (!ozi && !bor(req, ...ACCEPT))
    return res.status(403).json({ error: 'Boshqa xodimning hujjatini faqat ombor rad etadi' });
  const holat = ozi ? 'cancelled' : 'rejected';
  await db.query(
    `UPDATE cust_returns SET status = $2, decided_by = $3, decided_at = NOW(),
            decide_note = $4 WHERE id = $1 AND status = 'new'`,
    [r.id, holat, req.user.id, sabab]);
  await audit(req, { module: 'sales', action: 'return-' + holat, entity: 'cust_returns',
                     entity_id: r.id, payload: { doc_no: r.doc_no, note: sabab } });
  res.json({ ok: true, status: holat });
}));

module.exports = router;
