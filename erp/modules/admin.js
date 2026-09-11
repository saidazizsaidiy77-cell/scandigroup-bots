// ============================================================================
//  BOSHQARUV MODULI — xodimlar va rollar
//  Huquq: admin.users
// ============================================================================
const express = require('express');
const { db, wrap, audit } = require('../db');
const { need } = require('../auth');

const router = express.Router();

router.get('/workers', need('admin.users'), wrap(async (_req, res) => {
  const { rows } = await db.query(
    `SELECT w.id, w.name, w.phone, w.pin, w.tg_id, w.active,
            COALESCE(json_agg(json_build_object(
              'code', wr.role_code, 'name', r.name, 'surface', r.surface,
              'scope_shop_id', wr.scope_shop_id, 'scope_shop', sh.name
            ) ORDER BY r.sort) FILTER (WHERE wr.role_code IS NOT NULL), '[]') AS roles
       FROM workers w
       LEFT JOIN worker_roles wr ON wr.worker_id = w.id
       LEFT JOIN roles r         ON r.code = wr.role_code
       LEFT JOIN shops sh        ON sh.id = wr.scope_shop_id
      GROUP BY w.id ORDER BY w.active DESC, w.name`);
  res.json(rows);
}));

router.get('/roles', need('admin.users'), wrap(async (_req, res) => {
  const [roles, shops] = await Promise.all([
    db.query(`SELECT r.code, r.name, r.surface,
                     COUNT(rp.permission_code) AS permission_count
                FROM roles r LEFT JOIN role_permissions rp ON rp.role_code = r.code
               GROUP BY r.code, r.name, r.surface, r.sort ORDER BY r.sort`),
    db.query(`SELECT id, name FROM shops ORDER BY sort`),
  ]);
  res.json({ roles: roles.rows, shops: shops.rows });
}));

// Telegram ID — RAQAM, @nom emas (bazada bigint). Bot ichida /myid
// yozilganda aynan shu raqam chiqadi. Xodim @nomini yozsa baza
// "invalid input syntax for type bigint" deb javob berardi — bu xabar
// hech kimga hech narsa tushuntirmaydi, shuning uchun tekshiruv shu yerda.
//
// Maydon ixtiyoriy: u faqat Telegram ilovasi orqali kirish uchun kerak,
// saytga PIN bilan kiriladi.
function tgId(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (!/^\d{1,19}$/.test(s)) {
    const e = new Error(
      "Telegram ID raqam bo'lishi kerak (masalan 123456789), @nom emas. " +
      "Bilmasangiz bo'sh qoldiring — saytga PIN bilan kiriladi.");
    e.status = 400;
    throw e;
  }
  return s;
}

router.post('/workers', need('admin.users'), wrap(async (req, res) => {
  const { name, phone, pin, tg_id, roles = [] } = req.body;
  if (!name || !String(name).trim())
    return res.status(400).json({ error: 'Ism majburiy' });
  if (pin && !/^\d{4,6}$/.test(String(pin)))
    return res.status(400).json({ error: 'PIN 4-6 raqamdan iborat bo\'lishi kerak' });
  const tg = tgId(tg_id);

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const w = (await client.query(
      `INSERT INTO workers (name, phone, pin, tg_id) VALUES ($1,$2,$3,$4) RETURNING id`,
      [name.trim(), phone || null, pin ? String(pin) : null, tg])).rows[0];
    for (const r of roles) {
      await client.query(
        `INSERT INTO worker_roles (worker_id, role_code, scope_shop_id) VALUES ($1,$2,$3)`,
        [w.id, r.code, r.scope_shop_id || null]);
    }
    await audit(req, { module: 'admin', action: 'create', entity: 'worker',
                       entity_id: w.id, payload: { name, roles } }, client);
    await client.query('COMMIT');
    res.json({ id: w.id });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return res.status(409).json({ error: 'Bu PIN yoki Telegram ID band' });
    throw e;
  } finally {
    client.release();
  }
}));

router.patch('/workers/:id', need('admin.users'), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { name, phone, pin, tg_id, active, roles } = req.body;
  if (pin && !/^\d{4,6}$/.test(String(pin)))
    return res.status(400).json({ error: 'PIN 4-6 raqamdan iborat bo\'lishi kerak' });
  const tg = tgId(tg_id);

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE workers SET
         name   = COALESCE($2, name),
         phone  = COALESCE($3, phone),
         pin    = COALESCE($4, pin),
         tg_id  = COALESCE($5, tg_id),
         active = COALESCE($6, active)
       WHERE id = $1`,
      [id, name || null, phone || null, pin ? String(pin) : null,
       tg, typeof active === 'boolean' ? active : null]);
    if (Array.isArray(roles)) {
      await client.query(`DELETE FROM worker_roles WHERE worker_id = $1`, [id]);
      for (const r of roles) {
        await client.query(
          `INSERT INTO worker_roles (worker_id, role_code, scope_shop_id) VALUES ($1,$2,$3)`,
          [id, r.code, r.scope_shop_id || null]);
      }
    }
    // Rol yoki holat o'zgarsa sessiyalar bekor qilinadi — huquq darhol kuchga kiradi
    if (Array.isArray(roles) || active === false)
      await client.query(`DELETE FROM sessions WHERE worker_id = $1`, [id]);
    await audit(req, { module: 'admin', action: 'update', entity: 'worker',
                       entity_id: id, payload: req.body }, client);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return res.status(409).json({ error: 'Bu PIN yoki Telegram ID band' });
    throw e;
  } finally {
    client.release();
  }
}));

router.get('/audit', need('admin.audit'), wrap(async (_req, res) => {
  const { rows } = await db.query(
    `SELECT a.ts, w.name AS worker, a.module, a.action, a.entity, a.entity_id, a.payload
       FROM audit_log a LEFT JOIN workers w ON w.id = a.worker_id
      ORDER BY a.ts DESC LIMIT 100`);
  res.json(rows);
}));

module.exports = router;
