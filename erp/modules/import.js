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
const UNITS = ['production.units', 'production.manage'];

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
        created.push(await createOne(client, req, r.it));
      }

      await audit(req, { module: 'production', action: 'import', entity: 'units',
                         entity_id: created.length,
                         payload: { count: created.length, customers: newCustomers.length } },
                  client);
      await client.query('COMMIT');
      res.json({ saved: created.length, customers: newCustomers.length, created });
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

module.exports = router;
