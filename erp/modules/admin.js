// ============================================================================
//  BOSHQARUV MODULI — xodimlar va rollar
//  Huquq: admin.users
// ============================================================================
const express = require('express');
const { db, wrap, audit } = require('../db');
const { need } = require('../auth');
const pin = require('../pin');

const router = express.Router();

//  PIN qayerga yoziladi: maxfiy kalit bor bo'lsa IZGA, yo'q bo'lsa
//  eskicha ochiq ustunga (izoh: `erp/pin.js`). Ikkalasi bir vaqtda
//  to'lmaydi — aks holda ko'chirish qaysi biri haqiqiy ekanini
//  bilmasdi. Qaytadi: [pin, pin_hash].
const pinCols = (kod) => (kod && pin.ready) ? [null, pin.hash(kod)] : [kod, null];

//  ★ TSEX BO'LIMDAN CHIQADI, ikkalasi alohida so'ralmaydi. Bo'lim
//  tanlangan bo'lsa tsexi ham o'sha bo'limniki: ikki katak alohida
//  to'ldirilsa bir kun ular qarama-qarshi bo'lib qolardi — odam
//  «Korpus tsexi» da turib, bo'limi stulnikida bo'lardi va ishbay
//  oylik qaysi biriga yozilishi noaniq qolardi (izoh: sql/production.sql).
async function shtat(client, body) {
  const secId = body.section_id ? Number(body.section_id) : null;
  let shopId  = body.shop_id    ? Number(body.shop_id)    : null;
  //  ★ TSEX BO'LIMSIZ HAM QO'YILADI. Tsex boshlig'ining bo'limi
  //  YO'Q — u butun tsexga mas'ul; ilgari tsexni faqat bo'lim orqali
  //  tanlash mumkin edi va boshliqning tsexi bo'sh qolib ketardi.
  if (shopId) {
    const r = await client.query(`SELECT 1 FROM shops WHERE id = $1`, [shopId]);
    if (!r.rows.length) { const e = new Error('Bunday tsex yo\'q'); e.status = 400; throw e; }
  }
  //  Bo'lim tanlangan bo'lsa tsex O'SHANIKI: ikkalasi alohida
  //  to'ldirilsa bir kun qarama-qarshi bo'lib qolardi — odam «Korpus
  //  tsexi» da turib, bo'limi stulnikida bo'lardi.
  if (secId) {
    const r = await client.query(`SELECT shop_id FROM sections WHERE id = $1`, [secId]);
    if (!r.rows.length) { const e = new Error('Bunday bo\'lim yo\'q'); e.status = 400; throw e; }
    shopId = r.rows[0].shop_id;
  }
  const t = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());
  return { shop_id: shopId, section_id: secId,
           staff_group: t(body.staff_group), dept: t(body.dept),
           position: t(body.position), hired_at: t(body.hired_at) };
}

router.get('/workers', need('admin.users'), wrap(async (_req, res) => {
  const { rows } = await db.query(
    //  ★ PIN QAYTARILMAYDI. Bazada uning izi turadi va izdan raqamni
    //  tiklab bo'lmaydi (izoh: `erp/pin.js`) — shuning uchun ro'yxatda
    //  faqat «qo'yilganmi yoki yo'q» ko'rinadi. Unutilgan PIN topilmaydi,
    //  YANGISI qo'yiladi.
    `SELECT w.id, w.name, w.phone, w.tg_id, w.active, w.can_hold_cash,
            --  Inkassator: pulni hamma mijozdan u yig'adi
            --  (izoh: sql/cash.sql).
            w.cash_all_customers,
            --  Qo'lidagi pulni harajatga yozadimi (izoh: sql/cash.sql).
            w.can_spend_cash,
            --  Ombor bo'limi shu xodimga ochiladimi (izoh: sql/warehouse.sql).
            w.sees_warehouse,
            --  ★ SHTAT JOYI: guruh, tsex, bo'lim va lavozim
            --  (izoh: sql/production.sql). Ishbay oylik shundan
            --  hisoblanadi, shuning uchun dasturga KIRMAYDIGAN xodim
            --  ham shu ro'yxatda turadi.
            w.staff_group, w.shop_id, w.section_id, w.dept, w.position,
            wsh.name AS shop, wsc.name AS section,
            (w.pin IS NOT NULL OR w.pin_hash IS NOT NULL) AS has_pin,
            --  Qo'lidagi pulni qaysi harajat guruhlariga sarflay oladi.
            --  BO'SH = hammasi (izoh: sql/cash.sql).
            COALESCE((SELECT array_agg(g.group_code ORDER BY g.group_code)
                        FROM worker_expense_groups g
                       WHERE g.worker_id = w.id), '{}') AS cash_groups,
            COALESCE(json_agg(json_build_object(
              'code', wr.role_code, 'name', r.name, 'surface', r.surface,
              'scope_shop_id', wr.scope_shop_id, 'scope_shop', sh.name,
              'scope_channel', wr.scope_channel, 'scope_channel_name', ch.name,
              --  ★ Qaysi narx bilan ishlaydi: ulgurji yoki chakana
              --  (izoh: sql/sales.sql). Ismi kodga yozilmaydi.
              'price_kind', wr.price_kind,
              -- Vitrina sotuvchisi qaysi nuqtada ishlaydi (sql/warehouse.sql)
              'scope_warehouse_id', wr.scope_warehouse_id, 'scope_warehouse', wh.name
            ) ORDER BY r.sort) FILTER (WHERE wr.role_code IS NOT NULL), '[]') AS roles
       FROM workers w
       LEFT JOIN shops    wsh ON wsh.id = w.shop_id
       LEFT JOIN sections wsc ON wsc.id = w.section_id
       LEFT JOIN worker_roles wr ON wr.worker_id = w.id
       LEFT JOIN roles r         ON r.code = wr.role_code
       LEFT JOIN shops sh        ON sh.id = wr.scope_shop_id
       LEFT JOIN customer_channels ch ON ch.code = wr.scope_channel
       LEFT JOIN warehouses wh   ON wh.id = wr.scope_warehouse_id
      GROUP BY w.id, wsh.name, wsc.name ORDER BY w.active DESC, w.name`);
  res.json(rows);
}));

router.get('/roles', need('admin.users'), wrap(async (_req, res) => {
  const [roles, shops, channels, houses, eg, secs, sgroups] = await Promise.all([
    db.query(`SELECT r.code, r.name, r.surface,
                     COUNT(rp.permission_code) AS permission_count
                FROM roles r LEFT JOIN role_permissions rp ON rp.role_code = r.code
               GROUP BY r.code, r.name, r.surface, r.sort ORDER BY r.sort`),
    db.query(`SELECT id, name FROM shops ORDER BY sort`),
    // Savdo yo'nalishlari: xodimga biriktiriladi (izoh: sql/units.sql)
    db.query(`SELECT code, name FROM customer_channels ORDER BY sort, name`),
    // Vitrinalar: savdo xodimiga nuqtasi biriktiriladi. T/M ombor
    // ro'yxatda yo'q — u hammaga ochiq va tanlanadigan narsa emas.
    db.query(`SELECT id, name FROM warehouses
               WHERE kind = 'fg' AND is_active AND code <> 'TM'
               ORDER BY sort, name`),
    // Harajat guruhlari: qo'liga pul beriladigan xodim nimaga
    // sarflay olishi shu ro'yxatdan belgilanadi.
    db.query(`SELECT code, name FROM expense_groups ORDER BY sort, name`),
    //  Bo'limlar: xodimning SHTAT joyi (izoh: sql/production.sql).
    //  Rol doirasi bilan adashtirmaslik kerak — u tsex bo'yicha
    //  qo'yiladi va bo'limga tushmaydi.
    db.query(`SELECT sc.id, sc.name, sc.shop_id, sh.name AS shop
                FROM sections sc JOIN shops sh ON sh.id = sc.shop_id
               WHERE sc.active ORDER BY sh.sort, sc.sort`),
    //  ★ GURUH RO'YXATI IKKI MANBADAN. Shtatda ishlatilgani ham,
    //  OYLIK MODDASI kutayotgani ham (`expense_items.staff_group`):
    //  yangi modda qo'shilganda uning guruhi hali hech kimda yo'q va
    //  ro'yxatda ham turmasdi — odam uni qo'lda terardi, «ITR» va
    //  «itr » ikkita guruh bo'lib qolardi va modda ikkalasining
    //  birini ham topmasdi. Endi u modda qo'shilgan zahoti tanlanadi.
    db.query(`SELECT DISTINCT g FROM (
                SELECT staff_group AS g FROM workers
                 WHERE staff_group IS NOT NULL AND btrim(staff_group) <> ''
                UNION
                SELECT staff_group FROM expense_items
                 WHERE active AND staff_group IS NOT NULL
                   AND btrim(staff_group) <> '') t
               ORDER BY g`),
  ]);
  res.json({ roles: roles.rows, shops: shops.rows, channels: channels.rows,
             warehouses: houses.rows, expense_groups: eg.rows,
             sections: secs.rows,
             staff_groups: sgroups.rows.map(r => r.g) });
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

//  Qaysi harajat guruhlariga sarflay oladi. Yuborilmasa TEGILMAYDI:
//  kartochka boshqa maydon uchun saqlansa cheklov o'chib qolmasin.
//  Bo'sh ro'yxat esa ataylab: «hamma guruh» degani (izoh: sql/cash.sql).
async function saveCashGroups(client, workerId, codes) {
  if (!Array.isArray(codes)) return;
  await client.query(`DELETE FROM worker_expense_groups WHERE worker_id = $1`,
                     [workerId]);
  for (const c of codes) {
    await client.query(
      `INSERT INTO worker_expense_groups (worker_id, group_code)
       SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM expense_groups WHERE code = $2)
       ON CONFLICT DO NOTHING`, [workerId, c]);
  }
}

router.post('/workers', need('admin.users'), wrap(async (req, res) => {
  const { name, phone, tg_id, can_hold_cash, cash_all_customers,
          can_spend_cash, sees_warehouse, roles = [] } = req.body;
  if (!name || !String(name).trim())
    return res.status(400).json({ error: 'Ism majburiy' });
  const kod = req.body.pin ? String(req.body.pin) : null;
  if (kod && !/^\d{4,6}$/.test(kod))
    return res.status(400).json({ error: 'PIN 4-6 raqamdan iborat bo\'lishi kerak' });
  const tg = tgId(tg_id);

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const st = await shtat(client, req.body);
    const w = (await client.query(
      `INSERT INTO workers (name, phone, pin, pin_hash, tg_id, can_hold_cash,
                            cash_all_customers, can_spend_cash, sees_warehouse,
                            staff_group, shop_id, section_id, dept, position, hired_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [name.trim(), phone || null, ...pinCols(kod), tg,
       can_hold_cash === true, cash_all_customers === true,
       //  Standarti — YOZADI: qo'lida pul turgan odam uni hisobdan
       //  chiqara olsin (izoh: sql/cash.sql).
       can_spend_cash !== false,
       //  Standarti — KO'RADI: hech kimning ekrani o'zidan-o'zi
       //  o'zgarmaydi (izoh: sql/warehouse.sql).
       sees_warehouse !== false,
       st.staff_group, st.shop_id, st.section_id, st.dept, st.position,
       st.hired_at])).rows[0];
    for (const r of roles) {
      await client.query(
        `INSERT INTO worker_roles (worker_id, role_code, scope_shop_id, scope_channel,
                                   scope_warehouse_id, scope_own, price_kind)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [w.id, r.code, r.scope_shop_id || null, r.scope_channel || null,
         r.scope_warehouse_id || null, r.scope_own === true,
         r.price_kind === 'retail' ? 'retail' : null]);
    }
    await saveCashGroups(client, w.id, req.body.cash_groups);
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
  const { name, phone, tg_id, active, can_hold_cash, cash_all_customers,
          can_spend_cash, sees_warehouse, roles } = req.body;
  const kod = req.body.pin ? String(req.body.pin) : null;
  if (kod && !/^\d{4,6}$/.test(kod))
    return res.status(400).json({ error: 'PIN 4-6 raqamdan iborat bo\'lishi kerak' });
  const tg = tgId(tg_id);

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const st = await shtat(client, req.body);
    await client.query(
      `UPDATE workers SET
         name   = COALESCE($2, name),
         phone  = COALESCE($3, phone),
         --  PIN yuborilgan bo'lsa IKKALA ustun ham qayta yoziladi:
         --  yangisi izga tushadi, ochiq ustun bo'shaydi.
         pin      = CASE WHEN $8::boolean THEN $4 ELSE pin END,
         pin_hash = CASE WHEN $8::boolean THEN $9 ELSE pin_hash END,
         tg_id  = COALESCE($5, tg_id),
         active = COALESCE($6, active),
         --  Qo'liga pul beriladigan xodim (izoh: sql/cash.sql). Belgi
         --  yuborilmasa tegilmaydi: kartochka boshqa maydon uchun
         --  saqlansa belgi o'chib qolmasin.
         can_hold_cash = COALESCE($7, can_hold_cash),
         --  Inkassator belgisi ham shunday: yuborilmasa tegilmaydi.
         cash_all_customers = COALESCE($10, cash_all_customers),
         can_spend_cash = COALESCE($11, can_spend_cash),
         sees_warehouse = COALESCE($12, sees_warehouse),
         --  ★ SHTAT MAYDONLARI: yuborilgani YOZILADI, yuborilmagani
         --  tegilmaydi. Bo'sh yuborilgani «tegma» emas, «yo'q»
         --  degani — shuning uchun maydon KELGANMI degan belgi
         --  alohida uzatiladi (kartochka boshqa maydon uchun
         --  saqlansa bo'lim o'chib qolmasin).
         staff_group = CASE WHEN $13::boolean THEN $14::text ELSE staff_group END,
         shop_id     = CASE WHEN $13::boolean THEN $15::int  ELSE shop_id     END,
         section_id  = CASE WHEN $13::boolean THEN $16::int  ELSE section_id  END,
         dept        = CASE WHEN $13::boolean THEN $17::text ELSE dept        END,
         position    = CASE WHEN $13::boolean THEN $18::text ELSE position    END,
         hired_at    = CASE WHEN $13::boolean THEN $19::date ELSE hired_at    END
       WHERE id = $1`,
      [id, name || null, phone || null, pinCols(kod)[0],
       tg, typeof active === 'boolean' ? active : null,
       typeof can_hold_cash === 'boolean' ? can_hold_cash : null,
       kod !== null, pinCols(kod)[1],
       typeof cash_all_customers === 'boolean' ? cash_all_customers : null,
       typeof can_spend_cash === 'boolean' ? can_spend_cash : null,
       typeof sees_warehouse === 'boolean' ? sees_warehouse : null,
       'staff_group' in req.body || 'section_id' in req.body ||
         'position' in req.body || 'dept' in req.body || 'shop_id' in req.body,
       st.staff_group, st.shop_id, st.section_id, st.dept, st.position,
       st.hired_at]);
    if (Array.isArray(roles)) {
      await client.query(`DELETE FROM worker_roles WHERE worker_id = $1`, [id]);
      for (const r of roles) {
        await client.query(
          `INSERT INTO worker_roles (worker_id, role_code, scope_shop_id, scope_channel,
                                   scope_warehouse_id, scope_own, price_kind)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [id, r.code, r.scope_shop_id || null, r.scope_channel || null,
           r.scope_warehouse_id || null, r.scope_own === true,
           r.price_kind === 'retail' ? 'retail' : null]);
      }
    }
    await saveCashGroups(client, id, req.body.cash_groups);
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
