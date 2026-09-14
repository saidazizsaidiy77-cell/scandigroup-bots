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

test('tarixga tegadigan maydonlar faqat boshqaruvchiga ochiq', async () => {
  const u = await newUnit();
  await require('../db').db.query(
    `INSERT INTO workers (name) VALUES ('Sinov sotuvchi') ON CONFLICT DO NOTHING`);
  await require('../db').db.query(
    `INSERT INTO worker_roles (worker_id, role_code)
     SELECT id, 'sotuvchi' FROM workers WHERE name='Sinov sotuvchi'
     ON CONFLICT DO NOTHING`);
  sotuvchi = H.api(base, await H.sessionFor('Sinov sotuvchi'));

  for (const body of [{ conveyor_no: 'X-1' }, { qty: 5 }, { lak_on: '2026-01-01' },
                      { section_id: ROVER }]) {
    const r = await sotuvchi('PATCH', '/api/units/' + u.id, body);
    assert.equal(r.status, 403, JSON.stringify(body) + ' → ' + r.text);
  }
  // Narx va reja sanasi esa savdoga ochiq qolishi kerak
  assert.equal((await sotuvchi('PATCH', '/api/units/' + u.id, { unit_price: 100 })).status, 200);
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
  assert.equal(tm.href, '/ombor.html', 'ochiq ombor havolaga ega');
  // Ombor mudiriga faqat o'z ombori: vitrinalar savdoniki, xom ashyo
  // ta'minotniki. Ro'yxat ombor qatoridagi `perm` bo'yicha filtrlanadi.
  assert.deepEqual(list.body.rows.map((w) => w.code), ['TM'],
    'ombor mudiri boshqa omborlarni ko\'rmaydi');

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
  // Jurnal esa ochiq: o'z buyurtmasi qayerda turganini bilishi kerak
  assert.equal((await savdo('GET', '/api/units/')).status, 200);

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

test('yakun', async () => {
  server.close();
  await require('../db').db.end();
});
