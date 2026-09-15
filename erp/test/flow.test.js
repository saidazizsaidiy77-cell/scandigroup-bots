// ============================================================================
//  ASOSIY YO'LLAR
//
//  Bu yerda faqat SINGANDA ZAVOD TO'XTAYDIGAN narsalar sinaladi: konverni
//  o'tkazish, tsexdan tsexga topshirish, qaytarish, ombor qoldig'i, tsex
//  doirasi va tarixga tegadigan tahrirlar.
//
//  Har testda baza toza emas — bitta baza ustida ketma-ket ishlaydi, xuddi
//  zavoddagidek. Shuning uchun testlar bir-biriga bog'liq bo'lmasin deb har
//  biri o'z birligini yaratadi.
// ============================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helper');

let base, server, admin, korpus, lak, sotuvchi, tokenAdmin;
let PENAL, ARRA, ROVER, SHKUR, AST1, QADQAD;

test('baza quriladi va migratsiya IKKI MARTA o\'tadi', async () => {
  await H.freshDatabase();
  // Ikkinchi marta ham xatosiz — idempotentlik zavod uchun hayot-mamot:
  // ERP_AUTO_MIGRATE=1 da migratsiya yiqilsa sayt umuman ko'tarilmaydi.
  const { migrate } = require('../migrate');
  await migrate({ quiet: true });

  ({ server, base } = await H.startServer());
  tokenAdmin = await H.sessionFor('Administrator');
  admin    = H.api(base, tokenAdmin);
  korpus   = H.api(base, await H.sessionFor('Korpus ustasi'));
  lak      = H.api(base, await H.sessionFor("Bo'yoq ustasi"));

  PENAL  = (await H.id(`SELECT id FROM products WHERE sku = 'PEN-MILANO'`)).id;
  ARRA   = (await H.id(`SELECT id FROM sections WHERE code = 'KOR-ARRA'`)).id;
  ROVER  = (await H.id(`SELECT id FROM sections WHERE code = 'KOR-ROVER'`)).id;
  SHKUR  = (await H.id(`SELECT id FROM sections WHERE code = 'KOR-SHKUR'`)).id;
  AST1   = (await H.id(`SELECT id FROM sections WHERE code = 'BOY-AST1'`)).id;
  QADQAD = (await H.id(`SELECT id FROM sections WHERE code = 'QAD-QAD'`)).id;
});

const newUnit = async (extra = {}) => {
  const r = await admin('POST', '/api/units/', {
    items: [{ product_id: PENAL, qty: 1, section_id: ARRA, ...extra }] });
  assert.equal(r.status, 200, r.text);
  return r.body.created[0];
};

test('konver yaratiladi va jurnalda ko\'rinadi', async () => {
  const u = await newUnit();
  const j = await admin('GET', '/api/units/?conveyor_no=' + u.conveyor_no);
  assert.equal(j.status, 200);
  assert.equal(j.body.length, 1);
  assert.equal(j.body[0].section, 'Arra');
});

test('tsex ichida o\'tkaziladi, marshrutdan tashqariga emas', async () => {
  const u = await newUnit();
  const ok = await korpus('POST', '/api/units/move', { items: [{ unit_id: u.id }] });
  assert.equal(ok.status, 200, ok.text);
  assert.equal((await H.id(`SELECT current_section_id s FROM production_units WHERE id=$1`,
    [u.id])).s, ROVER);

  // Marshrutdan tashqari bo'lim — stul tsexinikini olamiz: penal u yerdan
  // o'tmaydi. (Qadoqlash bo'limi penalning marshrutida BOR, shuning uchun
  // u bu qoidani sinash uchun yaramaydi.) Admin orqali: tsex ustasida
  // avval doira tekshiriladi va marshrut qoidasiga navbat yetmaydi.
  const STUZBOR = (await H.id(`SELECT id FROM sections WHERE code='STU-ZBOR'`)).id;
  const bad = await admin('POST', '/api/units/move',
    { items: [{ unit_id: u.id, section_id: STUZBOR }] });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /marshrutda yo'q/);
});

test('jo\'natilmagan konverni keyingi tsex qabul qila olmaydi', async () => {
  const u = await newUnit({ section_id: SHKUR });

  const early = await lak('POST', '/api/units/move', { items: [{ unit_id: u.id }] });
  assert.equal(early.status, 400);
  assert.match(early.body.error, /jo'natilmagan/);

  // Jo'natishni faqat turgan tsexi qila oladi
  const wrong = await lak('POST', '/api/units/handover', { items: [u.id] });
  assert.equal(wrong.status, 400);

  assert.equal((await korpus('POST', '/api/units/handover', { items: [u.id] })).status, 200);

  const board = await lak('GET', '/api/units/board');
  assert.ok(board.body.inbox.some((x) => x.id === u.id), 'jo\'natilgach inbox\'da');

  const move = await lak('POST', '/api/units/move', { items: [{ unit_id: u.id }] });
  assert.equal(move.status, 200, move.text);
  assert.equal((await H.id(`SELECT current_section_id s FROM production_units WHERE id=$1`,
    [u.id])).s, AST1);
});

test('jo\'natish qaytarib olinadi', async () => {
  const u = await newUnit({ section_id: SHKUR });
  await korpus('POST', '/api/units/handover', { items: [u.id] });
  assert.ok((await H.id(`SELECT handover_on h FROM production_units WHERE id=$1`, [u.id])).h);

  await korpus('POST', '/api/units/handover', { items: [u.id], undo: true });
  assert.equal((await H.id(`SELECT handover_on h FROM production_units WHERE id=$1`, [u.id])).h, null);
});

test('chiqish bo\'limiga o\'tish OMBORGA TUSHIRMAYDI', async () => {
  const u = await newUnit({ section_id: (await H.id(
    `SELECT id FROM sections WHERE code='QAD-OYNA'`)).id });
  const before = (await H.id(
    `SELECT COALESCE((SELECT qty FROM fg_stock WHERE product_id=$1),0) q`, [PENAL])).q;

  const qad = H.api(base, await H.sessionFor('Qadoqlash ustasi'));
  assert.equal((await qad('POST', '/api/units/move', { items: [{ unit_id: u.id }] })).status, 200);

  const row = await H.id(`SELECT status FROM production_units WHERE id=$1`, [u.id]);
  assert.equal(row.status, 'production', 'ombor qabul qilmaguncha ishlab chiqarishda');
  assert.equal((await H.id(
    `SELECT COALESCE((SELECT qty FROM fg_stock WHERE product_id=$1),0) q`, [PENAL])).q, before);

  // Qaytarish ham qoldiqqa tegmaydi — u oshmagan edi
  assert.equal((await qad('POST', '/api/units/undo', { unit_id: u.id })).status, 200);
  assert.equal((await H.id(
    `SELECT COALESCE((SELECT qty FROM fg_stock WHERE product_id=$1),0) q`, [PENAL])).q, before);
});

test('T/M ombor: jo\'natdim → qabul qildim → jurnaldan chiqadi', async () => {
  const QADOYNA = (await H.id(`SELECT id FROM sections WHERE code='QAD-OYNA'`)).id;
  const u = await newUnit({ section_id: QADOYNA });
  const qad = H.api(base, await H.sessionFor('Qadoqlash ustasi'));
  await qad('POST', '/api/units/move', { items: [{ unit_id: u.id }] });   // → Qadoqlash

  const omborchi = H.api(base, await H.sessionFor('Administrator'));
  const before = (await H.id(
    `SELECT COALESCE((SELECT qty FROM fg_stock WHERE product_id=$1),0) q`, [PENAL])).q;

  // Jo'natilmaguncha qabul qilib bo'lmaydi
  const early = await omborchi('POST', '/api/units/stock/accept', { items: [u.id] });
  assert.equal(early.status, 400);
  assert.match(early.body.error, /jo'natilmagan/);

  assert.equal((await qad('POST', '/api/units/handover', { items: [u.id] })).status, 200);

  const inbox = await omborchi('GET', '/api/units/stock/inbox');
  assert.ok(inbox.body.some((x) => x.id === u.id), 'jo\'natilgach ombor ro\'yxatida');

  assert.equal((await omborchi('POST', '/api/units/stock/accept', { items: [u.id] })).status, 200);
  assert.equal((await H.id(`SELECT status FROM production_units WHERE id=$1`, [u.id])).status, 'fg');
  assert.equal((await H.id(`SELECT qty q FROM fg_stock WHERE product_id=$1`, [PENAL])).q,
    before + 1);

  // Ishlab chiqarish jurnalidan chiqadi
  const j = await omborchi('GET', '/api/units/?conveyor_no=' + u.conveyor_no);
  assert.equal(j.body.length, 0, 'qabul qilingach jurnalda ko\'rinmaydi');

  // Ombordagi konverni ishlab chiqarish orqaga sura olmaydi
  const back = await qad('POST', '/api/units/undo', { unit_id: u.id });
  assert.equal(back.status, 400);
  assert.match(back.body.error, /ombor/);

  // Ombor o'zi qaytarsa — jurnalga ham, ishlab chiqarishga ham qaytadi
  assert.equal((await omborchi('POST', '/api/units/stock/accept',
    { items: [u.id], undo: true })).status, 200);
  assert.equal((await H.id(`SELECT status FROM production_units WHERE id=$1`,
    [u.id])).status, 'production');
  assert.equal((await H.id(`SELECT qty q FROM fg_stock WHERE product_id=$1`, [PENAL])).q, before);
});

test('tsex ustasiga faqat o\'z tsexi ochiq', async () => {
  // Ustada jurnalni ko'rish huquqi yo'q — uning ekrani bitta: bo'limlar
  // aro harakat. Jurnal ochilib qolsa, ortiqcha ma'lumot chalkashtiradi.
  assert.equal((await korpus('GET', '/api/units/')).status, 403);

  const board = await korpus('GET', '/api/units/board');
  assert.equal(board.status, 200, board.text);
  assert.equal(board.body.shop.name, 'Korpus tsexi');
  assert.equal(board.body.shops.length, 1, 'boshqa tsex tanlab bo\'lmaydi');

  const other = await korpus('GET', '/api/units/board?shop_id=' +
    (await H.id(`SELECT id FROM shops WHERE code='BOYOQ'`)).id);
  assert.equal(other.status, 403, 'o\'zga tsex taqiqlanadi');

  // Ishlab chiqarish boshlig'i esa hammasini ko'radi
  const j = await admin('GET', '/api/units/');
  assert.ok([...new Set(j.body.map((r) => r.shop))].length >= 1);
});

const xodim = async (nom, rol) => {
  const { db } = require('../db');
  await db.query(`INSERT INTO workers (name) VALUES ($1) ON CONFLICT DO NOTHING`, [nom]);
  await db.query(`INSERT INTO worker_roles (worker_id, role_code)
                  SELECT id, $2 FROM workers WHERE name = $1
                  ON CONFLICT DO NOTHING`, [nom, rol]);
  return H.api(base, await H.sessionFor(nom));
};

test('tarixga tegadigan maydonlar faqat boshqaruvchiga ochiq', async () => {
  const u = await newUnit();
  sotuvchi = await xodim('Sinov sotuvchi', 'sotuvchi');
  // Ma'lumot kirituvchi: jurnalni to'ldiradi, lekin tarixga tegmaydi.
  const kirituvchi = await xodim('Sinov kirituvchi', 'kirituvchi');

  for (const body of [{ conveyor_no: 'X-1' }, { qty: 5 }, { lak_on: '2026-01-01' },
                      { section_id: ROVER }]) {
    const r = await kirituvchi('PATCH', '/api/units/' + u.id, body);
    assert.equal(r.status, 403, JSON.stringify(body) + ' → ' + r.text);
  }
  // Narx, zakaz va mijoz esa uning ishi
  assert.equal((await kirituvchi('PATCH', '/api/units/' + u.id,
    { unit_price: 100 })).status, 200);
});

test('joyni tuzatish yangi harakat qo\'shmaydi', async () => {
  const u = await newUnit();
  const count = () => H.id(`SELECT COUNT(*)::int n FROM unit_moves WHERE unit_id=$1`, [u.id]);
  const before = (await count()).n;

  assert.equal((await admin('PATCH', '/api/units/' + u.id, { section_id: SHKUR })).status, 200);
  assert.equal((await count()).n, before, 'harakatlar soni o\'zgarmaydi');
  assert.equal((await H.id(`SELECT current_section_id s FROM production_units WHERE id=$1`,
    [u.id])).s, SHKUR);
});

test('konveyer raqami takrorlanmaydi', async () => {
  const a = await newUnit();
  const b = await newUnit();
  const r = await admin('PATCH', '/api/units/' + b.id, { conveyor_no: a.conveyor_no });
  assert.equal(r.status, 409, r.text);
  assert.equal((await H.id(`SELECT conveyor_no c FROM production_units WHERE id=$1`,
    [b.id])).c, b.conveyor_no, 'rad etilgach eski raqam qoladi');
});

test('Excel/CSV dan yuklash: xato qator bo\'lsa hech narsa saqlanmaydi', async () => {
  const csv = '﻿' + [
    "Maxsulot guruhi;Maxsulot nomi;Soni;Bo'lim;Konveyer №",
    'Penal;Milano;2;Arra;IMP-1',
    'Penal;Yo\'q mahsulot;1;Arra;IMP-2',
  ].join('\r\n');

  const send = (save) => fetch(base + '/api/import/units' + (save ? '?save=1' : ''), {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream',
               Authorization: 'Bearer ' + tokenAdmin },
    body: Buffer.from(csv, 'utf8'),
  });

  const pre = await (await send(false)).json();
  assert.equal(pre.total, 2);
  assert.equal(pre.bad, 1);

  const saved = await send(true);
  assert.equal(saved.status, 400);
  assert.equal((await H.id(
    `SELECT COUNT(*)::int n FROM production_units WHERE conveyor_no LIKE 'IMP-%'`)).n, 0,
    'bitta qator ham kirmaydi');
});

test('ombor mudiri: omborlar ro\'yxati va jamlanma qoldiq', async () => {
  // Haqiqiy rol bilan sinaladi, admin bilan emas: huquq to'g'ri
  // berilganini faqat shu ko'rsatadi.
  const { db } = require('../db');
  await db.query(`INSERT INTO workers (name) VALUES ('Sinov ombor mudiri')
                  ON CONFLICT DO NOTHING`);
  await db.query(`INSERT INTO worker_roles (worker_id, role_code)
                  SELECT id, 'omborchi' FROM workers WHERE name='Sinov ombor mudiri'
                  ON CONFLICT DO NOTHING`);
  const mudir = H.api(base, await H.sessionFor('Sinov ombor mudiri'));

  // Ishlab chiqarish jurnali unga yopiq — ombor mudirining ishi emas
  assert.equal((await mudir('GET', '/api/units/')).status, 403);

  const list = await mudir('GET', '/api/warehouse/list');
  assert.equal(list.status, 200, list.text);
  const tm = list.body.rows.find((w) => w.code === 'TM');
  assert.ok(tm, 'T/M ombor ro\'yxatda');
  assert.equal(tm.href, '/ombor.html?w=TM', 'havola qaysi ombor ekanini aytadi');
  // Vitrinalar ham ochiq: ular showroom, lekin qoldiq nuqtai nazaridan
  // oddiy ombor — tayyor mahsulot turadi.
  const abu = list.body.rows.find((w) => w.code === 'VITR-ABU');
  assert.equal(abu.href, '/ombor.html?w=VITR-ABU');
  // Ombor mudiriga zavodning HAMMA ombori ochiq
  const mk = list.body.rows.map((w) => w.code);
  for (const kod of ['TM', 'XOM', 'MDF', 'FURN', 'VITR-ABU', 'VITR-PALMA', 'VITR-ARCA'])
    assert.ok(mk.includes(kod), `ombor mudiri ${kod} ni ko'radi`);

  // Savdo esa T/M ombor bilan vitrinalarni ko'radi, xom ashyoni emas
  const savdo = H.api(base, await H.sessionFor('Sinov sotuvchi'));
  const wl = await savdo('GET', '/api/warehouse/list');
  assert.equal(wl.status, 200, wl.text);
  const kodlar = wl.body.rows.map((w) => w.code);
  assert.ok(kodlar.includes('TM') && kodlar.includes('VITR-ABU'), kodlar.join(','));
  assert.ok(!kodlar.includes('XOM') && !kodlar.includes('MDF') &&
            !kodlar.includes('FURN'), 'xom ashyo omborlari savdoga ko\'rinmaydi');

  // Zavod ko'rinishi va panel ham savdoning ishi emas
  assert.equal((await savdo('GET', '/api/factory')).status, 403);
  assert.equal((await savdo('GET', '/api/dashboard')).status, 403);
  // Jurnal esa ochiq: o'z buyurtmasi qayerda turganini bilishi kerak.
  // Lekin faqat O'QISH uchun — konver yaratish ham, tahrirlash ham yo'q.
  assert.equal((await savdo('GET', '/api/units/')).status, 200);
  const bor = (await savdo('GET', '/api/units/')).body[0];
  assert.equal((await savdo('PATCH', '/api/units/' + bor.id,
    { unit_price: 999 })).status, 403, 'savdo jurnalni tahrirlay olmaydi');
  assert.equal((await savdo('POST', '/api/units/',
    { items: [{ product_id: PENAL, qty: 1 }] })).status, 403);
  assert.equal((await savdo('POST', '/api/units/move',
    { items: [{ unit_id: bor.id }] })).status, 403);
  // Omborda: qoldiq ochiq, qabul qilish va kirim/chiqim tarixi yopiq
  assert.equal((await savdo('GET', '/api/warehouse/fg/summary')).status, 200);
  assert.equal((await savdo('POST', '/api/units/stock/accept',
    { items: [bor.id] })).status, 403, 'savdo omborga qabul qila olmaydi');
  assert.equal((await savdo('GET', '/api/units/stock/moves')).status, 403);
  // Mijozlar spravochnigi esa o'zining ishi — ochiq qoladi
  assert.equal((await savdo('POST', '/api/units/customers',
    { name: 'Savdo qo\'shgan mijoz' })).status, 200);

  // Konverni omborga kiritamiz: rang va mato bilan, chunki jamlanma
  // aynan shular bo'yicha guruhlanadi.
  const QADOYNA = (await H.id(`SELECT id FROM sections WHERE code='QAD-OYNA'`)).id;
  const u = await newUnit({ section_id: QADOYNA, color: 'Venge', fabric: 'Velvet-12' });
  const qad = H.api(base, await H.sessionFor('Qadoqlash ustasi'));
  await qad('POST', '/api/units/move', { items: [{ unit_id: u.id }] });
  await qad('POST', '/api/units/handover', { items: [u.id] });
  // Qabul qilish ham mudirning huquqi (warehouse.move)
  assert.equal((await mudir('POST', '/api/units/stock/accept',
    { items: [u.id] })).status, 200);

  const sum = await mudir('GET', '/api/warehouse/fg/summary?q=Venge');
  assert.equal(sum.status, 200, sum.text);
  const row = sum.body.rows.find((r) => r.color === 'Venge' && r.fabric === 'Velvet-12');
  assert.ok(row, 'rang va mato bo\'yicha qator bor');
  assert.equal(row.units, 1);
  assert.equal(row.qty, 1);

  // Qatorni ochganda konver raqami chiqadi — shikoyat kelganda javob shu
  const det = await mudir('GET', '/api/warehouse/fg/units?product_id=' + row.product_id +
    '&color=Venge&fabric=Velvet-12');
  assert.equal(det.status, 200, det.text);
  assert.ok(det.body.rows.some((r) => r.conveyor_no === u.conveyor_no));

  // Sana oralig'i: omborga kirgan kun bo'yicha. Kelajakdagi oraliqda bo'sh
  const none = await mudir('GET', '/api/warehouse/fg/summary?from=2099-01-01');
  assert.equal(none.body.rows.length, 0);
  assert.equal(none.body.total.units, 0);
});

const post = (path, csv) => fetch(base + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/octet-stream',
             Authorization: 'Bearer ' + tokenAdmin },
  body: Buffer.from('\uFEFF' + csv.join('\r\n'), 'utf8'),
});

test('fayldan yuklash: «Omborga kirgan» sanasi konverni T/M omborga qo\'yadi', async () => {
  const csv = [
    "Maxsulot guruhi;Maxsulot nomi;Soni;Bo'lim;Konveyer \u2116;Rang;Omborga kirgan",
    'Penal;Milano;1;Arra;IMP-W1;Oq;',                 // ishlab chiqarishda
    'Penal;Milano;2;;IMP-W2;Venge;2026-09-01',        // omborda
  ];
  const pre = await (await post('/api/import/units', csv)).json();
  assert.equal(pre.bad, 0, JSON.stringify(pre.rows));
  assert.equal(pre.to_stock, 1, 'ko\'rib chiqishda nechtasi omborga tushishi ko\'rinadi');

  const saved = await (await post('/api/import/units?save=1', csv)).json();
  assert.equal(saved.saved, 2);
  assert.equal(saved.to_stock, 1);

  const w1 = await H.id(`SELECT status, fg_on FROM production_units WHERE conveyor_no='IMP-W1'`);
  const w2 = await H.id(`SELECT status, to_char(fg_on, 'YYYY-MM-DD') AS fg_on,
                                current_section_id
                           FROM production_units WHERE conveyor_no='IMP-W2'`);
  assert.equal(w1.status, 'production');
  assert.equal(w2.status, 'fg', 'sana qo\'yilgan qator omborga tushadi');
  assert.equal(w2.fg_on, '2026-09-01');
  assert.equal(w2.current_section_id, null, 'omborda bo\'lim bo\'lmaydi');

  // Jurnalda ko'rinmaydi, ombor qoldig'ida ko'rinadi
  assert.equal((await admin('GET', '/api/units/?conveyor_no=IMP-W2')).body.length, 0);
  const sum = await admin('GET', '/api/warehouse/fg/summary?q=IMP-W2');
  assert.equal(sum.body.total.units, 1);
  assert.equal(sum.body.total.qty, 2);

  // fg_stock ham qayta sanalgan
  assert.ok((await H.id(`SELECT qty FROM fg_stock WHERE product_id=$1`, [PENAL])).qty >= 2);
});

test('mijozlarni fayldan yuklash: notanish kanal butun faylni to\'xtatadi', async () => {
  const bad = [
    'Mijoz nomi;Tel raqami;Region;Kanal',
    'Sinov Mijoz Bir;+998901112233;Toshkent;B2C',
    'Sinov Mijoz Ikki;+998901112244;Samarqand;YO\'QKANAL',
  ];
  const pre = await (await post('/api/import/customers', bad)).json();
  assert.equal(pre.total, 2);
  assert.equal(pre.bad, 1);
  assert.match(pre.rows[1].errors[0], /kanal yo'q/);

  assert.equal((await post('/api/import/customers?save=1', bad)).status, 400);
  assert.equal((await H.id(
    `SELECT COUNT(*)::int n FROM customers WHERE name LIKE 'Sinov Mijoz%'`)).n, 0,
    'xato bo\'lsa bitta mijoz ham kirmaydi');

  // Tuzatilgach kiradi, ustunlar tartibi boshqacha bo'lsa ham
  const ok = [
    'Kanal;Mijoz nomi;Region;Tel raqami',
    'B2C;Sinov Mijoz Bir;Toshkent;+998901112233',
    'Instagram;Sinov Mijoz Ikki;Samarqand;',
  ];
  const done = await (await post('/api/import/customers?save=1', ok)).json();
  assert.equal(done.saved, 2);
  const c = await H.id(`SELECT channel, region, phone FROM customers WHERE name='Sinov Mijoz Bir'`);
  assert.equal(c.channel, 'B2C');
  assert.equal(c.region, 'Toshkent');

  // Qayta yuklash: mavjud mijozning yozilgani o'chmaydi, bo'sh maydon to'ladi
  const again = [
    'Mijoz nomi;Tel raqami;Izoh',
    'Sinov Mijoz Ikki;+998901112255;Ikkinchi yuklash',
  ];
  const r2 = await (await post('/api/import/customers?save=1', again)).json();
  assert.equal(r2.updated, 1);
  const c2 = await H.id(`SELECT channel, region, phone, note FROM customers
                          WHERE name='Sinov Mijoz Ikki'`);
  assert.equal(c2.channel, 'INSTAGRAM', 'oldingi kanal saqlanadi');
  assert.equal(c2.region, 'Samarqand');
  assert.equal(c2.phone, '+998901112255', 'bo\'sh maydon to\'ldiriladi');
  assert.equal(c2.note, 'Ikkinchi yuklash');
});

test('stul lak tsexining bo\'limida tursa ham stul tsexiniki bo\'lib qoladi', async () => {
  const STU_SHKUR = (await H.id(`SELECT id FROM sections WHERE code='STU-SHKUR'`)).id;
  const BOY_AST1  = (await H.id(`SELECT id FROM sections WHERE code='BOY-AST1'`)).id;
  const STUL_ID   = (await H.id(`SELECT id FROM shops WHERE code='STUL'`)).id;
  const OWEN = (await H.id(`SELECT id FROM products WHERE sku='STU-OWEN'`)).id;

  const r = await admin('POST', '/api/units/', {
    items: [{ product_id: OWEN, qty: 1, section_id: STU_SHKUR }] });
  assert.equal(r.status, 200, r.text);
  const u = r.body.created[0];

  const stul = H.api(base, await H.sessionFor('Stul ustasi'));
  // Stul tsexi boshlig'i uni lak bo'limiga O'ZI o'tkazadi: topshirish
  // so'ralmaydi, chunki konver boshqa odamning qo'liga o'tmayapti.
  const mv = await stul('POST', '/api/units/move', { items: [{ unit_id: u.id }] });
  assert.equal(mv.status, 200, mv.text);
  assert.equal((await H.id(`SELECT current_section_id s FROM production_units WHERE id=$1`,
    [u.id])).s, BOY_AST1, 'lak tsexining bo\'limiga o\'tdi');

  // Lak tsexi ustasining ekranida stul YO'Q
  const lakBoard = await lak('GET', '/api/units/board');
  assert.equal(lakBoard.status, 200, lakBoard.text);
  const lakda = lakBoard.body.sections.flatMap((sc) => sc.units).map((x) => x.conveyor_no);
  assert.ok(!lakda.includes(u.conveyor_no), 'lak ustasiga stul ko\'rinmaydi');
  assert.ok(!lakBoard.body.inbox.some((x) => x.conveyor_no === u.conveyor_no),
    'qabul qilish ro\'yxatida ham yo\'q');

  // Stul tsexi boshlig'ida esa — aynan lak bo'limining ustunida
  const stulBoard = await stul('GET', '/api/units/board');
  assert.equal(stulBoard.body.shop.id, STUL_ID);
  const kolonka = stulBoard.body.sections.find((sc) => sc.id === BOY_AST1);
  assert.ok(kolonka, 'lak tsexining bo\'limi stul ekranida ustun bo\'lib turadi');
  assert.ok(kolonka.units.some((x) => x.conveyor_no === u.conveyor_no));

  // Lak ustasi uni qimirlata olmaydi
  const urinish = await lak('POST', '/api/units/move', { items: [{ unit_id: u.id }] });
  assert.equal(urinish.status, 400, urinish.text);
  assert.match(urinish.body.error, /doirangizda emas/);

  // Stul boshlig'i esa oxirigacha o'zi olib boradi
  for (let i = 0; i < 4; i++) {
    const step = await stul('POST', '/api/units/move', { items: [{ unit_id: u.id }] });
    assert.equal(step.status, 200, `${i + 1}-qadam: ${step.text}`);
  }
  const oxir = await H.id(
    `SELECT sc.code, u.lak_on IS NOT NULL AS lak_yozildi
       FROM production_units u JOIN sections sc ON sc.id = u.current_section_id
      WHERE u.id = $1`, [u.id]);
  assert.equal(oxir.code, 'STU-QAD', 'qadoqlashgacha bir o\'zi o\'tkazdi');
  assert.ok(oxir.lak_yozildi, 'lak tsexiga kirish sanasi baribir yozildi');
});

test('jurnaldagi tsex filtri ham javobgar tsex bo\'yicha', async () => {
  const STU_SHKUR = (await H.id(`SELECT id FROM sections WHERE code='STU-SHKUR'`)).id;
  const BOY_AST1  = (await H.id(`SELECT id FROM sections WHERE code='BOY-AST1'`)).id;
  const STUL_ID   = (await H.id(`SELECT id FROM shops WHERE code='STUL'`)).id;
  const BOYOQ_ID  = (await H.id(`SELECT id FROM shops WHERE code='BOYOQ'`)).id;
  const OWEN = (await H.id(`SELECT id FROM products WHERE sku='STU-OWEN'`)).id;

  // Stul lak tsexining bo'limida turibdi
  const stul = H.api(base, await H.sessionFor('Stul ustasi'));
  const s = (await admin('POST', '/api/units/',
    { items: [{ product_id: OWEN, qty: 1, section_id: STU_SHKUR }] })).body.created[0];
  await stul('POST', '/api/units/move', { items: [{ unit_id: s.id }] });
  assert.equal((await H.id(`SELECT current_section_id c FROM production_units WHERE id=$1`,
    [s.id])).c, BOY_AST1);

  // Penal ham lak tsexida
  const pen = (await admin('POST', '/api/units/',
    { items: [{ product_id: PENAL, qty: 1, section_id: BOY_AST1 }] })).body.created[0];

  const kodlar = async (shopId) =>
    (await admin('GET', '/api/units/?shop_id=' + shopId)).body.map((x) => x.conveyor_no);

  const lakda = await kodlar(BOYOQ_ID);
  assert.ok(lakda.includes(pen.conveyor_no), 'penal lak tsexi filtrida chiqadi');
  assert.ok(!lakda.includes(s.conveyor_no), 'stul lak tsexi filtrida chiqmaydi');

  const stulda = await kodlar(STUL_ID);
  assert.ok(stulda.includes(s.conveyor_no),
    'lak bo\'limida tursa ham stul tsexi filtrida chiqadi');
  assert.ok(!stulda.includes(pen.conveyor_no));

  // Bo'lim ro'yxatida lak bo'limlari stul tsexiga ham biriktirilgan
  const ref = await admin('GET', '/api/ref');
  const ast = ref.body.sections.find((x) => x.id === BOY_AST1);
  assert.ok(ast.run_by.includes(STUL_ID),
    'lak bo\'limi stul tsexi ro\'yxatida ham tanlanadi');
});

test('boshlanmagan konver tsex ekranida turadi va bitta bosishda yo\'lga chiqadi', async () => {
  const OWEN = (await H.id(`SELECT id FROM products WHERE sku='STU-OWEN'`)).id;
  const STU_SHKUR = (await H.id(`SELECT id FROM sections WHERE code='STU-SHKUR'`)).id;

  // Bo'lim ko'rsatilmasdan kiritiladi — jurnalda «boshlanmagan» bo'lib turadi
  const r = await admin('POST', '/api/units/', { items: [{ product_id: OWEN, qty: 1 }] });
  assert.equal(r.status, 200, r.text);
  const u = r.body.created[0];
  assert.equal((await H.id(`SELECT current_section_id s FROM production_units WHERE id=$1`,
    [u.id])).s, null);

  const stul = H.api(base, await H.sessionFor('Stul ustasi'));
  const board = await stul('GET', '/api/units/board');
  assert.equal(board.status, 200, board.text);
  const bosh = board.body.unstarted.find((x) => x.id === u.id);
  assert.ok(bosh, 'boshlanmagan konver stul tsexi ekranida ko\'rinadi');
  assert.ok(bosh.on_route, 'u marshrutdan tashqarida emas, hali boshlanmagan');
  assert.equal(bosh.next_section, 'Shkurka', 'tugmada marshrutning birinchi bo\'limi');

  // Bo'lim ustunlarida ham, qabul qilish ro'yxatida ham takrorlanmaydi
  assert.ok(!board.body.sections.some((sc) => sc.units.some((x) => x.id === u.id)));
  assert.ok(!board.body.inbox.some((x) => x.id === u.id));

  // Bitta bosishda birinchi bo'limga chiqadi
  assert.equal((await stul('POST', '/api/units/move',
    { items: [{ unit_id: u.id }] })).status, 200);
  assert.equal((await H.id(`SELECT current_section_id s FROM production_units WHERE id=$1`,
    [u.id])).s, STU_SHKUR);

  // Endi u bo'lim ustunida, boshlanmaganlar ro'yxati esa bo'shadi
  const keyin = await stul('GET', '/api/units/board');
  assert.ok(!keyin.body.unstarted.some((x) => x.id === u.id));
  assert.ok(keyin.body.sections.find((sc) => sc.id === STU_SHKUR)
    .units.some((x) => x.id === u.id));

  // Boshqa tsex ustasiga ko'rinmaydi
  const korpusBoard = await korpus('GET', '/api/units/board');
  assert.ok(!(korpusBoard.body.unstarted || []).some((x) => x.id === u.id));
});

test('konver bo\'lib o\'tkaziladi va uchrashganda qayta qo\'shiladi', async () => {
  const u = await newUnit({ qty: 10 });          // Arrada 10 ta
  const holat = () => require('../db').db.query(
    `SELECT p.part, p.qty, s.code AS bolim
       FROM production_units p LEFT JOIN sections s ON s.id = p.current_section_id
      WHERE p.conveyor_no = $1 AND p.status = 'production'
      ORDER BY p.part`, [u.conveyor_no]).then((r) => r.rows);

  // 3 tasi Roverga, 7 tasi Arrada qoladi
  const r1 = await korpus('POST', '/api/units/move',
    { items: [{ unit_id: u.id, qty: 3 }] });
  assert.equal(r1.status, 200, r1.text);
  assert.deepEqual(await holat(),
    [{ part: 1, qty: 7, bolim: 'KOR-ARRA' }, { part: 2, qty: 3, bolim: 'KOR-ROVER' }]);

  // Yana 2 tasi — Roverdagi bo'lakka QO'SHILADI, uchinchi qator ochilmaydi
  assert.equal((await korpus('POST', '/api/units/move',
    { items: [{ unit_id: u.id, qty: 2 }] })).status, 200);
  assert.deepEqual(await holat(),
    [{ part: 1, qty: 5, bolim: 'KOR-ARRA' }, { part: 2, qty: 5, bolim: 'KOR-ROVER' }]);

  // Qolgan 5 tasi ham o'tdi — bitta 10 lik qator qoladi
  assert.equal((await korpus('POST', '/api/units/move', { items: [{ unit_id: u.id }] })).status, 200);
  assert.deepEqual(await holat(), [{ part: 2, qty: 10, bolim: 'KOR-ROVER' }]);

  // Tarix yo'qolmadi: hamma harakat o'sha konveyer raqamida turibdi
  const tarix = await H.id(
    `SELECT COUNT(*)::int n, SUM(m.qty)::int dona
       FROM unit_moves m JOIN production_units p ON p.id = m.unit_id
      WHERE p.conveyor_no = $1`, [u.conveyor_no]);
  assert.equal(tarix.n, 4, 'boshlang\'ich qoldiq + uchta o\'tkazish');
  assert.equal(tarix.dona, 10 + 3 + 2 + 5);
});

test('bo\'lib o\'tkazishni qaytarganda donalar o\'z joyiga qaytadi', async () => {
  const u = await newUnit({ qty: 8 });
  const holat = () => require('../db').db.query(
    `SELECT p.qty, s.code AS bolim
       FROM production_units p LEFT JOIN sections s ON s.id = p.current_section_id
      WHERE p.conveyor_no = $1 AND p.status = 'production'
      ORDER BY p.part`, [u.conveyor_no]).then((r) => r.rows);

  const r = await korpus('POST', '/api/units/move', { items: [{ unit_id: u.id, qty: 3 }] });
  const yangi = r.body.moved[0].unit_id;
  assert.notEqual(yangi, u.id, 'bo\'lak alohida qator bo\'ldi');
  assert.deepEqual(await holat(),
    [{ qty: 5, bolim: 'KOR-ARRA' }, { qty: 3, bolim: 'KOR-ROVER' }]);

  // Qaytarish: 3 tasi Arraga qaytadi va 5 taga qo'shiladi
  assert.equal((await korpus('POST', '/api/units/undo', { unit_id: yangi })).status, 200);
  assert.deepEqual(await holat(), [{ qty: 8, bolim: 'KOR-ARRA' }],
    'sakkiztasi yana bitta qator bo\'lib Arrada turibdi');
});

test('noto\'g\'ri son o\'tkazilmaydi', async () => {
  const u = await newUnit({ qty: 4 });
  for (const [qty, kutilgan] of [[0, /noldan katta/], [-2, /noldan katta/],
                                 [5, /o'tkazib bo'lmaydi/], [1.5, /butun/]]) {
    const r = await korpus('POST', '/api/units/move', { items: [{ unit_id: u.id, qty }] });
    assert.equal(r.status, 400, `${qty} → ${r.text}`);
    assert.match(r.body.error, kutilgan);
  }
  // Hech narsa o'zgarmadi
  assert.equal((await H.id(`SELECT qty FROM production_units WHERE id=$1`, [u.id])).qty, 4);
});

test('keyingi tsex konverning bir qismini qabul qila oladi', async () => {
  const KOR_SHKUR = (await H.id(`SELECT id FROM sections WHERE code='KOR-SHKUR'`)).id;
  const u = await newUnit({ qty: 10, section_id: KOR_SHKUR });

  // Korpus «Lak tsexiga jo'natdim» deydi — belgi butun qatorga qo'yiladi
  assert.equal((await korpus('POST', '/api/units/handover', { items: [u.id] })).status, 200);

  // Lak tsexi 4 tasini oladi, 6 tasi korpusda qoladi
  const r = await lak('POST', '/api/units/move', { items: [{ unit_id: u.id, qty: 4 }] });
  assert.equal(r.status, 200, r.text);
  const holat = async () => (await require('../db').db.query(
    `SELECT p.qty, s.code AS bolim, p.handover_on IS NOT NULL AS jonatilgan
       FROM production_units p LEFT JOIN sections s ON s.id = p.current_section_id
      WHERE p.conveyor_no = $1 AND p.status = 'production' ORDER BY p.part`,
    [u.conveyor_no])).rows;
  assert.deepEqual(await holat(), [
    { qty: 6, bolim: 'KOR-SHKUR', jonatilgan: true },
    { qty: 4, bolim: 'BOY-AST1',  jonatilgan: false },
  ], 'qolgani jo\'natilgan holida turadi, o\'tgani lak tsexida');

  // Qolgan 6 tasi ham qabul qilinadi — belgi saqlangani uchun
  assert.equal((await lak('POST', '/api/units/move', { items: [{ unit_id: u.id }] })).status, 200);
  assert.deepEqual(await holat(), [{ qty: 10, bolim: 'BOY-AST1', jonatilgan: false }],
    'hammasi lak tsexida bitta qator bo\'lib qo\'shildi');

  // Lak tsexiga kirish sanasi yozilgan
  assert.ok((await H.id(
    `SELECT lak_on FROM production_units WHERE conveyor_no=$1 AND status='production'`,
    [u.conveyor_no])).lak_on);
});

test('boshlang\'ich qoldiq to\'g\'ridan-to\'g\'ri T/M omborga kiritiladi', async () => {
  const STUL = (await H.id(`SELECT id FROM products WHERE sku='STU-LAURA'`)).id;
  const r = await admin('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 2, color: 'Venge', fabric: 'Velvet-12',
      unit_price: 300, fg_on: '2026-08-20', is_opening: true },
    { product_id: STUL,  qty: 6, color: 'Oq', fg_on: '2026-08-21', is_opening: true },
  ] });
  assert.equal(r.status, 200, r.text);

  const [a, b] = r.body.created;
  const holat = async (id) => await H.id(
    `SELECT status, to_char(fg_on,'YYYY-MM-DD') AS fg_on, current_section_id
       FROM production_units WHERE id = $1`, [id]);
  assert.deepEqual(await holat(a.id),
    { status: 'fg', fg_on: '2026-08-20', current_section_id: null });
  assert.deepEqual(await holat(b.id),
    { status: 'fg', fg_on: '2026-08-21', current_section_id: null });

  // Jurnalda ko'rinmaydi — u ishlab chiqarishda emas
  assert.equal((await admin('GET', '/api/units/?conveyor_no=' + a.conveyor_no)).body.length, 0);

  // Ombor qoldig'ida esa turibdi, O'LCHOV BIRLIGI bilan
  const sum = await admin('GET', '/api/warehouse/fg/summary?q=Venge');
  const qator = sum.body.rows.find((x) => x.color === 'Venge');
  assert.ok(qator, JSON.stringify(sum.body.rows));
  assert.equal(qator.uom, 'komplekt', 'penal komplekt bilan sanaladi');
  assert.equal(qator.qty, 2);

  // Yig'indi birliklar bo'yicha ajratiladi — dona bilan komplekt qo'shilmaydi
  const hammasi = await admin('GET', '/api/warehouse/fg/summary');
  const uoms = Object.fromEntries(hammasi.body.total.by_uom.map((x) => [x.uom, x.qty]));
  assert.ok(uoms.komplekt >= 2, JSON.stringify(uoms));
  assert.ok(uoms.dona >= 6, JSON.stringify(uoms));

  // fg_stock ham hisoblandi
  assert.ok((await H.id(`SELECT qty FROM fg_stock WHERE product_id=$1`, [STUL])).qty >= 6);
});

test('raqami noma\'lum qoldiq ham qabul qilinadi — tizim Q raqami beradi', async () => {
  // Qo'lda: raqamsiz ikkita qator
  const r = await admin('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 2, is_opening: true, fg_on: '2026-08-10' },
    { product_id: PENAL, qty: 1, is_opening: true, section_id: ARRA },
  ] });
  assert.equal(r.status, 200, r.text);
  for (const c of r.body.created)
    assert.match(c.conveyor_no, /^Q\d\d-\d{4}$/, c.conveyor_no);
  assert.notEqual(r.body.created[0].conveyor_no, r.body.created[1].conveyor_no,
    'ketma-ket raqamlar, takrorlanmaydi');

  // Oddiy konver esa K bilan qoladi
  const k = await admin('POST', '/api/units/', { items: [{ product_id: PENAL, qty: 1 }] });
  assert.match(k.body.created[0].conveyor_no, /^K\d\d-\d{4}$/);

  // Fayldan: konveyer ustuni umuman yo'q
  const csv = [
    "Maxsulot guruhi;Maxsulot nomi;Soni;Rang;Omborga kirgan",
    'Penal;Milano;4;Oq;2026-08-12',
    'Penal;Laura;2;Venge;2026-08-12',
  ];
  const pre = await (await post('/api/import/units', csv)).json();
  assert.equal(pre.bad, 0, JSON.stringify(pre.rows));
  const saved = await (await post('/api/import/units?save=1', csv)).json();
  assert.equal(saved.saved, 2);
  for (const c of saved.created) assert.match(c.conveyor_no, /^Q\d\d-\d{4}$/);

  // Hammasi ombor qoldig'ida turibdi
  const sum = await admin('GET', '/api/warehouse/fg/summary?q=Q2');
  assert.ok(sum.body.total.units >= 3, JSON.stringify(sum.body.total));
});

test('savdo menejeriga faqat o\'z yo\'nalishidagi mijozlar ko\'rinadi', async () => {
  const { db } = require('../db');
  await db.query(`INSERT INTO workers (name) VALUES ('Eksport menejeri'), ('B2B menejeri')
                  ON CONFLICT DO NOTHING`);
  await db.query(`INSERT INTO worker_roles (worker_id, role_code, scope_channel)
                  SELECT id, 'sotuvchi', 'EXPORT' FROM workers WHERE name='Eksport menejeri'
                  ON CONFLICT (worker_id, role_code) DO UPDATE SET scope_channel='EXPORT'`);
  await db.query(`INSERT INTO worker_roles (worker_id, role_code, scope_channel)
                  SELECT id, 'sotuvchi', 'B2B' FROM workers WHERE name='B2B menejeri'
                  ON CONFLICT (worker_id, role_code) DO UPDATE SET scope_channel='B2B'`);

  assert.equal((await admin('POST', '/api/units/customers', { items: [
    { name: 'Eksport mijozi', channel: 'EXPORT' },
    { name: 'B2B mijozi',     channel: 'B2B' },
    { name: 'Kanalsiz mijoz' },
  ] })).status, 200);

  const eks = H.api(base, await H.sessionFor('Eksport menejeri'));
  const b2b = H.api(base, await H.sessionFor('B2B menejeri'));

  const nomlar = async (api) =>
    (await api('GET', '/api/units/customers')).body.customers.map((c) => c.name);

  const e = await nomlar(eks);
  assert.ok(e.includes('Eksport mijozi'));
  assert.ok(!e.includes('B2B mijozi'), 'boshqa yo\'nalish ko\'rinmaydi');
  assert.ok(!e.includes('Kanalsiz mijoz'), 'kanalsiz mijoz ham ko\'rinmaydi');

  const b = await nomlar(b2b);
  assert.ok(b.includes('B2B mijozi'));
  assert.ok(!b.includes('Eksport mijozi'));

  // Administratorda doira yo'q — hammasini ko'radi
  const a = await nomlar(admin);
  for (const n of ['Eksport mijozi', 'B2B mijozi', 'Kanalsiz mijoz'])
    assert.ok(a.includes(n), n);
});

test('mijozning boshlang\'ich qarzi kiritiladi va qayta yuklashda o\'chmaydi', async () => {
  const csv = [
    'Mijoz nomi;Tel raqami;Kanal;Boshlang\'ich qarz',
    'Qarzdor mijoz;+998901110000;B2B;1250,50',
    'Qarzsiz mijoz;+998901110001;B2C;',
  ];
  assert.equal((await post('/api/import/customers?save=1', csv)).status, 200);
  const qarz = async (nom) => (await H.id(
    `SELECT opening_debt::float8 AS d FROM customers WHERE name = $1`, [nom])).d;
  assert.equal(await qarz('Qarzdor mijoz'), 1250.5, 'vergul bilan yozilgan raqam o\'qildi');
  assert.equal(await qarz('Qarzsiz mijoz'), null);

  // Qayta yuklash: qarz yozilgani o'chmaydi, bo'sh bo'lgani to'ladi
  const yana = [
    'Mijoz nomi;Tel raqami;Boshlang\'ich qarz',
    'Qarzdor mijoz;+998901110000;9999',
    'Qarzsiz mijoz;+998901110001;300',
  ];
  assert.equal((await post('/api/import/customers?save=1', yana)).status, 200);
  assert.equal(await qarz('Qarzdor mijoz'), 1250.5, 'yozilgan qarz almashtirilmaydi');
  assert.equal(await qarz('Qarzsiz mijoz'), 300, 'bo\'sh qarz to\'ldiriladi');

  // Kartochkadan tuzatish esa ishlaydi — shu jumladan tozalash
  const id = (await H.id(`SELECT id FROM customers WHERE name='Qarzdor mijoz'`)).id;
  assert.equal((await admin('PATCH', '/api/units/customers/' + id,
    { opening_debt: 500, opening_debt_on: '2026-09-01' })).status, 200);
  assert.equal(await qarz('Qarzdor mijoz'), 500);
  assert.equal((await admin('PATCH', '/api/units/customers/' + id,
    { opening_debt: null })).status, 200);
  assert.equal(await qarz('Qarzdor mijoz'), null, 'noto\'g\'ri raqam tozalanadi');

  // Ro'yxatda ko'rinadi
  const c = (await admin('GET', '/api/units/customers')).body.customers
    .find((x) => x.name === 'Qarzsiz mijoz');
  assert.equal(Number(c.opening_debt), 300);
});

// ══════════════════════════════════════════════════════════════ VITRINALAR

test('mahsulot T/M ombordan vitrinaga ko\'chiriladi, bir qismi ham', async () => {
  const mudir = H.api(base, await H.sessionFor('Sinov ombor mudiri'));

  // T/M omborda 10 talik konver
  const u = (await admin('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 10, color: 'Bej', is_opening: true, fg_on: '2026-09-05' },
  ] })).body.created[0];

  const qoldiq = async (w) => (await mudir(
    'GET', `/api/warehouse/fg/summary?w=${w}&q=Bej`)).body;
  assert.equal((await qoldiq('TM')).total.qty, 10);
  assert.equal((await qoldiq('VITR-ABU')).total.qty, 0, 'vitrina hozircha bo\'sh');

  // 3 tasi vitrinaga
  const r = await mudir('POST', '/api/warehouse/fg/transfer',
    { unit_id: u.id, qty: 3, to_code: 'VITR-ABU', moved_on: '2026-09-10' });
  assert.equal(r.status, 200, r.text);

  assert.equal((await qoldiq('TM')).total.qty, 7, 'qolgani T/M omborda turibdi');
  assert.equal((await qoldiq('VITR-ABU')).total.qty, 3);

  // Konver bo'lindi: raqami bir xil, jami o'zgarmadi
  const bolaklar = (await require('../db').db.query(
    `SELECT qty, w.code FROM production_units u
       LEFT JOIN warehouses w ON w.id = u.warehouse_id
      WHERE u.conveyor_no = $1 ORDER BY qty`, [u.conveyor_no])).rows;
  assert.equal(bolaklar.reduce((a, b) => a + b.qty, 0), 10, 'dona yo\'qolmadi');
  assert.equal(bolaklar.find((b) => b.qty === 3).code, 'VITR-ABU');
  assert.equal(bolaklar.find((b) => b.qty === 7).code, 'TM');

  // Vitrinadagi bo'lakni butunicha boshqa vitrinaga
  const vitr = (await mudir('GET',
    `/api/warehouse/fg/units?w=VITR-ABU&product_id=${PENAL}&color=Bej`)).body.rows[0];
  assert.equal(vitr.qty, 3);
  assert.equal((await mudir('POST', '/api/warehouse/fg/transfer',
    { unit_id: vitr.id, to_code: 'VITR-PALMA' })).status, 200);
  assert.equal((await qoldiq('VITR-ABU')).total.qty, 0);
  assert.equal((await qoldiq('VITR-PALMA')).total.qty, 3);

  // Harakat tarixi: bergan omborda chiqim, olganida kirim
  const tarix = async (w) => (await mudir('GET',
    `/api/units/stock/moves?w=${w}&from=2026-09-01&to=2026-09-30`)).body;
  assert.equal((await tarix('VITR-ABU')).chiqim, 3, 'vitrinadan chiqdi');
  assert.equal((await tarix('VITR-PALMA')).kirim, 3, 'ikkinchisiga kirdi');

  // Xatolar
  const yoq = await mudir('POST', '/api/warehouse/fg/transfer',
    { unit_id: vitr.id, to_code: 'VITR-PALMA' });
  assert.equal(yoq.status, 400);
  assert.match(yoq.body.error, /allaqachon/);
  assert.equal((await mudir('POST', '/api/warehouse/fg/transfer',
    { unit_id: vitr.id, to_code: 'XOM' })).status, 400, 'xom ashyo omboriga emas');
  assert.equal((await mudir('POST', '/api/warehouse/fg/transfer',
    { unit_id: vitr.id, qty: 99, to_code: 'VITR-ARCA' })).status, 400);

  // Savdo ko'radi, lekin ko'chira olmaydi
  const savdo = H.api(base, await H.sessionFor('Sinov sotuvchi'));
  assert.equal((await savdo('GET', '/api/warehouse/fg/summary?w=VITR-PALMA')).status, 200);
  assert.equal((await savdo('POST', '/api/warehouse/fg/transfer',
    { unit_id: vitr.id, to_code: 'TM' })).status, 403);
});

test('boshlang\'ich qoldiq to\'g\'ridan-to\'g\'ri vitrinaga kiritiladi', async () => {
  const r = await admin('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 2, color: 'Shokolad', is_opening: true,
      fg_on: '2026-09-03', warehouse_code: 'VITR-ARCA' },
  ] });
  assert.equal(r.status, 200, r.text);
  const w = await H.id(
    `SELECT w.code FROM production_units u JOIN warehouses w ON w.id = u.warehouse_id
      WHERE u.id = $1`, [r.body.created[0].id]);
  assert.equal(w.code, 'VITR-ARCA');

  const s = await admin('GET', '/api/warehouse/fg/summary?w=VITR-ARCA&q=Shokolad');
  assert.equal(s.body.total.qty, 2);
  assert.equal(s.body.warehouse.name, 'Arca vitrina');

  // T/M omborda ko'rinmaydi — aks holda bitta mahsulot ikki joyda sanalardi
  assert.equal((await admin('GET', '/api/warehouse/fg/summary?q=Shokolad')).body.total.qty, 0);

  // Noto'g'ri ombor kodi jimgina yutilmaydi
  const xato = await admin('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 1, is_opening: true, fg_on: '2026-09-03',
      warehouse_code: 'YO-Q' },
  ] });
  assert.equal(xato.status, 400);
  assert.match(xato.text, /topilmadi/);
});

// ═══════════════════════════════════════════════════════════════════ SAVDO

test('buyurtmaga ombordagi konver biriktiriladi — butunicha va bir qismi', async () => {
  const STUL = (await H.id(`SELECT id FROM products WHERE sku='STU-LAURA'`)).id;

  // Ombordagi ikkita konver: 3 talik penal va 10 talik stul
  const qoldiq = await admin('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 3, color: 'Oq',  is_opening: true, fg_on: '2026-09-01' },
    { product_id: STUL,  qty: 10, color: 'Oq', is_opening: true, fg_on: '2026-09-01' },
  ] });
  assert.equal(qoldiq.status, 200, qoldiq.text);
  const [penalUnit, stulUnit] = qoldiq.body.created;

  const mijoz = (await H.id(`SELECT id FROM customers WHERE name='Kanalsiz mijoz'`)).id;
  const r = await admin('POST', '/api/sales/orders', {
    customer_id: mijoz, due_on: '2026-10-01', items: [
      { product_id: PENAL, qty: 3, color: 'Oq', unit_price: 300 },
      { product_id: STUL,  qty: 4, color: 'Oq', unit_price: 55 },
    ] });
  assert.equal(r.status, 200, r.text);
  assert.match(r.body.order_no, /^Z\d\d-\d{4}$/, r.body.order_no);
  const zakaz = r.body.id;

  const ochish = async () => (await admin('GET', '/api/sales/orders/' + zakaz)).body;
  let o = await ochish();
  assert.equal(o.items.length, 2);
  const [q1, q2] = o.items;

  const nomzod = async (itemId) => (await admin(
    'GET', `/api/sales/orders/${zakaz}/candidates?item_id=${itemId}`)).body.rows;
  assert.ok((await nomzod(q1.id)).some((u) => u.id === penalUnit.id));

  // 1) Butun konver
  assert.equal((await admin('POST', `/api/sales/orders/${zakaz}/assign`,
    { item_id: q1.id, unit_id: penalUnit.id })).status, 200);

  // 2) 10 talik konverdan 4 tasi — qolgan 6 tasi omborda bo'sh turadi
  assert.equal((await admin('POST', `/api/sales/orders/${zakaz}/assign`,
    { item_id: q2.id, unit_id: stulUnit.id, qty: 4 })).status, 200);

  o = await ochish();
  assert.equal(o.order.status, 'reserved', 'konver biriktirilgach buyurtma band bo\'ladi');
  assert.equal(Number(o.items[0].assigned_qty), 3);
  assert.equal(Number(o.items[1].assigned_qty), 4);
  assert.equal(o.order.is_ready, true, '3 + 4 = butun buyurtma yopildi');

  // Konverga zakaz raqami va mijoz yozildi
  const bogla = await H.id(
    `SELECT order_no, customer_id FROM production_units WHERE id = $1`, [penalUnit.id]);
  assert.equal(bogla.order_no, r.body.order_no);
  assert.equal(bogla.customer_id, mijoz);

  // Bo'lingan konver: bir xil raqamda ikkita qator, jami 10 ta
  const bolaklar = (await require('../db').db.query(
    `SELECT qty, order_item_id FROM production_units WHERE conveyor_no = $1 ORDER BY qty`,
    [stulUnit.conveyor_no])).rows;
  assert.equal(bolaklar.length, 2, JSON.stringify(bolaklar));
  assert.equal(bolaklar.reduce((a, b) => a + b.qty, 0), 10, 'dona yo\'qolmadi');
  assert.equal(bolaklar.find((b) => b.qty === 4).order_item_id, q2.id);
  assert.equal(bolaklar.find((b) => b.qty === 6).order_item_id, null,
    'qolgan bo\'lak bo\'sh turadi');

  // Band konver boshqa buyurtmaga chiqmaydi
  assert.ok(!(await nomzod(q1.id)).some((u) => u.id === penalUnit.id),
    'biriktirilgan konver ro\'yxatda turmaydi');

  const yana = await admin('POST', `/api/sales/orders/${zakaz}/assign`,
    { item_id: q1.id, unit_id: penalUnit.id });
  assert.equal(yana.status, 400);
  assert.match(yana.body.error, /band/);

  // Konveri bor qator o'chirilmaydi, buyurtma ham bekor qilinmaydi
  const ochir = await admin('PATCH', '/api/sales/orders/' + zakaz,
    { items: [{ id: q2.id, product_id: STUL, qty: 4 }] });
  assert.equal(ochir.status, 400, ochir.text);
  const bekor = await admin('PATCH', '/api/sales/orders/' + zakaz, { status: 'cancelled' });
  assert.equal(bekor.status, 400);
  assert.match(bekor.body.error, /ajrating/);

  // Ajratilganda bo'laklar qayta qo'shiladi
  const bolak = (await require('../db').db.query(
    `SELECT id FROM production_units WHERE conveyor_no=$1 AND order_item_id IS NOT NULL`,
    [stulUnit.conveyor_no])).rows[0].id;
  assert.equal((await admin('POST', `/api/sales/orders/${zakaz}/unassign`,
    { unit_id: bolak })).status, 200);
  const qaytgan = (await require('../db').db.query(
    `SELECT qty FROM production_units WHERE conveyor_no = $1`, [stulUnit.conveyor_no])).rows;
  assert.deepEqual(qaytgan.map((x) => x.qty), [10], 'bo\'laklar bitta qatorga qaytdi');

  // Hammasi ajratilsa buyurtma yana "yangi" bo'ladi
  assert.equal((await admin('POST', `/api/sales/orders/${zakaz}/unassign`,
    { unit_id: penalUnit.id })).status, 200);
  assert.equal((await ochish()).order.status, 'new');
  assert.equal((await H.id(`SELECT order_no FROM production_units WHERE id=$1`,
    [penalUnit.id])).order_no, null, 'ajratilganda zakaz raqami ham o\'chadi');
});

test('zahiradagi konver biriktiriladi, ishlab chiqarishdagi esa yo\'q', async () => {
  const RANG = (await H.id(`SELECT id FROM sections WHERE code='BOY-RANG'`)).id;
  const zah = (await admin('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 2, color: 'Venge', section_id: RANG, is_stock: true },
  ] })).body.created[0];
  const ish = (await admin('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 2, color: 'Venge', section_id: ARRA },
  ] })).body.created[0];

  const mijoz = (await H.id(`SELECT id FROM customers WHERE name='Kanalsiz mijoz'`)).id;
  const z = (await admin('POST', '/api/sales/orders', { customer_id: mijoz,
    items: [{ product_id: PENAL, qty: 2, color: 'Venge' }] })).body;
  const qator = (await admin('GET', '/api/sales/orders/' + z.id)).body.items[0];

  const nomzod = (await admin('GET',
    `/api/sales/orders/${z.id}/candidates?item_id=${qator.id}`)).body.rows;
  assert.ok(nomzod.some((u) => u.id === zah.id), 'zahira ro\'yxatda');
  assert.ok(!nomzod.some((u) => u.id === ish.id),
    'ishlab chiqarishdagi konver sotilmaydi');

  assert.equal((await admin('POST', `/api/sales/orders/${z.id}/assign`,
    { item_id: qator.id, unit_id: zah.id })).status, 200);

  // Ishlab chiqarishdagini to'g'ridan-to'g'ri yuborsa ham qabul qilinmaydi
  const xato = await admin('POST', `/api/sales/orders/${z.id}/assign`,
    { item_id: qator.id, unit_id: ish.id });
  assert.equal(xato.status, 400);
  assert.match(xato.body.error, /ombordagi yoki zahiradagi/);
});

test('savdo yo\'nalishi buyurtmaga ham chegara bo\'ladi', async () => {
  const eks = H.api(base, await H.sessionFor('Eksport menejeri'));
  const b2b = H.api(base, await H.sessionFor('B2B menejeri'));
  const nomi = async (n) => (await H.id(`SELECT id FROM customers WHERE name=$1`, [n])).id;

  const ok = await eks('POST', '/api/sales/orders',
    { customer_id: await nomi('Eksport mijozi'),
      items: [{ product_id: PENAL, qty: 1 }] });
  assert.equal(ok.status, 200, ok.text);

  const yoq = await eks('POST', '/api/sales/orders',
    { customer_id: await nomi('B2B mijozi'), items: [] });
  assert.equal(yoq.status, 400);
  assert.match(yoq.body.error, /emas/);

  // Boshqa menejerning buyurtmasi ro'yxatda ham, ochganda ham ko'rinmaydi
  assert.ok(!(await b2b('GET', '/api/sales/orders')).body.rows
    .some((x) => x.id === ok.body.id));
  assert.equal((await b2b('GET', '/api/sales/orders/' + ok.body.id)).status, 404);
  assert.equal((await b2b('PATCH', '/api/sales/orders/' + ok.body.id,
    { note: 'tegdim' })).status, 400);

  // Administratorda doira yo'q
  assert.equal((await admin('GET', '/api/sales/orders/' + ok.body.id)).status, 200);
});

test('tsex ustasiga savdo yopiq', async () => {
  assert.equal((await korpus('GET', '/api/sales/orders')).status, 403);
  assert.equal((await korpus('POST', '/api/sales/orders', { customer_id: 1 })).status, 403);
});

test('yakun', async () => {
  server.close();
  await require('../db').db.end();
});
