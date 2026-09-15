// ============================================================================
//  ISHLAB CHIQARISH JURNALI — konveyer konverlari
//
//  Huquqlar:
//    production.view   — jurnalni ko'rish
//    production.entry  — konverni keyingi bo'limga o'tkazish
//    production.manage — konver yaratish, boshlang'ich qoldiq
//    sales.manage      — zakaz raqami, mijoz, narx, chiqish sanasi
// ============================================================================
const express = require('express');
const { db, wrap, audit, today } = require('../db');
const { need } = require('../auth');
const { resolveShift } = require('./shift');

const router = express.Router();
// Konver yaratish/tahrirlash huquqi. production.manage — marshrut va quvvat
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
router.get('/customers', need('production.view', 'sales.view'), wrap(async (req, res) => {
  const chans = channelsOf(req);
  const [customers, channels, managers] = await Promise.all([
    db.query(`SELECT * FROM v_customer_sales
               WHERE $1::text[] IS NULL OR channel = ANY($1)
               ORDER BY name`, [chans]),
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
        `INSERT INTO customers (name, phone, country, region, channel, manager_id,
                                note, opening_debt, opening_debt_on)
         VALUES ($1,$2, COALESCE($3, 'O''zbekiston'), $4,$5,$6,$7,$8,$9)
         ON CONFLICT (lower(name)) DO UPDATE SET
           phone      = COALESCE(EXCLUDED.phone,      customers.phone),
           country    = COALESCE(EXCLUDED.country,    customers.country),
           region     = COALESCE(EXCLUDED.region,     customers.region),
           channel    = COALESCE(EXCLUDED.channel,    customers.channel),
           manager_id = COALESCE(EXCLUDED.manager_id, customers.manager_id),
           note       = COALESCE(EXCLUDED.note,       customers.note),
           -- Boshlang'ich qarz bir marta kiritiladi. Qayta yuklashda
           -- yozilgani o'chmaydi, faqat bo'sh bo'lsa to'ldiriladi.
           opening_debt    = COALESCE(customers.opening_debt, EXCLUDED.opening_debt),
           opening_debt_on = COALESCE(customers.opening_debt_on, EXCLUDED.opening_debt_on)
         RETURNING id, name, phone, country, region, channel, manager_id`,
        [name, it.phone || null, it.country || null, it.region || null,
         it.channel || null, it.manager_id || null, it.note || null,
         it.opening_debt ?? null, it.opening_debt_on || null]);
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
  const { name, phone, country, region, channel, manager_id, note, active,
          opening_debt, opening_debt_on } = req.body;
  const { rows } = await db.query(
    `UPDATE customers SET
       name       = COALESCE($2, name),
       phone      = COALESCE($3, phone),
       country    = COALESCE($4, country),
       region     = COALESCE($5, region),
       channel    = COALESCE($6, channel),
       manager_id = COALESCE($7, manager_id),
       note       = COALESCE($8, note),
       active     = COALESCE($9, active),
       -- Qarz NULL bilan o'chirilishi ham kerak: noto'g'ri kiritilgan
       -- raqamni tozalash imkoni bo'lsin. Shuning uchun COALESCE emas —
       -- maydon yuborilgan bo'lsa nima yuborilgan bo'lsa shu yoziladi.
       opening_debt    = CASE WHEN $10::boolean THEN $11::numeric ELSE opening_debt END,
       opening_debt_on = CASE WHEN $10::boolean THEN $12::date    ELSE opening_debt_on END
     WHERE id = $1 RETURNING id`,
    [req.params.id, name || null, phone || null, country || null, region || null,
     channel || null, manager_id || null, note || null,
     typeof active === 'boolean' ? active : null,
     opening_debt !== undefined,
     opening_debt === '' || opening_debt == null ? null : Number(opening_debt),
     opening_debt_on || null]);
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

// T/M ombor qoldig'ini konverlardan QAYTA HISOBLAYDI.
//
//  Oldin qoldiq qo'shib-ayirish bilan yuritilardi (+1 kirganda, −1
//  chiqqanda). Har qo'shish bir joyda unutilsa yoki ikki marta bajarilsa,
//  qoldiq konverlardan jimgina ajralib ketardi va buni hech kim sezmasdi.
//
//  Endi konverlar yagona haqiqat: qoldiq ularning yig'indisi. Konveyer
//  raqami zavodning mezoni — qoldiq ham o'sha raqamlardan chiqishi kerak.
async function refreshStock(client, productId) {
  await client.query(
    `INSERT INTO fg_stock (product_id, qty, updated_at)
     SELECT $1, COALESCE(SUM(qty), 0), NOW()
       FROM production_units WHERE product_id = $1 AND status = 'fg'
     ON CONFLICT (product_id) DO UPDATE
       SET qty = EXCLUDED.qty, updated_at = NOW()`, [productId]);
}

// Tsex doirasi. Bo'lim boshlig'ida `scope_shop_id` bor — u faqat o'z
// tsexidagi konverni ko'radi va o'tkazadi. Admin va ishlab chiqarish
// boshlig'ida doira yo'q, ya'ni ro'yxat bo'sh — ular hammasini ko'radi.
// Shu sababli tekshiruv har doim "doira bor bo'lsa" shartidan boshlanadi.
const scopeOf = (req) => {
  const s = req.user?.scope_shop_ids || [];
  return s.length ? s : null;
};

// Savdo yo'nalishi doirasi. Menejerga kanal biriktirilgan bo'lsa — u
// faqat o'sha kanaldagi mijozlarni ko'radi; biriktirilmagan bo'lsa
// hammasini (rahbariyat, administrator). Tsex doirasi bilan bir xil
// mantiq: bu filtr emas, klient o'chira olmaydigan CHEGARA.
const channelsOf = (req) => {
  const c = req.user?.scope_channels || [];
  return c.length ? c : null;
};

function registerQuery(q, limit, scope = null) {
  // Bo'sh katak har doim oxirida tursin: saralash sababi — nimadir izlash,
  // "—" esa izlanayotgan narsa emas.
  const col = SORT[q.sort] || 'started_on';
  const way = String(q.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  return {
    text: `SELECT * FROM v_unit_register
      -- Jurnal — ISHLAB CHIQARISH jurnali. Ombor qabul qilgan konver
      -- undan chiqadi: u endi ishlab chiqarishning ishi emas. Bekor
      -- qilinganlar ham shunday. Ikkalasini ham status filtri bilan
      -- ataylab so'rab ko'rish mumkin.
      WHERE ($5::text IS NOT NULL OR status NOT IN ('cancelled', 'fg', 'shipped'))
        AND ($1::text IS NULL OR order_no ILIKE '%' || $1 || '%')
        AND ($2::text IS NULL OR conveyor_no ILIKE '%' || $2 || '%')
        AND ($3::int  IS NULL OR customer_id = $3)
        -- Tsex filtri ham JAVOBGAR bo'yicha: «Lak tsexi» tanlanganda
        -- lak bo'limlarida turgan stul chiqmaydi (u stul tsexiniki),
        -- «Stul tsexi» tanlanganda esa lak bo'limlarida turganlari ham
        -- chiqadi. Ekranda kim nimani boshqarsa, jurnalda ham shu.
        AND ($4::int  IS NULL OR owner_shop_id = $4)
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
        AND ($11::int[] IS NULL OR owner_shop_id = ANY($11))
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
//  Raqamni zavod beradi (`K26-0041`). Lekin boshlang'ich qoldiqda raqami
//  BO'LMAGAN mahsulotlar bor: ular tizim ishga tushishidan oldin ishlangan
//  va ustalar raqamini bilmaydi.
//
//  Bunday mahsulot raqamsiz qola olmaydi — sifat shikoyati, ishbay oylik
//  va xom ashyo sarfi hammasi raqamga bog'lanadi. Tizim raqam beradi,
//  lekin BOSHQA BOSH HARF bilan: `Q26-0007`. Shunda uni ko'rgan odam
//  darrov biladi — bu raqam mahsulotning ustida yozilmagan, uni tizim
//  qo'ygan. Keyin haqiqiy raqam topilsa, jurnaldan tuzatiladi.
async function nextConveyorNo(client = db, letter = 'K') {
  const prefix = `${letter}${String(new Date().getFullYear()).slice(-2)}-`;
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
  // Har mahsulotning OXIRGI narxi. Qoldiq kiritayotgan xodim yuzlab
  // qatorga bir xil narxni qayta terib chiqmasin — katak o'zi to'ladi,
  // lekin faqat BO'SH bo'lsa: qo'lda yozilgan narx hech qachon
  // almashtirilmaydi, aks holda tuzatish saqlanmay qolardi.
  const prices = await db.query(
    `SELECT DISTINCT ON (product_id) product_id, unit_price
       FROM production_units
      WHERE unit_price IS NOT NULL AND unit_price > 0
      ORDER BY product_id, id DESC`);
  res.json({
    colors:  rows.filter((r) => r.field === 'color').map((r) => r.value),
    fabrics: rows.filter((r) => r.field === 'fabric').map((r) => r.value),
    prices:  Object.fromEntries(prices.rows.map((r) => [r.product_id, Number(r.unit_price)])),
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

// Shu konver yura oladigan bo'limlar — tahrirlash oynasidagi ro'yxat uchun.
// Hamma bo'limni ko'rsatib, keyin "marshrutda yo'q" deb rad etish yomon:
// xodim nega bo'lmasligini bilmaydi va taxmin qilib o'tiradi.
router.get('/:id/route', need('production.view', 'production.entry'), wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT r.step_no, sc.id, sc.name, sc.is_exit, sh.name AS shop
       FROM production_units u
       JOIN v_product_route r ON r.product_id = u.product_id
       JOIN sections sc ON sc.id = r.section_id
       JOIN shops sh    ON sh.id = sc.shop_id
      WHERE u.id = $1 ORDER BY r.step_no`, [req.params.id]);
  res.json(rows);
}));

// ─────────────────────────────────────────────────── BIRLIK YARATISH / QOLDIQ
// Bir nechta qatorni birdan qabul qiladi — boshlang'ich qoldiq shu bilan
// kiritiladi: har qator o'z bo'limida turgan holda yaratiladi.
// Bitta konver yaratish. Sikl tanasi alohida funksiyaga chiqarilgan:
// uni jurnal sahifasi ham, Excel'dan yuklash ham chaqiradi — ikkalasi
// bir xil qoidalar bilan yozishi shart, aks holda yuklangan qator
// qo'lda kiritilganidan boshqacha bo'lib qoladi.
async function createOne(client, req, it) {
  if (!it.product_id) throw new Error('Mahsulot tanlanmagan');
  // Raqam bo'sh qoldirilsa server o'zi beradi. Boshlang'ich qoldiqda
  // esa Q bilan — raqamni tizim qo'ygani ko'rinib tursin.
  if (!it.conveyor_no || !String(it.conveyor_no).trim()) {
    it.conveyor_no = await nextConveyorNo(client, it.is_opening ? 'Q' : 'K');
  }

  // Bo'lim berilsa, u mahsulot marshrutida borligini tekshiramiz
  if (it.section_id) {
    const ok = (await client.query(
      `SELECT 1 FROM v_product_route WHERE product_id = $1 AND section_id = $2`,
      [it.product_id, it.section_id])).rowCount;
    if (!ok) throw new Error(
      `${it.conveyor_no}: tanlangan bo'lim bu mahsulot marshrutida yo'q`);
  }

  //  Ombor kodi berilsa — borligi tekshiriladi. Tekshirilmasa noto'g'ri
  //  yozilgan kod jimgina NULL bo'lib qolardi va mahsulot boshqa
  //  omborda paydo bo'lardi.
  if (it.warehouse_code) {
    const ok = (await client.query(
      `SELECT 1 FROM warehouses WHERE code = $1 AND kind = 'fg' AND is_active`,
      [it.warehouse_code])).rowCount;
    if (!ok) throw new Error(`${it.conveyor_no}: «${it.warehouse_code}» ombori topilmadi`);
  }

  const place = it.section_id ? (await client.query(
    `SELECT s.is_exit, sh.milestone
       FROM sections s JOIN shops sh ON sh.id = s.shop_id
      WHERE s.id = $1`, [it.section_id])).rows[0] : null;
  const isExit = place?.is_exit || false;

  // Konver allaqachon lak yoki qadoqlash tsexida turgan bo'lsa, o'sha
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
        fg_planned_on, is_stock, warehouse_id)
     VALUES ($1,$2,$3,$4, COALESCE($5::date, CURRENT_DATE), $6,
             COALESCE($7::date, CURRENT_DATE), $8,$9,$10,$11,
             $12, $13, $14, $15,
             $16,$17,$18,$19,$20,$21,$22,$23,
             -- Ombor faqat mahsulot omborga kirgan bo'lsa yoziladi.
             -- Ko'rsatilmasa T/M ombor: boshlang'ich qoldiqning katta
             -- qismi o'sha yerda va har qatorda tanlash so'ralmaydi.
             CASE WHEN $24::text IS NULL THEN NULL
                  ELSE (SELECT id FROM warehouses WHERE code = $24) END)
     RETURNING id, conveyor_no`,
    [String(it.conveyor_no).trim(), it.order_no || null, it.product_id,
     Number(it.qty) || 1, it.started_on || null, it.section_id || null,
     it.entered_section_on || null, it.customer_id || null,
     it.unit_price || null, it.ship_on || null, it.next_shop_planned_on || null,
     (isExit || it.fg_on) ? 'fg' : 'production',
     !!it.is_opening, it.note || null, req.user.id,
     trim(it.color), trim(it.fabric),
     it.lak_planned_on || null, lakOn,
     it.pack_planned_on || null, packOn,
     it.fg_planned_on || null, !!it.is_stock,
     (isExit || it.fg_on) ? (it.warehouse_code || 'TM') : null])).rows[0];

  if (it.section_id) {
    await client.query(
      `INSERT INTO unit_moves (unit_id, section_id, moved_on, qty, worker_id, note)
       VALUES ($1,$2, COALESCE($3::date, CURRENT_DATE), $4,$5,$6)`,
      [u.id, it.section_id, it.entered_section_on || null, Number(it.qty) || 1,
       req.user.id, it.is_opening ? 'Boshlang\'ich qoldiq' : null]);

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
  // Boshlang'ich qoldiqda konver allaqachon omborda turgan bo'lishi mumkin:
  // u yerga tizim ishga tushishidan oldin kirgan, ya'ni topshirish-qabul
  // qilish bo'lmagan. `fg_on` berilsa — o'sha kun, aks holda chiqish
  // bo'limiga qo'yilgan bo'lsa — o'sha bo'limga kirgan kun.
  if (isExit || it.fg_on) {
    await client.query(
      `UPDATE production_units SET fg_on = COALESCE($2::date, $3::date, CURRENT_DATE)
        WHERE id = $1`, [u.id, it.fg_on || null, it.entered_section_on || null]);
    await refreshStock(client, it.product_id);
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
// Jurnaldagi konverni tahrirlash — ishlab chiqarishning ishi. Savdo
// jurnalni FAQAT O'QIYDI: o'z buyurtmasi qayerda turganini ko'radi,
// lekin unga tegmaydi. Zakaz, mijoz va narx savdo moduli orqali
// qo'yiladi (u yozilgunga qadar — kirituvchi orqali). Mijozlar
// spravochnigi esa savdoniki, u COMMERCE da qoladi.
router.patch('/:id', need(...UNITS), wrap(async (req, res) => {
  const { order_no, customer_id, unit_price, ship_on, next_shop_planned_on, note, status,
          color, fabric, lak_planned_on, pack_planned_on,
          lak_on, pack_on, fg_on, conveyor_no, qty, section_id } = req.body;

  // ★ TARIXGA TEGADIGAN MAYDONLAR
  //
  //  Bular konverning o'zini o'zgartiradi, boshqa maydonlar esa unga
  //  ma'lumot qo'shadi:
  //    · konveyer raqami — konverning nomi, hamma hisobotda shu turadi;
  //    · soni            — jamlanma hisobotlar va T/M ombor qoldig'i shundan
  //                        hisoblanadi;
  //    · turgan joyi     — konverning zavoddagi o'rni; uni tuzatish tarixdagi
  //                        oxirgi yozuvni to'g'rilash demak;
  //    · FAKT sanalar    — tizim konver o'sha tsexga o'tganda yozgan,
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
    section_id:  'Mahsulot turgan joy',
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

  const nextSection = section_id != null && String(section_id).trim() !== ''
    ? Number(section_id) : null;

  // Uchalasi bitta tranzaksiyada: har biri konverning o'zidan tashqari
  // JAMLANMA yozuvga ham tegadi, va yarim o'zgargan holat hisobotni
  // jimgina buzardi.
  //   · raqam — flow_log.note da turadi (hisobot va qaytarish shuni qidiradi)
  //   · soni  — flow_log.qty_ok va T/M ombor qoldig'ida (fg_stock)
  //   · joyi  — unit_moves va flow_log dagi oxirgi yozuvning bo'limi
  if (nextNo || nextQty != null || nextSection != null) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const u = (await client.query(
        `SELECT conveyor_no, qty, product_id, status FROM production_units
          WHERE id = $1 FOR UPDATE`, [req.params.id])).rows[0];
      if (!u) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Konver topilmadi' }); }

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

        // Konverning har harakati jamlanma yozuv qoldirgan — hammasida
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

        // Soni o'zgargani qoldiqni ham o'zgartiradi — konverlardan qayta hisoblanadi
        if (u.status === 'fg') await refreshStock(client, u.product_id);
        await audit(req, { module: 'production', action: 'qty', entity: 'unit',
                           entity_id: req.params.id,
                           payload: { from: u.qty, to: nextQty } }, client);
      }

      // Joyi oxirida: soni o'zgargan bo'lsa, T/M ombor hisobi yangi soni
      // bilan ketishi kerak.
      if (nextSection != null) await relocate(client, req, Number(req.params.id), nextSection);

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
       -- paytda konver allaqachon lak yoki qadoqlash tsexida turgan
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
  if (!rows[0]) return res.status(404).json({ error: 'Konver topilmadi' });
  await audit(req, { module: 'production', action: 'update', entity: 'unit',
                     entity_id: req.params.id, payload: req.body });
  res.json({ ok: true });
}));

// ────────────────────────────────── XATO KIRITILGANNI OMBORGA O'TKAZISH
//
//  Boshlang'ich qoldiq kiritilayotganda «Tseh» ustunidan ombor o'rniga
//  tsex tanlanib ketishi mumkin — shunda omborda turgan mahsulot ishlab
//  chiqarishda paydo bo'ladi. Uni marshrut bo'ylab oxirigacha haydab
//  chiqarish ham, o'chirib qayta kiritish ham to'g'ri emas: birinchisi
//  yolg'on harakat yozadi, ikkinchisi konveyer raqamini yo'qotadi.
//
//  Shuning uchun TUZATISH: konver o'sha zahoti omborga o'tadi. Bu
//  qabul qilish EMAS — qadoqlash tsexidan kelgan mahsulot eskicha,
//  ombor mudirining «qabul qildim» tugmasi bilan o'tadi (`/stock/accept`).
//  Bu yerda faqat noto'g'ri kiritilgan qator to'g'rilanadi, shuning
//  uchun huquqi ham boshqa: `production.manage`.
//
//  Turgan bo'limi O'ZGARMAY qoladi — qabul qilishda ham shunday: konver
//  ombordan qaytarilsa (`undo`) o'z joyiga qaytishi kerak.
router.post('/:id/to-warehouse', need('production.manage'), wrap(async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const u = (await client.query(
      `SELECT * FROM production_units WHERE id = $1 FOR UPDATE`,
      [req.params.id])).rows[0];
    if (!u) throw new Error('Konver topilmadi');
    if (u.status === 'fg') throw new Error(`${u.conveyor_no}: allaqachon omborda`);
    if (u.status !== 'production')
      throw new Error(`${u.conveyor_no}: ishlab chiqarishda emas`);

    const w = (await client.query(
      `SELECT id, name FROM warehouses
        WHERE code = $1 AND kind = 'fg' AND is_active`,
      [req.body.warehouse_code || 'TM'])).rows[0];
    if (!w) throw new Error('Ombor topilmadi');

    await client.query(
      `UPDATE production_units
          SET status = 'fg', warehouse_id = $2,
              fg_on = COALESCE($3::date, fg_on, CURRENT_DATE)
        WHERE id = $1`, [u.id, w.id, req.body.fg_on || null]);
    await refreshStock(client, u.product_id);
    await audit(req, { module: 'warehouse', action: 'fg-fix', entity: 'unit',
                       entity_id: u.id,
                       payload: { conveyor_no: u.conveyor_no, to: w.name } }, client);
    await client.query('COMMIT');
    res.json({ ok: true, conveyor_no: u.conveyor_no, warehouse: w.name });
  } catch (e) {
    await client.query('ROLLBACK');
    if (!e.status) e.status = 400;
    throw e;
  } finally { client.release(); }
}));

// ─────────────────────────────────── BIRLIK QAYERDA TURGANINI TUZATISH
//
//  Bu O'TKAZISH EMAS. O'tkazish — zavodda bo'lib o'tgan voqea, unga yangi
//  yozuv qo'shiladi. Bu esa yozuvdagi XATO: konver aslida Frezada turgan,
//  jurnalda Arra deb yozilgan. Shuning uchun yangi harakat qo'shilmaydi —
//  oxirgi harakat to'g'rilanadi, va u bilan birga jamlanma yozuv ham
//  (flow_log), aks holda hisobot konverni bir vaqtda ikki bo'limda
//  ko'rsatib turadi.
async function relocate(client, req, unitId, sectionId) {
  const u = (await client.query(
    `SELECT id, conveyor_no, product_id, qty, current_section_id, status, entered_section_on
       FROM production_units WHERE id = $1 FOR UPDATE`, [unitId])).rows[0];
  if (!u) { const e = new Error('Konver topilmadi'); e.status = 404; throw e; }
  if (Number(sectionId) === u.current_section_id) return null;

  const to = (await client.query(
    `SELECT sc.id, sc.name, sc.is_exit, sh.name AS shop
       FROM sections sc JOIN shops sh ON sh.id = sc.shop_id
      WHERE sc.id = $1`, [sectionId])).rows[0];
  if (!to) { const e = new Error("Bunday bo'lim yo'q"); e.status = 400; throw e; }

  // Marshrutdan tashqari bo'lim tanlansa keyingi qadamni hisoblab bo'lmaydi
  // va usta ekranida tugma yo'qoladi — shuning uchun oldindan rad etamiz.
  const onRoute = (await client.query(
    `SELECT 1 FROM v_product_route WHERE product_id = $1 AND section_id = $2`,
    [u.product_id, sectionId])).rowCount;
  if (!onRoute) {
    const e = new Error(`«${to.name}» bu mahsulotning marshrutida yo'q`);
    e.status = 400; throw e;
  }

  const last = (await client.query(
    `SELECT id, flow_log_id, moved_on FROM unit_moves
      WHERE unit_id = $1 ORDER BY id DESC LIMIT 1`, [unitId])).rows[0];

  if (last) {
    await client.query(`UPDATE unit_moves SET section_id = $2 WHERE id = $1`,
                       [last.id, sectionId]);
    if (last.flow_log_id)
      await client.query(`UPDATE flow_log SET section_id = $2 WHERE id = $1`,
                         [last.flow_log_id, sectionId]);
  } else {
    // Konver hali hech bir bo'limga qo'yilmagan edi — bu uning birinchi
    // joylashuvi, demak yozuv yangidan yaratiladi.
    const on = u.entered_section_on || null;
    const shiftId = await resolveShift(client, u.product_id, 1, req.user.id, on);
    const flow = (await client.query(
      `INSERT INTO flow_log (shift_id, section_id, product_id, qty_ok, worker_id, note)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [shiftId, sectionId, u.product_id, u.qty, req.user.id, u.conveyor_no])).rows[0];
    await client.query(
      `INSERT INTO unit_moves (unit_id, section_id, moved_on, worker_id, note, flow_log_id)
       VALUES ($1,$2, COALESCE($3::date, CURRENT_DATE), $4, $5, $6)`,
      [unitId, sectionId, on, req.user.id, 'Joyi tuzatildi', flow.id]);
  }

  // Joyni tuzatish holatga tegmaydi: `fg` — ombor qabulining natijasi,
  // joylashuvniki emas. Omborda turgan konverning joyini tuzatish uni
  // ombordan chiqarib yubormasligi kerak.
  await client.query(
    `UPDATE production_units SET
       current_section_id = $2,
       entered_section_on = COALESCE(entered_section_on, CURRENT_DATE)
     WHERE id = $1`, [unitId, sectionId]);

  // Lak va qadoqlash FAKT sanalari harakatlardan qaytadan hisoblanadi: joy
  // o'zgargani bilan qaysi tsexga kirgani ham o'zgargan bo'lishi mumkin.
  //
  // Hisob natija bermasa eski qiymat QOLADI. Sabab: boshlang'ich qoldiqqa
  // kiritilgan konverda haqiqiy sana qo'lda yozilgan va harakat yozuvlarida
  // yo'q — uni nolga aylantirsak, qaytarib bo'lmaydigan ma'lumot yo'qoladi.
  await client.query(
    `UPDATE production_units u SET
       lak_on  = COALESCE((SELECT MIN(m.moved_on) FROM unit_moves m
                    JOIN sections s ON s.id = m.section_id
                    JOIN shops sh   ON sh.id = s.shop_id AND sh.milestone = 'lak'
                   WHERE m.unit_id = u.id), u.lak_on),
       pack_on = COALESCE((SELECT MIN(m.moved_on) FROM unit_moves m
                    JOIN sections s ON s.id = m.section_id
                    JOIN shops sh   ON sh.id = s.shop_id AND sh.milestone = 'pack'
                   WHERE m.unit_id = u.id), u.pack_on)
     WHERE u.id = $1`, [unitId]);

  await audit(req, { module: 'production', action: 'relocate', entity: 'unit',
                     entity_id: unitId,
                     payload: { from: u.current_section_id, to: sectionId } }, client);
  return { from: u.current_section_id, to: sectionId, section: to.name, shop: to.shop };
}

// ──────────────────────────────────────────── BIRLIKNI KEYINGI BO'LIMGA O'TKAZISH
//  n dona konverni boshqa bo'limga ko'chiradi. Uch holat bor va uchalasi
//  ham bitta joyda turishi kerak: o'tkazish ham, qaytarish ham xuddi shu
//  qoidaga bo'ysunadi, aks holda ikki tomonda ikki xil mantiq paydo
//  bo'lardi va donalar yo'qolib qolardi.
//
//    1. Nishonda shu konverning bo'lagi bor  → donalar unga qo'shiladi
//    2. Butun qator ko'chadi, nishonda bo'lak yo'q → qatorning o'zi ko'chadi
//    3. Bir qismi ko'chadi, nishonda bo'lak yo'q → yangi bo'lak ochiladi
//
//  Qator bo'shab qolsa o'chiriladi, tarixi esa qo'shilgan qatorga
//  ko'chiriladi: konveyer raqamining tarixi butun qolishi kerak.
//
//  `toSection` NULL bo'lishi mumkin — qaytarishda konver boshlanmagan
//  holatiga tushadi.
async function placePieces(client, req, u, toSection, n, movedOn) {
  const sibling = toSection ? (await client.query(
    `SELECT id FROM production_units
      WHERE conveyor_no = $1 AND id <> $2 AND status = 'production'
        AND current_section_id = $3
      ORDER BY id LIMIT 1 FOR UPDATE`, [u.conveyor_no, u.id, toSection])).rows[0] : null;
  const whole = n >= u.qty;

  if (sibling) {
    await client.query(
      `UPDATE production_units SET qty = qty + $2,
              entered_section_on = COALESCE($3::date, entered_section_on)
        WHERE id = $1`, [sibling.id, n, movedOn || null]);
    if (whole) {
      await client.query(`UPDATE unit_moves SET unit_id = $2 WHERE unit_id = $1`,
                         [u.id, sibling.id]);
      await client.query(`DELETE FROM production_units WHERE id = $1`, [u.id]);
    } else {
      await client.query(`UPDATE production_units SET qty = qty - $2 WHERE id = $1`,
                         [u.id, n]);
    }
    return sibling.id;
  }

  if (whole) {
    await client.query(
      `UPDATE production_units
          SET current_section_id = $2::int,
              entered_section_on = $3::date
        WHERE id = $1`, [u.id, toSection, movedOn || null]);
    return u.id;
  }

  return clonePart(client, req, u, n, { toSection, movedOn });
}

//  Konverdan n dona ajratib, yangi qator qiladi. Tarix (unit_moves) ESKI
//  qatorda qoladi: konveyer raqami bitta, tarix ham shu raqamniki.
//
//  `keepPlace` — bo'lak joyidan qimirlamaydi. Savdo shundan foydalanadi:
//  10 talik konverdan 4 tasi buyurtmaga biriktiriladi, qolgan 6 tasi
//  o'sha omborda bo'sh turaveradi (modules/sales.js). Usiz `toSection`
//  bo'sh bo'lgani "boshlanmagan holatga qaytar" degani — harakatni
//  bekor qilish shunga tayanadi va ikkisi bir xil bo'lib qolmasligi kerak.
async function clonePart(client, req, u, n, { toSection = null, movedOn = null,
                                              keepPlace = false } = {}) {
  const row = (await client.query(
    `INSERT INTO production_units
       (conveyor_no, part, order_no, product_id, qty, started_on,
        current_section_id, entered_section_on, customer_id, unit_price,
        status, is_opening, note, created_by, color, fabric,
        lak_planned_on, lak_on, pack_planned_on, pack_on, fg_planned_on, fg_on,
        next_shop_planned_on, is_stock, order_item_id)
     SELECT conveyor_no,
            (SELECT MAX(part) + 1 FROM production_units WHERE conveyor_no = u.conveyor_no),
            order_no, product_id, $2, started_on,
            CASE WHEN $6 THEN current_section_id ELSE $3::int END,
            CASE WHEN $6 THEN entered_section_on ELSE $4::date END,
            customer_id, unit_price,
            status, is_opening, note, $5, color, fabric,
            lak_planned_on, lak_on, pack_planned_on, pack_on, fg_planned_on,
            -- Omborga kirgan kun ham ko'chadi: bo'laklar bir kunda kirgan,
            -- va usiz bo'lak ombor qoldig'ida sanasiz turib qolardi.
            fg_on,
            -- Topshirish belgisi KO'CHIRILMAYDI: yangi bo'lak boshqa
            -- bo'limda va uni qaytadan jo'natish kerak bo'ladi.
            next_shop_planned_on, is_stock,
            -- Buyurtma bog'lami ham ko'chadi: biriktirilgan konver
            -- bo'linsa, buyurtmada "biriktirilgan" soni kamayib
            -- qolmasligi kerak.
            order_item_id
       FROM production_units u WHERE id = $1
     RETURNING id`,
    [u.id, n, toSection, movedOn || null, req.user.id, keepPlace])).rows[0].id;
  await client.query(`UPDATE production_units SET qty = qty - $2 WHERE id = $1`, [u.id, n]);
  return row;
}

//  ★ KONVER BO'LAKLARI
//
//  Bitta o'tkazishda konverning HAMMASI emas, bir qismi ketishi mumkin:
//  10 ta stulning 3 tasi Zborkaga o'tadi, 7 tasi Shkurkada qoladi. Shunda
//  konver ikkita qator bo'ladi — bir xil raqam, har biri o'z bo'limida.
//
//  Bo'laklar uchrashsa QO'SHILADI: keyin qolgan 7 tasi ham Zborkaga
//  o'tsa, u yerda bitta 10 lik qator qoladi va bo'sh qolgan qator
//  o'chiriladi (tarixi qo'shilgan qatorga ko'chiriladi). Shu sababdan
//  ustalar donama-dona o'tkazsa ham qatorlar ko'payib ketmaydi.
async function moveOne(client, req, { unit_id, section_id, moved_on, qty, qty_defect, defect_reason, note }) {
  const u = (await client.query(
    `SELECT * FROM production_units WHERE id = $1 FOR UPDATE`, [unit_id])).rows[0];
  if (!u) throw new Error('Konver topilmadi');
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

  // ★ JAVOBGAR TSEX
  //   Bo'lim konver QAYERDA ekanini aytadi, javobgar tsex esa KIM uni
  //   boshqarayotganini. Stulning lak ishi lak tsexining kabinasida
  //   bajariladi, lekin uni stul tsexi boshlig'i yuritadi — shuning uchun
  //   quyidagi hamma qoida bo'limning tsexiga emas, JAVOBGARGA tayanadi.
  //   Guruhga javobgar biriktirilmagan bo'lsa (penal, kamod, sp, stol)
  //   javobgar — turgan joyining tsexi, ya'ni eskicha.
  const owner = (await client.query(
    `SELECT g.owner_shop_id FROM products p
       JOIN product_groups g ON g.id = p.group_id
      WHERE p.id = $1`, [u.product_id])).rows[0]?.owner_shop_id || null;
  const shopOf = (sectionShopId) => owner || sectionShopId;
  const toShop = shopOf(sec.shop_id);

  // ★ QABUL QILISH QOIDASI
  //   Konverni X tsexining bo'limiga o'tkazish uchun X tsexi doirasida
  //   bo'lish kerak. Bundan ikki narsa o'z-o'zidan kelib chiqadi:
  //     · tsex ichidagi harakatni o'sha tsex boshlig'i qiladi;
  //     · tsexdan tsexga o'tkazishni QABUL QILUVCHI tomon bosadi.
  //   Ya'ni "topshirdim" degan alohida tugma va alohida holat kerak emas —
  //   konver oldingi tsexning oxirgi bo'limida turibdi degani "topshirishga
  //   tayyor" degani, va uni faqat keyingi tsex o'ziga ola oladi. Kim qabul
  //   qilgani va qachon — unit_moves da allaqachon yoziladi.
  const scope = scopeOf(req);
  if (scope && !scope.includes(toShop)) {
    const kim = owner
      ? (await client.query(`SELECT name FROM shops WHERE id = $1`, [owner])).rows[0].name
      : sec.shop;
    throw new Error(
      `${u.conveyor_no}: «${kim}» sizning doirangizda emas — ` +
      `konverni o'sha tsex boshlig'i boshqaradi`);
  }

  // Keyingi tsexga topshirish rejasi faqat konver HAQIQATAN boshqa tsexga
  // o'tganda tozalanadi. Tsex ichidagi harakat (arra → freza) rejaga
  // tegmasligi kerak: aks holda boshliq qo'ygan muddat birinchi
  // o'tkazishdayoq yo'qoladi.
  const from = u.current_section_id ? (await client.query(
    `SELECT shop_id FROM sections WHERE id = $1`, [u.current_section_id])).rows[0] : null;
  // Javobgar o'zgardimi — bo'lim tsexi emas. Stul lak bo'limiga o'tganda
  // javobgar o'zgarmaydi: topshirish ham, reja sanasini tozalash ham
  // kerak emas, chunki konver boshqa odamning qo'liga o'tmadi.
  const shopChanged = !from || shopOf(from.shop_id) !== toShop;

  // Tsexdan tsexga o'tish — ikki bosqich. Jo'natuvchi «jo'natdim» demaguncha
  // qabul qilib bo'lmaydi: aks holda ikkinchi bosqichning ma'nosi qolmaydi
  // va «men topshirmagandim» degan bahs qaytadan paydo bo'ladi.
  if (shopChanged && from && !(u.handover_on && u.handover_shop_id === shopOf(from.shop_id)))
    throw new Error(`${u.conveyor_no}: hali jo'natilmagan — oldingi tsex «jo'natdim» deyishi kerak`);

  const defect = Number(qty_defect) || 0;
  if (defect > 0 && !defect_reason) throw new Error('Brak uchun sabab kodi majburiy');

  // Nechta dona ketadi. Ko'rsatilmasa — hammasi (eskicha xulq).
  const n = qty == null || qty === '' ? u.qty : Number(qty);
  if (!Number.isInteger(n) || n <= 0)
    throw new Error(`${u.conveyor_no}: soni butun va noldan katta bo'lishi kerak`);
  if (n > u.qty)
    throw new Error(`${u.conveyor_no}: bu yerda ${u.qty} ta bor, ${n} tasini o'tkazib bo'lmaydi`);
  if (defect > n) throw new Error(`${u.conveyor_no}: brak soni o'tkazilayotgan sondan ko'p`);

  const row = await placePieces(client, req, u, target, n,
                                moved_on || new Date().toISOString().slice(0, 10));

  // Keyingi tsexga topshirish rejasi faqat konver HAQIQATAN boshqa tsexga
  // o'tganda tozalanadi. Holat va T/M ombor sanasiga esa tegilmaydi:
  // chiqish bo'limiga kirish mahsulotni omborga tushirmaydi, uni ombor
  // mudiri qabul qiladi (POST /stock/accept).
  if (shopChanged)
    await client.query(
      `UPDATE production_units SET next_shop_planned_on = NULL WHERE id = $1`, [row]);

  const move = (await client.query(
    `INSERT INTO unit_moves (unit_id, section_id, from_section_id, moved_on,
                             qty, qty_defect, defect_reason, worker_id, note)
     VALUES ($1,$2,$3, COALESCE($4::date, CURRENT_DATE), $5,$6,$7,$8,$9) RETURNING id`,
    [row, target, u.current_section_id || null, moved_on || null,
     n, defect, defect_reason || null, req.user.id, note || null])).rows[0];

  // Lak va Qadoqlash tsexiga kirish sanasi jurnalda alohida ustun. Reja
  // sanasini tsex boshlig'i qo'yadi, faktni esa konver o'sha tsexga
  // o'tganda tizim o'zi yozadi — qo'lda ikkinchi marta kiritilmaydi.
  // Stul oqimi bo'yoqlashdan keyin qaytadi, shuning uchun BIRINCHI kirish
  // sanasi saqlanadi: ustun bo'sh bo'lgandagina yoziladi.
  if (sec.milestone) {
    const col = sec.milestone === 'lak' ? 'lak_on' : 'pack_on';
    await client.query(
      `UPDATE production_units SET ${col} = COALESCE($2::date, CURRENT_DATE)
        WHERE id = $1 AND ${col} IS NULL`, [row, moved_on || null]);
  }

  // Umumiy hisobotlar (WIP, panel, Pareto) o'zgarishsiz ishlashi uchun
  // har o'tkazish jamlanma flow_log ga ham yoziladi.
  const shiftId = await resolveShift(client, u.product_id, 1, req.user.id, moved_on || null);
  const flow = (await client.query(
    `INSERT INTO flow_log (shift_id, section_id, product_id, qty_ok, qty_defect, worker_id, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [shiftId, target, u.product_id, n, defect, req.user.id, u.conveyor_no])).rows[0];
  if (defect > 0) {
    await client.query(
      `INSERT INTO defects (flow_log_id, work_date, section_id, product_id, reason_code, qty)
       VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3,$4,$5,$6)`,
      [flow.id, moved_on || null, target, u.product_id, defect_reason, defect]);
  }
  // Qaytarishda aynan shu jamlanma yozuvni topish uchun bog'lab qo'yamiz
  await client.query(`UPDATE unit_moves SET flow_log_id = $2 WHERE id = $1`,
                     [move.id, flow.id]);
  return { unit_id: row, conveyor_no: u.conveyor_no, qty: n,
           section_id: target, is_exit: sec.is_exit };
}

// ────────────────────────────────────────── OXIRGI O'TKAZISHNI QAYTARISH
//
//  "O'tkazish" bexosdan bosilishi oddiy hol — ayniqsa konver shu bilan T/M
//  omboriga tushib ketsa. Bekor qilish bunga yaramaydi: u konverni
//  jurnaldan butunlay chiqaradi. Shuning uchun bitta qadam orqaga
//  qaytariladi.
//
//  FAQAT OXIRGI harakat qaytariladi. O'rtadagisini olib tashlash tarixni
//  yolg'on qiladi: konver o'tmagan bo'limdan o'tgan bo'lib ko'rinadi.
//
//  Qaytariladigan narsalar — o'tkazish nimani yozgan bo'lsa, o'shalar:
//    · harakat yozuvi (unit_moves)
//    · jamlanma yozuv (flow_log) va undagi brak (defects · CASCADE)
//    · konverning joyi, holati va T/M omborga kirish sanasi
//    · lak va qadoqlash tsexiga kirish sanasi — qolgan harakatlardan
//      qaytadan hisoblanadi, chunki birinchi kirish sanasi saqlanadi
//    · T/M ombor qoldig'i (fg_stock)
async function undoLastMove(client, req, unit_id) {
  const u = (await client.query(
    `SELECT * FROM production_units WHERE id = $1 FOR UPDATE`, [unit_id])).rows[0];
  if (!u) throw new Error('Konver topilmadi');
  if (u.status === 'shipped')
    throw new Error(`${u.conveyor_no}: mijozga jo'natilgan, avval jo'natmani bekor qiling`);
  // T/M omborga qabul qilingan konver ishlab chiqarishnikи emas — uni
  // avval ombor qaytarishi kerak, aks holda qoldiq bilan jurnal ajralib
  // ketadi: ombor mahsulot bor deb turadi, jurnal esa uni orqaga suradi.
  if (u.status === 'fg')
    throw new Error(`${u.conveyor_no}: T/M omborda — avval ombor qabulini qaytaring`);

  const last = (await client.query(
    `SELECT m.*, s.is_exit FROM unit_moves m
       JOIN sections s ON s.id = m.section_id
      WHERE m.unit_id = $1 ORDER BY m.id DESC LIMIT 1`, [unit_id])).rows[0];
  if (!last) throw new Error(`${u.conveyor_no}: qaytariladigan o'tkazish yo'q`);

  // Qaytarish — o'tkazishning teskarisi, demak qoida ham o'sha: konver
  // hozir turgan tsex doirangizda bo'lsagina orqaga ola olasiz.
  const scope = scopeOf(req);
  if (scope) {
    const at = (await client.query(
      `SELECT sh.id, sh.name FROM sections s JOIN shops sh ON sh.id = s.shop_id
        WHERE s.id = $1`, [last.section_id])).rows[0];
    if (at && !scope.includes(at.id))
      throw new Error(`${u.conveyor_no}: konver «${at.name}» tsexida — qaytarishni o'sha tsex qiladi`);
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

  // Donalar KELGAN joyiga qaytadi. Bir qismi ko'chgan bo'lsa faqat o'sha
  // qism qaytadi, qolgani joyida turadi — o'tkazishning aynan teskarisi.
  // Qaytgan joyda bo'lak turgan bo'lsa donalar unga qo'shiladi.
  const back = Math.min(last.qty || u.qty, u.qty);
  const row = await placePieces(client, req, u, last.from_section_id || null,
                                back, last.moved_on);

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
     WHERE u.id = $1`, [row]);

  // T/M ombor qoldig'iga tegilmaydi: chiqish bo'limiga o'tish uni
  // oshirmagan edi, demak qaytarish ham kamaytirmaydi.

  return { unit_id: row, conveyor_no: u.conveyor_no, qty: back,
           from_section_id: last.section_id, to_section_id: last.from_section_id || null };
}

// Oxirgi o'tkazishni qaytarish. Bir nechta konverni birdan ham qabul qiladi.
router.post('/undo', need('production.entry'), wrap(async (req, res) => {
  const ids = Array.isArray(req.body.items) ? req.body.items : [req.body.unit_id];
  if (!ids.length) throw new Error('Konver tanlanmagan');
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

// ═══════════════════════════════════════════ KEYINGI TSEXGA JO'NATISH
//
//  Birinchi bosqich: ish tugadi, mahsulot keyingi tsexga topshirishga
//  tayyor. Mahsulot joyidan qimirlamaydi — u hali jo'natuvchi tsexda
//  turibdi va uning javobgarligida; faqat belgi qo'yiladi.
//
//  Ikkinchi bosqichni (qabul qilish) keyingi tsex bajaradi — o'tkazish
//  tugmasi bilan, va u faqat shu belgi turgan konverka ishlaydi.
async function handoverOne(client, req, unitId, undo) {
  // Jo'natuvchi — javobgar tsex, konver turgan bo'limning tsexi emas
  // (izoh: sql/catalog-groups.sql, owner_shop_id).
  const u = (await client.query(
    `SELECT u.id, u.conveyor_no, u.status,
            COALESCE(g.owner_shop_id, sc.shop_id) AS shop_id,
            COALESCE(osh.name, sh.name)           AS shop
       FROM production_units u
       JOIN products pr       ON pr.id = u.product_id
       JOIN product_groups g  ON g.id  = pr.group_id
       LEFT JOIN sections sc  ON sc.id = u.current_section_id
       LEFT JOIN shops sh     ON sh.id = sc.shop_id
       LEFT JOIN shops osh    ON osh.id = g.owner_shop_id
      WHERE u.id = $1 FOR UPDATE OF u`, [unitId])).rows[0];
  if (!u) throw new Error('Konver topilmadi');
  if (u.status === 'cancelled') throw new Error(`${u.conveyor_no}: bekor qilingan`);
  if (!u.shop_id) throw new Error(`${u.conveyor_no}: hech bir bo'limda turmagan`);

  const scope = scopeOf(req);
  if (scope && !scope.includes(u.shop_id))
    throw new Error(`${u.conveyor_no}: «${u.shop}» sizning doirangizda emas`);

  if (undo) {
    await client.query(
      `UPDATE production_units
          SET handover_on = NULL, handover_at = NULL,
              handover_by = NULL, handover_shop_id = NULL
        WHERE id = $1`, [unitId]);
    return { unit_id: unitId, conveyor_no: u.conveyor_no, sent: false };
  }

  await client.query(
    `UPDATE production_units
        SET handover_on = CURRENT_DATE, handover_at = NOW(),
            handover_by = $2, handover_shop_id = $3
      WHERE id = $1`, [unitId, req.user.id, u.shop_id]);
  return { unit_id: unitId, conveyor_no: u.conveyor_no, sent: true };
}

router.post('/handover', need('production.entry'), wrap(async (req, res) => {
  const ids = Array.isArray(req.body.items) ? req.body.items : [req.body.unit_id];
  if (!ids.length) throw new Error('Konver tanlanmagan');
  const undo = !!req.body.undo;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const done = [];
    for (const id of ids) done.push(await handoverOne(client, req, id, undo));
    await audit(req, { module: 'production', action: undo ? 'handover-undo' : 'handover',
                       entity: 'unit', entity_id: done.length,
                       payload: { units: done.map((x) => x.conveyor_no) } }, client);
    await client.query('COMMIT');
    res.json({ done });
  } catch (e) {
    await client.query('ROLLBACK');
    return res.status(400).json({ error: e.message });
  } finally { client.release(); }
}));

// ═════════════════════════════════ T/M OMBOR: QABUL QILISH VA QAYTARISH
//
//  Mahsulot chiqish bo'limiga (qadoqlash) yetgani — u omborda degani EMAS.
//  Qadoqlash tsexi «T/M omborga jo'natdim» deydi, ombor mudiri esa
//  «qabul qildim». Faqat shundan keyin konver:
//    · T/M ombor qoldig'iga tushadi (fg_stock)
//    · holati `fg` bo'ladi
//    · ishlab chiqarish jurnalidan chiqadi
//
//  Sabab tsexlar orasidagi bilan bir xil: topshirishda ikki tomon bo'lsa,
//  «berdim / olmadim» degan bahs o'rniga ikkita sana turadi.
async function acceptStock(client, req, unitId, undo) {
  const u = (await client.query(
    `SELECT u.*, sc.is_exit
       FROM production_units u
       LEFT JOIN sections sc ON sc.id = u.current_section_id
      WHERE u.id = $1 FOR UPDATE OF u`, [unitId])).rows[0];
  if (!u) throw new Error('Konver topilmadi');

  if (undo) {
    if (u.status !== 'fg')
      throw new Error(`${u.conveyor_no}: T/M omborda emas`);
    await client.query(
      `UPDATE production_units SET status = 'production', fg_on = NULL,
              warehouse_id = NULL WHERE id = $1`, [unitId]);
    await refreshStock(client, u.product_id);
    return { unit_id: unitId, conveyor_no: u.conveyor_no, accepted: false };
  }

  if (u.status === 'fg') throw new Error(`${u.conveyor_no}: allaqachon qabul qilingan`);
  if (u.status === 'cancelled') throw new Error(`${u.conveyor_no}: bekor qilingan`);
  if (!u.is_exit)
    throw new Error(`${u.conveyor_no}: hali chiqish bo'limiga yetmagan`);
  if (!u.handover_on)
    throw new Error(`${u.conveyor_no}: hali jo'natilmagan — qadoqlash tsexi «jo'natdim» deyishi kerak`);

  //  Ishlab chiqarishdan kelgan mahsulot HAR DOIM T/M omborga tushadi:
  //  vitrinaga u shu yerdan ko'chiriladi (`warehouse/fg/transfer`). Tsex
  //  vitrinaga to'g'ridan-to'g'ri topshirmaydi — aks holda ombor mudiri
  //  ko'rmagan mahsulot hisobga tushib qolardi.
  await client.query(
    `UPDATE production_units
        SET status = 'fg', fg_on = COALESCE(fg_on, CURRENT_DATE),
            warehouse_id = COALESCE(warehouse_id,
                                    (SELECT id FROM warehouses WHERE code = 'TM'))
      WHERE id = $1`, [unitId]);
  await refreshStock(client, u.product_id);
  return { unit_id: unitId, conveyor_no: u.conveyor_no, accepted: true };
}

// Omborga jo'natilgan, lekin hali qabul qilinmagan konverlar
router.get('/stock/inbox', need('warehouse.view', 'production.view'), wrap(async (_req, res) => {
  const { rows } = await db.query(
    `SELECT r.id, r.conveyor_no, r.order_no, r.product, r.product_type, r.qty,
            r.color, r.fabric, r.customer_name, r.shop, r.section,
            u.handover_on, w.name AS sent_by,
            (CURRENT_DATE - u.handover_on)::int AS days_waiting
       FROM v_unit_register r
       JOIN production_units u ON u.id = r.id
       JOIN sections sc        ON sc.id = u.current_section_id AND sc.is_exit
       LEFT JOIN workers w     ON w.id = u.handover_by
      WHERE r.status = 'production' AND u.handover_on IS NOT NULL
      ORDER BY u.handover_on, r.conveyor_no`);
  res.json(rows);
}));

// ─────────────────────────────────── T/M OMBOR QOLDIG'I — BIRLIK BO'YICHA
//
//  «12 dona Milano» degan qoldiq savolga javob bermaydi: mijoz shikoyat
//  qilganda qaysi konver ekani kerak bo'ladi. Shuning uchun ro'yxat
//  konverlardan iborat, yig'indi esa ularning ostida turadi.
const STOCK_SORT = {
  conveyor_no: 'conveyor_no', product: 'product', product_type: 'product_type',
  qty: 'qty', fg_on: 'fg_on', customer_name: 'customer_name',
  days_in_stock: 'days_in_stock', total_amount: 'total_amount',
};

//  Xodimga ko'rinadigan ombor. Vitrina sotuvchisiga nuqtasi
//  biriktirilgan bo'lsa u faqat o'shani va T/M omborni ko'radi
//  (izoh: modules/warehouse.js, `whScope`). Mos kelmasa so'rov NULL
//  qaytaradi va ro'yxat bo'sh chiqadi — xato emas, shunchaki yo'q.
const WH_PICK = `(SELECT w.id FROM warehouses w
                   WHERE w.code = COALESCE($6, 'TM')
                     AND (w.perm IS NULL OR w.perm = ANY($8::text[]))
                     AND ($9::int[] IS NULL OR w.id = ANY($9) OR w.code = 'TM'))`;

const whIds = (req) => {
  const ids = req.user?.scope_warehouse_ids || [];
  return ids.length ? ids : null;
};

function stockQuery(q, limit, req) {
  const col = STOCK_SORT[q.sort] || 'fg_on';
  const way = String(q.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  return {
    text: `SELECT * FROM v_fg_units
      WHERE warehouse_id = ${WH_PICK}
        AND ($1::int[] IS NULL OR group_id = ANY($1))
        AND ($2::int  IS NULL OR customer_id = $2)
        AND ($3::date IS NULL OR fg_on >= $3)
        AND ($4::date IS NULL OR fg_on <= $4)
        AND ($5::text IS NULL OR conveyor_no ILIKE '%' || $5 || '%'
             OR product ILIKE '%' || $5 || '%' OR sku ILIKE '%' || $5 || '%'
             OR order_no ILIKE '%' || $5 || '%')
        -- Ombor ekranidagi tur filtri. Excel ekranda ko'rinayotgani
        -- bilan bir xil bo'lishi kerak: mudir filtrlab yuklab olsa,
        -- faylda boshqa narsa chiqmasin.
        AND ($7::text IS NULL OR product_type = ANY(string_to_array($7, ',')))
      ORDER BY ${col} ${way} NULLS LAST, conveyor_no
      LIMIT ${limit}`,
    params: [groupIds(q), q.customer_id || null, q.from || null, q.to || null,
             q.q || null, q.w || null, q.product_type || null,
             req.user.permissions, whIds(req)],
  };
}

router.get('/stock', need('warehouse.view', 'production.view'), wrap(async (req, res) => {
  const { text, params } = stockQuery(req.query, 1000, req);
  const [rows, groups] = await Promise.all([
    db.query(text, params),
    // Guruh bo'yicha yig'indi — ro'yxat uzun bo'lsa ham umumiy manzara
    db.query(
      `SELECT product_type, COUNT(*)::int AS units, SUM(qty)::int AS qty
         FROM v_fg_units
        WHERE warehouse_id = (SELECT w.id FROM warehouses w
                               WHERE w.code = COALESCE($1, 'TM')
                                 AND (w.perm IS NULL OR w.perm = ANY($2::text[]))
                                 AND ($3::int[] IS NULL OR w.id = ANY($3)
                                      OR w.code = 'TM'))
        GROUP BY product_type ORDER BY product_type`,
      [req.query.w || null, req.user.permissions, whIds(req)]),
  ]);
  res.json({ rows: rows.rows, groups: groups.rows });
}));

router.get('/stock/export', need('warehouse.view', 'production.view'), wrap(async (req, res) => {
  const { text, params } = stockQuery(req.query, 20000, req);
  const { rows } = await db.query(text, params);
  const cols = [
    ['Konveyer raqami', (r) => r.conveyor_no],
    ['Zakaz raqami',    (r) => r.order_no],
    ['Maxsulot',        (r) => r.product],
    ['Guruhi',          (r) => r.product_type],
    ['Rang',            (r) => r.color],
    ['Mato',            (r) => r.fabric],
    ['Soni',            (r) => r.qty],
    ['Birligi',         (r) => r.uom],
    ['Omborga kirgan',  (r) => csvDate(r.fg_on)],
    ['Omborda, kun',    (r) => r.days_in_stock],
    ['Mijoz',           (r) => r.customer_name],
    ['Summa, $',        (r) => csvNum(r.total_amount)],
  ];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="tm-ombor-${today()}.csv"`);
  res.send('\uFEFF' + [
    cols.map(([n]) => csvCell(n)).join(';'),
    ...rows.map((r) => cols.map(([, get]) => csvCell(get(r))).join(';')),
  ].join('\r\n') + '\r\n');
}));

// Kirim va chiqim: sana oralig'i bo'yicha. Chiqim savdo moduli
// ulanmaguncha bo'sh keladi — ko'rinish tayyor turadi.
// Kirim/chiqim — omborni yurituvchi va rahbariyatniki. Savdo qoldiqni
// ko'radi, uning tarixini emas: sahifada tab yashirilgani yetarli emas,
// tekshiruv shu yerda.
router.get('/stock/moves', need('warehouse.move', 'warehouse.manage',
                                'production.manage', 'production.reports'),
  wrap(async (req, res) => {
  const from = req.query.from || today();
  const to   = req.query.to || from;
  const { rows } = await db.query(
    `SELECT * FROM v_fg_moves
      WHERE on_date BETWEEN $1::date AND $2::date
        AND ($3::text IS NULL OR kind = $3)
        AND warehouse_id = (SELECT w.id FROM warehouses w
                             WHERE w.code = COALESCE($4, 'TM')
                               AND (w.perm IS NULL OR w.perm = ANY($5::text[]))
                               AND ($6::int[] IS NULL OR w.id = ANY($6)
                                    OR w.code = 'TM'))
      ORDER BY on_date DESC, kind, conveyor_no
      LIMIT 2000`, [from, to, req.query.kind || null, req.query.w || null,
                    req.user.permissions, whIds(req)]);
  res.json({
    from, to, rows,
    kirim:  rows.filter((r) => r.kind === 'kirim').reduce((n, r) => n + r.qty, 0),
    chiqim: rows.filter((r) => r.kind === 'chiqim').reduce((n, r) => n + r.qty, 0),
  });
}));

router.post('/stock/accept', need('warehouse.move', 'production.manage'), wrap(async (req, res) => {
  const ids = Array.isArray(req.body.items) ? req.body.items : [req.body.unit_id];
  if (!ids.length) throw new Error('Konver tanlanmagan');
  const undo = !!req.body.undo;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const done = [];
    for (const id of ids) done.push(await acceptStock(client, req, id, undo));
    await audit(req, { module: 'warehouse', action: undo ? 'fg-undo' : 'fg-accept',
                       entity: 'unit', entity_id: done.length,
                       payload: { units: done.map((x) => x.conveyor_no) } }, client);
    await client.query('COMMIT');
    res.json({ done });
  } catch (e) {
    await client.query('ROLLBACK');
    return res.status(400).json({ error: e.message });
  } finally { client.release(); }
}));

// Har element: { unit_id, qty? } — soni ko'rsatilmasa konver butunligicha
// o'tadi. Bir qismi ko'rsatilsa konver bo'linadi (izoh: placePieces).
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
//    · sections — o'z tsexining bo'limlari va ularda turgan konverlar
//    · inbox    — oldingi tsexda "topshirishga tayyor" turganlar, ya'ni
//                 marshruti bo'yicha keyingi qadami MENING tsexim
//    · muddat   — keyingi tsexga topshirishga necha kun qolgani
//
//  ★ MUDDAT AYNAN JURNALDAGI SANA
//
//  Zavodda oqim: Korpus → Lak (bo'yoqlash) → Qadoqlash → T/M ombor.
//  Jurnalda har konver uchun shu uch sana turibdi: «Lak tsehi»,
//  «Qadoqlash tsehi», «T/M ombor». Usta telefonida ko'radigan muddat —
//  o'sha sananing o'zi, boshqa hisob emas: aks holda jurnalda bir sana,
//  telefonda boshqa sana chiqib, qaysi biriga ishonishni bilib bo'lmaydi.
//
//  Qaysi sana olinishi konver HOZIR qaysi tsexda turganiga qarab hal
//  bo'ladi — marshrutdagi keyingi BOSHQA tsex topiladi va o'sha tsexning
//  bosqich belgisi (shops.milestone) sanani tanlaydi:
//      korpusdagi konver    → keyingi tsex lak      → «Lak tsehi» sanasi
//      bo'yoqlashdagi konver → keyingi tsex qadoqlash → «Qadoqlash» sanasi
//      qadoqlashdagi konver  → oldinda tsex yo'q      → «T/M ombor» sanasi
//
//  Jurnalda sana qo'yilmagan bo'lsa eski hisob (marshrut va bo'lim
//  tezligidan chiqqan taxmin) zaxira bo'lib qoladi.
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
    `SELECT r.id, r.conveyor_no, r.order_no, r.product, r.product_type, r.sku, r.qty,
            r.color, r.fabric, r.customer_name, r.shop, r.shop_id,
            -- Hali hech bir bo'limda turmagan konverning egasi yo'q:
            -- u marshrutining BIRINCHI qadamiga qarab aniqlanadi.
            -- Aks holda kiritilgan konver hech kimning ekranida
            -- ko'rinmay qolardi va uni boshlab bo'lmasdi.
            COALESCE(r.owner_shop_id, ns.shop_id) AS owner_shop_id,
            r.section, r.section_id, r.entered_section_on,
            r.is_stock, r.waiting,
            -- Konver marshrutida YO'Q bo'limda turibdimi. Marshrut
            -- o'zgartirilganda shunday konver qolib ketishi mumkin, va
            -- unga keyingi qadamni hisoblab bo'lmaydi: "marshrut tugadi"
            -- deb ko'rsatish esa yolg'on bo'lardi.
            -- Boshlanmagan konver marshrutdan tashqarida emas: u hali
            -- yo'lga chiqmagan. Birinchi qadami topilgan bo'lsa — joyida.
            (r.step_no IS NOT NULL OR
             (r.section_id IS NULL AND n.section_id IS NOT NULL)) AS on_route,
            -- Shu tsexdan jo'natilganmi. Belgi tsex bilan birga saqlanadi,
            -- shuning uchun keyingi tsexda eski belgi «jo'natilgan» bo'lib
            -- ko'rinmaydi.
            (pu.handover_on IS NOT NULL
             AND pu.handover_shop_id = COALESCE(r.owner_shop_id, ns.shop_id)) AS sent,
            pu.handover_on,
            hw.name AS sent_by,
            n.section_id AS next_section_id,
            ns.name      AS next_section,
            -- Keyingi qadamning JAVOBGAR tsexi. Ekranda shu qiymat
            -- «jo'natish» tugmasini chiqaradimi yoki oddiy «o'tkazish»
            -- ni — shuning uchun bu yerda bo'limning tsexi emas,
            -- javobgari turishi kerak: stul lak bo'limiga o'tganda ham
            -- javobgar o'zgarmaydi, demak hech kimga topshirilmaydi.
            COALESCE(g.owner_shop_id, ns.shop_id) AS next_shop_id,
            COALESCE(osh.name, nsh.name)          AS next_shop_name,
            -- Topshiriladigan tsex: marshrutda oldinda turgan birinchi
            -- BOSHQA tsex. Qadoqlashda bunday tsex yo'q — oldinda ombor.
            COALESCE(hs.name, 'T/M ombor') AS due_shop,
            d.due_on,
            (d.due_on - CURRENT_DATE)::int AS days_left,
            d.due_src
       FROM v_unit_register r
       JOIN production_units pu ON pu.id = r.id
       -- Guruhga javobgar tsex: oldinda turgan bo'lim boshqa odamning
       -- qo'liga o'tishini shu hal qiladi, bo'limning tsexi emas.
       JOIN product_groups g    ON g.id = r.group_id
       LEFT JOIN workers hw     ON hw.id = pu.handover_by
       -- Marshrutdagi keyingi qadam. Bo'lim boshlig'i ro'yxatdan tanlab
       -- o'tirmasligi uchun tugmada aynan shu bo'lim nomi yoziladi.
       LEFT JOIN LATERAL (
         SELECT pr.section_id FROM v_product_route pr
          WHERE pr.product_id = r.product_id
            AND (r.step_no IS NULL OR pr.step_no > r.step_no)
          ORDER BY pr.step_no LIMIT 1) n ON true
       LEFT JOIN sections ns  ON ns.id  = n.section_id
       LEFT JOIN shops    nsh ON nsh.id = ns.shop_id
       LEFT JOIN shops    osh ON osh.id = g.owner_shop_id
       -- Oldinda turgan birinchi boshqa tsex va uning bosqich belgisi
       LEFT JOIN LATERAL (
         SELECT sh.name, sh.milestone
           FROM v_product_route pr
           JOIN sections sc2 ON sc2.id = pr.section_id
           JOIN shops    sh  ON sh.id  = sc2.shop_id
          WHERE pr.product_id = r.product_id AND pr.step_no > r.step_no
            AND COALESCE(g.owner_shop_id, sc2.shop_id)
                <> COALESCE(r.owner_shop_id, ns.shop_id)
          ORDER BY pr.step_no LIMIT 1) hs ON true
       -- Jurnaldagi sana: qaysi tsexga topshiriladi — o'shaniki
       LEFT JOIN LATERAL (
         SELECT COALESCE(j.dt, r.next_shop_on) AS due_on,
                CASE WHEN j.dt IS NOT NULL THEN 'jurnal' ELSE r.next_shop_src END AS due_src
           FROM (SELECT CASE hs.milestone
                          WHEN 'lak'  THEN r.lak_on
                          WHEN 'pack' THEN r.pack_on
                          ELSE CASE WHEN hs.name IS NULL THEN r.fg_on END
                        END AS dt) j) d ON true
      WHERE r.status = 'production'
        -- O'z tsexim, va menga JO'NATILGANLAR. Jo'natilmagani hali oldingi
        -- tsexning ishi — uni qabul qilish ro'yxatida ko'rsatish "olib
        -- qo'ying" degan taklif bo'lardi.
        AND (COALESCE(r.owner_shop_id, ns.shop_id) = $1
             OR (COALESCE(g.owner_shop_id, ns.shop_id) = $1
                 AND pu.handover_on IS NOT NULL
                 AND pu.handover_shop_id = r.owner_shop_id))
      -- Eng shoshilinchi yuqorida. Muddatsizlari oxirida: ular kutmayapti,
      -- ular haqida hali ma'lumot yo'q.
      ORDER BY d.due_on NULLS LAST, r.conveyor_no`, [shopId])).rows;

  // Ekrandagi bo'limlar: o'z tsexining bo'limlari, USTIGA shu tsex
  // boshqaradigan mahsulot marshrutidagi begona bo'limlar. Stul tsexi
  // boshlig'i lak tsexidagi «Astar sepish», «Lak» bo'limlarini ham
  // ko'radi — stul o'sha yerda turadi va uni o'zi o'tkazadi.
  //
  // Tartib marshrut bo'yicha: shunda ekrandagi ustunlar mahsulot
  // yuradigan yo'l bilan bir xil o'qiladi. Marshrutda yo'q bo'lim
  // (masalan, faqat korpusga tegishlisi) oxirida, o'z tartibida.
  const sections = (await db.query(
    `SELECT s.id, s.name, s.sort, s.is_exit, o.st
       FROM sections s
       LEFT JOIN LATERAL (
         SELECT MIN(pr.step_no) AS st
           FROM v_product_route pr
           JOIN products p2      ON p2.id = pr.product_id
           JOIN product_groups g2 ON g2.id = p2.group_id
          WHERE pr.section_id = s.id AND g2.owner_shop_id = $1) o ON true
      WHERE s.active AND (s.shop_id = $1 OR o.st IS NOT NULL)
      ORDER BY o.st NULLS LAST, s.sort, s.name`, [shopId])).rows;

  const mine = rows.filter((r) => r.owner_shop_id === shopId);
  // Kiritilgan, lekin hali konveyerga chiqmagan konverlar. Ular hech bir
  // bo'limda turmaydi, shuning uchun bo'lim ustunlariga tushmaydi —
  // ekranning tepasida alohida ro'yxat bo'lib turadi.
  const fresh = mine.filter((r) => !r.section_id);
  res.json({
    shops,
    shop: shops.find((s) => s.id === shopId),
    unstarted: fresh,
    sections: sections.map((sc) => ({
      ...sc, units: mine.filter((u) => u.section_id === sc.id) })),
    // Qabul qilishni kutayotganlar: boshqa tsexda turibdi, keyingi qadami menda
    inbox: rows.filter((r) => r.owner_shop_id !== shopId && r.section_id),
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
  // Ikki manba bitta lentada: bo'lim almashuvi (unit_moves) va keyingi
  // tsexga jo'natish belgisi (production_units.handover_*). Jo'natish
  // harakat emas — mahsulot joyidan qimirlamaydi — lekin nazorat uchun u
  // ham kun voqeasi: kim, qachon, qaysi konverni topshirishga qo'ydi.
  return {
    text: `SELECT * FROM (
      SELECT m.moved_on, m.moved_at, m.qty_defect, m.defect_reason, m.note,
             u.conveyor_no, u.order_no, u.qty, u.is_opening,
             p.name AS product,
             sc.name AS section, sh.id AS shop_id, sh.name AS shop,
             w.id AS worker_id, COALESCE(w.name, '—') AS worker,
             pr.name AS from_section, psh.name AS from_shop, psh.id AS from_shop_id,
             'move' AS kind
        FROM unit_moves m
        JOIN production_units u ON u.id = m.unit_id
        JOIN products p         ON p.id = u.product_id
        JOIN sections sc        ON sc.id = m.section_id
        JOIN shops sh           ON sh.id = sc.shop_id
        LEFT JOIN workers w     ON w.id = m.worker_id
        -- Oldingi harakat: "qayerdan" shundan chiqadi. Bo'lmasa — konver
        -- endi kiritilgan (boshlang'ich qoldiq yoki yangi konver).
        LEFT JOIN LATERAL (
          SELECT m2.section_id FROM unit_moves m2
           WHERE m2.unit_id = m.unit_id AND m2.id < m.id
           ORDER BY m2.id DESC LIMIT 1) pm ON true
        LEFT JOIN sections pr  ON pr.id = pm.section_id
        LEFT JOIN shops    psh ON psh.id = pr.shop_id
       WHERE m.moved_on BETWEEN $1::date AND $2::date

      UNION ALL

      SELECT u.handover_on, u.handover_at, 0, NULL, NULL,
             u.conveyor_no, u.order_no, u.qty, false,
             p.name,
             sc.name, sh.id, sh.name,
             w.id, COALESCE(w.name, '—'),
             NULL, NULL, NULL::int,
             'handover'
        FROM production_units u
        JOIN products p      ON p.id = u.product_id
        JOIN sections sc     ON sc.id = u.current_section_id
        JOIN shops sh        ON sh.id = u.handover_shop_id
        LEFT JOIN workers w  ON w.id = u.handover_by
       WHERE u.handover_on BETWEEN $1::date AND $2::date
    ) f
     WHERE ($3::int[] IS NULL OR f.shop_id = ANY($3))
       AND ($4::int   IS NULL OR f.shop_id = $4)
       AND ($5::int   IS NULL OR f.worker_id = $5)
       AND ($6::text  IS NULL OR f.conveyor_no ILIKE '%' || $6 || '%')
     ORDER BY f.moved_at DESC
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

const KIND_UZ = { move: "o'tkazish", handover: "keyingi tsexga jo'natdi" };

const FEED_COLUMNS = [
  ['Sana',            (r) => csvDate(r.moved_on)],
  ['Vaqt',            (r) => new Date(r.moved_at).toLocaleTimeString('ru-RU')],
  ['Xodim',           (r) => r.worker],
  ['Konveyer raqami', (r) => r.conveyor_no],
  ['Zakaz raqami',    (r) => r.order_no],
  ['Maxsulot',        (r) => r.product],
  ['Soni',            (r) => r.qty],
  ['Amal',            (r) => KIND_UZ[r.kind] || r.kind],
  ['Qayerdan',        (r) => r.kind === 'handover' ? ''
                       : r.from_section || (r.is_opening ? "boshlang'ich qoldiq" : 'yangi konver')],
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
// Boshlang'ich qoldiqni fayldan yuklashda T/M omborga tushgan konver
// uchun kerak (modules/import.js). Qoldiq ± bilan emas, har safar
// konverlardan qayta sanaladi — shu sabab bitta funksiya.
module.exports.refreshStock = refreshStock;
// Savdo buyurtmaga konverning bir qismini biriktirganda ishlatadi
// (modules/sales.js): bo'lish qoidasi bitta joyda tursin.
module.exports.clonePart = clonePart;
