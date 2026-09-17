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

  //  ★ SANA ORALIG'I FAQAT AYLANMAGA TEGADI. Qoldiq — hozirgi holat va
  //  oraliqqa bog'liq emas: «kelajakdagi oraliq» tanlansa omborda
  //  turgan mahsulot yo'qolib qolmaydi, faqat kirdi/chiqdi nolga
  //  tushadi. Aks holda mudir «ombor bo'shab qolibdi» deb o'qirdi.
  assert.equal(row.kirdi, 1, 'bugun kirgani aylanmada');
  const kel = await mudir('GET', '/api/warehouse/fg/summary?from=2099-01-01');
  const kelRow = kel.body.rows.find((r) => r.color === 'Venge');
  assert.ok(kelRow, 'qoldiq oraliqdan qat\'i nazar turadi');
  assert.equal(kelRow.qty, 1);
  assert.equal(kelRow.kirdi, 0, 'o\'sha oraliqda harakat yo\'q');
  assert.equal(kel.body.total.kirdi, 0);
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

  //  HAQDOR alohida ustunda: korxona mijozga qarzdor. Bitta ishorali
  //  maydonga manfiy bo'lib yoziladi, sanasi bilan birga.
  const haq = [
    'Mijoz nomi;Tel raqami;Qarzdor;Haqdor;Qarz sanasi',
    'Haqdor mijoz;+998901110002;;400;01.09.2026',
    'Ikki tomon;+998901110003;1000;250;01.09.2026',
    'Minus bilan;+998901110004;-150;;',
  ];
  const ol = await post('/api/import/customers?save=1', haq);
  assert.equal(ol.status, 200, ol.text);
  assert.equal(await qarz('Haqdor mijoz'), -400, 'haqdor manfiy bo\'lib yoziladi');
  assert.equal(await qarz('Ikki tomon'), 750, 'qarzdor - haqdor');
  assert.equal(await qarz('Minus bilan'), -150, 'bitta ustunda minus ham ishlaydi');
  assert.equal((await H.id(
    `SELECT to_char(opening_debt_on,'YYYY-MM-DD') AS d FROM customers
      WHERE name = 'Haqdor mijoz'`)).d, '2026-09-01', 'qarz sanasi fayldan');

  //  Hisobotda haqdor tomonda turadi, qarzdor ustunida minus bo'lib emas
  const hisobot = (await admin('GET',
    '/api/sales/debts?from=1900-01-01&to=2030-01-01')).body.rows
    .find((x) => x.name === 'Haqdor mijoz');
  assert.equal(Number(hisobot.closing_credit), 400);
  assert.equal(Number(hisobot.closing_debit), 0);
  assert.equal(Number(hisobot.debit), 0, 'qarzdor aylanmada minus turmaydi');
});

test('xato kiritilgan konver jurnaldan omborga o\'tkaziladi', async () => {
  // Boshlang'ich qoldiq omborga tushishi kerak edi, lekin tsex tanlangan
  const u = (await admin('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 4, color: 'Krem', is_opening: true, section_id: ARRA },
  ] })).body.created[0];
  assert.equal((await H.id(`SELECT status FROM production_units WHERE id=$1`,
    [u.id])).status, 'production');

  const r = await admin('POST', `/api/units/${u.id}/to-warehouse`,
    { warehouse_code: 'VITR-ABU', fg_on: '2026-09-04' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.warehouse, 'Abu-Saxiy vitrina');

  const holat = await H.id(
    `SELECT u.status, to_char(u.fg_on,'YYYY-MM-DD') AS fg_on, w.code,
            u.current_section_id
       FROM production_units u LEFT JOIN warehouses w ON w.id = u.warehouse_id
      WHERE u.id = $1`, [u.id]);
  assert.equal(holat.status, 'fg');
  assert.equal(holat.code, 'VITR-ABU');
  assert.equal(holat.fg_on, '2026-09-04');
  assert.equal(holat.current_section_id, ARRA,
    'turgan bo\'limi saqlanadi — ombordan qaytarilsa o\'z joyiga qaytsin');

  // Jurnaldan chiqdi, vitrina qoldig'iga tushdi
  assert.equal((await admin('GET', '/api/units/?conveyor_no=' + u.conveyor_no)).body.length, 0);
  assert.equal((await admin(
    'GET', '/api/warehouse/fg/summary?w=VITR-ABU&q=Krem')).body.total.qty, 4);

  // Ikkinchi marta o'tkazib bo'lmaydi
  const yana = await admin('POST', `/api/units/${u.id}/to-warehouse`,
    { warehouse_code: 'VITR-ABU' });
  assert.equal(yana.status, 400);
  assert.match(yana.body.error, /allaqachon/);

  // Xom ashyo omboriga ham, mavjud bo'lmagan omborga ham emas
  const ish = (await admin('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 1, section_id: ARRA },
  ] })).body.created[0];
  for (const kod of ['XOM', 'YO-Q'])
    assert.equal((await admin('POST', `/api/units/${ish.id}/to-warehouse`,
      { warehouse_code: kod })).status, 400, kod);

  // Bu TUZATISH — kirituvchida ham, ustada ham yo'q
  const kirituvchi = H.api(base, await H.sessionFor('Sinov kirituvchi'));
  assert.equal((await kirituvchi('POST', `/api/units/${ish.id}/to-warehouse`,
    { warehouse_code: 'TM' })).status, 403);
  assert.equal((await korpus('POST', `/api/units/${ish.id}/to-warehouse`,
    { warehouse_code: 'TM' })).status, 403);

  // Qaytarish ishlaydi: ombordan chiqib, o'z bo'limiga qaytadi
  assert.equal((await admin('POST', '/api/units/stock/accept',
    { items: [u.id], undo: true })).status, 200);
  const q = await H.id(
    `SELECT status, warehouse_id, current_section_id FROM production_units WHERE id=$1`,
    [u.id]);
  assert.deepEqual([q.status, q.warehouse_id, q.current_section_id],
                   ['production', null, ARRA]);
});

test('direktor bo\'limlarni va bugungi harakatlarni ko\'radi, o\'zgartirmaydi', async () => {
  const dir = H.api(base, await H.sessionFor('Direktor'));

  // Bo'limlar ekrani: doirasi yo'q, hamma tsexni ko'radi
  const b = await dir('GET', '/api/units/board');
  assert.equal(b.status, 200, b.text);
  assert.ok(b.body.shops.length > 1, 'tsexlar orasida tanlash mumkin');

  // Bugungi harakatlar lentasi, filtrlari bilan
  const f = await dir('GET', '/api/units/feed');
  assert.equal(f.status, 200, f.text);
  assert.ok(Array.isArray(f.body.moves));
  assert.ok(f.body.shops.length && f.body.workers.length,
    'tsex va xodim filtri uchun ro\'yxatlar keladi');
  const shopId = b.body.shops[0].id;
  assert.equal((await dir('GET', '/api/units/feed?shop_id=' + shopId)).status, 200);
  assert.equal((await dir('GET',
    '/api/units/feed?from=2026-09-01&to=2026-09-30')).status, 200);

  // Lekin qimirlata olmaydi — bu tsex boshlig'ining ishi
  const u = await newUnit();
  assert.equal((await dir('POST', '/api/units/move',
    { items: [{ unit_id: u.id }] })).status, 403);
  assert.equal((await dir('POST', '/api/units/handover',
    { items: [u.id] })).status, 403);

  //  Sahifa qaysi huquq bilan ochilishi klientda (`public/app.js`,
  //  `production.entry` yoki `production.reports`), shuning uchun shu
  //  yerda huquqlarning o'zi tekshiriladi.
  const huquq = async (api) => (await api('GET', '/api/auth/me')).body.permissions;
  assert.ok((await huquq(dir)).includes('production.reports'),
    'direktorda hisobot huquqi bor — sahifa unga ochiladi');

  // Savdoda esa yo'q: zavod bo'limlaridagi yuklama uning ishi emas
  const savdo = H.api(base, await H.sessionFor('Sinov sotuvchi'));
  const s = await huquq(savdo);
  assert.ok(!s.includes('production.reports') && !s.includes('production.entry'),
    'savdoga bo\'limlar ekrani ochilmaydi');
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

  //  Tur bo'yicha filtr BIR NECHTASINI qabul qiladi: «penal va kamod
  //  nechta qoldi» degan savol zavodda bitta turnikidan ko'proq beriladi.
  const STUL = (await H.id(`SELECT id FROM products WHERE sku='STU-LAURA'`)).id;
  assert.equal((await admin('POST', '/api/units/', { items: [
    { product_id: STUL, qty: 9, color: 'Oq', is_opening: true,
      fg_on: '2026-09-03', warehouse_code: 'VITR-ARCA' },
  ] })).status, 200);

  const jami = async (q) => (await admin(
    'GET', '/api/warehouse/fg/summary?w=VITR-ARCA' + q)).body.total;
  assert.equal((await jami('')).units, 2, 'ikkalasi ham omborda');
  assert.equal((await jami('&product_type=Penal')).qty, 2);
  assert.equal((await jami('&product_type=Stul')).qty, 9);
  assert.equal((await jami('&product_type=Penal,Stul')).units, 2, 'ikkitasi birdan');
  assert.equal((await jami('&product_type=Penal,Stul')).qty, 11);

  // Tanlov ro'yxati shu omborda TURGANLARIDAN tuziladi, qoldig'i bilan
  const f = (await admin('GET', '/api/warehouse/fg/summary?w=VITR-ARCA')).body.facets;
  assert.deepEqual(f, [{ product_type: 'Penal', qty: 2 },
                       { product_type: 'Stul', qty: 9 }]);

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

test('vitrina sotuvchisi o\'z nuqtasini va T/M omborni ko\'radi', async () => {
  const { db } = require('../db');
  const ABU = (await H.id(`SELECT id FROM warehouses WHERE code='VITR-ABU'`)).id;
  await db.query(`INSERT INTO workers (name) VALUES ('Abu-Saxiy sotuvchisi')
                  ON CONFLICT DO NOTHING`);
  await db.query(`INSERT INTO worker_roles (worker_id, role_code, scope_warehouse_id)
                  SELECT id, 'sotuvchi', $1 FROM workers WHERE name='Abu-Saxiy sotuvchisi'
                  ON CONFLICT (worker_id, role_code)
                  DO UPDATE SET scope_warehouse_id = $1`, [ABU]);
  const shou = H.api(base, await H.sessionFor('Abu-Saxiy sotuvchisi'));

  // Har omborga bittadan mahsulot
  const qoy = async (kod, rang) => (await admin('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 2, color: rang, is_opening: true,
      fg_on: '2026-09-06', warehouse_code: kod },
  ] })).body.created[0];
  const uAbu = await qoy('VITR-ABU', 'Abu-rang');
  await qoy('VITR-PALMA', 'Palma-rang');
  await qoy('TM', 'TM-rang');

  // Ro'yxatda faqat o'z nuqtasi va T/M ombor
  const kodlar = (await shou('GET', '/api/warehouse/list')).body.rows.map((w) => w.code);
  assert.deepEqual(kodlar.sort(), ['TM', 'VITR-ABU'],
    'boshqa vitrinalar ham, xom ashyo omborlari ham ko\'rinmaydi');

  // Qoldiq: o'ziniki va T/M ombor ochiq, boshqasi yo'q
  const qoldiq = async (w) => await shou('GET', `/api/warehouse/fg/summary?w=${w}`);
  assert.equal((await qoldiq('VITR-ABU')).body.total.qty, 2);
  assert.ok((await qoldiq('TM')).body.total.qty >= 2, 'zavod ombori ochiq');
  const yopiq = await qoldiq('VITR-PALMA');
  assert.equal(yopiq.status, 400);
  assert.match(yopiq.body.error, /topilmadi/);

  // Konverlar ro'yxati va Excel ham shu chegarada
  assert.equal((await shou(
    'GET', `/api/warehouse/fg/units?w=VITR-PALMA&product_id=${PENAL}&color=Palma-rang`
  )).status, 400);
  const excel = await shou('GET', '/api/units/stock?w=VITR-PALMA');
  assert.equal(excel.status, 200);
  assert.equal(excel.body.rows.length, 0, 'ko\'rmaydigan ombor bo\'sh chiqadi');

  // Ishlab chiqarish jurnali OCHIQ — chegara omborniki, jurnalniki emas
  assert.equal((await shou('GET', '/api/units/')).status, 200);

  // Buyurtma yozadi, lekin faqat ko'rinadigan ombordan biriktiradi
  assert.equal((await admin('POST', '/api/units/customers', { items: [
    { name: 'Vitrina mijozi' }] })).status, 200);
  const mijoz = (await H.id(`SELECT id FROM customers WHERE name='Vitrina mijozi'`)).id;
  const z = (await shou('POST', '/api/sales/orders', { customer_id: mijoz,
    items: [{ product_id: PENAL, qty: 2 }] })).body;
  assert.ok(z.id, JSON.stringify(z));
  const qator = (await shou('GET', '/api/sales/orders/' + z.id)).body.items[0];

  //  ★ VITRINA SAVDOGA TAKLIF QILINMAYDI — o'z nuqtasiniki ham.
  //  Do'kondagi mahsulot o'sha yerda sotiladi; buyurtmaga faqat T/M
  //  ombordagi va ishlab chiqarishdagi konver olinadi (zavod qarori).
  const nomzod = (await shou('GET',
    `/api/sales/orders/${z.id}/candidates?item_id=${qator.id}`)).body.rows;
  const ranglar = nomzod.filter((u) => u.status === 'fg').map((u) => u.color);
  assert.ok(ranglar.includes('TM-rang'), ranglar.join(','));
  assert.ok(!ranglar.includes('Abu-rang'), 'vitrina taklif qilinmaydi');
  assert.ok(!ranglar.includes('Palma-rang'), 'boshqa nuqtadagi ham');

  // To'g'ridan-to'g'ri id yuborsa ham qabul qilinmaydi — ikkala vitrina ham
  for (const rang of ['Palma-rang', 'Abu-rang']) {
    const v = (await H.id(
      `SELECT id FROM production_units WHERE color = $1`, [rang])).id;
    const xato = await shou('POST', `/api/sales/orders/${z.id}/assign`,
      { item_id: qator.id, unit_id: v });
    assert.equal(xato.status, 400, rang);
    assert.match(xato.body.error, /vitrinadagi/);
  }

  //  T/M ombordagisi esa biriktiriladi
  const tm = (await H.id(
    `SELECT id FROM production_units WHERE color = 'TM-rang'`)).id;
  assert.equal((await shou('POST', `/api/sales/orders/${z.id}/assign`,
    { item_id: qator.id, unit_id: tm, qty: 1 })).status, 200);

  //  Qator kataklari shu qoldiqdan quriladi: vitrina bu yerda ham yo'q
  const savdoQoldiq = (await shou('GET', '/api/sales/stock')).body.rows;
  assert.ok(savdoQoldiq.some((r) => r.color === 'TM-rang'), 'T/M ombor ko\'rinadi');
  assert.ok(!savdoQoldiq.some((r) => ['Abu-rang', 'Palma-rang'].includes(r.color)),
    'vitrina qoldig\'i savdo ro\'yxatida yo\'q');
  assert.ok(savdoQoldiq.every((r) => r.product_type && r.product && r.free > 0));

  // Doirasi yo'q sotuvchi hammasini ko'radi
  const bosh = H.api(base, await H.sessionFor('Sinov sotuvchi'));
  const hammasi = (await bosh('GET', '/api/warehouse/list')).body.rows.map((w) => w.code);
  assert.ok(hammasi.includes('VITR-PALMA'), hammasi.join(','));
});

// ═══════════════════════════════════════════════════════════════════ SAVDO
test('konver bo\'linmaydi — ustiga bron qo\'yiladi, bir nechta mijozdan', async () => {
  const STUL = (await H.id(`SELECT id FROM products WHERE sku='STU-LAURA'`)).id;

  // Ombordagi 10 talik stul
  const u = (await admin('POST', '/api/units/', { items: [
    { product_id: STUL, qty: 10, color: 'Oq', unit_price: 55,
      is_opening: true, fg_on: '2026-09-01' },
  ] })).body.created[0];

  const mijoz = (await H.id(`SELECT id FROM customers WHERE name='Kanalsiz mijoz'`)).id;
  const zakaz = async (qty) => {
    const r = await admin('POST', '/api/sales/orders',
      { customer_id: mijoz, items: [{ product_id: STUL, qty, unit_price: 55 }] });
    assert.equal(r.status, 200, r.text);
    const o = (await admin('GET', '/api/sales/orders/' + r.body.id)).body;
    return { id: r.body.id, no: r.body.order_no, item: o.items[0].id };
  };
  const z1 = await zakaz(6);
  const z2 = await zakaz(4);

  // 6 tasi birinchi buyurtmaga
  assert.equal((await admin('POST', `/api/sales/orders/${z1.id}/assign`,
    { item_id: z1.item, unit_id: u.id, qty: 6 })).status, 200);

  // KONVER BO'LINMADI: bitta qator, soni o'zgarmadi
  const qatorlar = (await require('../db').db.query(
    `SELECT qty FROM production_units WHERE conveyor_no = $1`, [u.conveyor_no])).rows;
  assert.deepEqual(qatorlar.map((x) => x.qty), [10], 'bitta qator bo\'lib qoldi');

  // Bron ro'yxati: jurnalda qator ochilganda shu chiqadi
  let bron = (await admin('GET', `/api/units/${u.id}/bron`)).body;
  assert.equal(bron.reserved, 6);
  assert.equal(bron.free, 4);
  assert.equal(bron.rows.length, 1);
  assert.equal(bron.rows[0].order_no, z1.no);
  assert.equal(bron.rows[0].qty, 6);

  // Bitta bron bo'lsa konverga mijoz va zakaz raqami yoziladi —
  // jurnalda tsex boshlig'i kimga ketayotganini ko'radi
  let konver = await H.id(
    `SELECT order_no, customer_id FROM production_units WHERE id = $1`, [u.id]);
  assert.equal(konver.order_no, z1.no);
  assert.equal(konver.customer_id, mijoz);

  // Qolgan 4 tasini boshqa buyurtma oladi
  assert.equal((await admin('POST', `/api/sales/orders/${z2.id}/assign`,
    { item_id: z2.item, unit_id: u.id, qty: 4 })).status, 200);
  bron = (await admin('GET', `/api/units/${u.id}/bron`)).body;
  assert.equal(bron.reserved, 10);
  assert.equal(bron.free, 0);
  assert.deepEqual(bron.rows.map((r) => r.qty), [6, 4]);

  // Ikki mijoz bo'lsa konverda bittasi yozilmaydi — ro'yxat qatorda turadi
  konver = await H.id(
    `SELECT order_no, customer_id FROM production_units WHERE id = $1`, [u.id]);
  assert.equal(konver.order_no, null);
  assert.equal(konver.customer_id, null);

  // Bo'sh dona qolmadi: konver endi nomzodlar ro'yxatida chiqmaydi
  const z3 = await zakaz(1);
  const nomzod = (await admin('GET',
    `/api/sales/orders/${z3.id}/candidates?item_id=${z3.item}`)).body.rows;
  assert.ok(!nomzod.some((x) => x.id === u.id), 'to\'lgan konver taklif qilinmaydi');

  // Qo'lda yuborsa ham olinmaydi
  const kop = await admin('POST', `/api/sales/orders/${z3.id}/assign`,
    { item_id: z3.item, unit_id: u.id, qty: 1 });
  assert.equal(kop.status, 400);
  assert.match(kop.body.error, /bo'sh 0 ta/);

  // Buyurtma to'ldi
  const o1 = (await admin('GET', '/api/sales/orders/' + z1.id)).body;
  assert.equal(Number(o1.items[0].assigned_qty), 6);
  assert.equal(o1.order.status, 'reserved');
  assert.equal(o1.order.is_ready, true);
  assert.equal(o1.units.length, 1);
  assert.equal(o1.units[0].qty, 6, 'bron soni ko\'rinadi');
  assert.equal(o1.units[0].unit_qty, 10, 'konverning o\'zi 10 ta');

  // Bron qo'yilgan konver boshqa omborga ko'chmaydi
  const mudir = H.api(base, await H.sessionFor('Sinov ombor mudiri'));
  const koch = await mudir('POST', '/api/warehouse/fg/transfer',
    { unit_id: u.id, to_code: 'VITR-ABU' });
  assert.equal(koch.status, 400);
  assert.match(koch.body.error, /buyurtmada/);

  // Bron qo'yilgan qator o'chirilmaydi, buyurtma bekor qilinmaydi
  assert.equal((await admin('PATCH', '/api/sales/orders/' + z1.id,
    { items: [] })).status, 400);
  const bekor = await admin('PATCH', '/api/sales/orders/' + z1.id,
    { status: 'cancelled' });
  assert.equal(bekor.status, 400);
  assert.match(bekor.body.error, /konverni qaytaring/);

  // Bronni olish: konver yana bo'shaydi, buyurtma "yangi" bo'ladi
  assert.equal((await admin('POST', `/api/sales/orders/${z1.id}/unassign`,
    { unit_id: u.id })).status, 200);
  bron = (await admin('GET', `/api/units/${u.id}/bron`)).body;
  assert.equal(bron.reserved, 4);
  assert.equal((await admin('GET', '/api/sales/orders/' + z1.id)).body.order.status, 'new');
  assert.equal((await H.id(
    `SELECT order_no FROM production_units WHERE id=$1`, [u.id])).order_no, z2.no,
    'bitta bron qolgach mijoz yana yoziladi');
});

test('ishlab chiqarishdagi konverga ham bron qo\'yiladi', async () => {
  const ish = (await admin('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 8, color: 'Venge', section_id: ARRA },
  ] })).body.created[0];

  const mijoz = (await H.id(`SELECT id FROM customers WHERE name='Kanalsiz mijoz'`)).id;
  const z = (await admin('POST', '/api/sales/orders', { customer_id: mijoz,
    items: [{ product_id: PENAL, qty: 3, color: 'Venge' }] })).body;
  const qator = (await admin('GET', '/api/sales/orders/' + z.id)).body.items[0];

  // Hali yo'lda bo'lsa ham nomzodlar ro'yxatida turadi — qayerdaligi bilan
  const nomzod = (await admin('GET',
    `/api/sales/orders/${z.id}/candidates?item_id=${qator.id}`)).body.rows;
  const n = nomzod.find((x) => x.id === ish.id);
  assert.ok(n, 'ishlab chiqarishdagi konver ham taklif qilinadi');
  assert.equal(n.status, 'production');
  assert.equal(n.section, 'Arra');
  assert.equal(n.free_qty, 8);

  assert.equal((await admin('POST', `/api/sales/orders/${z.id}/assign`,
    { item_id: qator.id, unit_id: ish.id, qty: 3 })).status, 200);

  // Konver ishlab chiqarishda qoldi va BO'LINMADI — marshrut bo'ylab
  // birga yuradi, jurnalda bitta qator
  const holat = await H.id(
    `SELECT status, qty, current_section_id FROM production_units WHERE id=$1`, [ish.id]);
  assert.deepEqual([holat.status, holat.qty, holat.current_section_id],
                   ['production', 8, ARRA]);
  assert.equal((await admin('GET', `/api/units/${ish.id}/bron`)).body.reserved, 3);

  // Jurnalda hamon bitta qator
  const j = (await admin('GET', '/api/units/?conveyor_no=' + ish.conveyor_no)).body;
  assert.equal(j.length, 1);

  // Bron konverni qimirlatmaydi: keyingi bo'limga o'tkazish ishlayveradi
  assert.equal((await admin('POST', '/api/units/move',
    { items: [{ unit_id: ish.id }] })).status, 200);
  assert.equal((await admin('GET', `/api/units/${ish.id}/bron`)).body.reserved, 3,
    'o\'tkazilgach ham bron joyida');

  // Bekor qilingan konverga bron qo'yilmaydi
  const bekor = (await admin('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 1, section_id: ARRA } ] })).body.created[0];
  assert.equal((await admin('PATCH', '/api/units/' + bekor.id,
    { status: 'cancelled' })).status, 200);
  const xato = await admin('POST', `/api/sales/orders/${z.id}/assign`,
    { item_id: qator.id, unit_id: bekor.id });
  assert.equal(xato.status, 400);
  assert.match(xato.body.error, /bekor qilingan/);
});

test('buyurtmada jo\'natish tafsilotlari va mijoz balansi', async () => {
  const mijoz = (await H.id(`SELECT id FROM customers WHERE name='Kanalsiz mijoz'`)).id;

  // Manzil talab qiladigan yo'l manzilsiz saqlanmaydi
  const yoq = await admin('POST', '/api/sales/orders',
    { customer_id: mijoz, ship_to: 'UY', items: [] });
  assert.equal(yoq.status, 400);
  assert.match(yoq.body.error, /manzil kerak/);

  // Zavodga kirsa manzil so'ralmaydi
  const ok = await admin('POST', '/api/sales/orders', {
    customer_id: mijoz, ship_to: 'ZAVOD', receiver_phone: '+998901234567',
    ordered_on: '2026-09-10', due_on: '2026-10-01', items: [] });
  assert.equal(ok.status, 200, ok.text);
  const o = (await admin('GET', '/api/sales/orders/' + ok.body.id)).body.order;
  assert.equal(o.ship_to, 'ZAVOD');
  assert.equal(o.ship_to_name, 'Avtomobil zavodga kiradi');
  assert.equal(o.receiver_phone, '+998901234567');
  assert.equal(String(o.ordered_on).slice(0, 10), '2026-09-10');
  assert.equal(String(o.due_on).slice(0, 10), '2026-10-01');

  //  Rang va mato ro'yxati: buyurtma yozayotganda zavodda ishlatilgani
  //  taklif qilinadi, «Venge» va «venga» deb ikki xil yozilmasin.
  const sg = (await admin('GET', '/api/sales/suggest')).body;
  assert.ok(sg.colors.includes('Oq'), sg.colors.join(','));
  assert.ok(sg.fabrics.some((f) => /Velvet/.test(f)), sg.fabrics.join(','));
  assert.ok(!sg.colors.includes(null) && !sg.colors.includes(''),
    'bo\'sh qiymat ro\'yxatga tushmaydi');

  // Ro'yxat ham keladi
  const d = (await admin('GET', '/api/sales/destinations')).body.rows;
  assert.deepEqual(d.map((x) => x.code), ['ZAVOD', 'TERMINAL', 'UY', 'DOKON']);
  assert.equal(d.find((x) => x.code === 'ZAVOD').needs_address, false);
  assert.equal(d.find((x) => x.code === 'UY').needs_address, true);

  //  BALANS: qarzga faqat CHIQIB KETGAN mahsulot qo'shiladi. Buyurtma
  //  yozilgani ham, bron qo'yilgani ham hali qarz emas.
  const balans = async () => (await admin('GET', '/api/units/customers'))
    .body.customers.find((c) => c.id === mijoz);
  const oldin = await balans();
  assert.equal(Number(oldin.shipped_amount), 0);
  assert.equal(Number(oldin.balance), Number(oldin.opening_debt || 0));

  // Mijozga chiqib ketgan konver qarzga qo'shiladi
  const u = (await admin('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 2, unit_price: 500, is_opening: true,
      fg_on: '2026-09-01', customer_id: mijoz },
  ] })).body.created[0];
  await require('../db').db.query(
    `UPDATE production_units SET status='shipped', ship_on=CURRENT_DATE WHERE id=$1`,
    [u.id]);
  const keyin = await balans();
  assert.equal(Number(keyin.shipped_amount), 1000);
  assert.equal(Number(keyin.balance), Number(oldin.opening_debt || 0) + 1000);
});

test('omborga xato kiritilgan soni to\'g\'rilanadi', async () => {
  //  2 talik mahsulot 4 ta bo'lib kiritilgan
  const u = (await admin('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 4, color: 'Moki', unit_price: 100,
      is_opening: true, fg_on: '2026-09-07' },
  ] })).body.created[0];
  const qoldiq = async () => (await admin(
    'GET', '/api/warehouse/fg/summary?q=Moki')).body.total;
  assert.equal((await qoldiq()).qty, 4);

  // To'g'rilash: qoldiq ham, summa ham darrov o'zgaradi
  assert.equal((await admin('PATCH', '/api/units/' + u.id, { qty: 2 })).status, 200);
  const t = await qoldiq();
  assert.equal(t.qty, 2);
  assert.equal(Number(t.amount), 200, 'summa yangi soni bilan');
  assert.equal((await H.id(`SELECT qty FROM fg_stock WHERE product_id=$1`,
    [PENAL])).qty >= 0, true);

  // Bron qo'yilgan donadan kam qilib bo'lmaydi
  const mijoz = (await H.id(`SELECT id FROM customers WHERE name='Kanalsiz mijoz'`)).id;
  const z = (await admin('POST', '/api/sales/orders', { customer_id: mijoz,
    items: [{ product_id: PENAL, qty: 2, color: 'Moki' }] })).body;
  const qator = (await admin('GET', '/api/sales/orders/' + z.id)).body.items[0];
  assert.equal((await admin('POST', `/api/sales/orders/${z.id}/assign`,
    { item_id: qator.id, unit_id: u.id, qty: 2 })).status, 200);

  const kam = await admin('PATCH', '/api/units/' + u.id, { qty: 1 });
  assert.equal(kam.status, 400);
  assert.match(kam.body.error, /buyurtmada/);
  assert.equal((await qoldiq()).qty, 2, 'soni o\'zgarmadi');

  // Ko'paytirish ishlayveradi
  assert.equal((await admin('PATCH', '/api/units/' + u.id, { qty: 5 })).status, 200);
  assert.equal((await qoldiq()).qty, 5);

  // Soni — tarixga tegadigan maydon: ombor mudiri o'zgartira olmaydi
  const mudir = H.api(base, await H.sessionFor('Sinov ombor mudiri'));
  assert.equal((await mudir('PATCH', '/api/units/' + u.id, { qty: 3 })).status, 403);
});

test('noto\'g\'ri kiritilgan konver ombordan bekor qilinadi', async () => {
  const u = (await admin('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 3, color: 'Xato', unit_price: 100,
      is_opening: true, fg_on: '2026-09-08' },
  ] })).body.created[0];
  const qoldiq = async () => (await admin(
    'GET', '/api/warehouse/fg/summary?q=Xato')).body.total;
  assert.equal((await qoldiq()).qty, 3);
  const stock = async () => Number((await H.id(
    `SELECT qty FROM fg_stock WHERE product_id = $1`, [PENAL])).qty);
  const oldin = await stock();

  //  Bronda turgani bekor qilinmaydi — mijozga va'da qilingan mahsulot
  //  jimgina yo'qolib qolardi.
  const mijoz = (await H.id(`SELECT id FROM customers WHERE name='Kanalsiz mijoz'`)).id;
  const z = (await admin('POST', '/api/sales/orders', { customer_id: mijoz,
    items: [{ product_id: PENAL, qty: 3, color: 'Xato' }] })).body;
  const qator = (await admin('GET', '/api/sales/orders/' + z.id)).body.items[0];
  assert.equal((await admin('POST', `/api/sales/orders/${z.id}/assign`,
    { item_id: qator.id, unit_id: u.id, qty: 3 })).status, 200);
  const band = await admin('PATCH', '/api/units/' + u.id, { status: 'cancelled' });
  assert.equal(band.status, 400);
  assert.match(band.body.error, /buyurtmada/);
  assert.equal((await qoldiq()).qty, 3, 'qoldiq o\'zgarmadi');

  // Bron olingach bekor qilinadi va qoldiqdan chiqadi
  assert.equal((await admin('POST', `/api/sales/orders/${z.id}/unassign`,
    { item_id: qator.id, unit_id: u.id })).status, 200);
  assert.equal((await admin('PATCH', '/api/units/' + u.id,
    { status: 'cancelled' })).status, 200);
  assert.equal((await qoldiq()).qty, 0);
  //  Jamlanma jadval ham: hisobot bekor qilingan konverni sanamasin
  assert.equal(await stock(), oldin - 3);

  // Chiqib ketgan konver bekor qilinmaydi — u mijozda va balansida
  const ketgan = (await admin('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 1, unit_price: 100, is_opening: true,
      fg_on: '2026-09-08' },
  ] })).body.created[0];
  await H.id(`UPDATE production_units SET status='shipped' WHERE id=$1`, [ketgan.id]);
  const yoq = await admin('PATCH', '/api/units/' + ketgan.id, { status: 'cancelled' });
  assert.equal(yoq.status, 400);
  assert.match(yoq.body.error, /chiqib ketgan/);

  // Ombor mudirining ishi emas — tarixga tegadi
  const mudir = H.api(base, await H.sessionFor('Sinov ombor mudiri'));
  assert.equal((await mudir('PATCH', '/api/units/' + u.id,
    { status: 'cancelled' })).status, 403);
});

//  ── OMBORDA YO'Q MAHSULOT: eng yaqin konver va «Kutmoqda» ─────────────
//
//  Menejer avval T/M ombordan sotadi; omborda yo'q bo'lsa qatorni baribir
//  yozadi va bron ishlab chiqarishdagi konverga qo'yiladi — OMBORGA ENG
//  YAQINIGA. Buyurtma bitta nakladnoy bo'lib qoladi, holati «kutmoqda».
test('omborda yo\'q mahsulot ishlab chiqarishdan bron qilinadi', async () => {
  const STOL = (await H.id(`SELECT id FROM products WHERE sku LIKE 'STL-%' LIMIT 1`)).id;

  //  Uchta konver yo'lda: rejalari har xil. Eng yaqini — 12-oktabr.
  const kech = (await admin('POST', '/api/units/', { items: [
    { product_id: STOL, qty: 3, color: 'Shabnam', section_id: ARRA,
      fg_planned_on: '2026-12-20' }] })).body.created[0];
  const erta = (await admin('POST', '/api/units/', { items: [
    { product_id: STOL, qty: 3, color: 'Shabnam', section_id: ARRA,
      fg_planned_on: '2026-10-12' }] })).body.created[0];

  //  Qator ro'yxati uch manbadan: bu mahsulot T/M omborda YO'Q, lekin
  //  ishlab chiqarishda bor — shuning uchun qatorga yozib bo'ladi.
  const qoldiq = (await admin('GET', '/api/sales/stock')).body.rows;
  assert.ok(!qoldiq.some((r) => r.product_id === STOL && r.src === 'fg'),
    'T/M omborda yo\'q');
  assert.ok(qoldiq.some((r) => r.product_id === STOL && r.src === 'production'),
    'ishlab chiqarishda bor');

  const mijoz = (await H.id(`SELECT id FROM customers WHERE name='Kanalsiz mijoz'`)).id;
  const z = (await admin('POST', '/api/sales/orders', { customer_id: mijoz,
    items: [{ product_id: STOL, qty: 3, color: 'Shabnam', unit_price: 100 }] })).body;
  const qator = (await admin('GET', '/api/sales/orders/' + z.id)).body.items[0];

  //  Nomzodlar: omborga eng yaqini tepada va sanasi bilan
  const n = (await admin('GET',
    `/api/sales/orders/${z.id}/candidates?item_id=${qator.id}`)).body.rows;
  assert.equal(n[0].id, erta.id, 'omborga eng yaqin konver birinchi');
  assert.equal(String(n[0].eta).slice(0, 10), '2026-10-12');
  assert.equal(n[0].eta_src, 'reja');
  assert.ok(n.some((u) => u.id === kech.id), 'keyingisi ham ro\'yxatda');

  assert.equal((await admin('POST', `/api/sales/orders/${z.id}/assign`,
    { item_id: qator.id, unit_id: erta.id, qty: 3 })).status, 200);

  //  Buyurtma KUTMOQDA: bron to'liq, lekin mahsulot hali omborda emas
  const o = (await admin('GET', '/api/sales/orders/' + z.id)).body.order;
  assert.equal(o.status, 'reserved');
  assert.equal(Number(o.assigned_qty), 3);
  assert.equal(Number(o.in_warehouse_qty), 0, 'hali omborga kelmagan');

  const kutmoqda = (await admin('GET', '/api/sales/orders?status=waiting')).body.rows;
  assert.ok(kutmoqda.some((x) => x.id === z.id), 'kutmoqda filtri');

  //  Bron qilingan konver yonida omborga tushish sanasi turadi
  const u = (await admin('GET', '/api/sales/orders/' + z.id)).body.units[0];
  assert.equal(String(u.eta).slice(0, 10), '2026-10-12');

  //  Omborga kelgach ro'yxatdan chiqadi — «kutmoqda» saqlanmaydi,
  //  har safar bronlardan hisoblanadi.
  assert.equal((await admin('POST', `/api/units/${erta.id}/to-warehouse`,
    { warehouse_code: 'TM' })).status, 200);
  const keyin = (await admin('GET', '/api/sales/orders?status=waiting')).body.rows;
  assert.ok(!keyin.some((x) => x.id === z.id), 'omborga keldi — endi kutilmaydi');
  const o2 = (await admin('GET', '/api/sales/orders/' + z.id)).body.order;
  assert.equal(Number(o2.in_warehouse_qty), 3);
});

//  ── ZAHIRAGA RANG BUYURTMA QILINADI ──────────────────────────────────
//
//  Zahira kutish bo'limida rangsiz turadi: mijoz aytgan rangga bo'yaladi.
//  Shuning uchun qator ro'yxatida u alohida manba (`stock`) bo'lib
//  keladi va unga istalgan rang buyurtma qilinadi.
test('zahira alohida manba bo\'lib chiqadi', async () => {
  const HOLD = (await H.id(
    `SELECT id FROM sections WHERE is_hold ORDER BY id LIMIT 1`)).id;
  const z = (await admin('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 6, section_id: HOLD, is_stock: true }] })).body.created[0];

  const rows = (await admin('GET', '/api/sales/stock')).body.rows;
  const zahira = rows.filter((r) => r.src === 'stock');
  assert.ok(zahira.some((r) => r.product_id === PENAL), 'zahira ro\'yxatda');
  assert.ok(zahira.every((r) => r.free > 0));

  //  Uch manba ham o'z nomi bilan keladi va T/M ombor birinchi turadi
  assert.deepEqual([...new Set(rows.map((r) => r.src))].slice(0, 1), ['fg']);
  assert.ok(rows.some((r) => r.src === 'production'));

  //  Rangsiz zahiraga rang yozib buyurtma beriladi — konver o'zi
  //  qimirlamaydi, bron ustiga qo'yiladi.
  const mijoz = (await H.id(`SELECT id FROM customers WHERE name='Kanalsiz mijoz'`)).id;
  const o = (await admin('POST', '/api/sales/orders', { customer_id: mijoz,
    items: [{ product_id: PENAL, qty: 2, color: 'Pistoq', unit_price: 100 }] })).body;
  const qator = (await admin('GET', '/api/sales/orders/' + o.id)).body.items[0];
  assert.equal((await admin('POST', `/api/sales/orders/${o.id}/assign`,
    { item_id: qator.id, unit_id: z.id, qty: 2 })).status, 200);
  const u = (await admin('GET', '/api/sales/orders/' + o.id)).body.units[0];
  assert.equal(u.is_stock, true);
  assert.equal(u.qty, 2, 'konver bo\'linmaydi — bron 2 ta');
});

//  ── ZAKAZ RAQAMI QO'LDA ──────────────────────────────────────────────
test('zakaz raqami qo\'lda qo\'yiladi va konverga ham ko\'chadi', async () => {
  const mijoz = (await H.id(`SELECT id FROM customers WHERE name='Kanalsiz mijoz'`)).id;
  const o = (await admin('POST', '/api/sales/orders',
    { customer_id: mijoz, order_no: '  ZV-77 ', items: [] })).body;
  assert.equal(o.order_no, 'ZV-77', 'bo\'sh joylar tozalanadi');

  //  Takrorlanmaydi
  const bor = await admin('POST', '/api/sales/orders',
    { customer_id: mijoz, order_no: 'ZV-77', items: [] });
  assert.equal(bor.status, 400);
  assert.match(bor.body.error, /allaqachon bor/);

  //  Bo'sh qoldirilsa tizim beradi
  const avto = (await admin('POST', '/api/sales/orders',
    { customer_id: mijoz, items: [] })).body;
  assert.match(avto.order_no, /^Z\d\d-\d{4}$/);

  //  Raqam o'zgarsa konverdagi zakaz raqami ham ko'chadi
  const u = (await admin('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 1, color: 'Zakaz', unit_price: 50,
      is_opening: true, fg_on: '2026-09-03' }] })).body.created[0];
  const q2 = (await admin('POST', '/api/sales/orders', { customer_id: mijoz,
    items: [{ product_id: PENAL, qty: 1, color: 'Zakaz' }] })).body;
  const qator = (await admin('GET', '/api/sales/orders/' + q2.id)).body.items[0];
  await admin('POST', `/api/sales/orders/${q2.id}/assign`,
    { item_id: qator.id, unit_id: u.id, qty: 1 });
  assert.equal((await H.id(
    `SELECT order_no FROM production_units WHERE id = $1`, [u.id])).order_no,
    q2.order_no);

  assert.equal((await admin('PATCH', '/api/sales/orders/' + q2.id,
    { order_no: 'ZV-101' })).status, 200);
  assert.equal((await H.id(
    `SELECT order_no FROM production_units WHERE id = $1`, [u.id])).order_no,
    'ZV-101', 'konverdagi raqam ham ko\'chdi');
});

//  ── T/M OMBOR QOLDIG'I: jami · bronda · bo'sh ────────────────────────
//
//  Ombor mudiri mahsulotni SANAYDI, pulni emas. Bronda turgan mahsulot
//  hali chiqib ketmagan — u javonda turibdi, shuning uchun «Soni» dan
//  ayrilmaydi: inventarizatsiyada sanaladigan raqam o'sha.
test('ombor qoldig\'i jami, bronda va bo\'sh bo\'lib chiqadi', async () => {
  const u = (await admin('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 10, color: 'Sanoq', unit_price: 70,
      is_opening: true, fg_on: '2026-09-04' }] })).body.created[0];
  const qoldiq = async () => (await admin(
    'GET', '/api/warehouse/fg/summary?q=Sanoq')).body;

  let d = await qoldiq();
  assert.equal(d.total.qty, 10);
  assert.equal(d.total.bron, 0);
  assert.equal(d.total.free, 10);
  assert.equal(d.rows[0].qty, 10);
  assert.equal(d.rows[0].free, 10);

  //  Buyurtma urildi: 4 tasi bronga olindi
  const mijoz = (await H.id(`SELECT id FROM customers WHERE name='Kanalsiz mijoz'`)).id;
  const z = (await admin('POST', '/api/sales/orders', { customer_id: mijoz,
    items: [{ product_id: PENAL, qty: 4, color: 'Sanoq' }] })).body;
  const qator = (await admin('GET', '/api/sales/orders/' + z.id)).body.items[0];
  assert.equal((await admin('POST', `/api/sales/orders/${z.id}/assign`,
    { item_id: qator.id, unit_id: u.id, qty: 4 })).status, 200);

  d = await qoldiq();
  assert.equal(d.total.qty, 10, 'bronda turgani ham omborda — sanoq o\'zgarmaydi');
  assert.equal(d.total.bron, 4);
  assert.equal(d.total.free, 6, 'broni ayirilgan qoldiq');
  assert.equal(d.rows[0].bron, 4);
  assert.equal(d.rows[0].free, 6);
  //  O'lchov birligi bo'yicha ham: dona bilan komplekt qo'shilmaydi
  const uom = d.total.by_uom.find((x) => x.qty === 10);
  assert.equal(uom.bron, 4);
  assert.equal(uom.free, 6);
});

//  ── YUK XATIDA CHIQARIB YUBORUVCHI ───────────────────────────────────
//
//  Hujjat mahsulot berilayotganda chop etiladi, tasdiq esa keyin
//  bosiladi — shuning uchun tasdiqlanmagan buyurtmada ham ombor
//  mudirining ismi va telefoni turadi.
test('yuk xatida ombor mudiri ko\'rsatiladi', async () => {
  await H.id(`UPDATE workers SET phone = '+998900000001'
               WHERE name = 'Sinov ombor mudiri'`);
  //  O'z mijozi bilan: bu buyurtma chiqib ketadi va boshqa testning
  //  qarzdorlik hisobiga qo'shilib ketmasin.
  await admin('POST', '/api/units/customers', { items: [{ name: 'Xujjat mijozi' }] });
  const mijoz = (await H.id(`SELECT id FROM customers WHERE name='Xujjat mijozi'`)).id;
  const z = (await admin('POST', '/api/sales/orders', { customer_id: mijoz,
    ship_to: 'ZAVOD',
    items: [{ product_id: PENAL, qty: 1, color: 'Xujjat', unit_price: 90 }] })).body;

  //  Hali hech kim chiqarmagan — lekin mudir bitta, ismi hujjatda
  const d = (await admin('GET', '/api/sales/orders/' + z.id)).body;
  assert.equal(d.order.shipped_by_name, null, 'hali tasdiqlanmagan');
  assert.equal(d.keeper.name, 'Sinov ombor mudiri');
  assert.equal(d.keeper.phone, '+998900000001');

  //  Chiqarib yuborilgach — aynan tasdiqlagan odam
  const u = (await admin('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 1, color: 'Xujjat', unit_price: 90,
      is_opening: true, fg_on: '2026-09-05' }] })).body.created[0];
  const qator = (await admin('GET', '/api/sales/orders/' + z.id)).body.items[0];
  await admin('POST', `/api/sales/orders/${z.id}/assign`,
    { item_id: qator.id, unit_id: u.id, qty: 1 });
  await admin('POST', `/api/sales/orders/${z.id}/send`);
  const mudir = H.api(base, await H.sessionFor('Sinov ombor mudiri'));
  assert.equal((await mudir('POST', `/api/sales/orders/${z.id}/ship`,
    { ship_on: '2026-10-06' })).status, 200);

  const keyin = (await admin('GET', '/api/sales/orders/' + z.id)).body;
  assert.equal(keyin.order.shipped_by_name, 'Sinov ombor mudiri');
  assert.equal(keyin.order.shipped_by_phone, '+998900000001');

  //  Mudir bir nechta bo'lsa kim ekani noma'lum — hujjatda bo'sh qoladi
  await H.id(`INSERT INTO workers (name, active) VALUES ('Ikkinchi mudir', true)
              ON CONFLICT DO NOTHING`);
  await H.id(`INSERT INTO worker_roles (worker_id, role_code)
              SELECT id, 'omborchi' FROM workers WHERE name = 'Ikkinchi mudir'
              ON CONFLICT DO NOTHING`);
  assert.equal((await admin('GET', '/api/sales/orders/' + z.id)).body.keeper, null);
  await H.id(`DELETE FROM workers WHERE name = 'Ikkinchi mudir'`);
});

//  ── YUK XATINI OMBOR MUDIRI CHOP ETADI ───────────────────────────────
//
//  Mahsulotni zavoddan u chiqarib beradi: hujjatni chop etib
//  haydovchining qo'liga beradi va SHUNDAN KEYIN tasdiqlaydi. Uning
//  savdo huquqi yo'q, shuning uchun buyurtma oynasi yopiq bo'lsa ham
//  hujjat ochiq bo'lishi kerak.
test('yuk xatini ombor mudiri buyurtma oynasisiz chiqaradi', async () => {
  const mudir = H.api(base, await H.sessionFor('Sinov ombor mudiri'));
  await admin('POST', '/api/units/customers', { items: [{ name: 'Hujjat chop mijozi' }] });
  const mijoz = (await H.id(
    `SELECT id FROM customers WHERE name='Hujjat chop mijozi'`)).id;
  const z = (await admin('POST', '/api/sales/orders', { customer_id: mijoz,
    ship_to: 'ZAVOD',
    items: [{ product_id: PENAL, qty: 2, color: 'Chop', unit_price: 70 }] })).body;

  //  Buyurtma oynasi unga yopiq — savdo hujjatni yozadi, u emas
  assert.equal((await mudir('GET', '/api/sales/orders/' + z.id)).status, 403);

  const w = await mudir('GET', '/api/sales/waybill/' + z.id);
  assert.equal(w.status, 200, w.text);
  assert.equal(w.body.order.order_no, z.order_no);
  assert.equal(w.body.order.customer_name, 'Hujjat chop mijozi');
  assert.equal(w.body.items.length, 1);
  assert.equal(w.body.items[0].product_type, 'Penal');
  assert.equal(Number(w.body.items[0].unit_price), 70);
  //  Imzo chizig'i ustida turadigan odam — tasdiqdan oldin ham
  assert.equal(w.body.keeper.name, 'Sinov ombor mudiri');

  //  Tsex ustasiga hujjat ham yopiq: mahsulotni u chiqarmaydi
  assert.equal((await korpus('GET', '/api/sales/waybill/' + z.id)).status, 403);
  //  Yo'q buyurtma — 404, «ruxsat yo'q» emas
  assert.equal((await mudir('GET', '/api/sales/waybill/999999')).status, 404);
});

test('chiqadigan buyurtma ombor mudiriga yuboriladi va u chiqaradi', async () => {
  const mudir = H.api(base, await H.sessionFor('Sinov ombor mudiri'));
  const mijoz = (await H.id(`SELECT id FROM customers WHERE name='Kanalsiz mijoz'`)).id;

  // Biri omborda, biri hali tsexda
  const tayyor = (await admin('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 4, color: 'Sut', unit_price: 250,
      is_opening: true, fg_on: '2026-09-02' },
  ] })).body.created[0];
  const yolda = (await admin('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 2, color: 'Sut', section_id: ARRA },
  ] })).body.created[0];

  const z = (await admin('POST', '/api/sales/orders', {
    customer_id: mijoz, ship_to: 'UY', address: 'Toshkent, Navoiy 5',
    receiver_phone: '+998901110022', due_on: '2026-10-05',
    items: [{ product_id: PENAL, qty: 6, color: 'Sut', unit_price: 250 }] })).body;
  const qator = (await admin('GET', '/api/sales/orders/' + z.id)).body.items[0];
  for (const [u, n] of [[tayyor, 4], [yolda, 2]])
    assert.equal((await admin('POST', `/api/sales/orders/${z.id}/assign`,
      { item_id: qator.id, unit_id: u.id, qty: n })).status, 200);

  //  Ro'yxatning o'zida ham konverlar qayerdaligi ko'rinadi: savdo
  //  xodimi «mahsulotim qayerda» degan savolga buyurtmani ochmasdan
  //  javob beradi. Omborda turgani birinchi.
  const qator_ = (await admin('GET', '/api/sales/orders?q=' + z.order_no)).body.rows[0];
  assert.equal(qator_.places.length, 2);
  assert.equal(qator_.places[0].omborda, true);
  assert.equal(qator_.places[0].warehouse_code, 'TM');
  assert.equal(qator_.places[0].qty, 4);
  assert.equal(qator_.places[1].omborda, false);
  assert.equal(qator_.places[1].joy, 'Arra');
  assert.equal(qator_.places[1].qty, 2);

  // Ombor mudiri hali ko'rmaydi — savdo yubormagan
  assert.equal((await mudir('GET', '/api/sales/shipping')).body.rows.length, 0);

  // Omborga yuborish
  assert.equal((await admin('POST', `/api/sales/orders/${z.id}/send`,
    { })).status, 200);
  const ro = (await mudir('GET', '/api/sales/shipping')).body.rows;
  assert.equal(ro.length, 1);
  assert.equal(ro[0].order_no, z.order_no);
  assert.equal(ro[0].ship_to_name, 'Mijoz uyiga');
  assert.equal(ro[0].address, 'Toshkent, Navoiy 5');
  assert.equal(ro[0].receiver_phone, '+998901110022');
  assert.equal(ro[0].assigned_qty, 6);
  assert.equal(ro[0].in_warehouse_qty, 4, 'ikkitasi hali tsexda');
  assert.equal(ro[0].units.length, 2);

  // Yuborilgach savdo tahrirlay olmaydi
  assert.equal((await admin('PATCH', '/api/sales/orders/' + z.id,
    { note: 'tegdim' })).status, 400);

  //  Lekin KO'RA oladi: omborga yuborilgan buyurtma ichida har konver
  //  qayerda turgani chiqadi («Konverlar qayerda» kartochkasi). Ilgari
  //  savdo buning uchun ombor sahifasiga kirardi, u yerda esa faqat
  //  omborga TUSHGANI ko'rinadi — tsexdagisi topilmasdi.
  const konver = (await admin('GET', '/api/sales/orders/' + z.id)).body.units;
  const tsexda = konver.find((u) => u.conveyor_no === yolda.conveyor_no);
  assert.equal(tsexda.status, 'production');
  assert.equal(tsexda.section, 'Arra', "bo'limi yoziladi");
  assert.ok(tsexda.shop, 'tsexi ham yoziladi');
  //  Omborga tushgani esa bo'limsiz — u endi javonda, tsexda emas
  const javonda = konver.find((u) => u.conveyor_no === tayyor.conveyor_no);
  assert.equal(javonda.status, 'fg');
  assert.equal(javonda.section, null);
  assert.equal(javonda.warehouse_code, 'TM');

  // Hammasi kelmagunча chiqarib bo'lmaydi
  const erta = await mudir('POST', `/api/sales/orders/${z.id}/ship`);
  assert.equal(erta.status, 400);
  assert.match(erta.body.error, /Hali omborga kelmagan/);
  assert.match(erta.body.error, new RegExp(yolda.conveyor_no));

  // Yo'ldagini omborga kiritamiz (jurnaldan tuzatish yo'li bilan)
  assert.equal((await admin('POST', `/api/units/${yolda.id}/to-warehouse`,
    { warehouse_code: 'TM' })).status, 200);

  // Endi chiqadi. Mudir faqat chiqqan kunni qo'yadi — pul kirim
  // sanasi savdoniki va ombordan yozilmaydi.
  const r = await mudir('POST', `/api/sales/orders/${z.id}/ship`,
    { ship_on: '2026-10-04', payment_on: '2026-10-20' });
  assert.equal(r.status, 200, r.text);

  let o = (await admin('GET', '/api/sales/orders/' + z.id)).body.order;
  assert.equal(o.status, 'shipped');
  assert.equal(String(o.shipped_on).slice(0, 10), '2026-10-04');
  assert.equal(o.payment_on, null, 'ombordan yuborilgan sana yozilmaydi');
  assert.equal(o.shipped_by_name, 'Sinov ombor mudiri');

  //  Pul kirim sanasini SAVDO qo'yadi — jo'natilgandan keyin ham.
  assert.equal((await admin('PATCH', `/api/sales/orders/${z.id}/payment`,
    { payment_on: '2026-10-20' })).status, 200);
  o = (await admin('GET', '/api/sales/orders/' + z.id)).body.order;
  assert.equal(String(o.payment_on).slice(0, 10), '2026-10-20');

  // Tuzatish ham, tozalash ham mumkin
  assert.equal((await admin('PATCH', `/api/sales/orders/${z.id}/payment`,
    { payment_on: null })).status, 200);
  assert.equal((await admin('GET', '/api/sales/orders/' + z.id)).body.order.payment_on,
    null);
  assert.equal((await admin('PATCH', `/api/sales/orders/${z.id}/payment`,
    { payment_on: '2026-11-01' })).status, 200);

  // Ombor mudiri qo'ya olmaydi — bu savdoning ishi
  assert.equal((await mudir('PATCH', `/api/sales/orders/${z.id}/payment`,
    { payment_on: '2026-12-01' })).status, 403);

  // Konverlar chiqib ketdi va ombor qoldig'idan ayrildi
  const holat = await H.id(
    `SELECT status, to_char(ship_on,'YYYY-MM-DD') AS on, customer_id, order_no
       FROM production_units WHERE id = $1`, [tayyor.id]);
  assert.equal(holat.status, 'shipped');
  assert.equal(holat.on, '2026-10-04');
  assert.equal(holat.customer_id, mijoz);
  assert.equal(holat.order_no, z.order_no);
  assert.equal((await admin('GET', '/api/warehouse/fg/summary?q=Sut')).body.total.qty, 0);

  // Bron qolmadi — mahsulot chiqib ketdi, tarix `ship_on` da
  assert.equal((await admin('GET', `/api/units/${tayyor.id}/bron`)).body.reserved, 0);

  // Mijoz qarziga qo'shildi: 6 × 250. Pul kirim SANASI balansga
  // tegmaydi — sana summa emas, to'lovni kassa yozadi.
  const c = (await admin('GET', '/api/units/customers')).body.customers
    .find((x) => x.id === mijoz);
  assert.ok(Number(c.shipped_amount) >= 1500, String(c.shipped_amount));
  assert.equal(Number(c.balance),
    Number(c.opening_debt || 0) + Number(c.shipped_amount),
    'balans faqat chiqib ketgandan hisoblanadi');

  // Ro'yxatdan chiqdi, ikkinchi marta jo'natilmaydi
  assert.equal((await mudir('GET', '/api/sales/shipping')).body.rows.length, 0);
  assert.equal((await mudir('POST', `/api/sales/orders/${z.id}/ship`)).status, 400);

  // Savdo o'zi chiqarib yubora olmaydi — bu ombor mudirining ishi
  const savdo = H.api(base, await H.sessionFor('Sinov sotuvchi'));
  assert.equal((await savdo('GET', '/api/sales/shipping')).status, 403);
});

//  ── QARZDORLIK: oraliq hisoboti ────────────────────────────────────────
//  Yuqoridagi test mahsulotni 2026-10-04 da chiqarib yubordi, mijozning
//  boshlang'ich qarzi esa o'z sanasi bilan turadi. Hisobot shu ikkisini
//  oraliqqa ajratadi: boshiga + qarzdor − haqdor = oxiriga.
test('qarzdorlik oraliq bo\'yicha hisoblanadi', async () => {
  const mijoz = (await H.id(
    `SELECT id FROM customers WHERE name = 'Kanalsiz mijoz'`)).id;
  //  Boshlang'ich qarz — chiqarishdan OLDINGI sana bilan
  await H.id(`UPDATE customers SET opening_debt = 500, opening_debt_on = '2026-09-01'
               WHERE id = $1`, [mijoz]);

  const okt = (await admin('GET',
    '/api/sales/debts?from=2026-10-01&to=2026-10-31')).body;
  assert.equal(okt.from, '2026-10-01');
  const r = okt.rows.find((x) => x.id === mijoz);
  assert.ok(r, 'mijoz hisobotda');
  //  Davr boshiga — boshlang'ich qarz va undan oldin chiqib ketganlar.
  //  Shu mijozdan avvalgi testlarda ham mahsulot chiqqan, shuning uchun
  //  aniq raqam emas: boshlang'ich qarz ICHIDA ekani tekshiriladi.
  assert.ok(Number(r.opening) >= 500, String(r.opening));
  //  ★ Oktabrda chiqib ketgani: 6 × 250 = 1500 — buyurtma QATORINING
  //  narxi bo'yicha. Konverning o'zida narx yo'q edi (tsexdan kelgan
  //  ikkitasi), lekin mijoz yuk xatidagi summani to'laydi: sotilgan
  //  narx chiqarishda konverga ko'chadi (modules/sales.js).
  assert.equal(Number(r.debit), 1500, String(r.debit));
  assert.equal(Number(r.credit), 0, 'kassa yo\'q — haqdor bo\'sh');
  //  Saldo o'z TOMONIDA beriladi: qarzdor — mijozning korxonaga qarzi,
  //  haqdor — korxonaning mijozga qarzi. Bitta ishorali raqam bo'lsa
  //  jadvalni o'qigan odam qaysi biri ekanini bilmasdi.
  assert.equal(Number(r.opening_debit), Number(r.opening));
  assert.equal(Number(r.opening_credit), 0);
  assert.equal(Number(r.closing_debit), Number(r.closing));
  assert.equal(Number(r.closing_credit), 0);
  assert.equal(Number(r.closing), Number(r.opening) + Number(r.debit),
    'boshiga + qarzdor = oxiriga');

  //  Keyingi oy: chiqib ketgan mahsulot endi «boshiga» da turadi va
  //  aylanma bo'sh bo'ladi — qarz esa o'zgarmaydi.
  const noy = (await admin('GET',
    '/api/sales/debts?from=2026-11-01&to=2026-11-30')).body;
  const r2 = noy.rows.find((x) => x.id === mijoz);
  assert.equal(Number(r2.opening), Number(r.closing));
  assert.equal(Number(r2.debit), 0);
  assert.equal(Number(r2.closing), Number(r.closing));

  //  Oxiriga — `v_customer_sales.balance` bilan bir xil: ikki hisob bir
  //  narsani aytishi kerak, aks holda qaysi biri to'g'ri degan savol chiqadi.
  const c = (await admin('GET', '/api/units/customers')).body.customers
    .find((x) => x.id === mijoz);
  assert.equal(Number(r2.closing), Number(c.balance));

  //  Butun tarix: davr boshlang'ich qarz sanasidan ham oldin boshlansa
  //  «boshiga» bo'sh bo'ladi va hamma narsa aylanmaga tushadi.
  const butun = (await admin('GET',
    '/api/sales/debts?from=1900-01-01&to=2030-01-01')).body.rows
    .find((x) => x.id === mijoz);
  assert.equal(Number(butun.opening), 0);
  assert.equal(Number(butun.debit), Number(r2.closing),
    'boshlang\'ich qarz ham, chiqib ketgan mahsulot ham aylanmada');

  //  Harakatlar: qaysi konver, qaysi kun. Yugurib boradigan qoldiq
  //  sahifada shundan chiziladi.
  const tafsilot = (await admin('GET',
    `/api/sales/debts/${mijoz}?from=2026-10-01&to=2026-10-31`)).body;
  assert.equal(Number(tafsilot.opening), Number(r.opening),
    'jadval bilan tafsilot bitta raqamni aytadi');
  assert.ok(tafsilot.rows.length >= 1);
  assert.ok(tafsilot.rows.every((x) => x.conveyor_no));

  //  Yo'nalish chegarasi: eksport menejeri B2B mijozini ko'rmaydi
  const eks = H.api(base, await H.sessionFor('Eksport menejeri'));
  const hammasi = (await eks('GET',
    '/api/sales/debts?from=1900-01-01&to=2030-01-01')).body.rows;
  assert.ok(!hammasi.some((x) => x.id === mijoz), 'chegara ishlaydi');
  assert.equal((await eks('GET',
    `/api/sales/debts/${mijoz}?from=1900-01-01&to=2030-01-01`)).status, 404);

  //  Ortiqcha to'lov: saldo HAQDOR tomonga o'tadi va u yerda musbat
  //  bo'lib turadi (manfiy qarzdor emas).
  await H.id(`UPDATE customers SET opening_debt = -200 WHERE id = $1`, [mijoz]);
  const teskari = (await admin('GET',
    '/api/sales/debts?from=2026-09-02&to=2026-09-03')).body.rows
    .find((x) => x.id === mijoz);
  assert.equal(Number(teskari.opening_debit), 0);
  assert.equal(Number(teskari.opening_credit), 200);
  assert.equal(Number(teskari.closing_credit), 200);
  //  Aylanma ustunida ham minus turmaydi — u HAQDOR tomonda
  const t2 = (await admin('GET',
    '/api/sales/debts?from=2026-08-01&to=2026-09-30')).body.rows
    .find((x) => x.id === mijoz);
  assert.equal(Number(t2.debit) >= 0, true, String(t2.debit));
  assert.equal(Number(t2.credit), 200, 'ortiqcha to\'lov haqdor aylanmada');
  await H.id(`UPDATE customers SET opening_debt = 500 WHERE id = $1`, [mijoz]);

  //  Ombor mudirining ishi emas
  const mudir = H.api(base, await H.sessionFor('Sinov ombor mudiri'));
  assert.equal((await mudir('GET', '/api/sales/debts')).status, 403);
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

//  ── TSEX BOSHLIG'I KONVERNI KIM KUTAYOTGANINI KO'RADI ────────────────
//
//  Savdo ekrani unga yopiq, lekin «bu partiyani kim kutmoqda» degan
//  savolga javob kerak. Javob bo'limlar ekranining O'ZIDA: konver
//  yonida nechtasi buyurtmada ekani, bosilsa ostida kim va qachonga.
test('bo\'limlar ekranida konverning buyurtma soni ko\'rinadi', async () => {
  const mijoz = (await H.id(`SELECT id FROM customers WHERE name='Kanalsiz mijoz'`)).id;
  const u = (await admin('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 5, color: 'Tsex', section_id: ARRA }] })).body.created[0];
  const z = (await admin('POST', '/api/sales/orders', {
    customer_id: mijoz, ship_to: 'ZAVOD', due_on: '2026-10-15',
    items: [{ product_id: PENAL, qty: 3, color: 'Tsex', unit_price: 100 }] })).body;
  const qator = (await admin('GET', '/api/sales/orders/' + z.id)).body.items[0];
  assert.equal((await admin('POST', `/api/sales/orders/${z.id}/assign`,
    { item_id: qator.id, unit_id: u.id, qty: 3 })).status, 200);

  //  Korpus ustasining ekrani: konver uning tsexida (Arra)
  const b = await korpus('GET', '/api/units/board');
  assert.equal(b.status, 200, b.text);
  const kon = b.body.sections.flatMap((x) => x.units)
    .find((x) => x.conveyor_no === u.conveyor_no);
  assert.ok(kon, 'konver bo\'limlar ekranida turibdi');
  assert.equal(kon.qty, 5);
  assert.equal(kon.booked_qty, 3, '5 tadan 3 tasi buyurtmada');
  //  Narx yo'q: ishlab chiqarish ekranida pul turmaydi
  assert.equal(kon.unit_price, undefined);

  //  Qator bosilganda ostida chiqadigan ro'yxat
  const d = (await korpus('GET', `/api/units/${u.id}/bron`)).body;
  assert.equal(d.reserved, 3);
  assert.equal(d.free, 2);
  assert.equal(d.rows.length, 1);
  assert.equal(d.rows[0].customer_name, 'Kanalsiz mijoz');
  assert.equal(d.rows[0].qty, 3);

  //  Doira CHEGARA: boshqa tsexni so'rasa ham
  const lak = (await H.id(`SELECT id FROM shops WHERE name = 'Lak tsexi'`)).id;
  assert.equal((await korpus('GET', '/api/units/board?shop_id=' + lak)).status, 403);
  //  Boshqa tsexning konverini to'g'ridan-to'g'ri so'rasa ham
  const begona = (await H.id(
    `SELECT u.id FROM production_units u
       JOIN v_unit_register r ON r.id = u.id
       JOIN shops sh ON sh.id = r.owner_shop_id
      WHERE sh.name = 'Lak tsexi' AND u.status = 'production' LIMIT 1`));
  if (begona) assert.equal(
    (await korpus('GET', `/api/units/${begona.id}/bron`)).status, 403);
});

test('tsex ustasiga savdo yopiq', async () => {
  assert.equal((await korpus('GET', '/api/sales/orders')).status, 403);
  assert.equal((await korpus('POST', '/api/sales/orders', { customer_id: 1 })).status, 403);
});

// ══════════════════════════════════════════════════════════════ KASSA
//
//  Zavod qoidasi: pulni MENEJER oladi — mijozning qarzi o'sha zahoti
//  kamayadi, lekin pul kassaga tushmaydi. U menejerning qo'lida
//  (qo'lidagi pul) va kassir sanab olgandan keyingina kassaga qo'shiladi.
test('menejer mijozdan pul oladi, kassa esa kassir qabul qilgach to\'ladi', async () => {
  const { db } = require('../db');
  //  Kassir va menejer — haqiqiy rollar bilan, admin bilan emas:
  //  huquq to'g'ri berilganini faqat shu ko'rsatadi.
  for (const [nom, rol] of [['Sinov kassir', 'kassir'], ['Sinov menejer', 'sotuvchi']]) {
    await db.query(`INSERT INTO workers (name) SELECT $1
                     WHERE NOT EXISTS (SELECT 1 FROM workers WHERE name = $1)`, [nom]);
    await db.query(`INSERT INTO worker_roles (worker_id, role_code)
                    SELECT id, $2 FROM workers WHERE name = $1
                    ON CONFLICT DO NOTHING`, [nom, rol]);
  }
  const kassir  = H.api(base, await H.sessionFor('Sinov kassir'));
  const menejer = H.api(base, await H.sessionFor('Sinov menejer'));
  const mijoz = (await H.id(`SELECT id FROM customers WHERE name='Kanalsiz mijoz'`)).id;
  const oldin = Number((await H.id(
    `SELECT balance FROM v_customer_sales WHERE id=$1`, [mijoz])).balance);

  //  Menejerda faqat BITTA yo'l: kassalar ro'yxati ham kelmaydi
  const refs = (await menejer('GET', '/api/cash/refs')).body;
  assert.equal(refs.boss, false);
  assert.equal(refs.accounts.length, 0, 'kassa qoldig\'i menejerning ishi emas');
  assert.ok(refs.customers.length);

  //  12 500 000 so'm, kurs 12 500 → 1 000 $
  const r = await menejer('POST', '/api/cash/ops', {
    from_kind: 'customer', from_id: mijoz,
    currency: 'UZS', amount: 12500000, rate: 12500, note: 'Naqd' });
  assert.equal(r.status, 200, r.text);
  assert.equal(Number(r.body.amount_usd), 1000, 'kurs bo\'yicha dollarga aylandi');

  //  Mijozning qarzi DARROV kamaydi — u to'ladi, uning oldida savol yo'q
  const keyin = Number((await H.id(
    `SELECT balance FROM v_customer_sales WHERE id=$1`, [mijoz])).balance);
  assert.equal(keyin, oldin - 1000);

  //  Pul esa MENEJERNING qo'lida, kassada emas
  const menejerId = (await H.id(`SELECT id FROM workers WHERE name='Sinov menejer'`)).id;
  const qolda = await H.id(`SELECT total_usd FROM v_worker_cash WHERE id=$1`, [menejerId]);
  assert.equal(Number(qolda.total_usd), 1000);
  const kassa1 = await H.id(`SELECT total_usd FROM v_cash_balance WHERE code='MAIN'`);
  assert.equal(Number(kassa1.total_usd), 0, 'kassir sanab olmaguncha kassada yo\'q');

  //  Kassir sanab oldi
  const acc = (await H.id(`SELECT id FROM cash_accounts WHERE code='MAIN'`)).id;
  const q = await kassir('POST', '/api/cash/ops', {
    from_kind: 'worker', from_id: menejerId, to_kind: 'account', to_id: acc,
    currency: 'UZS', amount: 12500000, rate: 12500 });
  assert.equal(q.status, 200, q.text);
  assert.equal(Number((await H.id(
    `SELECT total_usd FROM v_cash_balance WHERE code='MAIN'`)).total_usd), 1000);
  assert.equal(Number((await H.id(
    `SELECT total_usd FROM v_worker_cash WHERE id=$1`, [menejerId])).total_usd), 0);
  //  Mijozning qarzi ikki marta kamaymadi: pul ko'chdi, to'lov o'zgarmadi
  assert.equal(Number((await H.id(
    `SELECT balance FROM v_customer_sales WHERE id=$1`, [mijoz])).balance), oldin - 1000);
});

test('menejer boshqa operatsiya yoza olmaydi', async () => {
  const menejer = H.api(base, await H.sessionFor('Sinov menejer'));
  const acc = (await H.id(`SELECT id FROM cash_accounts WHERE code='MAIN'`)).id;
  const mijoz = (await H.id(`SELECT id FROM customers WHERE name='Kanalsiz mijoz'`)).id;
  //  Kassadan chiqim qilmoqchi — server tomonni O'ZI qo'yadi va
  //  natijada bu «mijozdan menejerga» bo'lib qoladi, kassaga tegmaydi.
  const oldin = Number((await H.id(
    `SELECT total_usd FROM v_cash_balance WHERE code='MAIN'`)).total_usd);
  await menejer('POST', '/api/cash/ops', {
    from_kind: 'account', from_id: acc, to_kind: 'expense',
    currency: 'USD', amount: 10 });
  assert.equal(Number((await H.id(
    `SELECT total_usd FROM v_cash_balance WHERE code='MAIN'`)).total_usd), oldin,
    'kassa qoldig\'i o\'zgarmadi');
  //  Bekor qilish ham unga yopiq
  const op = (await H.id(`SELECT id FROM cash_ops ORDER BY id DESC LIMIT 1`)).id;
  assert.equal((await menejer('PATCH', '/api/cash/ops/' + op)).status, 403);
  await H.id(`DELETE FROM cash_ops WHERE id=$1`, [op]);
});

//  ── HARAJAT: MODDA VA FOYDA-ZARAR OYI ────────────────────────────────
//
//  To'lov bugun ketadi, harajat esa boshqa oyniki bo'lishi mumkin:
//  sentabrda to'langan avgust ijarasi AVGUST foydasini kamaytiradi.
//  Ikkalasisiz harajat hisobotda «boshqa» bo'lib yo'qolib ketardi.
test('harajat moddasiz va oysiz yozilmaydi', async () => {
  const { db } = require('../db');
  const kassir = H.api(base, await H.sessionFor('Sinov kassir'));
  const acc = (await H.id(`SELECT id FROM cash_accounts WHERE code='MAIN'`)).id;
  await db.query(`INSERT INTO expense_groups (code, name) VALUES ('TEST','Sinov guruh')
                  ON CONFLICT DO NOTHING`);
  await db.query(`INSERT INTO expense_items (group_code, name) VALUES ('TEST','Ijara')
                  ON CONFLICT DO NOTHING`);
  const item = (await H.id(`SELECT id FROM expense_items WHERE name='Ijara'`)).id;
  const body = { from_kind: 'account', from_id: acc, to_kind: 'expense',
                 currency: 'USD', amount: 200 };

  const a = await kassir('POST', '/api/cash/ops', body);
  assert.equal(a.status, 400);
  assert.match(a.body.error, /modda/i);
  const b = await kassir('POST', '/api/cash/ops', { ...body, expense_item_id: item });
  assert.equal(b.status, 400);
  assert.match(b.body.error, /oy/i);

  const c = await kassir('POST', '/api/cash/ops',
    { ...body, expense_item_id: item, pl_month: '2026-08', op_date: '2026-09-16' });
  assert.equal(c.status, 200, c.text);
  //  Hisobotda TO'LOV oyida emas, ko'rsatilgan oyda turadi
  const pl = (await kassir('GET', '/api/cash/expenses')).body.rows
    .find((x) => x.item_name === 'Ijara');
  assert.equal(String(pl.pl_month).slice(0, 7), '2026-08');
  assert.equal(Number(pl.amount_usd), 200);

  //  Bekor qilingan operatsiya qoldiqdan chiqadi, tarixda qoladi
  const oldin = Number((await H.id(
    `SELECT total_usd FROM v_cash_balance WHERE code='MAIN'`)).total_usd);
  assert.equal((await kassir('PATCH', '/api/cash/ops/' + c.body.id)).status, 200);
  assert.equal(Number((await H.id(
    `SELECT total_usd FROM v_cash_balance WHERE code='MAIN'`)).total_usd), oldin + 200);
  assert.equal((await H.id(
    `SELECT status FROM cash_ops WHERE id=$1`, [c.body.id])).status, 'cancelled');
});

//  YANGI BUYURTMA BELGISI — savdo konverni olsa tsex boshlig'i buni
//  ekranda ko'radi. Belgi xodimga bog'liq: yonidagi boshliq ochgani
//  buniki hisoblanmaydi, aks holda ikki kishilik tsexda xabar bitta
//  odamga yetib, ikkinchisi bexabar qolardi.
test('yangi buyurtma bo\'limlar ekranida belgilanadi va ko\'rilgach o\'chadi', async () => {
  const u = (await admin('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 5, color: 'Oq', section_id: ARRA } ] })).body.created[0];

  const qator = async () => {
    const b = await korpus('GET', '/api/units/board');
    assert.equal(b.status, 200, b.text);
    for (const sc of b.body.sections) {
      const x = sc.units.find((y) => y.id === u.id);
      if (x) return x;
    }
    throw new Error('konver ekranda yo\'q');
  };

  assert.equal((await qator()).new_bron, false, 'broni yo\'q konverda belgi yo\'q');

  const mijoz = (await H.id(`SELECT id FROM customers WHERE name='Kanalsiz mijoz'`)).id;
  const z = (await admin('POST', '/api/sales/orders', { customer_id: mijoz,
    items: [{ product_id: PENAL, qty: 2, color: 'Oq' }] })).body;
  const it = (await admin('GET', '/api/sales/orders/' + z.id)).body.items[0];
  assert.equal((await admin('POST', `/api/sales/orders/${z.id}/assign`,
    { item_id: it.id, unit_id: u.id, qty: 2 })).status, 200);

  const yangi = await qator();
  assert.equal(yangi.new_bron, true, 'buyurtma tushdi — belgi chiqadi');
  assert.equal(yangi.booked_qty, 2);

  //  Boshqa xodim ochgani belgini o'chirmaydi
  assert.equal((await admin('GET', `/api/units/${u.id}/bron`)).status, 200);
  assert.equal((await qator()).new_bron, true, 'boshqa xodim ko\'rgani hisoblanmaydi');

  //  O'zi ochsa — o'chadi. Alohida «o'qildi» tugmasi yo'q: qatorni
  //  ochish ro'yxatni o'qish demak.
  assert.equal((await korpus('GET', `/api/units/${u.id}/bron`)).status, 200);
  assert.equal((await qator()).new_bron, false, 'ko\'rilgach belgi o\'chadi');

  //  Soni o'zgarsa yana yangi: mijozga va'da qilingan dona boshqacha bo'ldi
  assert.equal((await admin('POST', `/api/sales/orders/${z.id}/assign`,
    { item_id: it.id, unit_id: u.id, qty: 4 })).status, 200);
  const oshdi = await qator();
  assert.equal(oshdi.new_bron, true, 'bron soni o\'zgarsa yana belgilanadi');
  assert.equal(oshdi.booked_qty, 4);
});

//  PUL HAMMA XODIMGA BERILMAYDI — faqat belgisi qo'yilganlarga.
//  Belgi Xodimlar sahifasidan qo'yiladi, tekshiruv esa serverda:
//  tugmani yashirish himoya emas.
test('kassadan pul faqat belgilangan xodimga beriladi', async () => {
  const kassir = H.api(base, await H.sessionFor('Sinov kassir'));
  const admin2 = admin;
  const xodim = (await H.id(`SELECT id FROM workers WHERE name='Korpus ustasi'`)).id;
  const kassa = (await H.id(`SELECT id FROM cash_accounts WHERE code='MAIN'`)).id;
  const body = { from_kind: 'account', from_id: kassa, to_kind: 'worker', to_id: xodim,
                 currency: 'USD', amount: 100 };

  //  Belgisi yo'q — berib bo'lmaydi
  const yoq = await kassir('POST', '/api/cash/ops', body);
  assert.equal(yoq.status, 400, yoq.text);
  assert.match(yoq.body.error, /berilmaydi/);

  //  Ro'yxatda ham turmaydi
  assert.ok(!(await kassir('GET', '/api/cash/refs')).body.payable.some(w => w.id === xodim));

  //  Belgilangach — ham ro'yxatda, ham qabul qilinadi
  assert.equal((await admin2('PATCH', '/api/admin/workers/' + xodim,
    { can_hold_cash: true })).status, 200);
  assert.ok((await kassir('GET', '/api/cash/refs')).body.payable.some(w => w.id === xodim));
  const ok = await kassir('POST', '/api/cash/ops', body);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(Number((await H.id(
    `SELECT total_usd FROM v_worker_cash WHERE id=$1`, [xodim])).total_usd), 100);

  //  Boshqa maydon saqlansa belgi o'chib qolmaydi
  assert.equal((await admin2('PATCH', '/api/admin/workers/' + xodim,
    { phone: '+998900000000' })).status, 200);
  assert.equal((await H.id(
    `SELECT can_hold_cash FROM workers WHERE id=$1`, [xodim])).can_hold_cash, true);
});

//  KASSAGA YOZILGAN HARAJAT IKKI HISOBOTGA BORADI: foyda-zararga
//  hisobot oyi bilan, pul oqimiga to'lov sanasi bilan. Ikki sana atay
//  boshqa — sentabrda to'langan avgust ijarasi avgust foydasini
//  kamaytiradi, lekin pul sentabrda chiqadi.
test('harajat foyda-zarar va pul oqimi hisobotiga tushadi', async () => {
  const kassir = H.api(base, await H.sessionFor('Sinov kassir'));
  const kassa = (await H.id(`SELECT id FROM cash_accounts WHERE code='MAIN'`)).id;
  const modda = (await H.id(`SELECT id FROM expense_items ORDER BY id LIMIT 1`)).id;

  const r = await kassir('POST', '/api/cash/ops', {
    from_kind: 'account', from_id: kassa, to_kind: 'expense',
    currency: 'USD', amount: 250,
    op_date: '2026-09-15', expense_item_id: modda, pl_month: '2026-08' });
  assert.equal(r.status, 200, r.text);

  //  Foyda-zararda — AVGUSTda
  const pl = (await kassir('GET', '/api/cash/pl?from=2026-01&to=2026-12')).body;
  const h = pl.rows.filter(x => x.kind === 'expense'
    && x.pl_month.slice(0, 7) === '2026-08' && x.item_id === modda);
  assert.equal(h.length, 1, 'harajat avgust qatorida');
  assert.equal(Number(h[0].amount_usd), 250);
  assert.ok(!pl.rows.some(x => x.kind === 'expense'
    && x.pl_month.slice(0, 7) === '2026-09' && x.item_id === modda),
    'sentabrga tushmaydi — u to\'lov oyi, hisobot oyi emas');

  //  Pul oqimida — SENTABRda
  const fl = (await kassir('GET', '/api/cash/flow?from=2026-01&to=2026-12')).body;
  const o = fl.rows.filter(x => x.mon.slice(0, 7) === '2026-09'
    && x.dir === 'out' && x.item_id === modda);
  assert.equal(o.length, 1, 'chiqim sentabr qatorida');
  assert.equal(Number(o[0].amount_usd), 250);

  //  Menejerdan kassaga topshirish ICHKI harakat — oqimga tushmaydi,
  //  aks holda bitta to'lov ikki marta kirim bo'lib ko'rinardi.
  const ichki = fl.rows.filter(x => x.side === 'worker' || x.side === 'account');
  assert.equal(ichki.length, 0, 'ichki harakat pul oqimida yo\'q');

  //  Mijozdan kelgan pul esa KIRIM
  assert.ok(fl.rows.some(x => x.dir === 'in' && x.side === 'customer'),
    'mijoz to\'lovi kirimda');

  //  Bekor qilingan operatsiya ikkala hisobotdan ham chiqadi
  assert.equal((await kassir('PATCH', '/api/cash/ops/' + r.body.id)).status, 200);
  const pl2 = (await kassir('GET', '/api/cash/pl?from=2026-01&to=2026-12')).body;
  assert.ok(!pl2.rows.some(x => x.kind === 'expense' && x.item_id === modda),
    'bekor qilingani foyda-zarardan chiqadi');
});

//  OMBOR TARIXI: kim qabul qilgani yoziladi va kirim/chiqim bo'yicha
//  filtrlanadi. Yig'indi esa filtrdan qat'i nazar oraliqning o'zi
//  haqida gapiradi — «faqat kirim» tanlanganda chiqim nol bo'lib
//  ko'rinsa, mudir o'sha kuni hech narsa chiqmagan deb o'qirdi.
test('ombor harakatida kim qabul qilgani ko\'rinadi va filtr ishlaydi', async () => {
  //  Chiqish bo'limiga TO'G'RIDAN-TO'G'RI kiritilgan konver omborga
  //  tushib bo'lgan bo'ladi (boshlang'ich qoldiq yo'li, createOne):
  //  shuning uchun oddiy yo'l — boshidan kiritib, marshrut bo'ylab
  //  haydab chiqarish.
  const u = await newUnit({ qty: 2 });
  //  Marshrut tsexdan tsexga o'tadi, o'tish esa ikki bosqich: avval
  //  jo'natish, keyin qabul qilish. Shuning uchun o'tkazish yiqilsa
  //  topshirish yoziladi va qayta urinib ko'riladi.
  for (let i = 0; i < 20; i++) {
    const at = await H.id(
      `SELECT s.is_exit FROM production_units u
         JOIN sections s ON s.id = u.current_section_id WHERE u.id = $1`, [u.id]);
    if (at && at.is_exit) break;
    let mv = await admin('POST', '/api/units/move', { items: [{ unit_id: u.id }] });
    if (mv.status !== 200) {
      assert.equal((await admin('POST', '/api/units/handover',
        { items: [u.id] })).status, 200);
      mv = await admin('POST', '/api/units/move', { items: [{ unit_id: u.id }] });
    }
    assert.equal(mv.status, 200, mv.text);
  }
  const ho = await admin('POST', '/api/units/handover', { items: [u.id] });
  assert.equal(ho.status, 200, JSON.stringify(ho.body));
  //  Qabul qilgan odam — ADMIN emas, ombor mudiri: ismi o'shaniki
  //  bo'lishi kerak.
  const mudir = H.api(base, await H.sessionFor('Sinov ombor mudiri'));
  const ac = await mudir('POST', '/api/units/stock/accept', { items: [u.id] });
  assert.equal(ac.status, 200, JSON.stringify(ac.body));

  const bugun = new Date().toISOString().slice(0, 10);
  const q = `from=${bugun}&to=${bugun}`;
  const hammasi = (await mudir('GET', '/api/units/stock/moves?' + q)).body;
  const qator = hammasi.rows.find((r) => r.unit_id === u.id && r.kind === 'kirim');
  assert.ok(qator, 'kirim tarixda');
  assert.equal(qator.by_name, 'Sinov ombor mudiri');

  //  Filtr: faqat chiqim so'ralsa kirim qatorlari kelmaydi
  const chiqim = (await mudir('GET', `/api/units/stock/moves?${q}&kind=chiqim`)).body;
  assert.ok(!chiqim.rows.some((r) => r.kind === 'kirim'), 'filtrda kirim yo\'q');
  //  ...lekin yig'indi o'zgarmaydi
  assert.equal(chiqim.kirim, hammasi.kirim, 'yig\'indi filtrdan qat\'i nazar');

  //  Qabul qaytarilsa belgi ham o'chadi: konver omborda emas, qabul
  //  qilgan odam ham yo'q.
  assert.equal((await mudir('POST', '/api/units/stock/accept',
    { items: [u.id], undo: true })).status, 200);
  assert.equal((await H.id(
    `SELECT fg_by FROM production_units WHERE id=$1`, [u.id])).fg_by, null);
});

//  TA'MINOTCHIGA TO'LOV IKKI JOYGA YOZILADI: uning qarzidan ayriladi
//  va foyda-zararda o'z moddasida turadi. Ikkalasi ham to'g'ri —
//  «to_kind = expense» bo'lsa ta'minotchining qarzi kamaymasdi,
//  moddasiz bo'lsa esa hisobotdan yo'qolib ketardi.
test('ta\'minotchiga to\'lov moddasi bilan yoziladi', async () => {
  const { db } = require('../db');
  await db.query(`INSERT INTO suppliers (name) VALUES ('Sinov ta''minotchi')
                  ON CONFLICT DO NOTHING`);
  const tam = (await H.id(`SELECT id FROM suppliers WHERE name='Sinov ta''minotchi'`)).id;
  const modda = (await H.id(
    `SELECT id FROM expense_items WHERE needs_supplier LIMIT 1`));
  assert.ok(modda, "«Ta'minotchilarga to'lov» moddasi belgilangan");

  const kassir = H.api(base, await H.sessionFor('Sinov kassir'));
  const kassa = (await H.id(`SELECT id FROM cash_accounts WHERE code='MAIN'`)).id;

  //  Oy so'raladi: moddasi bor to'lov qaysi oyning foyda-zararida
  //  ekani aytilmasa hisobotda «boshqa» bo'lib yo'qolib ketardi.
  const oysiz = await kassir('POST', '/api/cash/ops', {
    from_kind: 'account', from_id: kassa, to_kind: 'supplier', to_id: tam,
    currency: 'USD', amount: 300, expense_item_id: modda.id });
  assert.equal(oysiz.status, 400, oysiz.text);

  const r = await kassir('POST', '/api/cash/ops', {
    from_kind: 'account', from_id: kassa, to_kind: 'supplier', to_id: tam,
    currency: 'USD', amount: 300, op_date: '2026-09-20',
    expense_item_id: modda.id, pl_month: '2026-09' });
  assert.equal(r.status, 200, r.text);

  //  Foyda-zararda — o'z moddasida
  const pl = (await kassir('GET', '/api/cash/pl?from=2026-09&to=2026-09')).body;
  const h = pl.rows.find(x => x.kind === 'expense' && x.item_id === modda.id);
  assert.ok(h, 'ta\'minotchiga to\'lov foyda-zararda');
  assert.equal(Number(h.amount_usd), 300);

  //  Pul oqimida — ta'minotchi tomonida
  const fl = (await kassir('GET', '/api/cash/flow?from=2026-09&to=2026-09')).body;
  assert.ok(fl.rows.some(x => x.dir === 'out' && x.side === 'supplier'),
    'chiqim ta\'minotchiga');
});

//  ★ PODOTCHYOT «HISOB BERISH SHARTI BILAN»: xodim qo'lidagi puldan
//  nimaga sarflaganini O'ZI yozadi va shu bilan pul qo'lidan chiqadi.
//  Lekin hamma hamma narsani emas — tsex boshlig'i faqat o'ziga
//  ochilgan guruhga yoza oladi.
test('podotchyot olgan xodim sarfini o\'zi yozadi, faqat ochilgan guruhga', async () => {
  const { db } = require('../db');
  const kassir = H.api(base, await H.sessionFor('Sinov kassir'));
  const kassa = (await H.id(`SELECT id FROM cash_accounts WHERE code='MAIN'`)).id;

  //  Tsex boshlig'i: podotchyot oladi, lekin faqat bitta guruhga
  await db.query(`INSERT INTO workers (name) SELECT 'Sinov tsex boshlig''i'
                   WHERE NOT EXISTS (SELECT 1 FROM workers WHERE name='Sinov tsex boshlig''i')`);
  const b = (await H.id(`SELECT id FROM workers WHERE name='Sinov tsex boshlig''i'`)).id;
  await db.query(`INSERT INTO worker_roles (worker_id, role_code)
                  VALUES ($1,'ishlab_boshl') ON CONFLICT DO NOTHING`, [b]);
  const bosh = H.api(base, await H.sessionFor('Sinov tsex boshlig\'i'));

  const guruh = (await H.id(`SELECT code FROM expense_groups ORDER BY sort LIMIT 1`)).code;
  const modda = (await H.id(
    `SELECT id FROM expense_items WHERE group_code=$1 LIMIT 1`, [guruh])).id;
  const boshqa = (await H.id(
    `SELECT id FROM expense_items WHERE group_code <> $1 LIMIT 1`, [guruh])).id;

  //  Belgisi yo'q — sarf yozib bo'lmaydi
  const yoq = await bosh('POST', '/api/cash/ops', {
    to_kind: 'expense', currency: 'USD', amount: 50,
    expense_item_id: modda, pl_month: '2026-09' });
  assert.equal(yoq.status, 400, yoq.text);
  assert.match(yoq.body.error, /podotchyot/);

  //  Belgilanadi va faqat BITTA guruh ochiladi
  assert.equal((await admin('PATCH', '/api/admin/workers/' + b,
    { can_hold_cash: true, cash_groups: [guruh] })).status, 200);

  //  Kassir unga pul beradi
  assert.equal((await kassir('POST', '/api/cash/ops', {
    from_kind: 'account', from_id: kassa, to_kind: 'worker', to_id: b,
    currency: 'USD', amount: 500 })).status, 200);
  assert.equal(Number((await H.id(
    `SELECT total_usd FROM v_worker_cash WHERE id=$1`, [b])).total_usd), 500);

  //  Ochilmagan guruhga yozib bo'lmaydi
  const xato = await bosh('POST', '/api/cash/ops', {
    to_kind: 'expense', currency: 'USD', amount: 50,
    expense_item_id: boshqa, pl_month: '2026-09' });
  assert.equal(xato.status, 400, xato.text);
  assert.match(xato.body.error, /ochilmagan/);

  //  O'z guruhiga — yoziladi va pul qo'lidan chiqadi
  const ok = await bosh('POST', '/api/cash/ops', {
    to_kind: 'expense', currency: 'USD', amount: 120,
    expense_item_id: modda, pl_month: '2026-09' });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(Number((await H.id(
    `SELECT total_usd FROM v_worker_cash WHERE id=$1`, [b])).total_usd), 380);

  //  Tomonlarni KLIENT qo'ymaydi: kassaning pulini sarflab bo'lmaydi
  const soxta = await bosh('POST', '/api/cash/ops', {
    from_kind: 'account', from_id: kassa, to_kind: 'expense',
    currency: 'USD', amount: 10, expense_item_id: modda, pl_month: '2026-09' });
  assert.equal(soxta.status, 200, soxta.text);
  const oxirgi = await H.id(
    `SELECT from_kind, from_id FROM cash_ops ORDER BY id DESC LIMIT 1`);
  assert.equal(oxirgi.from_kind, 'worker', 'server tomonni o\'zi qo\'yadi');
  assert.equal(oxirgi.from_id, b);
});

//  SOLISHTIRMA DALOLATNOMA: bitta mijozning har bir qatori hujjatga
//  bog'langan bo'lishi kerak — chiqim yuk xatiga, to'lov kirim
//  orderiga. Mijoz «bu qanday chiqim edi» deb so'raganda javob bir
//  bosishda topilsin.
test('dalolatnomada har qator hujjatga bog\'langan', async () => {
  const mijoz = (await H.id(`SELECT id FROM customers WHERE name='Kanalsiz mijoz'`)).id;
  const d = (await admin('GET',
    `/api/sales/debts/${mijoz}?from=2026-01-01&to=2026-12-31`)).body;

  //  Boshiga + qarzdor − haqdor = oxiriga
  assert.equal(Number(d.closing),
    Number(d.opening) + Number(d.total.debit) - Number(d.total.credit));

  const tolov = d.rows.find((r) => r.kind === 'payment');
  assert.ok(tolov, 'to\'lov qatori bor');
  assert.ok(tolov.doc_no && tolov.op_id, 'to\'lovda hujjat raqami va id');
  //  Summa MODUL bilan: mijoz tomonida to'lov manfiy turadi, lekin
  //  izohda «-12500000» degan raqam savol berdirardi.
  assert.match(tolov.note, /· 12 500 000\.00 so'm$/, tolov.note);

  //  Kirim orderi hujjati: kim olib kelgani bilan
  const hujjat = (await admin('GET', '/api/sales/payment/' + tolov.op_id)).body;
  assert.equal(hujjat.op.doc_no, tolov.doc_no);
  assert.equal(hujjat.op.customer_name, 'Kanalsiz mijoz');
  assert.ok(hujjat.op.qabul, 'kim olib kelgani yozilgan');

  //  Chiqimda yuk xatiga havola: buyurtmasi topilgan qatorda order_id
  const chiqim = d.rows.filter((r) => r.kind === 'ship' && r.order_id);
  assert.ok(chiqim.length, 'yuk xatiga bog\'langan chiqim bor');
  assert.equal((await admin('GET',
    '/api/sales/waybill/' + chiqim[0].order_id)).status, 200);

  //  Boshqa yo'nalishdagi mijozning hujjati ochilmaydi: chegara
  //  qarzdorlik bilan bir xil.
  const eksport = H.api(base, await H.sessionFor('Eksport menejeri'));
  assert.equal((await eksport('GET', '/api/sales/payment/' + tolov.op_id)).status, 404);
});

//  ★ XODIM QO'LIDAGI BOSHLANG'ICH QOLDIQ — kassaniki bilan bir xil
//  qoida: operatsiya EMAS, shuning uchun kassa qoldig'iga tegmaydi.
//  Kassadan berish bilan yozib qo'yilsa kassa shuncha kamayib ketardi,
//  holbuki o'sha pul kassadan bugun chiqmagan.
test('xodim qo\'lidagi boshlang\'ich qoldiq kassaga tegmaydi', async () => {
  const { db } = require('../db');
  const kassir = H.api(base, await H.sessionFor('Sinov kassir'));
  const kassa = (await H.id(`SELECT id FROM cash_accounts WHERE code='MAIN'`)).id;

  await db.query(`INSERT INTO workers (name) SELECT 'Sinov ta''minotchi'
                   WHERE NOT EXISTS (SELECT 1 FROM workers WHERE name='Sinov ta''minotchi')`);
  const x = (await H.id(`SELECT id FROM workers WHERE name='Sinov ta''minotchi'`)).id;

  const oldin = Number((await H.id(
    `SELECT total_usd FROM v_cash_balance WHERE id=$1`, [kassa])).total_usd);

  //  So'm qoldig'i kurssiz yozilmaydi — kassaniki bilan bir xil shart
  assert.equal((await kassir('PATCH', `/api/cash/workers/${x}/opening`,
    { opening_uzs: 1000000 })).status, 400);

  const r = await kassir('PATCH', `/api/cash/workers/${x}/opening`, {
    opening_on: '2026-09-01', opening_uzs: 12500000,
    opening_rate: 12500, opening_usd: 200 });
  assert.equal(r.status, 200, r.text);

  //  Qo'lidagi pul: 200 $ + 12 500 000 so'm / 12 500 = 1200 $
  assert.equal(Number((await H.id(
    `SELECT total_usd FROM v_worker_cash WHERE id=$1`, [x])).total_usd), 1200);

  //  Kassa qimirlamadi
  assert.equal(Number((await H.id(
    `SELECT total_usd FROM v_cash_balance WHERE id=$1`, [kassa])).total_usd), oldin);

  //  Ro'yxatda ko'rinadi va o'z sahifasiga havolasi bor
  const list = (await kassir('GET', '/api/cash/list')).body;
  const q = (list.workers || []).find((w) => w.id === x);
  assert.ok(q, 'qo\'lida puli bor xodim ro\'yxatda');
  assert.equal(q.href, '/kassa.html?a=w' + x);

  //  Kassir o'sha xodimning lentasini ocha oladi, menejer esa yo'q
  assert.equal((await kassir('GET', '/api/cash/ops?a=w' + x)).status, 200);
  const menejer = H.api(base, await H.sessionFor('Sinov menejer'));
  assert.equal((await menejer('GET', '/api/cash/ops?a=w' + x)).status, 403);

  //  Topshirsa qo'lidan chiqadi va kassaga tushadi
  assert.equal((await kassir('POST', '/api/cash/ops', {
    from_kind: 'worker', from_id: x, to_kind: 'account', to_id: kassa,
    currency: 'USD', amount: 200 })).status, 200);
  assert.equal(Number((await H.id(
    `SELECT total_usd FROM v_worker_cash WHERE id=$1`, [x])).total_usd), 1000);
  assert.equal(Number((await H.id(
    `SELECT total_usd FROM v_cash_balance WHERE id=$1`, [kassa])).total_usd), oldin + 200);
});

//  ★ PODOTCHYOT OLGAN XODIM TA'MINOTCHIGA HAM TO'LAYDI: ombor mudiri
//  bozorda naqd to'laydi va o'sha odamning qarzi kamayishi kerak.
//  Ilgari ta'minotchilar ro'yxati faqat kassirga kelardi va uchinchi
//  bosqich xodimda bo'sh chiqardi.
test('podotchyot olgan xodim ta\'minotchiga to\'lay oladi', async () => {
  const { db } = require('../db');
  const kassir = H.api(base, await H.sessionFor('Sinov kassir'));
  const kassa = (await H.id(`SELECT id FROM cash_accounts WHERE code='MAIN'`)).id;
  const bosh = H.api(base, await H.sessionFor('Sinov tsex boshlig\'i'));
  const b = (await H.id(`SELECT id FROM workers WHERE name='Sinov tsex boshlig''i'`)).id;

  //  Cheklovi olinadi: bu xodim hamma guruhga sarflay oladi
  await db.query(`DELETE FROM worker_expense_groups WHERE worker_id=$1`, [b]);

  const tam = (await H.id(`SELECT id FROM suppliers WHERE active ORDER BY id LIMIT 1`)).id;
  const modda = (await H.id(
    `SELECT id FROM expense_items WHERE needs_supplier AND active LIMIT 1`)).id;

  //  Ro'yxat XODIMGA ham keladi — u ham tanlashi kerak
  const refs = (await bosh('GET', '/api/cash/refs')).body;
  assert.ok((refs.suppliers || []).some((x) => x.id === tam),
    'ta\'minotchilar ro\'yxati xodimga ham keladi');

  assert.equal((await kassir('POST', '/api/cash/ops', {
    from_kind: 'account', from_id: kassa, to_kind: 'worker', to_id: b,
    currency: 'USD', amount: 300 })).status, 200);
  const oldin = Number((await H.id(
    `SELECT total_usd FROM v_worker_cash WHERE id=$1`, [b])).total_usd);

  //  Moddasiz o'tmaydi: harajat foyda-zarardan yo'qolib ketardi
  assert.equal((await bosh('POST', '/api/cash/ops', {
    to_kind: 'supplier', to_id: tam, currency: 'USD', amount: 40 })).status, 400);

  const r = await bosh('POST', '/api/cash/ops', {
    to_kind: 'supplier', to_id: tam, currency: 'USD', amount: 40,
    op_date: '2026-09-22', expense_item_id: modda, pl_month: '2026-09' });
  assert.equal(r.status, 200, r.text);

  //  Pul XODIMNING qo'lidan chiqdi, kassadan emas
  assert.equal(Number((await H.id(
    `SELECT total_usd FROM v_worker_cash WHERE id=$1`, [b])).total_usd), oldin - 40);
  const op = await H.id(
    `SELECT from_kind, from_id, to_kind, to_id FROM cash_ops ORDER BY id DESC LIMIT 1`);
  assert.equal(op.from_kind, 'worker');
  assert.equal(op.from_id, b);
  assert.equal(op.to_kind, 'supplier');
  assert.equal(op.to_id, tam);

  //  Foyda-zararda o'z moddasida turadi
  const pl = (await kassir('GET', '/api/cash/pl?from=2026-09&to=2026-09')).body;
  assert.ok(pl.rows.some((x) => x.kind === 'expense' && x.item_id === modda),
    'xodim yozgan to\'lov foyda-zararda');
});

//  ★ TA'MINOTCHILAR FAYLDAN. Zavod ro'yxatni Excel'da yuritadi va
//  ustunini «TURI» deb ataydi, ichida esa turning NOMI turadi
//  («Qadoqlash materiali»), kodi emas — ikkalasi ham o'qilishi kerak.
test('ta\'minotchilarni fayldan yuklash: turi nomi bilan ham o\'qiladi', async () => {
  const bad = [
    'Hisob nomi;Telefon raqami;TURI',
    'Sinov Mdf Aka;90-111-22-33;MDF',
    'Sinov Yomon Tur;90-111-22-44;YO\'QTUR',
  ];
  const pre = await (await post('/api/import/suppliers', bad)).json();
  assert.equal(pre.total, 2);
  assert.equal(pre.bad, 1);
  assert.match(pre.rows[1].errors[0], /yo'nalish yo'q/);

  assert.equal((await post('/api/import/suppliers?save=1', bad)).status, 400);
  assert.equal((await H.id(
    `SELECT COUNT(*)::int n FROM suppliers
      WHERE name IN ('Sinov Mdf Aka', 'Sinov Yomon Tur')`)).n, 0,
    'xato bo\'lsa bitta ta\'minotchi ham kirmaydi');

  //  Tuzatilgach kiradi: turi KODI bilan ham, NOMI bilan ham
  const ok = [
    'TURI;Hisob nomi;Telefon raqami',
    'MDF;Sinov Mdf Aka;90-111-22-33',
    'Qadoqlash materiali;Sinov Karton;90-111-22-55',
  ];
  const done = await (await post('/api/import/suppliers?save=1', ok)).json();
  assert.equal(done.saved, 2);
  assert.equal((await H.id(
    `SELECT category FROM suppliers WHERE name='Sinov Karton'`)).category, 'QADOQ');

  //  Qayta yuklash nusxa ochmaydi va yozilganini o'chirmaydi
  const yana = await (await post('/api/import/suppliers?save=1', [
    'Hisob nomi;TURI', 'Sinov Karton;'])).json();
  assert.equal(yana.saved, 1);
  assert.equal((await H.id(
    `SELECT COUNT(*)::int n FROM suppliers WHERE name='Sinov Karton'`)).n, 1);
  assert.equal((await H.id(
    `SELECT category FROM suppliers WHERE name='Sinov Karton'`)).category, 'QADOQ');
});

//  ★ TA'MINOTCHINING BOSHLANG'ICH QARZI. Mijoznikiga TESKARI tomon:
//  musbat raqam KORXONA ta'minotchiga qarzdorligini anglatadi. Shusiz
//  kassadan qilingan birinchi to'lov uni minusga tushirardi.
test('ta\'minotchi qarzi: to\'lov qarzdan ayriladi', async () => {
  const admin  = H.api(base, await H.sessionFor('Administrator'));
  const kassir = H.api(base, await H.sessionFor('Sinov kassir'));
  const kassa = (await H.id(`SELECT id FROM cash_accounts WHERE code='MAIN'`)).id;

  const yangi = await admin('POST', '/api/purchasing/suppliers', {
    name: 'Sinov Qarzdor Mdf', category: 'MDF',
    opening_debt: 1000, opening_debt_on: '2026-09-01' });
  assert.equal(yangi.status, 200, yangi.text);
  const tam = (await H.id(
    `SELECT id FROM suppliers WHERE name='Sinov Qarzdor Mdf'`)).id;

  const balans = async () => Number((await H.id(
    `SELECT balance FROM v_supplier_debt WHERE id=$1`, [tam])).balance);
  assert.equal(await balans(), 1000, 'boshlang\'ich qarz');

  //  To'landi — qarz kamayadi
  const modda = (await H.id(
    `SELECT id FROM expense_items WHERE needs_supplier AND active LIMIT 1`)).id;
  assert.equal((await kassir('POST', '/api/cash/ops', {
    from_kind: 'account', from_id: kassa, to_kind: 'supplier', to_id: tam,
    currency: 'USD', amount: 300, op_date: '2026-09-20',
    expense_item_id: modda, pl_month: '2026-09' })).status, 200);
  assert.equal(await balans(), 700, 'to\'lov qarzdan ayriladi');

  //  Ro'yxatda qarzi bilan keladi
  const list = (await admin('GET', '/api/purchasing/suppliers')).body;
  const q = list.suppliers.find((x) => x.id === tam);
  assert.equal(Number(q.balance), 700);
  assert.equal(Number(q.opening_debt), 1000);

  //  Qayta import qarzni O'CHIRMAYDI
  assert.equal((await admin('POST', '/api/purchasing/suppliers', {
    items: [{ name: 'Sinov Qarzdor Mdf', phone: '90-000-00-00' }] })).status, 200);
  assert.equal(Number((await H.id(
    `SELECT opening_debt FROM suppliers WHERE id=$1`, [tam])).opening_debt), 1000);

  //  Kartochkadan esa tuzatiladi ham, tozalanadi ham
  assert.equal((await admin('PATCH', '/api/purchasing/suppliers/' + tam,
    { opening_debt: -50 })).status, 200);
  assert.equal(await balans(), -350, 'oldindan to\'lov — manfiy tomonda');
  assert.equal((await admin('PATCH', '/api/purchasing/suppliers/' + tam,
    { opening_debt: null })).status, 200);
  assert.equal((await H.id(
    `SELECT opening_debt FROM suppliers WHERE id=$1`, [tam])).opening_debt, null);
});

//  ★ TA'MINOT QARZDORLIGI — aylanma-saldo qaydnomasi. Mijozlarniki
//  bilan bir xil shakl, tomoni esa TESKARI: ta'minotchi passiv hisob,
//  haqdor — bizning qarzimiz, qarzdor — to'lov.
test('ta\'minot qarzdorligi: boshiga + haqdor − qarzdor = oxiriga', async () => {
  const admin  = H.api(base, await H.sessionFor('Administrator'));
  const kassir = H.api(base, await H.sessionFor('Sinov kassir'));
  const kassa = (await H.id(`SELECT id FROM cash_accounts WHERE code='MAIN'`)).id;

  await admin('POST', '/api/purchasing/suppliers', {
    name: 'Sinov Saldo Lak', category: 'LAK',
    opening_debt: 800, opening_debt_on: '2026-08-01' });
  const tam = (await H.id(
    `SELECT id FROM suppliers WHERE name='Sinov Saldo Lak'`)).id;
  const modda = (await H.id(
    `SELECT id FROM expense_items WHERE needs_supplier AND active LIMIT 1`)).id;

  //  Sentabrda 250 to'landi
  assert.equal((await kassir('POST', '/api/cash/ops', {
    from_kind: 'account', from_id: kassa, to_kind: 'supplier', to_id: tam,
    currency: 'USD', amount: 250, op_date: '2026-09-15',
    expense_item_id: modda, pl_month: '2026-09' })).status, 200);

  const d = (await admin(
    'GET', '/api/purchasing/debts?from=2026-09-01&to=2026-09-30')).body;
  const r = d.rows.find((x) => x.id === tam);
  assert.ok(r, 'ta\'minotchi hisobotda');
  //  Boshlang'ich qarz avgustda — davr BOSHIGA haqdor bo'lib turadi
  assert.equal(Number(r.opening_credit), 800);
  assert.equal(Number(r.opening_debit), 0);
  //  Davr ichida: to'lov qarzdor tomonda
  assert.equal(Number(r.debit), 250);
  assert.equal(Number(r.credit), 0);
  //  boshiga + haqdor − qarzdor = oxiriga
  assert.equal(Number(r.closing_credit), 550);

  //  Qator ochilganda harakatlari va yugurib boradigan qoldiq
  const ich = (await admin(
    'GET', `/api/purchasing/debts/${tam}?from=2026-09-01&to=2026-09-30`)).body;
  assert.equal(Number(ich.opening), 800);
  assert.equal(Number(ich.closing), 550);
  assert.equal(ich.rows.length, 1);
  assert.equal(ich.rows[0].kind, 'payment');
  assert.ok(ich.rows[0].doc_no, 'to\'lov hujjat raqami bilan');

  //  «Hammasi» oralig'ida boshlang'ich qarz DAVR ICHIDA turadi
  const hammasi = (await admin(
    'GET', '/api/purchasing/debts?from=1900-01-01&to=2026-12-31')).body;
  const h = hammasi.rows.find((x) => x.id === tam);
  assert.equal(Number(h.opening_credit), 0);
  assert.equal(Number(h.credit), 800);
  assert.equal(Number(h.debit), 250);
  assert.equal(Number(h.closing_credit), 550);
});

//  ★ SOF AYLANMA KAPITAL — sana HOLATIGA olingan surat. Ustun oyning
//  15-sanasi va oxirgi kuni; kelajakdagi sana ustun bo'lmaydi.
test('aylanma kapital: ustun 15-sana va oy oxiri, aktiv − passiv = sof', async () => {
  const admin = H.api(base, await H.sessionFor('Administrator'));
  const d = (await admin(
    'GET', '/api/cash/working-capital?from=2026-08-01&to=2026-09-17')).body;

  const kunlar = d.rows.map((r) => String(r.on_date).slice(0, 10));
  assert.deepEqual(kunlar, ['2026-08-15', '2026-08-31', '2026-09-15'],
    'oyning 15-sanasi va oxiri; kelajak sana yo\'q');

  for (const r of d.rows) {
    const aktiv = ['fg', 'wip', 'xom', 'kassa', 'qolda', 'mijoz_qarz', 'tamin_avans']
      .reduce((a, k) => a + Number(r[k] || 0), 0);
    const passiv = ['tamin_qarz', 'mijoz_avans']
      .reduce((a, k) => a + Number(r[k] || 0), 0);
    assert.equal(Number(r.aktiv).toFixed(2), aktiv.toFixed(2));
    assert.equal(Number(r.passiv).toFixed(2), passiv.toFixed(2));
    assert.equal(Number(r.sof).toFixed(2), (aktiv - passiv).toFixed(2));
  }

  //  Ta'minotchi qarzi PASSIVDA: avgustda 800 edi, sentabrda 250
  //  to'landi (yuqoridagi sinov) — ya'ni kamayib boradi.
  const avg = d.rows.find((r) => String(r.on_date).startsWith('2026-08-15'));
  const sen = d.rows.find((r) => String(r.on_date).startsWith('2026-09-15'));
  assert.ok(Number(avg.tamin_qarz) > Number(sen.tamin_qarz),
    'to\'langan qarz passivdan kamayadi');

  //  Xom ashyo qatori TURADI, lekin nol: modul hali yozilmagan.
  //  Qator umuman bo'lmasa hisobot to'la ko'rinardi.
  assert.equal(Number(sen.xom), 0);
  assert.ok('wip_shops' in d, 'tsex kesimi keladi');
});

test('yakun', async () => {
  server.close();
  await require('../db').db.end();
});
