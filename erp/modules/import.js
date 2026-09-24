// ============================================================================
//  BOSHLANG'ICH QOLDIQNI FAYLDAN YUKLASH
//
//  Zavod qoldiqni Excel'da yuritadi. Uni qo'lda bittalab ko'chirish yuzlab
//  qator degani, ya'ni yuzta xato imkoniyati — shuning uchun fayl
//  to'g'ridan-to'g'ri o'qiladi.
//
//  Ikki bosqich, va bu ataylab:
//    1. KO'RIB CHIQISH (dry) — fayl o'qiladi, har qator tekshiriladi va
//       qaysi katakda nima noto'g'ri ekani aytiladi. Bazaga tegilmaydi.
//    2. SAQLASH — faqat BARCHA qator to'g'ri bo'lsa. Yarim yuklangan
//       qoldiq eng yomon holat: nima kirdi, nima kirmadi — bilib bo'lmaydi,
//       va qayta yuklasa konveyer raqamlari takrorlanadi.
//
//  Ustun nomlari erkin: zavod o'z faylini qayta chizmaydi, tizim uning
//  sarlavhalariga moslashadi.
// ============================================================================
const express = require('express');
const { db, wrap, audit } = require('../db');
const { need } = require('../auth');
const { readSheet } = require('../xlsx');
const { createOne } = require('./units');

const router = express.Router();
//  Fayldan yuklash — BOSHLANG'ICH QOLDIQ yo'li (`is_opening: true`),
//  ya'ni bir martalik ish. Kundalik konver kiritadigan xodimda u
//  bo'lmaydi (izoh: `modules/units.js`, `createOne`).
const UNITS    = ['production.manage'];

// ─────────────────────────────────────────────────────────────── SARLAVHALAR
// Taqqoslashdan oldin sarlavha soddalashtiriladi: katta-kichik harf,
// bo'shliq, tinish belgisi va o'zbekcha apostrof (bo'lim / bo‘lim / bolim)
// farqi yo'qoladi.
const norm = (s) => String(s ?? '')
  .toLowerCase()
  .replace(/[''`ʻʼ’‘]/g, '')
  .replace(/[^a-z0-9а-яё]/gi, '');

const FIELDS = {
  conveyor_no: ['konveyer', 'konveyerraqami', 'konveyernomeri', 'konver', 'konvernomeri',
                'kn', 'kraqam', 'kraqami', 'номерконвейера', 'конвейер'],
  order_no:    ['zakaz', 'zakazraqami', 'zakaznomeri', 'zn', 'buyurtma',
                'buyurtmaraqami', 'заказ', 'номерзаказа'],
  product:     ['maxsulot', 'mahsulot', 'maxsulotnomi', 'mahsulotnomi', 'nomi', 'nom',
                'sku', 'tovar', 'продукт', 'товар', 'наименование'],
  qty:         ['soni', 'son', 'dona', 'miqdor', 'qty', 'количество', 'колво', 'кол'],
  section:     ['bolim', 'bolimi', 'uchastka', 'участок', 'отдел'],
  shop:        ['tsex', 'tseh', 'sex', 'seh', 'cex', 'цех'],
  group:       ['guruh', 'guruhi', 'maxsulotguruhi', 'mahsulotguruhi', 'gruppa',
                'группа', 'категория'],
  color:       ['rang', 'rangi', 'цвет'],
  fabric:      ['mato', 'matosi', 'ткань'],
  customer:    ['mijoz', 'mijoznomi', 'klient', 'xaridor', 'клиент', 'покупатель'],
  unit_price:  ['narx', 'narxi', 'price', 'цена'],
  started_on:  ['boshsana', 'sana', 'boshlanishsanasi', 'дата', 'датаначала'],
  is_stock:    ['zahira', 'zaxira', 'запас', 'резерв'],
  // Omborga kirgan sana bo'lsa, konver ishlab chiqarishda emas, T/M
  // omborda turibdi degani: qoldiqqa tushadi va jurnalda ko'rinmaydi.
  fg_on:       ['omborgakirgan', 'omborgakirgansana', 'omborgakirgansanasi',
                'omborsana', 'omborsanasi', 'tmombor', 'tmomborsana',
                'tmomborsanasi', 'qabulqilingansana', 'qabulsana',
                'датаприемки', 'приемка', 'наскладе', 'складсана'],
  note:        ['izoh', 'izohi', 'примечание', 'комментарий'],
};

function mapHeaders(head) {
  const map = {};            // maydon → ustun raqami
  const unknown = [];
  head.forEach((h, i) => {
    const n = norm(h);
    if (!n) return;
    const field = Object.keys(FIELDS).find((f) => FIELDS[f].includes(n));
    if (field) { if (map[field] == null) map[field] = i; }
    else unknown.push(String(h).trim());
  });
  return { map, unknown };
}

// ──────────────────────────────────────────────────────────────────── O'QISH
// CSV: ajratgich sarlavha qatoridan topiladi. Excel MDH mintaqasida `;`
// bilan saqlaydi, boshqa joyda `,` — ikkalasi ham kelaveradi.
function parseCsv(text) {
  const body = text.replace(/^﻿/, '');
  const first = body.split(/\r?\n/, 1)[0] || '';
  const sep = [';', ',', '\t']
    .map((c) => [c, first.split(c).length])
    .sort((a, b) => b[1] - a[1])[0][0];

  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quoted) {
      if (c === '"' && body[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((x) => x.trim()));
}

const isXlsx = (buf) => buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;

// ────────────────────────────────────────────────────────────── QIYMATLARNI
const YES = new Set(['ha', 'xa', 'yes', 'true', 'da', 'да', '1', '+', 'v', '✓']);

// Sana: Excel'dan YYYY-MM-DD bo'lib keladi, qo'lda yozilganda esa
// 01.09.2026 yoki 1/9/2026 bo'lishi mumkin.
function toDate(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = /^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})$/.exec(s);
  if (!m) return undefined;                       // tanib bo'lmadi
  const [, d, mo, y] = m;
  const year = y.length === 2 ? '20' + y : y;
  return `${year}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Narx: "1 200,50" ham, "1200.5" ham keladi
function toNum(v) {
  const s = String(v ?? '').replace(/\s| /g, '').replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

// ──────────────────────────────────────────────────────────────── SPRAVOCHNIK
async function lookups() {
  const [products, sections, customers, units] = await Promise.all([
    db.query(`SELECT p.id, p.sku, p.name, g.name AS group_name
                FROM products p JOIN product_groups g ON g.id = p.group_id
               WHERE p.active`),
    db.query(`SELECT sc.id, sc.name, sh.name AS shop FROM sections sc
                JOIN shops sh ON sh.id = sc.shop_id WHERE sc.active`),
    db.query(`SELECT id, name FROM customers WHERE active`),
    db.query(`SELECT conveyor_no FROM production_units`),
  ]);

  // Fason nomi guruhlar bo'ylab takrorlanadi: «Milano» — Penal ham,
  // Kamod ham, Stul ham, Sp ham. Ya'ni faqat nom yetarli emas, va bu
  // istisno emas — oddiy hol. Shuning uchun uch xil kalit:
  //   SKU            → aniq
  //   guruh + nom    → aniq
  //   nom            → bitta bo'lsa aniq, ko'p bo'lsa qaysi guruhlarda
  //                    borligini aytamiz
  const bySku = new Map(), byGroupName = new Map(), byProduct = new Map();
  products.rows.forEach((p) => {
    bySku.set(norm(p.sku), p.id);
    byGroupName.set(norm(p.group_name + p.name), p.id);
    const k = norm(p.name);
    const was = byProduct.get(k);
    byProduct.set(k, was
      ? { groups: [...was.groups, p.group_name] }
      : { id: p.id, groups: [p.group_name] });
  });

  const bySection = new Map();
  sections.rows.forEach((sc) => {
    const k = norm(sc.name);
    bySection.set(k, bySection.has(k) ? null : sc.id);
    bySection.set(norm(sc.shop + sc.name), sc.id);   // "Korpus tsexi Arra"
  });

  return {
    bySku, byGroupName, byProduct, bySection,
    byCustomer: new Map(customers.rows.map((c) => [norm(c.name), c.id])),
    taken: new Set(units.rows.map((u) => norm(u.conveyor_no))),
  };
}

// ────────────────────────────────────────────────────── QATORNI TEKSHIRISH
function buildRow(cells, map, ref, seen) {
  const at = (f) => (map[f] == null ? '' : String(cells[map[f]] ?? '').trim());
  const errors = [];
  const it = { is_opening: true };

  // Mahsulot: avval SKU, keyin nom. Katalogdagi nomdan bir harf farq
  // qilsa topilmaydi — shuning uchun xato aniq qator raqami bilan chiqadi.
  const prod = at('product');
  const grp  = at('group');
  if (!prod) errors.push('Maxsulot ko\'rsatilmagan');
  else {
    const id = ref.bySku.get(norm(prod))
            ?? (grp ? ref.byGroupName.get(norm(grp + prod)) : undefined);
    if (id != null) it.product_id = id;
    else {
      const hit = ref.byProduct.get(norm(prod));
      if (!hit) errors.push(`Katalogda yo'q: «${prod}»`);
      else if (hit.groups.length > 1)
        errors.push(`«${prod}» ${hit.groups.length} ta guruhda bor ` +
          `(${hit.groups.join(', ')})${grp ? ` — «${grp}» guruhida yo'q` : ''}. ` +
          `«Guruh» ustunini qo'shing yoki SKU yozing`);
      else it.product_id = hit.id;
    }
  }

  const sec = at('section');
  if (sec) {
    const shop = at('shop');
    const id = ref.bySection.get(norm(shop + sec)) ?? ref.bySection.get(norm(sec));
    if (id == null) errors.push(`Bunday bo'lim yo'q: «${sec}»`);
    else it.section_id = id;
  }

  const qty = at('qty');
  if (qty) {
    const n = toNum(qty);
    if (n === undefined || !Number.isInteger(n) || n <= 0)
      errors.push(`Soni raqam bo'lishi kerak: «${qty}»`);
    else it.qty = n;
  } else it.qty = 1;

  const conv = at('conveyor_no');
  if (conv) {
    if (ref.taken.has(norm(conv))) errors.push(`Bu konveyer raqami band: ${conv}`);
    else if (seen.has(norm(conv))) errors.push(`Faylda takrorlangan: ${conv}`);
    else seen.add(norm(conv));
    it.conveyor_no = conv;
  }

  const price = at('unit_price');
  if (price) {
    const n = toNum(price);
    if (n === undefined) errors.push(`Narx raqam emas: «${price}»`);
    else if (n > 0) it.unit_price = n;
  }

  const date = at('started_on');
  if (date) {
    const d = toDate(date);
    if (d === undefined) errors.push(`Sanani tanib bo'lmadi: «${date}»`);
    else { it.started_on = d; it.entered_section_on = d; }
  }

  // Omborga kirgan sana: shu qator ishlab chiqarishda emas, omborda.
  const fg = at('fg_on');
  if (fg) {
    const d = toDate(fg);
    if (d === undefined) errors.push(`Omborga kirgan sanani tanib bo'lmadi: «${fg}»`);
    else it.fg_on = d;
  }

  const cust = at('customer');
  if (cust) {
    const id = ref.byCustomer.get(norm(cust));
    if (id == null) { it.new_customer = cust; }   // saqlashda qo'shiladi
    else it.customer_id = id;
  }

  it.order_no = at('order_no') || null;
  it.color    = at('color')    || null;
  it.fabric   = at('fabric')   || null;
  it.note     = at('note')     || null;
  it.is_stock = YES.has(norm(at('is_stock')));

  return { it, errors };
}

// ═══════════════════════════════════════════════════════════════════ YO'LLAR
// Fayl xom bayt bo'lib keladi: JSON ichida base64 qilib yuborish hajmni
// uchdan bir baravar oshiradi va foyda bermaydi.
router.post('/units', need(...UNITS),
  express.raw({ type: '*/*', limit: '20mb' }),
  wrap(async (req, res) => {
    const buf = req.body;
    if (!buf || !buf.length) {
      const e = new Error('Fayl bo\'sh'); e.status = 400; throw e;
    }

    let table;
    try {
      table = isXlsx(buf) ? readSheet(buf) : parseCsv(buf.toString('utf8'));
    } catch (e) {
      e.status = 400; e.message = 'Faylni o\'qib bo\'lmadi: ' + e.message; throw e;
    }

    // Sarlavhadan oldin bo'sh qatorlar bo'lishi mumkin — birinchi to'ldirilgan
    // qator sarlavha deb olinadi.
    const headIdx = table.findIndex((r) => r.some((c) => String(c).trim()));
    if (headIdx < 0) { const e = new Error('Fayl bo\'sh'); e.status = 400; throw e; }

    const { map, unknown } = mapHeaders(table[headIdx]);
    if (map.product == null) {
      const e = new Error(
        'Maxsulot ustuni topilmadi. Sarlavhada «Maxsulot» yoki «SKU» bo\'lishi kerak. ' +
        'Topilgan ustunlar: ' + table[headIdx].filter(Boolean).join(', '));
      e.status = 400; throw e;
    }

    const ref = await lookups();
    const seen = new Set();
    const rows = [];
    for (let i = headIdx + 1; i < table.length; i++) {
      const cells = table[i];
      if (!cells.some((c) => String(c).trim())) continue;      // bo'sh qator
      const { it, errors } = buildRow(cells, map, ref, seen);
      rows.push({ line: i + 1, it, errors });
    }
    if (!rows.length) { const e = new Error('Faylda qator yo\'q'); e.status = 400; throw e; }

    const bad = rows.filter((r) => r.errors.length);
    const newCustomers = [...new Set(rows.map((r) => r.it.new_customer).filter(Boolean))];

    // KO'RIB CHIQISH
    if (req.query.save !== '1') {
      return res.json({
        preview: true,
        columns: Object.keys(map),
        unknown,
        total: rows.length,
        bad: bad.length,
        to_stock: rows.filter((r) => r.it.fg_on).length,
        new_customers: newCustomers,
        rows: rows.slice(0, 200),
      });
    }

    // SAQLASH — faqat hammasi to'g'ri bo'lsa
    if (bad.length) {
      const e = new Error(`${bad.length} ta qatorda xato bor — saqlanmadi`);
      e.status = 400; throw e;
    }
    if (newCustomers.length && req.query.new_customers !== '1') {
      const e = new Error(
        `Faylda ${newCustomers.length} ta yangi mijoz bor. Ularni qo'shishga rozilik bering ` +
        'yoki avval Mijozlar bo\'limiga kiriting.');
      e.status = 400; throw e;
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('conveyor_no'))`);

      // Yangi mijozlar — bittadan, nomi bo'yicha takrorlanmas
      const added = new Map();
      for (const name of newCustomers) {
        const { rows: c } = await client.query(
          `INSERT INTO customers (name) VALUES ($1)
           ON CONFLICT (lower(name)) DO UPDATE SET name = EXCLUDED.name
           RETURNING id`, [name]);
        added.set(name, c[0].id);
      }

      const created = [];
      for (const r of rows) {
        if (r.it.new_customer) r.it.customer_id = added.get(r.it.new_customer);
        // «Omborga kirgan» sanasi bo'lsa konverni to'g'ri omborga qo'yish
        // — createOne ning ishi: qoida bitta joyda tursin, aks holda
        // qo'lda kiritish bilan fayldan yuklash ikki xil ishlab ketadi.
        created.push(await createOne(client, req, r.it));
      }

      await audit(req, { module: 'production', action: 'import', entity: 'units',
                         entity_id: created.length,
                         payload: { count: created.length, customers: newCustomers.length } },
                  client);
      await client.query('COMMIT');
      res.json({ saved: created.length, customers: newCustomers.length,
                 to_stock: rows.filter((r) => r.it.fg_on).length, created });
    } catch (e) {
      await client.query('ROLLBACK');
      if (e.code === '23505') {
        e.status = 409;
        e.message = 'Konveyer raqami takrorlandi — hech narsa saqlanmadi';
      } else if (!e.status) e.status = 400;
      throw e;
    } finally {
      client.release();
    }
  }));

// ════════════════════════════════════════════════ MIJOZLAR RO'YXATI FAYLDAN
//
//  Mijozlar sahifasidagi qo'lda kiritish ustunlar TARTIBIGA bog'liq edi:
//  zavodning Excel'i esa o'z tartibida. Shuning uchun bu yerda ham ustun
//  nomiga qarab moslashadi va xuddi qoldiq kabi ikki bosqichda ishlaydi:
//  avval ko'rib chiqish, keyin — hammasi to'g'ri bo'lsa — saqlash.
//
//  Takror nom xato emas: mavjud mijozning bo'sh maydonlari to'ldiriladi
//  (qo'lda kiritish ham shunday ishlaydi). Aks holda ro'yxatni ikkinchi
//  marta yuklab bo'lmasdi.
const CFIELDS = {
  name:    ['mijoz', 'mijoznomi', 'nomi', 'nom', 'klient', 'xaridor', 'firma',
            'tashkilot', 'клиент', 'покупатель', 'наименование', 'фио'],
  phone:   ['tel', 'telefon', 'telraqam', 'telraqami', 'telefonraqam',
            'telefonraqami', 'raqam', 'nomer', 'телефон', 'номертелефона'],
  country: ['davlat', 'respublika', 'mamlakat', 'страна', 'республика'],
  region:  ['region', 'viloyat', 'shahar', 'hudud', 'регион', 'область', 'город'],
  channel: ['kanal', 'manba', 'mijozturi', 'tur', 'канал', 'источник', 'тип'],
  manager: ['menejer', 'savdomenejeri', 'masul', 'masuli', 'masulxodim',
            'masulsavdoxodimi', 'savdoxodimi', 'менеджер'],
  note:    ['izoh', 'izohi', 'примечание', 'комментарий'],
  // Boshlang'ich qarzdorlik: tizim ishga tushgan kundagi qarz, $ da.
  //
  //  IKKI TOMON. `debt` — QARZDOR, mijozning korxonaga qarzi; `credit` —
  //  HAQDOR, korxonaning mijozga qarzi (oldindan to'lov). Zavod ro'yxatida
  //  ikkovi odatda alohida ustun bo'ladi, shuning uchun ikkalasi ham
  //  o'qiladi va `opening_debt = qarzdor − haqdor` bo'lib yoziladi.
  //  Bitta ustunda minus bilan yozilgani ham ishlaydi.
  debt:    ['qarz', 'qarzi', 'qarzdor', 'qarzdorlik', 'boshlangichqarz',
            'boshlangichqarzdorlik', 'долг', 'задолженность', 'дебет'],
  credit:  ['haqdor', 'haq', 'xaqdor', 'oldindantolov', 'oldindantulov', 'avans',
            'аванс', 'переплата', 'кредит'],
  debt_on: ['qarzsanasi', 'qarzsana', 'boshlangichqarzsanasi', 'qarzholatisanasi',
            'датадолга', 'дата'],
};

router.post('/customers', need('production.units', 'sales.manage', 'production.manage'),
  express.raw({ type: '*/*', limit: '10mb' }),
  wrap(async (req, res) => {
    const buf = req.body;
    if (!buf || !buf.length) { const e = new Error('Fayl bo\'sh'); e.status = 400; throw e; }

    let table;
    try {
      table = isXlsx(buf) ? readSheet(buf) : parseCsv(buf.toString('utf8'));
    } catch (e) {
      e.status = 400; e.message = 'Faylni o\'qib bo\'lmadi: ' + e.message; throw e;
    }

    const headIdx = table.findIndex((r) => r.some((c) => String(c).trim()));
    if (headIdx < 0) { const e = new Error('Fayl bo\'sh'); e.status = 400; throw e; }

    const map = {}, unknown = [];
    table[headIdx].forEach((h, i) => {
      const n = norm(h);
      if (!n) return;
      const f = Object.keys(CFIELDS).find((k) => CFIELDS[k].includes(n));
      if (f) { if (map[f] == null) map[f] = i; } else unknown.push(String(h).trim());
    });
    if (map.name == null) {
      const e = new Error(
        'Mijoz nomi ustuni topilmadi. Sarlavhada «Mijoz» yoki «Nomi» bo\'lishi kerak. ' +
        'Topilgan ustunlar: ' + table[headIdx].filter(Boolean).join(', '));
      e.status = 400; throw e;
    }

    const [ch, wk, cur] = await Promise.all([
      db.query(`SELECT code, name FROM customer_channels`),
      db.query(`SELECT id, name FROM workers WHERE active`),
      db.query(`SELECT name FROM customers`),
    ]);
    // Kanal kodi bilan ham, nomi bilan ham yozilishi mumkin: zavod
    // faylida «Instagram» deb turadi, kodda esa INSTAGRAM.
    const byChannel = new Map();
    for (const c of ch.rows) { byChannel.set(norm(c.code), c.code); byChannel.set(norm(c.name), c.code); }
    const byWorker = new Map(wk.rows.map((w) => [norm(w.name), w.id]));

    // Zavod faylida xodim qisqa yoziladi — «Pulatov Soyibjon», tizimda esa
    // to'liq: «Pulatov Soyibjon Salim o'g'li». Aynan moslik topilmasa,
    // fayldagi nom bilan BOSHLANADIGAN xodim qidiriladi va faqat BITTA
    // bo'lsa qabul qilinadi. Ikkitasi chiqsa — xato: tizim o'zi tanlab,
    // mijozni boshqa odamga yozib qo'ymasligi kerak.
    const findWorker = (nom) => {
      const n = norm(nom);
      if (byWorker.has(n)) return { id: byWorker.get(n) };
      const hits = wk.rows.filter((w) => norm(w.name).startsWith(n));
      if (hits.length === 1) return { id: hits[0].id, as: hits[0].name };
      if (hits.length > 1) return { many: hits.map((w) => w.name) };
      return {};
    };
    const existing = new Set(cur.rows.map((c) => norm(c.name)));

    const seen = new Set();
    const missing = new Set();        // ro'yxatda yo'q savdo menejerlari
    const matched = new Map();        // qisqa nom → tizimdagi to'liq nom
    const rows = [];
    for (let i = headIdx + 1; i < table.length; i++) {
      const cells = table[i];
      if (!cells.some((c) => String(c).trim())) continue;
      const at = (f) => (map[f] == null ? '' : String(cells[map[f]] ?? '').trim());
      const errors = [];
      const it = {};

      const name = at('name');
      if (!name) errors.push('Mijoz nomi bo\'sh');
      else if (seen.has(norm(name))) errors.push(`Faylda takrorlangan: «${name}»`);
      else seen.add(norm(name));
      it.name = name;

      const chn = at('channel');
      if (chn) {
        const code = byChannel.get(norm(chn));
        if (!code) errors.push(`Bunday kanal yo'q: «${chn}». Bor: ` +
          ch.rows.map((c) => c.code).join(', '));
        else it.channel = code;
      }

      const mgr = at('manager');
      if (mgr) {
        const hit = findWorker(mgr);
        // Bitta xodim yuzlab qatorda uchraydi: har qatorga bir xil xato
        // yozilsa ro'yxat o'qib bo'lmas bo'lib qoladi. Shuning uchun
        // nomlar alohida yig'iladi va bir marta ko'rsatiladi.
        if (hit.many)
          errors.push(`«${mgr}» bir nechta xodimga to'g'ri keladi: ${hit.many.join(', ')}`);
        else if (hit.id == null) { errors.push(`Xodim topilmadi: «${mgr}»`); missing.add(mgr); }
        else { it.manager_id = hit.id; if (hit.as) matched.set(mgr, hit.as); }
      }

      //  Qarzdor va haqdor bitta raqamga yig'iladi: `opening_debt` ishorali
      //  maydon, manfiysi haqdorni anglatadi (hisobot uni o'z tomoniga
      //  ajratadi — `v_customer_ledger`).
      const debt = at('debt'), credit = at('credit');
      if (debt || credit) {
        const d = debt   ? toNum(debt)   : 0;
        const k = credit ? toNum(credit) : 0;
        if (d === undefined) errors.push(`Qarz raqam emas: «${debt}»`);
        else if (k === undefined) errors.push(`Haqdor raqam emas: «${credit}»`);
        else it.opening_debt = (d || 0) - (k || 0);
      }

      const debtOn = at('debt_on');
      if (debtOn) {
        const d = toDate(debtOn);
        if (d === undefined) errors.push(`Qarz sanasi tushunarsiz: «${debtOn}»`);
        else it.opening_debt_on = d;
      }

      it.phone   = at('phone')   || null;
      it.country = at('country') || null;
      it.region  = at('region')  || null;
      it.note    = at('note')    || null;
      rows.push({ line: i + 1, it, errors, exists: existing.has(norm(name)) });
    }
    if (!rows.length) { const e = new Error('Faylda qator yo\'q'); e.status = 400; throw e; }

    const bad = rows.filter((r) => r.errors.length);

    if (req.query.save !== '1') {
      return res.json({
        preview: true, columns: Object.keys(map), unknown,
        total: rows.length, bad: bad.length,
        updates: rows.filter((r) => r.exists).length,
        missing_managers: [...missing],
        // Qisqa nom bilan topilganlar: xodim ko'rib tasdiqlasin
        matched_managers: [...matched].map(([a, b]) => `${a} → ${b}`),
        rows: rows.slice(0, 200),
      });
    }
    if (bad.length) {
      const e = new Error(`${bad.length} ta qatorda xato bor — saqlanmadi`);
      e.status = 400; throw e;
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      for (const r of rows) {
        await client.query(
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
             -- Qarz bir marta: kiritilgani qayta yuklashda o'chmaydi
             opening_debt = COALESCE(customers.opening_debt, EXCLUDED.opening_debt),
             opening_debt_on = COALESCE(customers.opening_debt_on,
                                        EXCLUDED.opening_debt_on)`,
          [r.it.name, r.it.phone, r.it.country, r.it.region,
           r.it.channel || null, r.it.manager_id || null, r.it.note,
           r.it.opening_debt ?? null, r.it.opening_debt_on || null]);
      }
      await audit(req, { module: 'sales', action: 'import', entity: 'customers',
                         entity_id: rows.length, payload: { count: rows.length } }, client);
      await client.query('COMMIT');
      res.json({ saved: rows.length, updated: rows.filter((r) => r.exists).length });
    } catch (e) {
      await client.query('ROLLBACK');
      if (!e.status) e.status = 400;
      throw e;
    } finally { client.release(); }
  }));

// ════════════════════════════════════════════ TA'MINOTCHILARNI YUKLASH
//
//  Zavod ro'yxatni Excel'da yuritadi va uni qo'lda terib chiqish —
//  o'ttiz ikkita qator, har birida nomi, raqami va turi — bir soatlik
//  ish va o'nta xato. Mijozlar bilan bir xil yo'l: fayl tanlanadi,
//  avval TEKSHIRIB ko'rsatiladi, keyin saqlanadi.
const SFIELDS = {
  name:     ['taminotchi', 'taminotchinomi', 'hisobnomi', 'hisob', 'nomi', 'nom',
             'firma', 'tashkilot', 'поставщик', 'наименование'],
  phone:    ['tel', 'telefon', 'telraqam', 'telraqami', 'telefonraqam',
             'telefonraqami', 'raqam', 'nomer', 'телефон', 'номертелефона'],
  //  Zavod faylida ustun «TURI» deb ataladi va ichida turning NOMI
  //  turadi («QADOQLASH MATERIALI»), kodi emas. Ikkalasi ham o'qiladi.
  category: ['turi', 'tur', 'yonalish', 'yonalishkodi', 'nimayetkazadi',
             'kategoriya', 'категория', 'тип'],
  country:  ['davlat', 'respublika', 'mamlakat', 'страна', 'республика'],
  region:   ['region', 'viloyat', 'shahar', 'hudud', 'регион', 'область', 'город'],
  inn:      ['stir', 'inn', 'инн'],
  manager:  ['masul', 'masuli', 'masulxodim', 'taminotchixodim', 'menejer',
             'менеджер', 'ответственный'],
  note:     ['izoh', 'izohi', 'примечание', 'комментарий'],
  //  Boshlang'ich qarz, $ da. Mijozdagidek IKKI ustun o'qiladi, lekin
  //  tomoni teskari: ta'minotchida «qarzdormiz» — KORXONA unga
  //  qarzdor (odatiy hol), «haqdormiz» esa oldindan to'lov.
  debt:     ['qarz', 'qarzdor', 'qarzmiz', 'qarzdormiz', 'boshlangichqarz',
             'долг', 'кредиторка'],
  credit:   ['haqdor', 'haqdormiz', 'oldindantolov', 'oldindantulov', 'avans',
             'аванс', 'переплата'],
  debt_on:  ['qarzsanasi', 'qarzsana', 'boshlangichqarzsanasi',
             'qarzholatisanasi', 'датадолга'],
};

router.post('/suppliers', need('purchasing.manage'),
  express.raw({ type: '*/*', limit: '10mb' }),
  wrap(async (req, res) => {
    const buf = req.body;
    if (!buf || !buf.length) { const e = new Error('Fayl bo\'sh'); e.status = 400; throw e; }

    let table;
    try {
      table = isXlsx(buf) ? readSheet(buf) : parseCsv(buf.toString('utf8'));
    } catch (e) {
      e.status = 400; e.message = 'Faylni o\'qib bo\'lmadi: ' + e.message; throw e;
    }

    const headIdx = table.findIndex((r) => r.some((c) => String(c).trim()));
    if (headIdx < 0) { const e = new Error('Fayl bo\'sh'); e.status = 400; throw e; }

    const map = {}, unknown = [];
    table[headIdx].forEach((h, i) => {
      const n = norm(h);
      if (!n) return;
      const f = Object.keys(SFIELDS).find((k) => SFIELDS[k].includes(n));
      if (f) { if (map[f] == null) map[f] = i; } else unknown.push(String(h).trim());
    });
    if (map.name == null) {
      const e = new Error(
        'Ta\'minotchi nomi ustuni topilmadi. Sarlavhada «Nomi» yoki «Hisob nomi» ' +
        'bo\'lishi kerak. Topilgan ustunlar: ' +
        table[headIdx].filter(Boolean).join(', '));
      e.status = 400; throw e;
    }

    const [cat, wk, cur] = await Promise.all([
      db.query(`SELECT code, name FROM supplier_categories ORDER BY sort`),
      db.query(`SELECT id, name FROM workers WHERE active`),
      db.query(`SELECT name FROM suppliers`),
    ]);
    //  Kodi bilan ham, nomi bilan ham: zavod faylida «MDF» deb turadi,
    //  «Qadoqlash materiali» ham o'sha ustunda nom bo'lib yoziladi.
    const byCat = new Map();
    for (const c of cat.rows) { byCat.set(norm(c.code), c.code); byCat.set(norm(c.name), c.code); }
    const byWorker = new Map(wk.rows.map((w) => [norm(w.name), w.id]));
    const findWorker = (nom) => {
      const n = norm(nom);
      if (byWorker.has(n)) return { id: byWorker.get(n) };
      const hits = wk.rows.filter((w) => norm(w.name).startsWith(n));
      if (hits.length === 1) return { id: hits[0].id, as: hits[0].name };
      if (hits.length > 1) return { many: hits.map((w) => w.name) };
      return {};
    };
    const existing = new Set(cur.rows.map((c) => norm(c.name)));

    const seen = new Set(), missing = new Set(), matched = new Map();
    const rows = [];
    for (let i = headIdx + 1; i < table.length; i++) {
      const cells = table[i];
      if (!cells.some((c) => String(c).trim())) continue;
      const at = (f) => (map[f] == null ? '' : String(cells[map[f]] ?? '').trim());
      const errors = [];
      const it = {};

      const name = at('name');
      if (!name) errors.push('Ta\'minotchi nomi bo\'sh');
      else if (seen.has(norm(name))) errors.push(`Faylda takrorlangan: «${name}»`);
      else seen.add(norm(name));
      it.name = name;

      const tur = at('category');
      if (tur) {
        const code = byCat.get(norm(tur));
        if (!code) errors.push(`Bunday yo'nalish yo'q: «${tur}». Bor: ` +
          cat.rows.map((c) => c.name).join(', '));
        else it.category = code;
      }

      const mgr = at('manager');
      if (mgr) {
        const hit = findWorker(mgr);
        if (hit.many)
          errors.push(`«${mgr}» bir nechta xodimga to'g'ri keladi: ${hit.many.join(', ')}`);
        else if (hit.id == null) { errors.push(`Xodim topilmadi: «${mgr}»`); missing.add(mgr); }
        else { it.manager_id = hit.id; if (hit.as) matched.set(mgr, hit.as); }
      }

      //  Qarzdor va haqdor bitta ishorali raqamga yig'iladi. Tomoni
      //  mijoznikiga TESKARI: musbat — korxona ta'minotchiga qarzdor.
      const debt = at('debt'), credit = at('credit');
      if (debt || credit) {
        const d = debt   ? toNum(debt)   : 0;
        const k = credit ? toNum(credit) : 0;
        if (d === undefined) errors.push(`Qarz raqam emas: «${debt}»`);
        else if (k === undefined) errors.push(`Haqdor raqam emas: «${credit}»`);
        else it.opening_debt = (d || 0) - (k || 0);
      }

      const debtOn = at('debt_on');
      if (debtOn) {
        const dt = toDate(debtOn);
        if (dt === undefined) errors.push(`Qarz sanasi tushunarsiz: «${debtOn}»`);
        else it.opening_debt_on = dt;
      }

      it.phone   = at('phone')   || null;
      it.country = at('country') || null;
      it.region  = at('region')  || null;
      it.inn     = at('inn')     || null;
      it.note    = at('note')    || null;
      rows.push({ line: i + 1, it, errors, exists: existing.has(norm(name)) });
    }
    if (!rows.length) { const e = new Error('Faylda qator yo\'q'); e.status = 400; throw e; }

    const bad = rows.filter((r) => r.errors.length);

    if (req.query.save !== '1') {
      return res.json({
        preview: true, columns: Object.keys(map), unknown,
        total: rows.length, bad: bad.length,
        updates: rows.filter((r) => r.exists).length,
        missing_managers: [...missing],
        matched_managers: [...matched].map(([a, b]) => `${a} → ${b}`),
        rows: rows.slice(0, 200),
      });
    }
    if (bad.length) {
      const e = new Error(`${bad.length} ta qatorda xato bor — saqlanmadi`);
      e.status = 400; throw e;
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      for (const r of rows) {
        //  Qayta yuklashda yozilgani O'CHMAYDI, faqat bo'sh maydon
        //  to'ladi — mijozlar bilan bir xil qoida.
        await client.query(
          `INSERT INTO suppliers (name, phone, country, region, category,
                                  manager_id, inn, note,
                                  opening_debt, opening_debt_on)
           VALUES ($1,$2, COALESCE($3, 'O''zbekiston'), $4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (lower(name)) DO UPDATE SET
             phone      = COALESCE(EXCLUDED.phone,      suppliers.phone),
             country    = COALESCE(EXCLUDED.country,    suppliers.country),
             region     = COALESCE(EXCLUDED.region,     suppliers.region),
             category   = COALESCE(EXCLUDED.category,   suppliers.category),
             manager_id = COALESCE(EXCLUDED.manager_id, suppliers.manager_id),
             inn        = COALESCE(EXCLUDED.inn,        suppliers.inn),
             note       = COALESCE(EXCLUDED.note,       suppliers.note),
             -- Qarz bir marta: kiritilgani qayta yuklashda o'chmaydi
             opening_debt    = COALESCE(suppliers.opening_debt,
                                        EXCLUDED.opening_debt),
             opening_debt_on = COALESCE(suppliers.opening_debt_on,
                                        EXCLUDED.opening_debt_on)`,
          [r.it.name, r.it.phone, r.it.country, r.it.region,
           r.it.category || null, r.it.manager_id || null, r.it.inn, r.it.note,
           r.it.opening_debt ?? null, r.it.opening_debt_on || null]);
      }
      await audit(req, { module: 'purchasing', action: 'import', entity: 'suppliers',
                         entity_id: rows.length, payload: { count: rows.length } }, client);
      await client.query('COMMIT');
      res.json({ saved: rows.length, updated: rows.filter((r) => r.exists).length });
    } catch (e) {
      await client.query('ROLLBACK');
      if (!e.status) e.status = 400;
      throw e;
    } finally { client.release(); }
  }));

// ─────────────────────────────────────────────── XOM ASHYO SPRAVOCHNIGI
//
//  Zavodda yuzlab material bor va ularni qo'lda terib chiqish bir
//  kunlik ish va o'nlab xato bo'lardi — mijozlar va ta'minotchilar
//  bilan bir xil yo'l: avval TEKSHIRIB ko'rsatiladi, xato qator bo'lsa
//  hech narsa saqlanmaydi; qayta yuklashda yozilgani o'chmaydi, faqat
//  bo'sh maydon to'ladi.
//
//  ★ HAR RANG ALOHIDA MATERIAL (zavod qarori): rang ustun EMAS, u
//  nomning ichida turadi — «LDSP 16mm oq» va «LDSP 16mm venge»
//  ikkita qator bo'ladi. Ustun bo'lsa qoldiq material bo'yicha
//  yig'ilib, «oq LDSP tugadi» degan savolga javob bo'lmasdi.
const MFIELDS = {
  name:     ['material', 'materialnomi', 'nomi', 'nom', 'nomlanishi',
             'наименование', 'материал'],
  code:     ['kod', 'kodi', 'artikul', 'код', 'артикул'],
  //  Zavod faylida ustun «O'lchov birligi» yoki qisqa «birlik» bo'ladi.
  uom:      ['olchovbirligi', 'olchov', 'birlik', 'birligi', 'olchambirligi',
             'edizm', 'единицаизмерения', 'ед', 'единица'],
  category: ['turkum', 'turkumi', 'turi', 'tur', 'guruh', 'guruhi',
             'kategoriya', 'категория', 'группа'],
  note:     ['izoh', 'izohi', 'примечание', 'комментарий'],
};

router.post('/materials', need('materials.manage', 'production.manage'),
  express.raw({ type: '*/*', limit: '10mb' }),
  wrap(async (req, res) => {
    const buf = req.body;
    if (!buf || !buf.length) { const e = new Error('Fayl bo\'sh'); e.status = 400; throw e; }

    let table;
    try {
      table = isXlsx(buf) ? readSheet(buf) : parseCsv(buf.toString('utf8'));
    } catch (e) {
      e.status = 400; e.message = 'Faylni o\'qib bo\'lmadi: ' + e.message; throw e;
    }

    const headIdx = table.findIndex((r) => r.some((c) => String(c).trim()));
    if (headIdx < 0) { const e = new Error('Fayl bo\'sh'); e.status = 400; throw e; }

    const map = {}, unknown = [];
    table[headIdx].forEach((h, i) => {
      const n = norm(h);
      if (!n) return;
      const f = Object.keys(MFIELDS).find((k) => MFIELDS[k].includes(n));
      if (f) { if (map[f] == null) map[f] = i; } else unknown.push(String(h).trim());
    });
    if (map.name == null) {
      const e = new Error(
        'Material nomi ustuni topilmadi. Sarlavhada «Nomi» yoki «Material» ' +
        'bo\'lishi kerak. Topilgan ustunlar: ' +
        table[headIdx].filter(Boolean).join(', '));
      e.status = 400; throw e;
    }
    if (map.uom == null) {
      const e = new Error(
        'O\'lchov birligi ustuni topilmadi. Sarlavhada «O\'lchov birligi» ' +
        'yoki «Birlik» bo\'lishi kerak. Topilgan ustunlar: ' +
        table[headIdx].filter(Boolean).join(', '));
      e.status = 400; throw e;
    }

    const [cat, uom, cur] = await Promise.all([
      db.query(`SELECT code, name FROM material_categories ORDER BY sort`),
      db.query(`SELECT code, name FROM material_uoms ORDER BY sort`),
      db.query(`SELECT name FROM materials`),
    ]);
    //  Kodi bilan ham, nomi bilan ham topiladi: zavod faylida «MDF»
    //  deb turishi ham, «Qadoqlash materiali» deb turishi ham mumkin.
    const byCat = new Map();
    for (const c of cat.rows) { byCat.set(norm(c.code), c.code); byCat.set(norm(c.name), c.code); }
    const byUom = new Map();
    for (const u of uom.rows) { byUom.set(norm(u.code), u.code); byUom.set(norm(u.name), u.code); }
    //  Zavodda ko'p uchraydigan yozuvlar: «м2», «шт», «кг».
    for (const [a, b] of [['m2', 'm2'], ['kv', 'm2'], ['kvm', 'm2'], ['m3', 'm3'],
                          ['sht', 'dona'], ['pcs', 'dona'], ['db', 'dona'],
                          ['l', 'litr'], ['metr', 'm'], ['pm', 'm'],
                          ['kompl', 'komplekt'], ['kmpl', 'komplekt']])
      if (!byUom.has(a) && byUom.has(b)) byUom.set(a, b);
    const existing = new Set(cur.rows.map((c) => norm(c.name)));

    const seen = new Set();
    const rows = [];
    for (let i = headIdx + 1; i < table.length; i++) {
      const cells = table[i];
      if (!cells.some((c) => String(c).trim())) continue;
      const at = (f) => (map[f] == null ? '' : String(cells[map[f]] ?? '').trim());
      const errors = [];
      const it = {};

      const name = at('name');
      if (!name) errors.push('Material nomi bo\'sh');
      else if (seen.has(norm(name))) errors.push(`Faylda takrorlangan: «${name}»`);
      else seen.add(norm(name));
      it.name = name;

      const birlik = at('uom');
      if (!birlik) errors.push('O\'lchov birligi bo\'sh');
      else {
        const code = byUom.get(norm(birlik));
        if (!code) errors.push(`Bunday o'lchov birligi yo'q: «${birlik}». Bor: ` +
          uom.rows.map((u) => u.name).join(', '));
        else it.uom = code;
      }

      const turkum = at('category');
      if (turkum) {
        const code = byCat.get(norm(turkum));
        if (!code) errors.push(`Bunday turkum yo'q: «${turkum}». Bor: ` +
          cat.rows.map((c) => c.name).join(', '));
        else it.category = code;
      }

      it.code = at('code') || null;
      it.note = at('note') || null;
      rows.push({ line: i + 1, it, errors, exists: existing.has(norm(name)) });
    }
    if (!rows.length) { const e = new Error('Faylda qator yo\'q'); e.status = 400; throw e; }

    const bad = rows.filter((r) => r.errors.length);

    if (req.query.save !== '1') {
      return res.json({
        preview: true, columns: Object.keys(map), unknown,
        total: rows.length, bad: bad.length,
        updates: rows.filter((r) => r.exists).length,
        rows: rows.slice(0, 200),
      });
    }
    if (bad.length) {
      const e = new Error(`${bad.length} ta qatorda xato bor — saqlanmadi`);
      e.status = 400; throw e;
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      for (const r of rows) {
        //  Qayta yuklashda yozilgani O'CHMAYDI, faqat bo'sh maydon
        //  to'ladi. O'lchov birligi esa YANGILANADI: u materialning
        //  o'zi haqida va faylda tuzatilgan bo'lishi mumkin.
        await client.query(
          `INSERT INTO materials (code, name, uom, category, note, created_by)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (lower(name)) DO UPDATE SET
             code     = COALESCE(EXCLUDED.code,     materials.code),
             uom      = EXCLUDED.uom,
             category = COALESCE(EXCLUDED.category, materials.category),
             note     = COALESCE(EXCLUDED.note,     materials.note)`,
          [r.it.code, r.it.name, r.it.uom, r.it.category || null, r.it.note,
           req.user.id]);
      }
      await audit(req, { module: 'materials', action: 'import', entity: 'materials',
                         entity_id: rows.length, payload: { count: rows.length } }, client);
      await client.query('COMMIT');
      res.json({ saved: rows.length, updated: rows.filter((r) => r.exists).length });
    } catch (e) {
      await client.query('ROLLBACK');
      if (!e.status) e.status = 400;
      throw e;
    } finally { client.release(); }
  }));

// ──────────────────────────────────────────────────── XODIMLAR RO'YXATI
//
//  ★ ZAVODDA OLTMISH KISHI ISHLAYDI, TIZIMGA O'NTASI KIRADI.
//  Boshliq, mudir, menejer va kassir dasturda ishlaydi — ularning
//  PIN'i va roli bor. Arra operatori, shkurkachi, qorovul va oshpaz
//  esa dasturni umuman ochmaydi, lekin OYLIK hammasiga beriladi va
//  ishbay hisob konver qaysi bo'limdan o'tganiga bog'lanadi. Shtat
//  ro'yxati shu sababdan hoziroq kiritiladi: modul ma'lumotsiz ishga
//  tushmaydi (CLAUDE.md, «avval kiritish, keyin modul»).
//
//  Oltmish oltita qatorni qo'lda terib chiqish yarim kunlik ish va
//  o'nlab xato bo'lardi — mijozlar, ta'minotchilar va materiallar
//  bilan BIR XIL yo'l: avval TEKSHIRIB ko'rsatiladi, xato qator
//  bo'lsa hech narsa saqlanmaydi.
//
//  ★ PIN FAYLDAN O'QILMAYDI — ustun bo'lsa ham. PIN yozilgan Excel
//  pochtada, telefonda va stol ustida qoladi, ya'ni izini yashirish
//  (`erp/pin.js`) hech narsa bermasdi. U faqat xodim kartochkasidan
//  qo'yiladi. Rol ham shunday: doira va huquq bitta-bitta beriladi,
//  ro'yxatdan emas.
const WFIELDS = {
  name:     ['fish', 'fio', 'ism', 'ismi', 'ismfamiliya', 'xodim', 'hodim',
             'xodimnomi', 'nomi', 'nom', 'фио', 'сотрудник'],
  group:    ['guruh', 'guruhi', 'toifa', 'bolinma', 'группа'],
  shop:     ['tsex', 'tseh', 'sex', 'цех'],
  dept:     ['bolim', 'bolimi', 'uchastka', 'отдел', 'участок'],
  position: ['lavozim', 'lavozimi', 'kasb', 'vazifa', 'должность'],
  phone:    ['tel', 'telefon', 'telraqam', 'telraqami', 'telefonraqami',
             'raqam', 'nomer', 'телефон'],
  hired_at: ['ishgakirgan', 'ishgakirgansana', 'qabulsanasi', 'sana',
             'принят', 'датаприема'],
};

router.post('/workers', need('admin.users'),
  express.raw({ type: '*/*', limit: '10mb' }),
  wrap(async (req, res) => {
    const buf = req.body;
    if (!buf || !buf.length) { const e = new Error('Fayl bo\'sh'); e.status = 400; throw e; }

    let table;
    try {
      table = isXlsx(buf) ? readSheet(buf) : parseCsv(buf.toString('utf8'));
    } catch (e) {
      e.status = 400; e.message = 'Faylni o\'qib bo\'lmadi: ' + e.message; throw e;
    }

    const headIdx = table.findIndex((r) => r.some((c) => String(c).trim()));
    if (headIdx < 0) { const e = new Error('Fayl bo\'sh'); e.status = 400; throw e; }

    const map = {}, unknown = [];
    table[headIdx].forEach((h, i) => {
      const n = norm(h);
      if (!n) return;
      const f = Object.keys(WFIELDS).find((k) => WFIELDS[k].includes(n));
      if (f) { if (map[f] == null) map[f] = i; } else unknown.push(String(h).trim());
    });
    if (map.name == null) {
      const e = new Error(
        'Xodim ismi ustuni topilmadi. Sarlavhada «F.I.SH» yoki «Ismi» ' +
        'bo\'lishi kerak. Topilgan ustunlar: ' +
        table[headIdx].filter(Boolean).join(', '));
      e.status = 400; throw e;
    }

    const [sh, sc, cur] = await Promise.all([
      db.query(`SELECT id, code, name FROM shops`),
      db.query(`SELECT id, shop_id, name FROM sections WHERE active`),
      db.query(`SELECT id, name FROM workers`),
    ]);
    //  Tsex kodi bilan ham, nomi bilan ham: zavod faylida «Korpus
    //  tsexi» turadi, kod esa KORPUS.
    const byShop = new Map();
    for (const s of sh.rows) { byShop.set(norm(s.code), s); byShop.set(norm(s.name), s); }
    //  ★ BO'LIM TSEX ICHIDA IZLANADI. «Qadoqlash» nomli bo'lim IKKITA
    //  tsexda bor (qadoqlash tsexida va stulda), «Lak» ham shunday —
    //  faqat nom bo'yicha izlansa odam noto'g'ri tsexning bo'limiga
    //  tushib, ishbay oylik begona bo'limga yozilardi.
    const bySection = new Map();
    for (const s of sc.rows) bySection.set(s.shop_id + '|' + norm(s.name), s);
    const existing = new Map(cur.rows.map((w) => [norm(w.name), w.id]));

    const seen = new Set(), noSection = [];
    const rows = [];
    for (let i = headIdx + 1; i < table.length; i++) {
      const cells = table[i];
      if (!cells.some((c) => String(c).trim())) continue;
      const at = (f) => (map[f] == null ? '' : String(cells[map[f]] ?? '').trim());
      const errors = [];
      const it = {};

      const name = at('name');
      if (!name) errors.push('Xodim ismi bo\'sh');
      //  Bir xil ism ikki qatorda — qaysi biri kim ekanini aytib
      //  bo'lmaydi, ya'ni oylik ham qaysi biriga yozilishi noaniq.
      else if (seen.has(norm(name))) errors.push(`Faylda takrorlangan: «${name}»`);
      else seen.add(norm(name));
      it.name = name;

      const tsex = at('shop');
      if (tsex) {
        const hit = byShop.get(norm(tsex));
        if (!hit) errors.push(`Bunday tsex yo'q: «${tsex}». Bor: ` +
          sh.rows.map((x) => x.name).join(', '));
        else it.shop_id = hit.id;
      }

      //  Bo'lim MATNI har doim yoziladi, `section_id` esa faqat
      //  topilganda: «HR» va «Logistika» ishlab chiqarish bo'limi
      //  emas va `sections` da qatori yo'q — odam shu sababdan
      //  shtatdan tushib qolmasligi kerak.
      const bolim = at('dept');
      it.dept = bolim || null;
      if (bolim && it.shop_id) {
        const hit = bySection.get(it.shop_id + '|' + norm(bolim));
        if (hit) it.section_id = hit.id;
        //  Xato EMAS, OGOHLANTIRISH: odam kiritiladi, bo'limi esa
        //  kartochkadan qo'yiladi. Xato qilinsa butun fayl
        //  saqlanmasdi va bitta noto'g'ri yozilgan nom oltmish
        //  kishini tizimdan tashqarida qoldirardi.
        else noSection.push(`${name} — «${tsex} · ${bolim}»`);
      }

      const sana = at('hired_at');
      if (sana) {
        const dt = toDate(sana);
        if (dt === undefined) errors.push(`Ishga kirgan sana tushunarsiz: «${sana}»`);
        else it.hired_at = dt;
      }

      it.staff_group = at('group')    || null;
      it.position    = at('position') || null;
      it.phone       = at('phone')    || null;
      rows.push({ line: i + 1, it, errors, exists: existing.has(norm(name)) });
    }
    if (!rows.length) { const e = new Error('Faylda qator yo\'q'); e.status = 400; throw e; }

    const bad = rows.filter((r) => r.errors.length);

    if (req.query.save !== '1') {
      return res.json({
        preview: true, columns: Object.keys(map), unknown,
        total: rows.length, bad: bad.length,
        updates: rows.filter((r) => r.exists).length,
        //  Bo'limi topilmaganlar ALOHIDA ro'yxat bo'lib chiqadi:
        //  ularning ishbay oyligi bo'limga bog'lanmaydi va buni
        //  saqlashdan OLDIN ko'rish kerak.
        no_section: noSection,
        rows: rows.slice(0, 200),
      });
    }
    if (bad.length) {
      const e = new Error(`${bad.length} ta qatorda xato bor — saqlanmadi`);
      e.status = 400; throw e;
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      let yangi = 0;
      for (const r of rows) {
        const id = existing.get(norm(r.it.name));
        //  ★ QAYTA YUKLASHDA BO'SH KATAK TEGMAYDI, TO'LDIRILGANI
        //  USTUN TURADI. Shtat ro'yxatida fayl haqiqat manbai: odam
        //  Arradan Frezaga o'tsa yangi fayl buni aytadi va eski
        //  bo'lim qolib ketmasligi kerak. Bo'sh katak esa «tegma»
        //  degani — mijoz va ta'minotchi bilan bir xil qoida.
        //
        //  PIN, rol, doira va pul belgilariga umuman tegilmaydi: ular
        //  kartochkadan beriladi va fayl ularni bilmaydi.
        if (id) {
          await client.query(
            `UPDATE workers SET
               staff_group = COALESCE($2, staff_group),
               shop_id     = COALESCE($3, shop_id),
               section_id  = COALESCE($4, section_id),
               dept        = COALESCE($5, dept),
               position    = COALESCE($6, position),
               phone       = COALESCE($7, phone),
               hired_at    = COALESCE($8, hired_at)
             WHERE id = $1`,
            [id, r.it.staff_group, r.it.shop_id || null, r.it.section_id || null,
             r.it.dept, r.it.position, r.it.phone, r.it.hired_at || null]);
        } else {
          //  PIN'siz ochiladi: bu odam dasturga kirmaydi. Kerak
          //  bo'lsa kartochkadan PIN ham, rol ham beriladi.
          await client.query(
            `INSERT INTO workers (name, staff_group, shop_id, section_id,
                                  dept, position, phone, hired_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [r.it.name, r.it.staff_group, r.it.shop_id || null,
             r.it.section_id || null, r.it.dept, r.it.position,
             r.it.phone, r.it.hired_at || null]);
          yangi++;
        }
      }
      await audit(req, { module: 'admin', action: 'import', entity: 'workers',
                         entity_id: rows.length,
                         payload: { count: rows.length, yangi } }, client);
      await client.query('COMMIT');
      res.json({ saved: rows.length, created: yangi,
                 updated: rows.length - yangi, no_section: noSection.length });
    } catch (e) {
      await client.query('ROLLBACK');
      if (!e.status) e.status = 400;
      throw e;
    } finally { client.release(); }
  }));

module.exports = router;
