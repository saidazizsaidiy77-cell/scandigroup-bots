// ============================================================================
//  ISHLAB CHIQARISH JURNALI — konveyer birliklari
//
//  Huquqlar:
//    production.view   — jurnalni ko'rish
//    production.entry  — birlikni keyingi bo'limga o'tkazish
//    production.manage — birlik yaratish, boshlang'ich qoldiq
//    sales.manage      — zakaz raqami, mijoz, narx, chiqish sanasi
// ============================================================================
const express = require('express');
const { db, wrap, audit, today } = require('../db');
const { need } = require('../auth');
const { resolveShift } = require('./shift');

const router = express.Router();
// Birlik yaratish/tahrirlash huquqi. production.manage — marshrut va quvvat
// uchun; kunlik kiritish uchun production.units yetarli.
const UNITS    = ['production.units', 'production.manage'];
const COMMERCE = ['production.units', 'sales.manage', 'production.manage'];

// Rang va mato erkin matn. Bo'sh satr NULL bo'lib yozilsin — aks holda
// taklif ro'yxatida bo'sh qator paydo bo'ladi.
const trim = (v) => {
  const s = String(v ?? '').trim();
  return s || null;
};

// ───────────────────────────────────────────────────────────────── MIJOZLAR
router.get('/customers', need('production.view', 'sales.view'), wrap(async (_req, res) => {
  const [customers, channels, managers] = await Promise.all([
    db.query(`SELECT * FROM v_customer_sales ORDER BY name`),
    db.query(`SELECT * FROM customer_channels ORDER BY sort`),
    // Savdo menejeri sifatida biriktirish mumkin bo'lgan xodimlar:
    // savdo roli borlar birinchi turadi
    db.query(
      `SELECT w.id, w.name,
              EXISTS (SELECT 1 FROM v_worker_permissions vp
                       WHERE vp.worker_id = w.id AND vp.module = 'sales') AS is_sales
         FROM workers w WHERE w.active ORDER BY is_sales DESC, w.name`),
  ]);
  res.json({ customers: customers.rows, channels: channels.rows, managers: managers.rows });
}));

router.get('/customers/stats', need('production.view', 'sales.view'), wrap(async (_req, res) => {
  const [byChannel, byCountry, byRegion, byManager] = await Promise.all([
    db.query(`SELECT * FROM v_channel_sales ORDER BY amount DESC, customers DESC`),
    db.query(`SELECT * FROM v_country_sales ORDER BY amount DESC, customers DESC`),
    db.query(`SELECT * FROM v_region_sales  ORDER BY amount DESC, customers DESC`),
    db.query(`SELECT * FROM v_manager_sales ORDER BY amount DESC, customers DESC`),
  ]);
  res.json({ byChannel: byChannel.rows, byCountry: byCountry.rows,
             byRegion: byRegion.rows, byManager: byManager.rows });
}));

// Bitta mijoz yoki ro'yxatni birdan qabul qiladi (import uchun)
router.post('/customers', need(...COMMERCE), wrap(async (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [req.body];
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const saved = [];
    for (const it of items) {
      const name = String(it.name || '').trim();
      if (!name) throw new Error('Mijoz nomi majburiy');
      // Takror kiritilsa yangi qator yaratmaydi — bo'sh maydonlarni to'ldiradi
      const { rows } = await client.query(
        `INSERT INTO customers (name, phone, country, region, channel, manager_id, note)
         VALUES ($1,$2, COALESCE($3, 'O''zbekiston'), $4,$5,$6,$7)
         ON CONFLICT (lower(name)) DO UPDATE SET
           phone      = COALESCE(EXCLUDED.phone,      customers.phone),
           country    = COALESCE(EXCLUDED.country,    customers.country),
           region     = COALESCE(EXCLUDED.region,     customers.region),
           channel    = COALESCE(EXCLUDED.channel,    customers.channel),
           manager_id = COALESCE(EXCLUDED.manager_id, customers.manager_id),
           note       = COALESCE(EXCLUDED.note,       customers.note)
         RETURNING id, name, phone, country, region, channel, manager_id`,
        [name, it.phone || null, it.country || null, it.region || null,
         it.channel || null, it.manager_id || null, it.note || null]);
      saved.push(rows[0]);
    }
    await client.query('COMMIT');
    res.json(Array.isArray(req.body.items) ? { saved } : saved[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    return res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
}));

router.patch('/customers/:id', need(...COMMERCE), wrap(async (req, res) => {
  const { name, phone, country, region, channel, manager_id, note, active } = req.body;
  const { rows } = await db.query(
    `UPDATE customers SET
       name       = COALESCE($2, name),
       phone      = COALESCE($3, phone),
       country    = COALESCE($4, country),
       region     = COALESCE($5, region),
       channel    = COALESCE($6, channel),
       manager_id = COALESCE($7, manager_id),
       note       = COALESCE($8, note),
       active     = COALESCE($9, active)
     WHERE id = $1 RETURNING id`,
    [req.params.id, name || null, phone || null, country || null, region || null,
     channel || null, manager_id || null, note || null,
     typeof active === 'boolean' ? active : null]);
  if (!rows[0]) return res.status(404).json({ error: 'Mijoz topilmadi' });
  res.json({ ok: true });
}));

// ─────────────────────────────────────────────────────────────────── JURNAL
// Saralash klientda emas, serverda: ro'yxat 500 qator bilan cheklangan,
// shuning uchun faqat ko'rinib turgan qatorlarni saralash yolg'on natija
// beradi — "eng qimmat mahsulot" 501-qatorda qolib ketishi mumkin.
//
// Ustun nomi klientdan keladi, shuning uchun ro'yxat qat'iy: SQL ga faqat
// shu jadvaldagi qiymat tushadi.
const SORT = {
  started_on: 'started_on', conveyor_no: 'conveyor_no', order_no: 'order_no',
  product: 'product', product_type: 'product_type', color: 'color',
  fabric: 'fabric', qty: 'qty', section: 'section',
  lak_on: 'lak_on', pack_on: 'pack_on', fg_on: 'fg_on',
  customer_name: 'customer_name', unit_price: 'unit_price',
  total_amount: 'total_amount',
};

// Jurnal va Excel bitta so'rovdan chiqadi: ekranda ko'ringan filtr va
// saralash faylda ham aynan shunday bo'lishi kerak, aks holda xodim
// ikkitasini solishtirib chalkashadi.
// Guruh ro'yxati vergul bilan keladi: `group_ids=2,3`. Bitta qiymatli eski
// `group_id` ham qabul qilinadi — havola yoki xatcho'p buzilmasin.
function groupIds(q) {
  const raw = q.group_ids || q.group_id;
  if (!raw) return null;
  const ids = String(raw).split(',').map((x) => Number(x)).filter(Number.isInteger);
  return ids.length ? ids : null;
}

// Tsex doirasi. Bo'lim boshlig'ida `scope_shop_id` bor — u faqat o'z
// tsexidagi birlikni ko'radi va o'tkazadi. Admin va ishlab chiqarish
// boshlig'ida doira yo'q, ya'ni ro'yxat bo'sh — ular hammasini ko'radi.
// Shu sababli tekshiruv har doim "doira bor bo'lsa" shartidan boshlanadi.
const scopeOf = (req) => {
  const s = req.user?.scope_shop_ids || [];
  return s.length ? s : null;
};

function registerQuery(q, limit, scope = null) {
  // Bo'sh katak har doim oxirida tursin: saralash sababi — nimadir izlash,
  // "—" esa izlanayotgan narsa emas.
  const col = SORT[q.sort] || 'started_on';
  const way = String(q.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  return {
    text: `SELECT * FROM v_unit_register
      -- Bekor qilinganlar faqat maxsus so'ralganda ko'rinadi
      WHERE ($5::text IS NOT NULL OR status <> 'cancelled')
        AND ($1::text IS NULL OR order_no ILIKE '%' || $1 || '%')
        AND ($2::text IS NULL OR conveyor_no ILIKE '%' || $2 || '%')
        AND ($3::int  IS NULL OR customer_id = $3)
        AND ($4::int  IS NULL OR shop_id = $4)
        AND ($5::text IS NULL OR status = $5)
        AND ($6::date IS NULL OR started_on >= $6)
        AND ($7::date IS NULL OR started_on <= $7)
        AND ($8::text IS NULL OR product ILIKE '%' || $8 || '%'
             OR sku ILIKE '%' || $8 || '%' OR customer_name ILIKE '%' || $8 || '%')
        -- Guruh: bittasi emas, ro'yxat. Zavod ko'pincha "stuldan tashqari
        -- hammasi" deb qaraydi — bitta qiymat bunga yetmaydi.
        AND ($9::int[] IS NULL OR group_id = ANY($9))
        AND ($10::int  IS NULL OR fason_id = $10)
        -- Tsex doirasi: filtr emas, chegara. Klient uni o'chira olmaydi.
        AND ($11::int[] IS NULL OR shop_id = ANY($11))
        -- "Qayerda" ustuni bo'yicha: tsex tanlangach bo'lim ham tanlanadi
        AND ($12::int   IS NULL OR section_id = $12)
      ORDER BY ${col} ${way} NULLS LAST, conveyor_no DESC
      LIMIT ${limit}`,
    params: [q.order_no || null, q.conveyor_no || null, q.customer_id || null,
             q.shop_id || null, q.status || null, q.from || null, q.to || null,
             q.q || null, groupIds(q), q.fason_id || null, scope,
             q.section_id || null],
  };
}

router.get('/', need('production.view'), wrap(async (req, res) => {
  const { text, params } = registerQuery(req.query, 500, scopeOf(req));
  const { rows } = await db.query(text, params);
  res.json(rows);
}));

// ─────────────────────────────────────────────────────── EXCELGA YUKLAB OLISH
//
//  CSV, chunki xlsx uchun kutubxona kerak bo'lardi — bu yerda esa fayl
//  Excel'da ochilsa bas. Excel'ni to'g'ri ochishi uchun uchta shart:
//    · UTF-8 BOM — bo'lmasa o'zbekcha harflar buziladi
//    · ustun ajratgich `;` — MDH mintaqasidagi Excel shuni kutadi
//    · kasr `,` — o'sha mintaqada raqam aks holda matn bo'lib qoladi
//  Sana YYYY-MM-DD: Excel uni har qanday tilda sana deb taniydi.
const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const csvNum = (v) => v == null ? '' : String(v).replace('.', ',');

// Bazadan sana `Date` bo'lib keladi, uni shundayligicha yozsa Excel'ga
// "Sun Sep 06 2026 ..." tushadi. Kun mahalliy qismlardan yig'iladi:
// toISOString() vaqt mintaqasiga qarab sanani bir kunga surib yuborishi
// mumkin, DATE ustunida esa vaqt umuman yo'q.
const pad = (n) => String(n).padStart(2, '0');
const csvDate = (v) => !v ? ''
  : v instanceof Date
    ? `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`
    : String(v).slice(0, 10);

const STATUS_UZ = { production: 'ishlab chiqarishda', fg: 'T/M omborda',
                    shipped: "jo'natilgan", cancelled: 'bekor qilingan' };

// Zahirada sana yo'q — sabab manba ustunida yoziladi. Sananing o'rniga
// so'z qo'yib bo'lmaydi: Excel o'sha ustunni sana deb o'qiydi va bitta
// matn butun ustunni matnga aylantiradi.
const srcCell = (r, src) => src || (r.is_stock ? 'zahira' : '');

const EXPORT_COLUMNS = [
  ['Bosh sana',        (r) => csvDate(r.started_on)],
  ['Konveyer raqami',  (r) => r.conveyor_no],
  ['Zakaz raqami',     (r) => r.order_no],
  ['Maxsulot nomi',    (r) => r.product],
  ['Maxsulot guruhi',  (r) => r.product_type],
  ['Rang',             (r) => r.color || (r.is_stock ? 'zahira' : '')],
  ['Mato',             (r) => r.fabric],
  ['Soni',             (r) => r.qty],
  ['Tsex',             (r) => r.shop],
  ["Bo'lim",           (r) => r.section],
  ['Lak tsehi',        (r) => csvDate(r.lak_on)],
  ['Lak manbasi',      (r) => r.lak_src],
  ['Qadoqlash tsehi',  (r) => csvDate(r.pack_on)],
  ['Qadoqlash manbasi',(r) => srcCell(r, r.pack_src)],
  ['T/M ombor',        (r) => csvDate(r.fg_on)],
  ['T/M manbasi',      (r) => srcCell(r, r.fg_src)],
  ['Mijoz nomi',       (r) => r.customer_name],
  ['Narx, $',          (r) => csvNum(r.unit_price)],
  ['Summa, $',         (r) => csvNum(r.total_amount)],
  ['Holat',            (r) => STATUS_UZ[r.status] || r.status],
];

router.get('/export', need('production.view'), wrap(async (req, res) => {
  // Ekrandagi ro'yxat 500 qator bilan cheklangan, fayl esa hisobot uchun —
  // unda butun jurnal bo'lishi kerak.
  const { text, params } = registerQuery(req.query, 20000, scopeOf(req));
  const { rows } = await db.query(text, params);

  const head = EXPORT_COLUMNS.map(([name]) => csvCell(name)).join(';');
  const body = rows.map((r) =>
    EXPORT_COLUMNS.map(([, get]) => csvCell(get(r))).join(';'));

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition',
    `attachment; filename="jurnal-${today()}.csv"`);
  res.send('\uFEFF' + [head, ...body].join('\r\n') + '\r\n');
}));

router.get('/orders', need('production.view'), wrap(async (_req, res) => {
  const { rows } = await db.query(`SELECT * FROM v_orders ORDER BY started_on DESC`);
  res.json(rows);
}));

// Konveyer raqami: K26-0001 — yil ikki raqam, so'ng yillik tartib raqami.
// Raqam ikki joyda beriladi (taklif va saqlash), shuning uchun format
// shu yerda bir marta yozilgan: ikkisi ajralib ketmasin.
// Tranzaksiya ichidan chaqirilsa o'sha tranzaksiyaning `client` ini uzating.
async function nextConveyorNo(client = db) {
  const prefix = `K${String(new Date().getFullYear()).slice(-2)}-`;
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(SUBSTRING(conveyor_no FROM '\\d+$')::int), 0) + 1 AS n
       FROM production_units WHERE conveyor_no LIKE $1`, [`${prefix}%`]);
  return prefix + String(rows[0].n).padStart(4, '0');
}

// Rang va mato uchun oldindan spravochnik tuzilmaydi — kiritilganlari
// o'zi yig'iladi va keyingi kiritishda tanlash uchun taklif qilinadi.
// Shunday qilib zavod o'z ranglarini ishlab ketaveradi, ro'yxatni oldindan
// tuzib chiqish kerak bo'lmaydi.
router.get('/suggest', need('production.view'), wrap(async (_req, res) => {
  const { rows } = await db.query(
    `SELECT 'color' AS field, color AS value, COUNT(*) AS n
       FROM production_units WHERE color IS NOT NULL GROUP BY color
     UNION ALL
     SELECT 'fabric', fabric, COUNT(*)
       FROM production_units WHERE fabric IS NOT NULL GROUP BY fabric
     ORDER BY n DESC, value`);
  res.json({
    colors:  rows.filter((r) => r.field === 'color').map((r) => r.value),
    fabrics: rows.filter((r) => r.field === 'fabric').map((r) => r.value),
  });
}));

router.get('/next-no', need(...UNITS), wrap(async (_req, res) => {
  res.json({ conveyor_no: await nextConveyorNo() });
}));

router.get('/:id/history', need('production.view'), wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT m.moved_on, m.moved_at, sc.name AS section, sh.name AS shop,
            m.qty_defect, m.defect_reason, w.name AS worker, m.note
       FROM unit_moves m
       JOIN sections sc    ON sc.id = m.section_id
       JOIN shops sh       ON sh.id = sc.shop_id
       LEFT JOIN workers w ON w.id = m.worker_id
      WHERE m.unit_id = $1 ORDER BY m.moved_at`, [req.params.id]);
  res.json(rows);
}));

// ─────────────────────────────────────────────────── BIRLIK YARATISH / QOLDIQ
// Bir nechta qatorni birdan qabul qiladi — boshlang'ich qoldiq shu bilan
// kiritiladi: har qator o'z bo'limida turgan holda yaratiladi.
// Bitta birlik yaratish. Sikl tanasi alohida funksiyaga chiqarilgan:
// uni jurnal sahifasi ham, Excel'dan yuklash ham chaqiradi — ikkalasi
// bir xil qoidalar bilan yozishi shart, aks holda yuklangan qator
// qo'lda kiritilganidan boshqacha bo'lib qoladi.
async function createOne(client, req, it) {
  if (!it.product_id) throw new Error('Mahsulot tanlanmagan');
  // Raqam bo'sh qoldirilsa server o'zi beradi
  if (!it.conveyor_no || !String(it.conveyor_no).trim()) {
    it.conveyor_no = await nextConveyorNo(client);
  }

  // Bo'lim berilsa, u mahsulot marshrutida borligini tekshiramiz
  if (it.section_id) {
    const ok = (await client.query(
      `SELECT 1 FROM v_product_route WHERE product_id = $1 AND section_id = $2`,
      [it.product_id, it.section_id])).rowCount;
    if (!ok) throw new Error(
      `${it.conveyor_no}: tanlangan bo'lim bu mahsulot marshrutida yo'q`);
  }

  const place = it.section_id ? (await client.query(
    `SELECT s.is_exit, sh.milestone
       FROM sections s JOIN shops sh ON sh.id = s.shop_id
      WHERE s.id = $1`, [it.section_id])).rows[0] : null;
  const isExit = place?.is_exit || false;

  // Birlik allaqachon lak yoki qadoqlash tsexida turgan bo'lsa, o'sha
  // tsexga kirish sanasi ma'lum: kiritilmagan bo'lsa bo'limga kirgan
  // sanadan olinadi. Boshlang'ich qoldiqda buni qo'lda takrorlash
  // shart bo'lmaydi.
  const enteredOn = it.entered_section_on || it.started_on || null;
  const lakOn  = it.lak_on  || (place?.milestone === 'lak'  ? enteredOn : null);
  const packOn = it.pack_on || (place?.milestone === 'pack' ? enteredOn : null);

  const u = (await client.query(
    `INSERT INTO production_units
       (conveyor_no, order_no, product_id, qty, started_on, current_section_id,
        entered_section_on, customer_id, unit_price, ship_on, next_shop_planned_on,
        status, is_opening, note, created_by,
        color, fabric, lak_planned_on, lak_on, pack_planned_on, pack_on,
        fg_planned_on, is_stock)
     VALUES ($1,$2,$3,$4, COALESCE($5::date, CURRENT_DATE), $6,
             COALESCE($7::date, CURRENT_DATE), $8,$9,$10,$11,
             $12, $13, $14, $15,
             $16,$17,$18,$19,$20,$21,$22,$23)
     RETURNING id, conveyor_no`,
    [String(it.conveyor_no).trim(), it.order_no || null, it.product_id,
     Number(it.qty) || 1, it.started_on || null, it.section_id || null,
     it.entered_section_on || null, it.customer_id || null,
     it.unit_price || null, it.ship_on || null, it.next_shop_planned_on || null,
     isExit ? 'fg' : 'production', !!it.is_opening, it.note || null, req.user.id,
     trim(it.color), trim(it.fabric),
     it.lak_planned_on || null, lakOn,
     it.pack_planned_on || null, packOn,
     it.fg_planned_on || null, !!it.is_stock])).rows[0];

  if (it.section_id) {
    await client.query(
      `INSERT INTO unit_moves (unit_id, section_id, moved_on, worker_id, note)
       VALUES ($1,$2, COALESCE($3::date, CURRENT_DATE), $4, $5)`,
      [u.id, it.section_id, it.entered_section_on || null, req.user.id,
       it.is_opening ? 'Boshlang\'ich qoldiq' : null]);

    // Jamlanma hisobotlar (WIP, zavod ko'rinishi, panel) flow_log ga tayanadi —
    // boshlang'ich qoldiq ham o'sha yerga yozilmasa, kiritilgan mahsulot
    // hisobotlarda ko'rinmay qoladi.
    const shiftId = await resolveShift(client, it.product_id, 1, req.user.id,
                                       it.entered_section_on || null);
    await client.query(
      `INSERT INTO flow_log (shift_id, section_id, product_id, qty_ok, worker_id,
                             note, is_opening)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [shiftId, it.section_id, it.product_id, Number(it.qty) || 1, req.user.id,
       u.conveyor_no + (it.is_opening ? ' · boshlang\'ich qoldiq' : ''),
       !!it.is_opening]);
  }
  if (isExit) {
    await client.query(
      `UPDATE production_units SET fg_on = COALESCE($2::date, CURRENT_DATE) WHERE id = $1`,
      [u.id, it.entered_section_on || null]);
    await client.query(
      `INSERT INTO fg_stock (product_id, qty, updated_at) VALUES ($1,$2,NOW())
       ON CONFLICT (product_id) DO UPDATE
         SET qty = fg_stock.qty + EXCLUDED.qty, updated_at = NOW()`,
      [it.product_id, Number(it.qty) || 1]);
  }
  return u;
}

router.post('/', need(...UNITS), wrap(async (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [req.body];
  if (!items.length) return res.status(400).json({ error: 'Qator yo\'q' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Bir nechta xodim bir vaqtda kiritsa raqam to'qnashmasligi uchun:
    // raqam berish shu tranzaksiya davomida qulflanadi.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('conveyor_no'))`);

    const created = [];
    for (const it of items) {
      const u = await createOne(client, req, it);
      created.push(u);
    }
    await audit(req, { module: 'production', action: 'create', entity: 'units',
                       entity_id: created.length, payload: { count: created.length } }, client);
    await client.query('COMMIT');
    res.json({ created });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505')
      return res.status(409).json({ error: 'Bu konveyer raqami allaqachon mavjud' });
    return res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
}));

// Zakaz raqami, mijoz, narx, chiqish sanasi — savdo qo'yadi.
// Rang va matoni ishlab chiqarish qo'yadi, lak/qadoqlash rejasini esa
// tsex boshlig'i — hammasi bitta jurnal qatorida turadi.
router.patch('/:id', need(...COMMERCE), wrap(async (req, res) => {
  const { order_no, customer_id, unit_price, ship_on, next_shop_planned_on, note, status,
          color, fabric, lak_planned_on, pack_planned_on,
          lak_on, pack_on, fg_on, conveyor_no, qty } = req.body;

  // ★ TARIXGA TEGADIGAN MAYDONLAR
  //
  //  Bular birlikning o'zini o'zgartiradi, boshqa maydonlar esa unga
  //  ma'lumot qo'shadi:
  //    · konveyer raqami — birlikning nomi, hamma hisobotda shu turadi;
  //    · soni            — jamlanma hisobotlar va T/M ombor qoldig'i shundan
  //                        hisoblanadi;
  //    · FAKT sanalar    — tizim birlik o'sha tsexga o'tganda yozgan,
  //                        ya'ni haqiqatan bo'lib o'tgan voqea.
  //
  //  Shuning uchun ularni faqat administrator va ishlab chiqarish
  //  boshlig'i (production.manage) o'zgartiradi. Savdo menejeri va
  //  ma'lumot kirituvchi o'sha oynada narx, mijoz va REJA sanalarini
  //  qo'yaveradi — tarixga tegmaydi.
  //
  //  Tekshiruv shu yerda, sahifada emas: katakni yashirish himoya emas,
  //  so'rovni qo'lda ham yuborsa bo'ladi.
  const RESTRICTED = {
    conveyor_no: 'Konveyer raqami',
    qty:         'Soni',
    lak_on:      'Lak tsexiga kirgan sana',
    pack_on:     'Qadoqlash tsexiga kirgan sana',
    fg_on:       'T/M omborga kirgan sana',
  };
  const touched = Object.keys(RESTRICTED)
    .filter((k) => req.body[k] != null && String(req.body[k]).trim() !== '');
  if (touched.length && !req.user.permissions.includes('production.manage')) {
    const e = new Error(touched.map((k) => RESTRICTED[k]).join(', ') +
      " \u2014 buni faqat administrator va ishlab chiqarish boshlig'i o'zgartiradi");
    e.status = 403; throw e;
  }

  const nextNo  = conveyor_no != null && String(conveyor_no).trim()
    ? String(conveyor_no).trim() : null;
  const nextQty = qty != null && String(qty).trim() !== '' ? Number(qty) : null;
  if (nextQty != null && (!Number.isInteger(nextQty) || nextQty <= 0)) {
    const e = new Error('Soni butun va noldan katta bo\'lishi kerak');
    e.status = 400; throw e;
  }

  // Raqam va soni bitta tranzaksiyada: ikkalasi ham birlikning o'zidan
  // tashqari JAMLANMA yozuvga ham tegadi, va yarim o'zgargan holat
  // hisobotni jimgina buzardi.
  //   · raqam — flow_log.note da turadi (hisobot va qaytarish shuni qidiradi)
  //   · soni  — flow_log.qty_ok va T/M ombor qoldig'ida (fg_stock)
  if (nextNo || nextQty != null) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const u = (await client.query(
        `SELECT conveyor_no, qty, product_id, status FROM production_units
          WHERE id = $1 FOR UPDATE`, [req.params.id])).rows[0];
      if (!u) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Birlik topilmadi' }); }

      if (nextNo && nextNo !== u.conveyor_no) {
        await client.query(
          `UPDATE production_units SET conveyor_no = $2 WHERE id = $1`,
          [req.params.id, nextNo]);
        await client.query(
          `UPDATE flow_log SET note = $2 || substring(note FROM length($1) + 1)
            WHERE note = $1 OR note LIKE $1 || ' ·%'`, [u.conveyor_no, nextNo]);
        await audit(req, { module: 'production', action: 'rename', entity: 'unit',
                           entity_id: req.params.id,
                           payload: { from: u.conveyor_no, to: nextNo } }, client);
      }

      if (nextQty != null && nextQty !== u.qty) {
        await client.query(
          `UPDATE production_units SET qty = $2 WHERE id = $1`, [req.params.id, nextQty]);

        // Birlikning har harakati jamlanma yozuv qoldirgan — hammasida
        // o'sha paytdagi soni turibdi. Bog'lanish ustuni (flow_log_id)
        // qo'shilishidan oldingi harakatlarda u yo'q, ular izoh bo'yicha
        // topiladi — raqam yuqorida allaqachon yangilangani uchun izlash
        // YANGI raqam bilan ketadi.
        const no = nextNo || u.conveyor_no;
        await client.query(
          `UPDATE flow_log SET qty_ok = $2
            WHERE id IN (SELECT flow_log_id FROM unit_moves
                          WHERE unit_id = $1 AND flow_log_id IS NOT NULL)
               OR note = $3 OR note LIKE $3 || ' ·%'`,
          [req.params.id, nextQty, no]);

        // T/M ombor qoldig'i: birlik omborga tushgan bo'lsa farqi qo'shiladi
        if (u.status === 'fg') {
          await client.query(
            `UPDATE fg_stock SET qty = GREATEST(qty + $2, 0), updated_at = NOW()
              WHERE product_id = $1`, [u.product_id, nextQty - u.qty]);
        }
        await audit(req, { module: 'production', action: 'qty', entity: 'unit',
                           entity_id: req.params.id,
                           payload: { from: u.qty, to: nextQty } }, client);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      if (e.code === '23505') { e.status = 409; e.message = `«${conveyor_no}» band`; }
      else if (!e.status) e.status = 400;
      throw e;
    } finally { client.release(); }
  }

  const { rows } = await db.query(
    `UPDATE production_units SET
       order_no             = COALESCE($2, order_no),
       customer_id          = COALESCE($3, customer_id),
       unit_price           = COALESCE($4, unit_price),
       ship_on              = COALESCE($5::date, ship_on),
       next_shop_planned_on = COALESCE($6::date, next_shop_planned_on),
       note                 = COALESCE($7, note),
       status               = COALESCE($8, status),
       color                = COALESCE($9,  color),
       fabric               = COALESCE($10, fabric),
       lak_planned_on       = COALESCE($11::date, lak_planned_on),
       pack_planned_on      = COALESCE($12::date, pack_planned_on),
       lak_on               = COALESCE($13::date, lak_on),
       pack_on              = COALESCE($14::date, pack_on),
       fg_planned_on        = COALESCE($15::date, fg_planned_on),
       -- FAKT sanalarni ham tuzatish mumkin. Tizim ishga tushirilayotgan
       -- paytda birlik allaqachon lak yoki qadoqlash tsexida turgan
       -- bo'ladi va haqiqiy sana o'tmishda qolgan — uni kiritib bo'lmasa
       -- jurnal birinchi kundanoq noto'g'ri bo'lib qoladi. Sahifada bu
       -- faqat production.manage huquqiga ochiq.
       fg_on                = COALESCE($17::date, fg_on),
       -- Zahira belgisi COALESCE bilan emas: uni O'CHIRISH ham kerak
       -- (buyurtma tushdi, endi zahira emas), COALESCE esa false ni
       -- "tegilmadi" deb o'qib, belgini hech qachon yechmasdi.
       is_stock             = COALESCE($16::boolean, is_stock)
     WHERE id = $1 RETURNING id`,
    [req.params.id, order_no || null, customer_id || null,
     unit_price === '' || unit_price == null ? null : Number(unit_price),
     ship_on || null, next_shop_planned_on || null, note || null, status || null,
     trim(color), trim(fabric), lak_planned_on || null, pack_planned_on || null,
     lak_on || null, pack_on || null, req.body.fg_planned_on || null,
     typeof req.body.is_stock === 'boolean' ? req.body.is_stock : null,
     fg_on || null]);
  if (!rows[0]) return res.status(404).json({ error: 'Birlik topilmadi' });
  await audit(req, { module: 'production', action: 'update', entity: 'unit',
                     entity_id: req.params.id, payload: req.body });
  res.json({ ok: true });
}));

// ──────────────────────────────────────────── BIRLIKNI KEYINGI BO'LIMGA O'TKAZISH
async function moveOne(client, req, { unit_id, section_id, moved_on, qty_defect, defect_reason, note }) {
  const u = (await client.query(
    `SELECT * FROM production_units WHERE id = $1 FOR UPDATE`, [unit_id])).rows[0];
  if (!u) throw new Error('Birlik topilmadi');
  if (u.status === 'cancelled') throw new Error(`${u.conveyor_no}: bekor qilingan`);

  const route = (await client.query(
    `SELECT section_id, step_no FROM v_product_route WHERE product_id = $1 ORDER BY step_no`,
    [u.product_id])).rows;
  if (!route.length) throw new Error(`${u.conveyor_no}: marshrut biriktirilmagan`);

  // Bo'lim ko'rsatilmasa — marshrutdagi keyingisi
  let target = section_id;
  if (!target) {
    const cur = route.findIndex((r) => r.section_id === u.current_section_id);
    const next = route[cur + 1];
    if (!next) throw new Error(`${u.conveyor_no}: marshrut tugagan`);
    target = next.section_id;
  } else if (!route.some((r) => r.section_id === Number(target))) {
    throw new Error(`${u.conveyor_no}: bo'lim marshrutda yo'q`);
  }

  const sec = (await client.query(
    `SELECT s.is_exit, s.shop_id, sh.name AS shop, sh.milestone
       FROM sections s JOIN shops sh ON sh.id = s.shop_id
      WHERE s.id = $1`, [target])).rows[0];

  // ★ QABUL QILISH QOIDASI
  //   Birlikni X tsexining bo'limiga o'tkazish uchun X tsexi doirasida
  //   bo'lish kerak. Bundan ikki narsa o'z-o'zidan kelib chiqadi:
  //     · tsex ichidagi harakatni o'sha tsex boshlig'i qiladi;
  //     · tsexdan tsexga o'tkazishni QABUL QILUVCHI tomon bosadi.
  //   Ya'ni "topshirdim" degan alohida tugma va alohida holat kerak emas —
  //   birlik oldingi tsexning oxirgi bo'limida turibdi degani "topshirishga
  //   tayyor" degani, va uni faqat keyingi tsex o'ziga ola oladi. Kim qabul
  //   qilgani va qachon — unit_moves da allaqachon yoziladi.
  const scope = scopeOf(req);
  if (scope && !scope.includes(sec.shop_id))
    throw new Error(
      `${u.conveyor_no}: «${sec.shop}» sizning doirangizda emas — ` +
      `birlikni o'sha tsex boshlig'i qabul qiladi`);

  // Keyingi tsexga topshirish rejasi faqat birlik HAQIQATAN boshqa tsexga
  // o'tganda tozalanadi. Tsex ichidagi harakat (arra → freza) rejaga
  // tegmasligi kerak: aks holda boshliq qo'ygan muddat birinchi
  // o'tkazishdayoq yo'qoladi.
  const from = u.current_section_id ? (await client.query(
    `SELECT shop_id FROM sections WHERE id = $1`, [u.current_section_id])).rows[0] : null;
  const shopChanged = !from || from.shop_id !== sec.shop_id;

  const defect = Number(qty_defect) || 0;
  if (defect > 0 && !defect_reason) throw new Error('Brak uchun sabab kodi majburiy');

  const move = (await client.query(
    `INSERT INTO unit_moves (unit_id, section_id, moved_on, qty_defect, defect_reason, worker_id, note)
     VALUES ($1,$2, COALESCE($3::date, CURRENT_DATE), $4,$5,$6,$7) RETURNING id`,
    [unit_id, target, moved_on || null, defect, defect_reason || null, req.user.id, note || null])).rows[0];

  await client.query(
    `UPDATE production_units SET
       current_section_id   = $2,
       entered_section_on   = COALESCE($3::date, CURRENT_DATE),
       next_shop_planned_on = CASE WHEN $5::boolean THEN NULL
                                   ELSE next_shop_planned_on END,
       status = CASE WHEN $4 THEN 'fg' ELSE status END,
       fg_on  = CASE WHEN $4 THEN COALESCE($3::date, CURRENT_DATE) ELSE fg_on END
     WHERE id = $1`, [unit_id, target, moved_on || null, sec.is_exit, shopChanged]);

  // Lak va Qadoqlash tsexiga kirish sanasi jurnalda alohida ustun. Reja
  // sanasini tsex boshlig'i qo'yadi, faktni esa birlik o'sha tsexga
  // o'tganda tizim o'zi yozadi — qo'lda ikkinchi marta kiritilmaydi.
  // Stul oqimi bo'yoqlashdan keyin qaytadi, shuning uchun BIRINCHI kirish
  // sanasi saqlanadi: ustun bo'sh bo'lgandagina yoziladi.
  if (sec.milestone) {
    const col = sec.milestone === 'lak' ? 'lak_on' : 'pack_on';
    await client.query(
      `UPDATE production_units SET ${col} = COALESCE($2::date, CURRENT_DATE)
        WHERE id = $1 AND ${col} IS NULL`, [unit_id, moved_on || null]);
  }

  // Umumiy hisobotlar (WIP, panel, Pareto) o'zgarishsiz ishlashi uchun
  // har o'tkazish jamlanma flow_log ga ham yoziladi.
  const shiftId = await resolveShift(client, u.product_id, 1, req.user.id, moved_on || null);
  const flow = (await client.query(
    `INSERT INTO flow_log (shift_id, section_id, product_id, qty_ok, qty_defect, worker_id, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [shiftId, target, u.product_id, u.qty, defect, req.user.id, u.conveyor_no])).rows[0];
  if (defect > 0) {
    await client.query(
      `INSERT INTO defects (flow_log_id, work_date, section_id, product_id, reason_code, qty)
       VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3,$4,$5,$6)`,
      [flow.id, moved_on || null, target, u.product_id, defect_reason, defect]);
  }
  // Qaytarishda aynan shu jamlanma yozuvni topish uchun bog'lab qo'yamiz
  await client.query(`UPDATE unit_moves SET flow_log_id = $2 WHERE id = $1`,
                     [move.id, flow.id]);
  if (sec.is_exit) {
    await client.query(
      `INSERT INTO fg_stock (product_id, qty, updated_at) VALUES ($1,$2,NOW())
       ON CONFLICT (product_id) DO UPDATE
         SET qty = fg_stock.qty + EXCLUDED.qty, updated_at = NOW()`, [u.product_id, u.qty]);
  }
  return { unit_id, section_id: target, is_exit: sec.is_exit };
}

// ────────────────────────────────────────── OXIRGI O'TKAZISHNI QAYTARISH
//
//  "O'tkazish" bexosdan bosilishi oddiy hol — ayniqsa birlik shu bilan T/M
//  omboriga tushib ketsa. Bekor qilish bunga yaramaydi: u birlikni
//  jurnaldan butunlay chiqaradi. Shuning uchun bitta qadam orqaga
//  qaytariladi.
//
//  FAQAT OXIRGI harakat qaytariladi. O'rtadagisini olib tashlash tarixni
//  yolg'on qiladi: birlik o'tmagan bo'limdan o'tgan bo'lib ko'rinadi.
//
//  Qaytariladigan narsalar — o'tkazish nimani yozgan bo'lsa, o'shalar:
//    · harakat yozuvi (unit_moves)
//    · jamlanma yozuv (flow_log) va undagi brak (defects · CASCADE)
//    · birlikning joyi, holati va T/M omborga kirish sanasi
//    · lak va qadoqlash tsexiga kirish sanasi — qolgan harakatlardan
//      qaytadan hisoblanadi, chunki birinchi kirish sanasi saqlanadi
//    · T/M ombor qoldig'i (fg_stock)
async function undoLastMove(client, req, unit_id) {
  const u = (await client.query(
    `SELECT * FROM production_units WHERE id = $1 FOR UPDATE`, [unit_id])).rows[0];
  if (!u) throw new Error('Birlik topilmadi');
  if (u.status === 'shipped')
    throw new Error(`${u.conveyor_no}: mijozga jo'natilgan, avval jo'natmani bekor qiling`);

  const last = (await client.query(
    `SELECT m.*, s.is_exit FROM unit_moves m
       JOIN sections s ON s.id = m.section_id
      WHERE m.unit_id = $1 ORDER BY m.id DESC LIMIT 1`, [unit_id])).rows[0];
  if (!last) throw new Error(`${u.conveyor_no}: qaytariladigan o'tkazish yo'q`);

  // Qaytarish — o'tkazishning teskarisi, demak qoida ham o'sha: birlik
  // hozir turgan tsex doirangizda bo'lsagina orqaga ola olasiz.
  const scope = scopeOf(req);
  if (scope) {
    const at = (await client.query(
      `SELECT sh.id, sh.name FROM sections s JOIN shops sh ON sh.id = s.shop_id
        WHERE s.id = $1`, [last.section_id])).rows[0];
    if (at && !scope.includes(at.id))
      throw new Error(`${u.conveyor_no}: birlik «${at.name}» tsexida — qaytarishni o'sha tsex qiladi`);
  }

  // Jamlanma yozuv. Bog'lanish ustuni qo'shilishidan oldingi harakatlarda
  // NULL — ular uchun bo'lim, mahsulot, sana va konveyer raqami bo'yicha
  // eng oxirgi mos yozuv olinadi.
  const flowId = last.flow_log_id || (await client.query(
    `SELECT f.id FROM flow_log f JOIN shifts sh ON sh.id = f.shift_id
      WHERE f.section_id = $1 AND f.product_id = $2
        AND sh.work_date = $3 AND f.note = $4
      ORDER BY f.id DESC LIMIT 1`,
    [last.section_id, u.product_id, last.moved_on, u.conveyor_no])).rows[0]?.id;
  if (flowId) await client.query(`DELETE FROM flow_log WHERE id = $1`, [flowId]);

  await client.query(`DELETE FROM unit_moves WHERE id = $1`, [last.id]);

  // Oldingi harakat — birlik shu yerga qaytadi. Umuman harakat qolmasa,
  // birlik "boshlanmagan" holatga tushadi.
  const prev = (await client.query(
    `SELECT m.*, s.is_exit FROM unit_moves m
       JOIN sections s ON s.id = m.section_id
      WHERE m.unit_id = $1 ORDER BY m.id DESC LIMIT 1`, [unit_id])).rows[0];

  await client.query(
    `UPDATE production_units SET
       current_section_id = $2::int,
       entered_section_on = $3::date,
       status = CASE WHEN status = 'cancelled' THEN status
                     WHEN $4::boolean THEN 'fg' ELSE 'production' END,
       fg_on  = CASE WHEN $4::boolean THEN $3::date ELSE NULL END
     WHERE id = $1`,
    [unit_id, prev?.section_id || null, prev?.moved_on || null, prev?.is_exit || false]);

  // Lak va qadoqlash sanalari qolgan harakatlardan qaytadan olinadi
  await client.query(
    `UPDATE production_units u SET
       lak_on  = (SELECT MIN(m.moved_on) FROM unit_moves m
                    JOIN sections s ON s.id = m.section_id
                    JOIN shops sh   ON sh.id = s.shop_id AND sh.milestone = 'lak'
                   WHERE m.unit_id = u.id),
       pack_on = (SELECT MIN(m.moved_on) FROM unit_moves m
                    JOIN sections s ON s.id = m.section_id
                    JOIN shops sh   ON sh.id = s.shop_id AND sh.milestone = 'pack'
                   WHERE m.unit_id = u.id)
     WHERE u.id = $1`, [unit_id]);

  // T/M ombor qoldig'i: chiqish bo'limiga o'tkazilgan bo'lsa, qaytariladi.
  // Manfiyga tushmasin — qoldiq qo'lda ham tuzatilgan bo'lishi mumkin.
  if (last.is_exit) {
    await client.query(
      `UPDATE fg_stock SET qty = GREATEST(qty - $2, 0), updated_at = NOW()
        WHERE product_id = $1`, [u.product_id, u.qty]);
  }

  return { unit_id, conveyor_no: u.conveyor_no,
           from_section_id: last.section_id, to_section_id: prev?.section_id || null };
}

// Oxirgi o'tkazishni qaytarish. Bir nechta birlikni birdan ham qabul qiladi.
router.post('/undo', need('production.entry'), wrap(async (req, res) => {
  const ids = Array.isArray(req.body.items) ? req.body.items : [req.body.unit_id];
  if (!ids.length) throw new Error('Birlik tanlanmagan');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const undone = [];
    for (const id of ids) undone.push(await undoLastMove(client, req, id));
    // Ombor qoldig'i tegadigan amal — audit jurnaliga tushadi
    await audit(req, { module: 'production', action: 'undo', entity: 'unit_move',
                       entity_id: undone.length,
                       payload: { units: undone.map((x) => x.conveyor_no) } }, client);
    await client.query('COMMIT');
    res.json({ undone });
  } catch (e) {
    await client.query('ROLLBACK');
    return res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
}));

router.post('/move', need('production.entry'), wrap(async (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [req.body];
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const moved = [];
    for (const it of items) moved.push(await moveOne(client, req, it));
    await client.query('COMMIT');
    res.json({ moved });
  } catch (e) {
    await client.query('ROLLBACK');
    return res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
}));

// ══════════════════════════════════ BO'LIMLAR ARO HARAKAT — TSEX EKRANI
//
//  Bo'lim boshlig'ining kunlik ekrani. Jurnal emas: jurnal 16 ustunli
//  hisobot, bu esa ish quroli — konverlar bo'limlar bo'yicha turadi va
//  bitta bosishda keyingi bo'limga o'tadi.
//
//  Uch qism bir so'rovdan chiqadi:
//    · sections — o'z tsexining bo'limlari va ularda turgan birliklar
//    · inbox    — oldingi tsexda "topshirishga tayyor" turganlar, ya'ni
//                 marshruti bo'yicha keyingi qadami MENING tsexim
//    · muddat   — keyingi tsexga topshirishga necha kun qolgani
//
//  Muddat v_unit_register dan keladi: qo'lda qo'yilgan reja bo'lsa u,
//  aks holda marshrut va bo'lim tezligidan chiqqan taxmin. Tezlik oxirgi
//  14 kunlik haqiqiy o'tkazishlardan o'lchanadi (v_section_rate), shuning
//  uchun zavod ishlay boshlagach muddatlar o'z-o'zidan aniqlashadi.
router.get('/board', need('production.view', 'production.entry'), wrap(async (req, res) => {
  const scope = scopeOf(req);

  const shops = (await db.query(
    `SELECT id, name, sort FROM shops
      WHERE ($1::int[] IS NULL OR id = ANY($1))
      ORDER BY sort, name`, [scope])).rows;
  if (!shops.length) return res.json({ shops: [], shop: null, sections: [], inbox: [] });

  const shopId = Number(req.query.shop_id) || shops[0].id;
  if (!shops.some((s) => s.id === shopId))
    return res.status(403).json({ error: 'Bu tsex sizning doirangizda emas' });

  const rows = (await db.query(
    `SELECT r.id, r.conveyor_no, r.order_no, r.product, r.sku, r.qty,
            r.color, r.fabric, r.customer_name, r.shop, r.shop_id,
            r.section, r.section_id, r.entered_section_on,
            r.next_shop_on, r.next_shop_src, r.is_stock, r.waiting,
            (CURRENT_DATE - r.entered_section_on)::int AS days_here,
            (r.next_shop_on - CURRENT_DATE)::int       AS days_left,
            n.section_id AS next_section_id,
            ns.name      AS next_section,
            ns.shop_id   AS next_shop_id,
            nsh.name     AS next_shop_name
       FROM v_unit_register r
       -- Marshrutdagi keyingi qadam. Bo'lim boshlig'i ro'yxatdan tanlab
       -- o'tirmasligi uchun tugmada aynan shu bo'lim nomi yoziladi.
       LEFT JOIN LATERAL (
         SELECT pr.section_id FROM v_product_route pr
          WHERE pr.product_id = r.product_id AND pr.step_no > r.step_no
          ORDER BY pr.step_no LIMIT 1) n ON true
       LEFT JOIN sections ns  ON ns.id  = n.section_id
       LEFT JOIN shops    nsh ON nsh.id = ns.shop_id
      WHERE r.status = 'production' AND r.section_id IS NOT NULL
        AND (r.shop_id = $1 OR ns.shop_id = $1)
      -- Eng shoshilinchi yuqorida. Muddatsizlari oxirida: ular kutmayapti,
      -- ular haqida hali ma'lumot yo'q.
      ORDER BY r.next_shop_on NULLS LAST, r.conveyor_no`, [shopId])).rows;

  const sections = (await db.query(
    `SELECT id, name, sort, is_exit FROM sections
      WHERE shop_id = $1 AND active ORDER BY sort, name`, [shopId])).rows;

  const mine = rows.filter((r) => r.shop_id === shopId);
  res.json({
    shops,
    shop: shops.find((s) => s.id === shopId),
    sections: sections.map((sc) => ({
      ...sc, units: mine.filter((u) => u.section_id === sc.id) })),
    // Qabul qilishni kutayotganlar: boshqa tsexda turibdi, keyingi qadami menda
    inbox: rows.filter((r) => r.shop_id !== shopId),
  });
}));

// ═══════════════════════════════════════════════ BUGUNGI HARAKATLAR — NAZORAT
//
//  Admin xodimlar kiritgan ma'lumotni shu yerdan ko'radi. Jurnalni 500
//  qator bo'ylab ko'zdan kechirish bilan nazorat qilib bo'lmaydi — u har
//  kuni takrorlanadigan ish bo'lgani uchun arzon bo'lishi shart. Bu yerda
//  kun xronologik lenta bo'lib turadi: kim, qachon, qaysi konverni,
//  qayerdan qayerga.
function feedQuery(q, scope, limit) {
  return {
    text: `SELECT m.id, m.moved_on, m.moved_at, m.qty_defect, m.defect_reason, m.note,
            u.conveyor_no, u.order_no, u.qty, u.is_opening,
            p.name AS product,
            sc.name AS section, sh.id AS shop_id, sh.name AS shop,
            w.id AS worker_id, COALESCE(w.name, '—') AS worker,
            pr.name AS from_section, psh.name AS from_shop, psh.id AS from_shop_id
       FROM unit_moves m
       JOIN production_units u ON u.id = m.unit_id
       JOIN products p         ON p.id = u.product_id
       JOIN sections sc        ON sc.id = m.section_id
       JOIN shops sh           ON sh.id = sc.shop_id
       LEFT JOIN workers w     ON w.id = m.worker_id
       -- Oldingi harakat: "qayerdan" shundan chiqadi. Bo'lmasa — birlik
       -- endi kiritilgan (boshlang'ich qoldiq yoki yangi konver).
       LEFT JOIN LATERAL (
         SELECT m2.section_id FROM unit_moves m2
          WHERE m2.unit_id = m.unit_id AND m2.id < m.id
          ORDER BY m2.id DESC LIMIT 1) pm ON true
       LEFT JOIN sections pr ON pr.id = pm.section_id
       LEFT JOIN shops    psh ON psh.id = pr.shop_id
      WHERE m.moved_on BETWEEN $1::date AND $2::date
        AND ($3::int[] IS NULL OR sh.id = ANY($3))
        AND ($4::int   IS NULL OR sh.id = $4)
        AND ($5::int   IS NULL OR w.id  = $5)
        AND ($6::text  IS NULL OR u.conveyor_no ILIKE '%' || $6 || '%')
      ORDER BY m.moved_at DESC, m.id DESC
      LIMIT ${limit}`,
    params: [q.from || today(), q.to || q.from || today(), scope,
             q.shop_id || null, q.worker_id || null, q.conveyor_no || null],
  };
}

router.get('/feed', need('production.view'), wrap(async (req, res) => {
  const scope = scopeOf(req);
  const { text, params } = feedQuery(req.query, scope, 500);
  const [moves, shops, workers] = await Promise.all([
    db.query(text, params),
    db.query(`SELECT id, name FROM shops
               WHERE ($1::int[] IS NULL OR id = ANY($1)) ORDER BY sort, name`, [scope]),
    // Filtr ro'yxati: oxirgi oyda haqiqatan yozuv kiritganlar. Butun xodimlar
    // ro'yxati emas — 90% i hech qachon jurnalga tegmaydi.
    db.query(
      `SELECT DISTINCT w.id, w.name
         FROM unit_moves m
         JOIN workers w   ON w.id = m.worker_id
         JOIN sections sc ON sc.id = m.section_id
        WHERE m.moved_on >= CURRENT_DATE - 30
          AND ($1::int[] IS NULL OR sc.shop_id = ANY($1))
        ORDER BY w.name`, [scope]),
  ]);
  res.json({ moves: moves.rows, shops: shops.rows, workers: workers.rows });
}));

const FEED_COLUMNS = [
  ['Sana',            (r) => csvDate(r.moved_on)],
  ['Vaqt',            (r) => new Date(r.moved_at).toLocaleTimeString('ru-RU')],
  ['Xodim',           (r) => r.worker],
  ['Konveyer raqami', (r) => r.conveyor_no],
  ['Zakaz raqami',    (r) => r.order_no],
  ['Maxsulot',        (r) => r.product],
  ['Soni',            (r) => r.qty],
  ['Qayerdan',        (r) => r.from_section || (r.is_opening ? "boshlang'ich qoldiq" : 'yangi konver')],
  ['Qayerga',         (r) => r.section],
  ['Tsex',            (r) => r.shop],
  ['Tsexdan tsexga',  (r) => (r.from_shop_id && r.from_shop_id !== r.shop_id ? 'ha' : '')],
  ['Brak',            (r) => r.qty_defect || ''],
  ['Brak sababi',     (r) => r.defect_reason],
  ['Izoh',            (r) => r.note],
];

router.get('/feed/export', need('production.view'), wrap(async (req, res) => {
  const { text, params } = feedQuery(req.query, scopeOf(req), 20000);
  const { rows } = await db.query(text, params);
  const head = FEED_COLUMNS.map(([name]) => csvCell(name)).join(';');
  const body = rows.map((r) => FEED_COLUMNS.map(([, get]) => csvCell(get(r))).join(';'));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition',
    `attachment; filename="harakatlar-${req.query.from || today()}.csv"`);
  res.send('﻿' + [head, ...body].join('\r\n') + '\r\n');
}));

module.exports = router;
// Excel'dan yuklash shu funksiyani chaqiradi (modules/import.js) — qo'lda
// kiritilgan qator bilan yuklangan qator bir xil yo'ldan o'tsin.
module.exports.createOne = createOne;
