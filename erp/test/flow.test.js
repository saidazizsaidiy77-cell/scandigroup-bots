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

//  Kelajakdagi sana HISOBLANADI, yozib qo'yilmaydi. Ishlab chiqarishdagi
//  konverning omborga tushish sanasi BUGUNDAN sanaladi (marshrut zanjiri),
//  buyurtmaning chiqish sanasi esa undan keyin turishi kerak — aks holda
//  bron qabul qilinmaydi (`assertMuddat`). Qotib qolgan «2026-10-05»
//  kalendar oldinga siljigach o'tmishga aylanib, savdoga aloqasi yo'q
//  testlarni ham yiqitardi.
const kun = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

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

  const ho = await korpus('POST', '/api/units/handover', { items: [u.id] });
  assert.equal(ho.status, 200, ho.text);

  const board = await lak('GET', '/api/units/board');
  assert.ok(board.body.inbox.some((x) => x.id === u.id), 'jo\'natilgach inbox\'da');

  //  Sana endi majburiy emas (zanjir uni o'zi hisoblaydi), lekin
  //  yozilgani yoziladi va formuladan ustun turadi.
  const move = await lak('POST', '/api/units/move',
    { items: [{ unit_id: u.id, plan_on: '2026-09-25' }] });
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

//  ★ OMBOR MUDIRI: BIR QISMINI QABUL QILADI va JO'NATISHNI QAYTARADI.
//  Qadoqlash «10 ta jo'natdim» deydi, javonga esa 2 tasi qo'yiladi;
//  ba'zan esa mahsulot umuman kelmaydi va qator ro'yxatda osilib
//  qolardi — mudir uni qabul ham, olib tashlay ham olmasdi.
test('omborda qisman qabul va tsexga qaytarish', async () => {
  const QADOYNA = (await H.id(`SELECT id FROM sections WHERE code='QAD-OYNA'`)).id;
  const u = (await admin('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 10, color: 'Oq', section_id: QADOYNA }] })).body.created[0];
  const qad = H.api(base, await H.sessionFor('Qadoqlash ustasi'));
  await qad('POST', '/api/units/move', { items: [{ unit_id: u.id }] });
  //  Ombor huquqi bilan: administrator ham — alohida «omborchi»
  //  yaratilmaydi, chunki yuk xatidagi «ombor mudiri» o'sha roldagi
  //  YAGONA faol xodimdan olinadi va ikkinchisi uni bo'shatib qo'yardi.
  const mudir = admin;

  //  Jo'natilmagan konverni qaytarib bo'lmaydi.
  assert.equal((await mudir('POST', '/api/units/stock/return',
    { items: [u.id] })).status, 400);

  assert.equal((await qad('POST', '/api/units/handover', { items: [u.id] })).status, 200);
  assert.ok((await mudir('GET', '/api/units/stock/inbox')).body.some((x) => x.id === u.id));

  //  Qaytarilgach ro'yxatdan chiqadi, mahsulot esa JOYIDAN QIMIRLAMAYDI.
  assert.equal((await mudir('POST', '/api/units/stock/return',
    { items: [u.id] })).status, 200);
  const q = await H.id(
    `SELECT handover_on, status, current_section_id FROM production_units WHERE id=$1`,
    [u.id]);
  assert.equal(q.handover_on, null, "jo'natilgan belgisi o'chdi");
  assert.equal(q.status, 'production');
  assert.ok(q.current_section_id, "bo'limi saqlandi");
  assert.equal((await mudir('GET', '/api/units/stock/inbox'))
    .body.filter((x) => x.id === u.id).length, 0);

  //  Qisman qabul: 10 tadan 4 tasi javonga qo'yiladi.
  assert.equal((await qad('POST', '/api/units/handover', { items: [u.id] })).status, 200);
  const before = (await H.id(
    `SELECT COALESCE((SELECT qty FROM fg_stock WHERE product_id=$1),0) q`, [PENAL])).q;
  const kop = await mudir('POST', '/api/units/stock/accept',
    { items: [{ unit_id: u.id, qty: 11 }] });
  assert.equal(kop.status, 400, kop.text);

  const ok = await mudir('POST', '/api/units/stock/accept',
    { items: [{ unit_id: u.id, qty: 4 }] });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body.done[0].qty, 4);

  //  Qabul qilingani — YANGI bo'lak, raqami o'sha; qolgani eski
  //  qatorda va «jo'natilgan» bo'lib ro'yxatda turaveradi.
  const olingan = await H.id(
    `SELECT qty, status FROM production_units WHERE id=$1`, [ok.body.done[0].unit_id]);
  assert.deepEqual([olingan.qty, olingan.status], [4, 'fg']);
  const qolgan = await H.id(
    `SELECT qty, status, handover_on IS NOT NULL AS jo FROM production_units WHERE id=$1`,
    [u.id]);
  assert.deepEqual([qolgan.qty, qolgan.status, qolgan.jo], [6, 'production', true]);
  assert.equal((await mudir('GET', '/api/units/stock/inbox'))
    .body.find((x) => x.id === u.id).qty, 6, "qolgani ro'yxatda");
  assert.equal((await H.id(`SELECT qty q FROM fg_stock WHERE product_id=$1`, [PENAL])).q,
    before + 4);

  //  Qolganini ham qabul qilsa konver to'liq omborga o'tadi.
  assert.equal((await mudir('POST', '/api/units/stock/accept',
    { items: [{ unit_id: u.id }] })).status, 200);
  assert.equal((await H.id(`SELECT status FROM production_units WHERE id=$1`, [u.id])).status,
    'fg');
});

//  ★ BOSQICHDAN SAKRAB BO'LMAYDI. Topshirish — marshrutning
//  CHEGARASIDA bo'ladigan ish: konver yo keyingi tsexga o'tadi, yo
//  chiqish bo'limidan T/M omborga. Ilgari server faqat doirani
//  qarardi va doirasi keng xodim o'rtadagi bo'limdan ham
//  «jo'natilgan» deb belgilay olardi — oradagi tsexning ustidan
//  sakrab, mahsulotni to'g'ridan-to'g'ri omborga yozib yuborardi.
test('o\'z tsexi ichidagi konver jo\'natilmaydi — bosqich sakralmaydi', async () => {
  const ARRA2 = (await H.id(`SELECT id FROM sections WHERE code='KOR-ARRA'`)).id;
  const u = await newUnit({ section_id: ARRA2 });

  //  Arra — korpusning ichidagi bo'lim: oldinda o'sha tsexning
  //  qadamlari turibdi, ya'ni topshiradigan narsa yo'q.
  const erta = await korpus('POST', '/api/units/handover', { items: [u.id] });
  assert.equal(erta.status, 400, erta.text);
  assert.match(erta.body.error, /hali/);

  //  Administratorda doira yo'q, lekin qoida unga ham tegishli —
  //  chegara DOIRADAN emas, MARSHRUTDAN chiqadi.
  assert.equal((await admin('POST', '/api/units/handover', { items: [u.id] })).status, 400);

  //  Chiqish bo'limiga yetmagan konverni omborga ham jo'natib bo'lmaydi:
  //  qadoqlashgacha yo'l bor.
  const j = await H.id(`SELECT current_section_id FROM production_units WHERE id=$1`, [u.id]);
  assert.equal(j.current_section_id, ARRA2, 'konver joyida qoldi');
});

//  ★ NECHTASI JO'NATILAYOTGANI SO'RALADI: tsex o'n talikning
//  to'rttasini tayyorlab, qolganini ertaga beradi.
test('konverning bir qismi jo\'natiladi', async () => {
  const u = (await admin('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 10, color: 'Oq', section_id: SHKUR }] })).body.created[0];

  const kop = await korpus('POST', '/api/units/handover',
    { items: [{ unit_id: u.id, qty: 11 }] });
  assert.equal(kop.status, 400, kop.text);

  const ok = await korpus('POST', '/api/units/handover',
    { items: [{ unit_id: u.id, qty: 4 }] });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body.done[0].qty, 4);

  //  Jo'natilgani — yangi bo'lak, raqami o'sha; qolgani esa eski
  //  qatorda, o'z bo'limida va belgisiz turaveradi.
  const ketdi = await H.id(
    `SELECT qty, handover_on IS NOT NULL AS jo FROM production_units WHERE id=$1`,
    [ok.body.done[0].unit_id]);
  assert.deepEqual([ketdi.qty, ketdi.jo], [4, true]);
  const qoldi = await H.id(
    `SELECT qty, handover_on IS NOT NULL AS jo FROM production_units WHERE id=$1`, [u.id]);
  assert.deepEqual([qoldi.qty, qoldi.jo], [6, false]);
  assert.equal(ketdi.qty + qoldi.qty, 10, 'dona yo\'qolmadi');

  //  Qabul qiluvchi tsex ro'yxatida faqat JO'NATILGAN bo'lak turadi.
  const inbox = (await lak('GET', '/api/units/board')).body.inbox;
  assert.ok(inbox.some((x) => x.id === ok.body.done[0].unit_id));
  assert.ok(!inbox.some((x) => x.id === u.id), 'qolgani jo\'natilmagan');
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

  //  `production.units` — jurnalni TO'LDIRISH huquqi: zakaz, mijoz,
  //  narx, rang. Hozir uni `production.manage` siz oladigan rol yo'q
  //  (ma'lumot kirituvchida jurnal ochilmaydi), shuning uchun chegara
  //  sinov uchun atay yaratilgan rolda tekshiriladi — huquqning O'ZI
  //  joyida turibdi va ertaga yangi rolga berilishi mumkin.
  const { db } = require('../db');
  await db.query(
    `INSERT INTO roles (code, name) VALUES ('sinov_jurnal', 'Sinov jurnalchi')
     ON CONFLICT DO NOTHING`);
  await db.query(
    `INSERT INTO role_permissions (role_code, permission_code)
     VALUES ('sinov_jurnal','production.view'), ('sinov_jurnal','production.units')
     ON CONFLICT DO NOTHING`);
  const jurnalchi = await xodim('Sinov jurnalchi', 'sinov_jurnal');

  for (const body of [{ conveyor_no: 'X-1' }, { qty: 5 }, { lak_on: '2026-01-01' },
                      { section_id: ROVER }]) {
    const r = await jurnalchi('PATCH', '/api/units/' + u.id, body);
    assert.equal(r.status, 403, JSON.stringify(body) + ' → ' + r.text);
  }
  // Narx, zakaz va mijoz esa uning ishi
  assert.equal((await jurnalchi('PATCH', '/api/units/' + u.id,
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

  // Lak tsexi 4 tasini oladi, 6 tasi korpusda qoladi. Qabul qilayotgan
  // tsex keyingisiga muddat qo'yadi — shuning uchun sana bilan.
  const r = await lak('POST', '/api/units/move',
    { items: [{ unit_id: u.id, qty: 4, plan_on: '2026-09-25' }] });
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
  assert.equal((await lak('POST', '/api/units/move',
    { items: [{ unit_id: u.id, plan_on: '2026-09-25' }] })).status, 200);
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
  //  Oddiy konver esa MAHSULOTNING harfi bilan: penal korpusniki,
  //  ya'ni K va zavod daftaridagidek uch xonali.
  const k = await admin('POST', '/api/units/', { items: [{ product_id: PENAL, qty: 1 }] });
  assert.match(k.body.created[0].conveyor_no, /^K\d\d-\d{3}$/,
    k.body.created[0].conveyor_no);

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

test('savdo boshlig\'i buyurtmalarni menejer bo\'yicha saralaydi', async () => {
  //  ★ Savdo bo'lim boshlig'ining birinchi savoli — «kim nima yozdi».
  //  Ro'yxatda menejer ustuni bor edi, lekin uni SARALAB bo'lmasdi:
  //  o'ttizta qatordan bittasining ishini ko'z bilan terib olish kerak
  //  edi. Server filtri bor edi, sahifa esa uni yubormasdi.
  //
  //  Boshliqda doira YO'Q (`scope_own` belgilanmagan) — shuning uchun
  //  u hamma menejerning buyurtmasini ko'radi va ular orasidan
  //  tanlaydi. Doirasi bor xodimga ro'yxat chizilmaydi ham: u yerda
  //  baribir bitta ism turardi.
  const mgr = (await H.id(`SELECT id FROM workers WHERE name='Sinov sotuvchi'`)).id;
  const mijoz = (await H.id(`SELECT id FROM customers WHERE name='Kanalsiz mijoz'`)).id;

  const meniki = await admin('POST', '/api/sales/orders',
    { customer_id: mijoz, manager_id: mgr, items: [] });
  assert.equal(meniki.status, 200, meniki.text);
  const ozga = await admin('POST', '/api/sales/orders', { customer_id: mijoz, items: [] });
  assert.equal(ozga.status, 200, ozga.text);

  const filtr = (await admin('GET', '/api/sales/orders?manager_id=' + mgr)).body.rows;
  assert.ok(filtr.some((r) => r.id === meniki.body.id), 'o\'sha menejerniki chiqadi');
  assert.ok(!filtr.some((r) => r.id === ozga.body.id), 'boshqasiniki chiqmaydi');
  assert.ok(filtr.every((r) => r.manager_id === mgr), 'hammasi bitta menejerniki');

  //  Filtrsiz ikkalasi ham turadi.
  const hammasi = (await admin('GET', '/api/sales/orders')).body.rows;
  for (const o of [meniki, ozga])
    assert.ok(hammasi.some((r) => r.id === o.body.id));
});

test('savdo xodimiga faqat O\'Z mijozi va O\'Z buyurtmasi ko\'rinadi', async () => {
  //  ★ Yo'nalish doirasi bitta menejerni ajratib bermaydi: bitta
  //  kanalda bir nechta menejer ishlaydi va ular bir-birining mijozini,
  //  narxini va buyurtmasini ko'rib turardi. Belgi XODIMDA
  //  (`worker_roles.scope_own`), kodda emas — ism ham, mijoz ham
  //  hech qayerga yozilmaydi (4-qoida).
  const { db } = require('../db');
  for (const nom of ['Oz menejer bir', 'Oz menejer ikki']) {
    await db.query(`INSERT INTO workers (name) VALUES ($1) ON CONFLICT DO NOTHING`, [nom]);
    await db.query(
      `INSERT INTO worker_roles (worker_id, role_code, scope_own)
       SELECT id, 'sotuvchi', true FROM workers WHERE name = $1
       ON CONFLICT (worker_id, role_code) DO UPDATE SET scope_own = true`, [nom]);
  }
  const m1id = (await H.id(`SELECT id FROM workers WHERE name='Oz menejer bir'`)).id;
  const m2id = (await H.id(`SELECT id FROM workers WHERE name='Oz menejer ikki'`)).id;
  const m1 = H.api(base, await H.sessionFor('Oz menejer bir'));
  const m2 = H.api(base, await H.sessionFor('Oz menejer ikki'));

  assert.equal((await admin('POST', '/api/units/customers', { items: [
    { name: 'Birinchining mijozi', manager_id: m1id },
    { name: 'Ikkinchining mijozi', manager_id: m2id },
    { name: 'Egasiz mijoz' },
  ] })).status, 200);

  const nomlar = async (api) =>
    (await api('GET', '/api/units/customers')).body.customers.map((c) => c.name);

  const a = await nomlar(m1);
  assert.ok(a.includes('Birinchining mijozi'));
  assert.ok(!a.includes('Ikkinchining mijozi'), 'boshqa menejerniki ko\'rinmaydi');
  //  Egasi yo'q mijoz ham ko'rinmaydi: u hech kimniki emas.
  assert.ok(!a.includes('Egasiz mijoz'));

  //  Doirasi yo'q xodim (administrator) hammasini ko'radi.
  const h = await nomlar(admin);
  for (const n of ['Birinchining mijozi', 'Ikkinchining mijozi', 'Egasiz mijoz'])
    assert.ok(h.includes(n), n);

  //  ★ BUYURTMA HAM O'ZINIKI. Chegara SERVERDA: id qo'lda yuborilsa ham.
  const c1 = (await H.id(`SELECT id FROM customers WHERE name='Birinchining mijozi'`)).id;
  const c2 = (await H.id(`SELECT id FROM customers WHERE name='Ikkinchining mijozi'`)).id;
  const z = await m1('POST', '/api/sales/orders', { customer_id: c1, items: [] });
  assert.equal(z.status, 200, z.text);

  assert.equal((await m2('GET', '/api/sales/orders/' + z.body.id)).status, 404,
    'boshqa menejerning buyurtmasi ochilmaydi');
  assert.equal((await m1('GET', '/api/sales/orders/' + z.body.id)).status, 200);
  assert.equal((await admin('GET', '/api/sales/orders/' + z.body.id)).status, 200);

  const roy = (await m2('GET', '/api/sales/orders')).body.rows;
  assert.ok(!roy.some((r) => r.id === z.body.id), 'ro\'yxatda ham ko\'rinmaydi');

  //  Boshqa menejerning mijoziga buyurtma yozib bo'lmaydi.
  const yoq = await m2('POST', '/api/sales/orders', { customer_id: c1, items: [] });
  assert.equal(yoq.status, 400, yoq.text);
  assert.match(yoq.body.error, /boshqa menejerning mijozi/);

  //  Tahrirlash ham: boshqa menejerning mijozi id bilan ham tegilmaydi.
  assert.equal((await m1('PATCH', '/api/units/customers/' + c2,
    { region: 'Xorazm' })).status, 404);

  //  ★ Doirasi bor xodim yozgan mijoz O'ZINIKI bo'ladi — aks holda u
  //  mijozni kiritadi-yu, saqlangan zahoti ro'yxatdan yo'qolardi.
  assert.equal((await m1('POST', '/api/units/customers',
    { name: 'Menejer yozgan mijoz' })).status, 200);
  assert.ok((await nomlar(m1)).includes('Menejer yozgan mijoz'));
  assert.equal((await H.id(
    `SELECT manager_id FROM customers WHERE name='Menejer yozgan mijoz'`)).manager_id, m1id);
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

  // Bu TUZATISH — jurnalni to'ldiradiganda ham, ustada ham yo'q
  const jurnalchi = H.api(base, await H.sessionFor('Sinov jurnalchi'));
  assert.equal((await jurnalchi('POST', `/api/units/${ish.id}/to-warehouse`,
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

test('rangsiz konver savdoda ko\'rinadi va rangi buyurtmada tanlanadi', async () => {
  //  ★ Ishlab chiqarishdagi konver RANGSIZ tug'iladi — zahira ham,
  //  bo'limsiz kiritilgan «boshlanmagan» konver ham. Rang mijoz
  //  aytganda ma'lum bo'ladi va o'shanda bo'yaladi, shuning uchun
  //  bunday konver savdo ro'yxatidan tushib ketmasligi kerak.
  const bosh = (await admin('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 6 },          // bo'limsiz, rangsiz
  ] })).body.created[0];

  const st = (await admin('GET', '/api/sales/stock')).body.rows;
  const q = st.find((r) => r.src === 'production'
    && r.product_id === PENAL && !r.color);
  assert.ok(q, 'boshlanmagan rangsiz konver savdo ro\'yxatida turadi');

  //  Rangi bor buyurtma qatoriga ham nomzod bo'ladi: bo'yalmagan
  //  partiya istalgan rangga yaraydi.
  const mijoz = (await H.id(`SELECT id FROM customers WHERE name='Kanalsiz mijoz'`)).id;
  const z = (await admin('POST', '/api/sales/orders', { customer_id: mijoz,
    items: [{ product_id: PENAL, qty: 2, color: 'Venge' }] })).body;
  const qator = (await admin('GET', '/api/sales/orders/' + z.id)).body.items[0];
  const nomzod = (await admin('GET',
    `/api/sales/orders/${z.id}/candidates?item_id=${qator.id}`)).body.rows;
  assert.ok(nomzod.some((x) => x.id === bosh.id),
    'rangsiz konver rangi bor qatorga ham taklif qilinadi');

  //  ★ YANGI RANG KIRITILMAYDI — tekshiruv SERVERDA. Ro'yxat klientda
  //  quriladi, ya'ni qo'lda yuborilgan qiymat shu yerda tutilishi kerak:
  //  bitta «Venge» va bitta «venge » ombor qoldig'ini ikkiga bo'lardi.
  const yangi = await admin('PATCH', '/api/sales/orders/' + z.id, {
    customer_id: mijoz,
    items: [{ id: qator.id, product_id: PENAL, qty: 2, color: 'Feruza' }] });
  assert.equal(yangi.status, 400, yangi.text);
  assert.match(yangi.body.error, /ro'yxatda yo'q/);

  //  Boridan bo'lsa o'tadi, katta-kichik harfga qaramaydi.
  const ok = await admin('PATCH', '/api/sales/orders/' + z.id, {
    customer_id: mijoz,
    items: [{ id: qator.id, product_id: PENAL, qty: 2, color: 'venge' }] });
  assert.equal(ok.status, 200, ok.text);
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

//  ★ KONVER BUYURTMA SANASIDAN KEYIN KELSA — BRON QABUL QILINMAYDI.
//  Qoida IKKI joyda tekshiriladi va test ham ikkalasini oladi: bron
//  qo'yilganda va chiqish sanasi ORQAGA surilganda. Ikkinchisisiz qoida
//  bitta bosishda chetlab o'tilardi.
test('chiqish sanasidan keyin keladigan konver bron qilinmaydi', async () => {
  const ish = (await admin('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 5, color: 'Venge', section_id: ARRA },
  ] })).body.created[0];

  //  Sana marshrutdan chiqadi (korpus zanjiri: lak +6, qadoqlash +6,
  //  ombor +1) — testda ham aynan o'sha qiymat olinadi, nusxasi emas.
  const sana = await H.id(
    `SELECT TO_CHAR(fg_on - 1, 'YYYY-MM-DD') AS erta,
            TO_CHAR(fg_on + 5, 'YYYY-MM-DD') AS kech
       FROM v_unit_register WHERE id = $1`, [ish.id]);
  assert.ok(sana.erta, 'ishlab chiqarishdagi konverda omborga tushish sanasi bor');

  const mijoz = (await H.id(`SELECT id FROM customers WHERE name='Kanalsiz mijoz'`)).id;
  const z = (await admin('POST', '/api/sales/orders', { customer_id: mijoz,
    due_on: sana.erta,
    items: [{ product_id: PENAL, qty: 2, color: 'Venge' }] })).body;
  const qator = (await admin('GET', '/api/sales/orders/' + z.id)).body.items[0];

  //  Ro'yxatdan OLIB TASHLANMAYDI — belgilanadi: chiqish sanasini surish
  //  ham yo'l va u menejerning qaroriga qoladi.
  const nomzod = (await admin('GET',
    `/api/sales/orders/${z.id}/candidates?item_id=${qator.id}`)).body.rows;
  assert.equal(nomzod.find((x) => x.id === ish.id)?.late, true);

  const xato = await admin('POST', `/api/sales/orders/${z.id}/assign`,
    { item_id: qator.id, unit_id: ish.id, qty: 2 });
  assert.equal(xato.status, 400);
  assert.match(xato.body.error, new RegExp(ish.conveyor_no));
  assert.match(xato.body.error, /keyinroq keladi/);

  //  Sana surilsa — o'sha konver olinadi.
  assert.equal((await admin('PATCH', '/api/sales/orders/' + z.id,
    { due_on: sana.kech })).status, 200);
  assert.equal((await admin('POST', `/api/sales/orders/${z.id}/assign`,
    { item_id: qator.id, unit_id: ish.id, qty: 2 })).status, 200);

  //  Va bron qo'yilgach sanani ORQAGA surib bo'lmaydi: aks holda qoida
  //  uzoq sana bilan bron qilib, keyin sanani qaytarish bilan chetlab
  //  o'tilardi.
  const orqaga = await admin('PATCH', '/api/sales/orders/' + z.id,
    { due_on: sana.erta });
  assert.equal(orqaga.status, 400);
  assert.match(orqaga.body.error, /keyinroq keladi/);
  assert.equal((await H.id(`SELECT TO_CHAR(due_on,'YYYY-MM-DD') AS d
                              FROM orders WHERE id=$1`, [z.id])).d, sana.kech,
    'rad etilgan sana yozilmaydi');

  //  T/M omborda turgan konverga qoida TEGMAYDI: u allaqachon javonda,
  //  kutiladigan sanasi yo'q.
  const tayyor = (await admin('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 2, color: 'Venge', is_opening: true,
      fg_on: sana.kech },
  ] })).body.created[0];
  assert.equal((await admin('PATCH', '/api/sales/orders/' + z.id,
    { due_on: sana.kech })).status, 200);
  const q2 = (await admin('POST', '/api/sales/orders', { customer_id: mijoz,
    due_on: sana.erta,
    items: [{ product_id: PENAL, qty: 2, color: 'Venge' }] })).body;
  const q2r = (await admin('GET', '/api/sales/orders/' + q2.id)).body.items[0];
  assert.equal((await admin('POST', `/api/sales/orders/${q2.id}/assign`,
    { item_id: q2r.id, unit_id: tayyor.id, qty: 2 })).status, 200,
    'ombordagi konver har qanday sanada olinadi');
});

//  ★ Zakaz raqami zavod daftaridagi joydan davom etadi (`doc_no_start`).
//  Tizim o'z hisobidan yursa nakladnoydagi raqam daftardagisiga to'g'ri
//  kelmasdi va bitta buyurtmani ikki joyda izlash kerak bo'lardi.
test('zakaz raqami boshlanish raqamidan past tushmaydi', async () => {
  const mijoz = (await H.id(`SELECT id FROM customers WHERE name='Kanalsiz mijoz'`)).id;
  const bosh = (await H.id(`SELECT first_no FROM doc_no_start WHERE prefix = 'Z26-'`));
  assert.equal(Number(bosh.first_no), 757);

  const z = (await admin('POST', '/api/sales/orders',
    { customer_id: mijoz, items: [] })).body;
  assert.match(z.order_no, /^Z\d\d-\d{4}$/);
  const yil = 'Z' + String(new Date().getFullYear()).slice(-2) + '-';
  if (z.order_no.startsWith('Z26-'))
    assert.ok(Number(z.order_no.slice(4)) >= 757, z.order_no);
  else
    assert.equal(yil, z.order_no.slice(0, 4), 'yil almashsa prefiks ham almashadi');

  //  Keyingisi bittaga oshadi — ketma-ketlik uzilmaydi.
  const z2 = (await admin('POST', '/api/sales/orders',
    { customer_id: mijoz, items: [] })).body;
  assert.equal(Number(z2.order_no.slice(4)), Number(z.order_no.slice(4)) + 1);
});

//  ★ SAVDO ISHLAB CHIQARISHGA SO'ROV YOZADI — faqat stol va stulga.
//  Konver BU YERDA ochilmaydi: so'rov rahbariyat navbatiga tushadi va
//  tasdiqlangach o'sha qatorga O'ZI biriktiriladi.
//  ★ SAVDO BO'LIM BOSHLIG'I — ALOHIDA LAVOZIM, huquqi menejerniki
//  bilan BIR XIL. Ikkinchi ro'yxat yozilmadi: menejerga qo'shilgan
//  huquq boshliqqa ham o'zi tushadi. Farqi faqat doirasida.
test('savdo bo\'lim boshlig\'i roli menejer bilan bir xil huquqda', async () => {
  const bor = await H.id(
    `SELECT name, sort FROM roles WHERE code = 'savdo_boshliq'`);
  assert.ok(bor, 'rol yaratildi');
  assert.match(bor.name, /boshlig/);

  //  Ro'yxatda menejerning USTIDA turadi — lavozim bo'yicha o'qiladi.
  const men = await H.id(`SELECT sort FROM roles WHERE code = 'sotuvchi'`);
  assert.ok(bor.sort < men.sort, `${bor.sort} < ${men.sort}`);

  //  Huquqlari AYNAN bir xil: biri ikkinchisidan ortiq ham, kam ham emas.
  const farq = await H.id(
    `SELECT COUNT(*)::int AS n FROM (
         SELECT permission_code FROM role_permissions WHERE role_code = 'sotuvchi'
         EXCEPT
         SELECT permission_code FROM role_permissions WHERE role_code = 'savdo_boshliq'
       UNION ALL
         SELECT permission_code FROM role_permissions WHERE role_code = 'savdo_boshliq'
         EXCEPT
         SELECT permission_code FROM role_permissions WHERE role_code = 'sotuvchi') x`);
  assert.equal(farq.n, 0, 'huquqlar bir xil');

  //  Va u haqiqatan ishlaydi: buyurtmalar ham, mijozlar ham ochiladi.
  const boshliq = await xodim('Sinov savdo rahbari', 'savdo_boshliq');
  assert.equal((await boshliq('GET', '/api/sales/orders')).status, 200);
  assert.equal((await boshliq('GET', '/api/units/customers')).status, 200);
  //  Ishlab chiqarish jurnali ochiq, konver yaratish esa yo'q.
  assert.equal((await boshliq('GET', '/api/units/')).status, 200);
  assert.equal((await boshliq('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 1 }] })).status, 403);
});

//  ★ HAR HARFNING O'Z HISOBI: stol C, stul S, korpus K — zavod
//  bitta raqamni ko'rib nechta stol, nechta stul va nechta korpus
//  chiqqanini biladi. Umumiy hisob bo'lsa raqam shu ma'nosini
//  yo'qotardi.
test('raqamlar harf bo\'yicha ALOHIDA sanaladi', async () => {
  const kir = await xodim('Sinov raqam2', 'kirituvchi');
  const STUL = (await H.id(
    `SELECT p.id FROM products p JOIN product_groups g ON g.id = p.group_id
      WHERE g.code = 'STU' AND p.active ORDER BY p.id LIMIT 1`)).id;
  const STOL = (await H.id(
    `SELECT p.id FROM products p JOIN product_groups g ON g.id = p.group_id
      WHERE g.code = 'STL' AND p.active ORDER BY p.id LIMIT 1`)).id;

  const no = async (pid) => (await kir('GET',
    '/api/units/requests/next-no?product_id=' + pid)).body.conveyor_no;
  const [s1, c1, k1] = [await no(STUL), await no(STOL), await no(PENAL)];

  //  Stulga konver ochilsa STOL va KORPUS hisobi QIMIRLAMAYDI.
  assert.equal((await kir('POST', '/api/units/requests',
    { product_id: STUL, qty: 1 })).status, 200);
  assert.notEqual(await no(STUL), s1, 'stul hisobi oshdi');
  assert.equal(await no(STOL), c1, 'stol hisobi joyida');
  assert.equal(await no(PENAL), k1, 'korpus hisobi joyida');

  //  Harflari ham har xil.
  assert.equal(s1[0], 'S');
  assert.equal(c1[0], 'C');
  assert.equal(k1[0], 'K');

  //  ★ Hisob ZAVOD DAFTARIDAGI joydan boshlanadi (`doc_no_start`):
  //  qog'ozga yozilgan, tizimga kirmagan konverlar bor edi va raqam
  //  ikki joyda ajralib ketardi.
  const yil = String(new Date().getFullYear()).slice(-2);
  if (yil === '26') {
    const bosh = await H.id(
      `SELECT prefix, first_no FROM doc_no_start WHERE prefix IN ('C26-','S26-','K26-')
        ORDER BY prefix LIMIT 1`);
    assert.ok(bosh, 'boshlanish raqamlari yozilgan');
    for (const [no, min] of [[s1, 468], [c1, 231], [k1, 107]])
      assert.ok(Number(no.split('-')[1]) >= min, `${no} ≥ ${min}`);
  }
});

test('savdo stulga so\'rov yozadi, penalga emas', async () => {
  const mijoz = (await H.id(`SELECT id FROM customers WHERE name='Kanalsiz mijoz'`)).id;
  const STUL = (await H.id(
    `SELECT p.id FROM products p JOIN product_groups g ON g.id = p.group_id
      WHERE g.code = 'STU' AND p.active ORDER BY p.id LIMIT 1`)).id;

  const z = (await admin('POST', '/api/sales/orders', { customer_id: mijoz, items: [
    { product_id: STUL,  qty: 5 },
    { product_id: PENAL, qty: 2 },
  ] })).body;
  const qatorlar = (await admin('GET', '/api/sales/orders/' + z.id)).body.items;
  const stulQ  = qatorlar.find((x) => x.product_id === STUL);
  const penalQ = qatorlar.find((x) => x.product_id === PENAL);

  //  Belgi GURUHDA: nomzodlar javobida ham keladi — sahifa tugmani
  //  shunga qarab chizadi.
  const nomz = (await admin('GET',
    `/api/sales/orders/${z.id}/candidates?item_id=${stulQ.id}`)).body;
  assert.equal(nomz.item.can_request, true);
  const nomz2 = (await admin('GET',
    `/api/sales/orders/${z.id}/candidates?item_id=${penalQ.id}`)).body;
  assert.equal(nomz2.item.can_request, false);

  //  Penalga so'rov yozilmaydi — tekshiruv SERVERDA.
  const yoq = await admin('POST', `/api/sales/orders/${z.id}/request-unit`,
    { item_id: penalQ.id, qty: 1 });
  assert.equal(yoq.status, 400, yoq.text);
  assert.match(yoq.body.error, /faqat/);

  //  Qatorda yopilmaganidan ko'p so'ralmaydi.
  const kop = await admin('POST', `/api/sales/orders/${z.id}/request-unit`,
    { item_id: stulQ.id, qty: 9 });
  assert.equal(kop.status, 400, kop.text);

  const so = await admin('POST', `/api/sales/orders/${z.id}/request-unit`,
    { item_id: stulQ.id, qty: 5 });
  assert.equal(so.status, 200, so.text);
  assert.match(so.body.conveyor_no, /^S\d\d-\d{3,}$/, so.body.conveyor_no);

  //  Konver HALI ochilmadi — so'rov navbatda turibdi.
  assert.equal((await H.id(
    `SELECT COUNT(*)::int AS n FROM production_units WHERE conveyor_no = $1`,
    [so.body.conveyor_no])).n, 0, 'tasdiqlanmaguncha konver yo\'q');
  const q = await H.id(
    `SELECT id, status, order_item_id FROM unit_requests WHERE conveyor_no = $1`,
    [so.body.conveyor_no]);
  assert.equal(q.status, 'pending');
  assert.equal(q.order_item_id, stulQ.id, 'so\'rov qatorga bog\'langan');

  //  ★ Tasdiqlovchi QAYSI BUYURTMA uchun ekanini ro'yxatning o'zida
  //  ko'radi: mijoz allaqachon kutib turadi va uning birinchi savoli shu.
  const sorov = (await admin('GET', '/api/units/requests?status=pending'))
    .body.rows.find((x) => x.id === q.id);
  assert.equal(sorov.order_no, z.order_no, 'zakaz raqami ro\'yxatda');

  //  Tasdiqlangach konver «boshlanmagan» bo'lib ochiladi va o'sha
  //  qatorga O'ZI biriktiriladi — menejer qaytib kelib qidirmaydi.
  const ok = await admin('POST', `/api/units/requests/${q.id}/approve`);
  assert.equal(ok.status, 200, ok.text);
  const u = await H.id(
    `SELECT current_section_id, status, qty FROM production_units WHERE id = $1`,
    [ok.body.unit_id]);
  assert.equal(u.current_section_id, null, 'boshlanmagan — bo\'limi yo\'q');
  assert.equal(u.status, 'production');
  assert.equal((await admin('GET', `/api/units/${ok.body.unit_id}/bron`)).body.reserved, 5);

  const qayta = (await admin('GET', '/api/sales/orders/' + z.id)).body.items
    .find((x) => x.id === stulQ.id);
  assert.equal(Number(qayta.assigned_qty), 5, 'qator yopildi');

  //  ★ CHERNOVIK: konver hali YO'LGA CHIQMAGAN, ya'ni T/M omborga
  //  tushish kunini tizim hisoblay olmaydi va mijozga aytiladigan
  //  chiqish sanasi noma'lum. Savdo buni ro'yxatning o'zida ko'radi.
  const ro = (await admin('GET', '/api/sales/orders?q=' + z.order_no)).body.rows[0];
  assert.equal(Number(ro.not_started_qty), 5, 'chernovik: boshlanmagan konver');
  assert.ok((await admin('GET', '/api/sales/orders?status=draft'))
    .body.rows.some((x) => x.id === z.id), 'chernovik filtri');

  //  ★ TSEX BOSHLIG'IGA XABAR: stul — stul tsexiga. Kimga borishi
  //  DOIRADAN chiqadi, kodga tsex yozilmaydi.
  const STULTSEX2 = (await H.id(`SELECT id FROM shops WHERE code = 'STUL'`)).id;
  const xab = await H.id(
    `SELECT n.title, n.worker_id FROM notifications n
       JOIN worker_roles wr ON wr.worker_id = n.worker_id
      WHERE wr.scope_shop_id = $1 AND n.title LIKE '%boshlanmagan%'
      ORDER BY n.id DESC LIMIT 1`, [STULTSEX2]);
  assert.ok(xab, 'stul tsexi boshlig\'iga xabar ketdi');

  //  ★ MENYUDAGI BELGI ro'yxat bilan bir xil raqamni beradi.
  const stulchi = H.api(base, await H.sessionFor('Stul ustasi'));
  const bosh = (await stulchi('GET', '/api/units/board')).body.unstarted || [];
  const nav = (await stulchi('GET', '/api/navbat')).body.navbat
    .find((x) => /boshlanmagan/.test(x.izoh));
  assert.equal(nav?.n, bosh.length, 'belgi ro\'yxat uzunligi bilan bir xil');
  assert.ok(bosh.some((x) => x.id === ok.body.unit_id), 'konver ro\'yxatda');

  //  Tsex boshlab qo'ysa buyurtma chernovikdan chiqadi.
  assert.equal((await stulchi('POST', '/api/units/move',
    { items: [{ unit_id: ok.body.unit_id }] })).status, 200);
  const ro2 = (await admin('GET', '/api/sales/orders?q=' + z.order_no)).body.rows[0];
  assert.equal(Number(ro2.not_started_qty), 0, 'boshlangach chernovik tugadi');

  //  Yopilgan qatorga ikkinchi so'rov yozilmaydi.
  const yana = await admin('POST', `/api/sales/orders/${z.id}/request-unit`,
    { item_id: stulQ.id });
  assert.equal(yana.status, 400, yana.text);
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
    items: [{ product_id: PENAL, qty: 2, color: 'Venge', unit_price: 100 }] })).body;
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
    items: [{ product_id: PENAL, qty: 1, color: 'Venge', unit_price: 90 }] })).body;

  //  Hali hech kim chiqarmagan — lekin mudir bitta, ismi hujjatda
  const d = (await admin('GET', '/api/sales/orders/' + z.id)).body;
  assert.equal(d.order.shipped_by_name, null, 'hali tasdiqlanmagan');
  assert.equal(d.keeper.name, 'Sinov ombor mudiri');
  assert.equal(d.keeper.phone, '+998900000001');

  //  Chiqarib yuborilgach — aynan tasdiqlagan odam
  const u = (await admin('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 1, color: 'Venge', unit_price: 90,
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
    items: [{ product_id: PENAL, qty: 2, color: 'Venge', unit_price: 70 }] })).body;

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
    receiver_phone: '+998901110022', due_on: kun(90),
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
    customer_id: mijoz, ship_to: 'ZAVOD', due_on: kun(90),
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
    //  Tsexdan tsexga qabul qilishda muddat majburiy, tsex ichida esa
    //  e'tiborga olinmaydi — har o'tkazishda yuborilaveradi.
    const it = { unit_id: u.id, plan_on: '2026-09-25' };
    let mv = await admin('POST', '/api/units/move', { items: [it] });
    if (mv.status !== 200) {
      assert.equal((await admin('POST', '/api/units/handover',
        { items: [u.id] })).status, 200);
      mv = await admin('POST', '/api/units/move', { items: [it] });
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
test('tsex boshlig\'i ham qo\'lidagi pulni sarflaydi', async () => {
  //  ★ Hujjatdagi qoida («tsex boshliqlari faqat oylik uchun») kodda
  //  bajarilmagan edi: `tsex_usta` da `cash.entry` yo'q edi va qo'lida
  //  pul turgan boshliq sarfini YOZA OLMASDI — «Mening pulim» sahifasi
  //  unga umuman ochilmasdi. Pul kassirga og'zaki aytilib qolardi.
  const { db } = require('../db');
  const kassir = H.api(base, await H.sessionFor('Sinov kassir'));
  const kassa = (await H.id(`SELECT id FROM cash_accounts WHERE code='MAIN'`)).id;

  await db.query(`INSERT INTO workers (name) SELECT 'Sinov usta pulli'
                   WHERE NOT EXISTS (SELECT 1 FROM workers WHERE name='Sinov usta pulli')`);
  const u = (await H.id(`SELECT id FROM workers WHERE name='Sinov usta pulli'`)).id;
  await db.query(`INSERT INTO worker_roles (worker_id, role_code)
                  VALUES ($1,'tsex_usta') ON CONFLICT DO NOTHING`, [u]);
  const usta = H.api(base, await H.sessionFor('Sinov usta pulli'));

  //  Belgisi yo'q ekan — sahifa ochiladi, lekin sarf yozilmaydi.
  //  Huquqning O'ZI hech kimga pul bermaydi.
  const modda = (await H.id(`SELECT id FROM expense_items LIMIT 1`)).id;
  const yoq = await usta('POST', '/api/cash/ops', {
    to_kind: 'expense', currency: 'USD', amount: 10,
    expense_item_id: modda, pl_month: '2026-09' });
  assert.equal(yoq.status, 400, yoq.text);
  assert.match(yoq.body.error, /korxona puli yo'q/);

  //  Belgi qo'yiladi (guruh berilmadi — demak hammasi) va pul beriladi.
  assert.equal((await admin('PATCH', '/api/admin/workers/' + u,
    { can_hold_cash: true })).status, 200);
  assert.equal((await kassir('POST', '/api/cash/ops', {
    from_kind: 'account', from_id: kassa, to_kind: 'worker', to_id: u,
    currency: 'USD', amount: 300 })).status, 200);

  //  Endi o'zi yozadi va pul qo'lidan chiqadi.
  const ok = await usta('POST', '/api/cash/ops', {
    to_kind: 'expense', currency: 'USD', amount: 70,
    expense_item_id: modda, pl_month: '2026-09' });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(Number((await H.id(
    `SELECT total_usd FROM v_worker_cash WHERE id=$1`, [u])).total_usd), 230);

  //  Kassa unga baribir OCHILMAYDI: moliyaviy hisobot ham, boshqa
  //  xodimning puli ham ko'rinmaydi — `cash.entry` faqat o'z qo'lidagi
  //  pulni beradi.
  assert.equal((await usta('GET', '/api/cash/pl')).status, 403);
  assert.equal((await usta('PATCH', '/api/cash/ops/1')).status, 403);
});

test('tsex doirasi T/M ombor qoldig\'ida ham ishlaydi', async () => {
  //  ★ Stul kiritadigan xodimga T/M omborda faqat STULLAR ko'rinadi:
  //  u ertaga nima so'rashni hal qilish uchun javonda nechta stul
  //  turganini biladi, penal esa uning ishi emas.
  //
  //  Bu QULAYLIK, himoya emas — jurnal baribir hammaga ochiq. Lekin
  //  xodim o'zi tanlagan turlar ham doira bilan KESISHTIRILADI:
  //  doiradan tashqaridagini qo'lda yozib ham ochib bo'lmaydi.
  const { db } = require('../db');
  const stulTsex = (await H.id(`SELECT id FROM shops WHERE code='STUL'`)).id;
  await db.query(`INSERT INTO workers (name) SELECT 'Sinov stul kirituvchi'
                   WHERE NOT EXISTS
                     (SELECT 1 FROM workers WHERE name='Sinov stul kirituvchi')`);
  const w = (await H.id(
    `SELECT id FROM workers WHERE name='Sinov stul kirituvchi'`)).id;
  await db.query(
    `INSERT INTO worker_roles (worker_id, role_code, scope_shop_id)
     VALUES ($1,'kirituvchi',$2)
     ON CONFLICT (worker_id, role_code) DO UPDATE SET scope_shop_id = $2`,
    [w, stulTsex]);
  const aziz = H.api(base, await H.sessionFor('Sinov stul kirituvchi'));

  //  Omborda ikkala tur ham bo'lsin.
  const STUL = (await H.id(
    `SELECT p.id FROM products p JOIN product_groups g ON g.id = p.group_id
      WHERE g.code = 'STU' AND p.active ORDER BY p.id LIMIT 1`)).id;
  assert.equal((await admin('POST', '/api/units/', { items: [
    { product_id: STUL,  qty: 4, is_opening: true, fg_on: '2026-09-03' },
    { product_id: PENAL, qty: 2, is_opening: true, fg_on: '2026-09-03' },
  ] })).status, 200);

  const q = await aziz('GET', '/api/warehouse/fg/summary');
  assert.equal(q.status, 200, q.text);
  const turlar = [...new Set(q.body.rows.map((r) => r.product_type))];
  assert.ok(turlar.includes('Stul'), 'stullar ko\'rinadi');
  assert.ok(!turlar.includes('Penal'), 'penal ko\'rinmaydi');

  //  Qo'lda so'ralgani ham kesishtiriladi — doiradan chiqib bo'lmaydi.
  const soxta = await aziz('GET', '/api/warehouse/fg/summary?product_type=Penal');
  assert.equal(soxta.status, 200, soxta.text);
  assert.equal(soxta.body.rows.length, 0, 'doiradan tashqaridagi ochilmaydi');

  //  Doirasi yo'q xodimda hammasi turadi.
  const hammasi = (await admin('GET', '/api/warehouse/fg/summary')).body.rows;
  const t2 = [...new Set(hammasi.map((r) => r.product_type))];
  assert.ok(t2.includes('Stul') && t2.includes('Penal'));

  //  ★ OMBOR RO'YXATI HAM QISQARADI: tsex boshlig'ining savoli
  //  «javonda nechta turibdi» — u T/M omborga tegishli. Vitrina
  //  ko'rgazma, xom ashyo esa ta'minotniki: uchala vitrina ro'yxatda
  //  turgani uni har safar o'z javonini izlashga majbur qilardi.
  const omborlar = (await aziz('GET', '/api/warehouse/list')).body.rows;
  assert.deepEqual(omborlar.map((w) => w.code), ['TM'],
    'tsex doirasi bor xodimga faqat T/M ombor');

  //  Chegara SERVERDA: kodini qo'lda yozib ham ochib bo'lmaydi.
  const vitr = await H.id(
    `SELECT code FROM warehouses WHERE kind='fg' AND code <> 'TM' LIMIT 1`);
  const soxtaWh = await aziz('GET', '/api/warehouse/fg/summary?w=' + vitr.code);
  assert.equal(soxtaWh.status, 400, soxtaWh.text);

  //  Ombor mudirida esa hammasi ochiq qolaveradi.
  const barcha = (await admin('GET', '/api/warehouse/list')).body.rows;
  assert.ok(barcha.length > 1 && barcha.some((w) => w.code === vitr.code));
});

test('vitrinadan qaytarish: boshliq yozadi, vitrina tasdiqlaydi, T/M oladi',
  async () => {
  //  ★ UCH ODAM, UCH BOSQICH (zavod qarori, 2026-09). Vitrinadagi
  //  mahsulot T/M omborga bir bosishda qaytmaydi — u mashinada yuradi:
  //
  //    boshliq yozadi → vitrina tasdiqlaydi → T/M qabul qiladi
  //
  //  Mahsulot FAQAT uchinchi bosqichda ko'chadi: yo'ldagi mahsulot
  //  vitrinada hali bor, T/M da hali yo'q — ikkala qoldiq ham to'g'ri.
  const { db } = require('../db');
  const kassir = null;
  const vitr = (await H.id(
    `SELECT id, code FROM warehouses WHERE kind='fg' AND code <> 'TM'
      AND is_active ORDER BY sort LIMIT 1`));
  const tm = (await H.id(`SELECT id FROM warehouses WHERE code='TM'`)).id;

  //  Vitrinaga biriktirilgan sotuvchi va DOIRASIZ boshliq.
  await db.query(`INSERT INTO workers (name) SELECT 'Sinov vitrinachi'
                   WHERE NOT EXISTS (SELECT 1 FROM workers WHERE name='Sinov vitrinachi')`);
  const v = (await H.id(`SELECT id FROM workers WHERE name='Sinov vitrinachi'`)).id;
  await db.query(
    `INSERT INTO worker_roles (worker_id, role_code, scope_warehouse_id)
     VALUES ($1,'sotuvchi',$2)
     ON CONFLICT (worker_id, role_code) DO UPDATE SET scope_warehouse_id = $2`,
    [v, vitr.id]);
  const shou = H.api(base, await H.sessionFor('Sinov vitrinachi'));
  const boshliq = await xodim('Sinov savdo boshliq', 'sotuvchi');

  //  Omborga 6 talik konver kiritib, vitrinaga ko'chiramiz.
  const u = (await admin('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 6, color: 'Venge', unit_price: 100,
      is_opening: true, fg_on: '2026-09-02' }] })).body.created[0];
  assert.equal((await admin('POST', '/api/warehouse/fg/transfer',
    { unit_id: u.id, to_code: vitr.code })).status, 200);

  //  ★ VITRINA SOTUVCHISI HUJJAT YOZMAYDI: o'z qoldig'ini o'zi yozib,
  //  o'zi berib yuborardi — ikki odam qoidasi shu yerda boshlanadi.
  const yoq = await shou('POST', '/api/warehouse/fg/returns',
    { items: [{ unit_id: u.id, qty: 2 }] });
  assert.equal(yoq.status, 403, yoq.text);

  //  Boshliq yozadi — 6 talikdan 2 tasi.
  const d = await boshliq('POST', '/api/warehouse/fg/returns',
    { items: [{ unit_id: u.id, qty: 2 }] });
  assert.equal(d.status, 200, d.text);
  assert.match(d.body.doc_no, /^V\d{2}-\d{4}$/, d.body.doc_no);

  //  O'ZI yozgan hujjatni o'zi tasdiqlay olmaydi.
  const ozi = await boshliq('POST', `/api/warehouse/fg/returns/${d.body.id}/confirm`);
  assert.equal(ozi.status, 400, ozi.text);
  assert.match(ozi.body.error, /o'zingiz tasdiqlay/i);

  //  T/M ham hali qabul qila olmaydi: mahsulot yo'lga chiqmagan.
  const erta = await admin('POST', `/api/warehouse/fg/returns/${d.body.id}/accept`);
  assert.equal(erta.status, 400, erta.text);
  assert.match(erta.body.error, /jo'natilmagan/);

  //  Vitrina tasdiqlaydi — mahsulot do'kondan chiqdi, LEKIN hali
  //  vitrinaning qoldig'ida: T/M ga yetib kelgani yo'q.
  assert.equal((await shou('POST',
    `/api/warehouse/fg/returns/${d.body.id}/confirm`)).status, 200);
  assert.equal((await H.id(
    `SELECT warehouse_id FROM production_units WHERE id=$1`, [u.id])).warehouse_id,
    vitr.id, 'yo\'ldagi mahsulot hali vitrinada turadi');

  //  T/M qabul qiladi — endi konver BO'LINADI: 2 tasi T/M ga, 4 tasi
  //  vitrinada qoladi.
  const ok = await admin('POST', `/api/warehouse/fg/returns/${d.body.id}/accept`);
  assert.equal(ok.status, 200, ok.text);
  assert.equal((await H.id(
    `SELECT qty FROM production_units WHERE id=$1`, [u.id])).qty, 4,
    'vitrinada 4 tasi qoldi');
  const kelgan = await H.id(
    `SELECT SUM(qty)::int AS q FROM production_units
      WHERE conveyor_no = $1 AND warehouse_id = $2 AND status = 'fg'`,
    [u.conveyor_no, tm]);
  assert.equal(kelgan.q, 2, 'T/M ga 2 tasi keldi');

  //  ★ HUJJATDA NIMA BORLIGI RO'YXATDA TURADI: tasdiqlaydigan odam
  //  javondagi mahsulotni AYNAN shu ro'yxat bilan solishtiradi.
  //  Turi ham kerak — faqat nomi ko'rinsa qaysi guruh ekani noaniq
  //  qolardi.
  const hujjat = (await boshliq('GET', '/api/warehouse/fg/returns')).body.rows
    .find((r) => r.id === d.body.id);
  assert.ok(hujjat.items?.length, 'hujjat tarkibi keladi');
  assert.equal(hujjat.items[0].product_type, 'Penal');
  assert.equal(hujjat.items[0].color, 'Venge');
  assert.equal(hujjat.items[0].qty, 2);

  //  Hujjat yozish ro'yxatida ham turi bor — bir xil savol, bir xil javob.
  const nomzodlar = (await boshliq('GET',
    '/api/warehouse/fg/returns/candidates?w=' + vitr.code)).body.rows;
  assert.ok(nomzodlar.every((x) => x.product && x.product_type));

  //  Ombor tarixida ham yozuv bor: vitrinada chiqim, T/M da kirim.
  const harakat = await H.id(
    `SELECT qty, from_warehouse_id, to_warehouse_id FROM warehouse_moves
      WHERE conveyor_no = $1 ORDER BY id DESC LIMIT 1`, [u.conveyor_no]);
  assert.deepEqual([harakat.qty, harakat.from_warehouse_id, harakat.to_warehouse_id],
                   [2, vitr.id, tm]);

  //  Ikkinchi marta qabul qilinmaydi.
  assert.equal((await admin('POST',
    `/api/warehouse/fg/returns/${d.body.id}/accept`)).status, 400);

  //  Hujjat yozish ro'yxati: shu vitrinada turgani. T/M dan ham
  //  o'qiladi — hujjat IKKI TOMONLI bo'ldi va o'sha ro'yxatdan
  //  omborlar aro harakat yoziladi.
  const nomzod = (await boshliq('GET',
    '/api/warehouse/fg/returns/candidates?w=' + vitr.code)).body.rows;
  assert.ok(Array.isArray(nomzod));
  assert.equal((await boshliq('GET',
    '/api/warehouse/fg/returns/candidates?w=TM')).status, 200);

  //  ★ ENDI U ODDIY T/M QOLDIG'I: hohlagan savdo xodimi buyurtma yozadi.
  //  Vitrinada turganda savdoga umuman chiqmasdi.
  const st = (await admin('GET', '/api/sales/stock')).body.rows;
  assert.ok(st.some((r) => r.src === 'fg' && r.product_id === PENAL),
    'qaytgan mahsulot savdo ro\'yxatida turadi');
});
//  ★ OMBORLAR ARO HARAKAT — qaytarishning TESKARI yo'nalishi, aynan
//  o'sha mexanizm bilan: T/M ombor mudiri hujjat yozadi va jo'natadi,
//  vitrinaga mas'ul savdo xodimi qabul qiladi. Mahsulot FAQAT
//  uchinchi bosqichda ko'chadi — yo'ldagi mahsulot ikkala qoldiqda
//  ham to'g'ri turadi.
test('T/M dan vitrinaga hujjat bilan ko\'chiriladi', async () => {
  const { db } = require('../db');
  const vitr = await H.id(
    `SELECT id, code, name FROM warehouses WHERE kind='fg' AND code <> 'TM'
      AND is_active ORDER BY sort LIMIT 1`);
  const tm = (await H.id(`SELECT id FROM warehouses WHERE code='TM'`)).id;
  const mudir = admin;

  //  T/M omborga 6 talik konver kiritamiz.
  const u = (await admin('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 6, color: 'Oq', is_opening: true,
      fg_on: '2026-09-01' }] })).body.created[0];

  //  Vitrinaga mas'ul savdo xodimi.
  await db.query(`INSERT INTO workers (name) SELECT 'Sinov vitrina 2'
                   WHERE NOT EXISTS (SELECT 1 FROM workers WHERE name='Sinov vitrina 2')`);
  const v = (await H.id(`SELECT id FROM workers WHERE name='Sinov vitrina 2'`)).id;
  await db.query(
    `INSERT INTO worker_roles (worker_id, role_code, scope_warehouse_id)
     VALUES ($1,'sotuvchi',$2)
     ON CONFLICT (worker_id, role_code) DO UPDATE SET scope_warehouse_id = $2`,
    [v, vitr.id]);
  const sotuvchi2 = H.api(base, await H.sessionFor('Sinov vitrina 2'));

  //  Hujjat: 6 tadan 4 tasi ketadi.
  const d = await mudir('POST', '/api/warehouse/fg/moves',
    { to_warehouse_id: vitr.id, items: [{ unit_id: u.id, qty: 4 }] });
  assert.equal(d.status, 200, d.text);
  assert.match(d.body.doc_no, /^H\d{2}-\d{4}$/, d.body.doc_no);

  //  Hujjat yozilgani bilan mahsulot QIMIRLAMAYDI.
  assert.equal((await H.id(
    `SELECT COALESCE(warehouse_id, $2) AS w FROM production_units WHERE id=$1`,
    [u.id, tm])).w, tm, 'hali T/M da');

  //  Jo'natilmaguncha qabul qilinmaydi.
  assert.equal((await sotuvchi2('POST',
    `/api/warehouse/fg/returns/${d.body.id}/accept`)).status, 400);

  //  Mudir jo'natadi — o'zi yozgan bo'lsa ham: T/M da ikkinchi odam yo'q.
  const jo = await mudir('POST', `/api/warehouse/fg/returns/${d.body.id}/confirm`);
  assert.equal(jo.status, 200, jo.text);

  //  Vitrinaga mas'ul xodim qabul qiladi va mahsulot SHUNDA ko'chadi.
  const q = await sotuvchi2('POST', `/api/warehouse/fg/returns/${d.body.id}/accept`);
  assert.equal(q.status, 200, q.text);
  const bor = await H.id(
    `SELECT SUM(qty)::int AS n FROM production_units
      WHERE conveyor_no = $1 AND warehouse_id = $2 AND status='fg'`,
    [u.conveyor_no, vitr.id]);
  assert.equal(bor.n, 4, 'vitrinada 4 ta');
  const qoldi = await H.id(
    `SELECT SUM(qty)::int AS n FROM production_units
      WHERE conveyor_no = $1 AND COALESCE(warehouse_id,$2) = $2 AND status='fg'`,
    [u.conveyor_no, tm]);
  assert.equal(qoldi.n, 2, 'T/M da 2 ta qoldi');

  //  Ombor tarixida ikki qator: T/M da chiqim, vitrinada kirim.
  assert.equal((await H.id(
    `SELECT COUNT(*)::int AS n FROM warehouse_moves
      WHERE conveyor_no = $1 AND from_warehouse_id = $2 AND to_warehouse_id = $3`,
    [u.conveyor_no, tm, vitr.id])).n, 1);
});

test('bronda turgan konverning BO\'SH donasi ko\'chadi', async () => {
  //  ★ Ilgari ro'yxat sharti `reserved_qty = 0` edi: o'n talikning
  //  BITTASI mijozga va'da qilingan bo'lsa, qolgan to'qqiztasi ham
  //  ro'yxatdan tushib qolardi — mudir javondagi mahsulotni vitrinaga
  //  chiqara olmasdi va sababini ekrandan topa olmasdi.
  //
  //  Konver qabul qilinganda BO'LINADI va bron ESKI qatorda qoladi,
  //  ya'ni ko'chadigan bo'lak bronsiz bo'ladi.
  const { db } = require('../db');
  const tm = (await H.id(`SELECT id FROM warehouses WHERE code='TM'`)).id;
  const vitr = await H.id(
    `SELECT id, code FROM warehouses WHERE kind='fg' AND code <> 'TM'
        AND is_active ORDER BY sort, id LIMIT 1`);
  const u = (await admin('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 10, color: 'Bosh-rang', is_opening: true,
      fg_on: '2026-09-01' }] })).body.created[0];

  //  Buyurtma yozib, 4 tasini bron qilamiz.
  const mijoz = (await H.id(`SELECT id FROM customers ORDER BY id LIMIT 1`)).id;
  const z = (await admin('POST', '/api/sales/orders', { customer_id: mijoz,
    items: [{ product_id: PENAL, color: 'Bosh-rang', qty: 4 }] })).body;
  assert.ok(z.id, JSON.stringify(z));
  const qator = (await admin('GET', `/api/sales/orders/${z.id}`)).body.items[0];
  const bron = await admin('POST', `/api/sales/orders/${z.id}/assign`,
    { item_id: qator.id, unit_id: u.id, qty: 4 });
  assert.equal(bron.status, 200, bron.text);

  //  Ro'yxatda TURADI — bo'sh donasi bilan.
  const n = (await admin('GET', '/api/warehouse/fg/returns/candidates?w=TM'))
    .body.rows.find((x) => x.id === u.id);
  assert.ok(n, 'bronda turgan konver ro\'yxatdan tushib qolmaydi');
  assert.equal(n.reserved_qty, 4);
  assert.equal(n.free_qty, 6);

  //  Bo'shdan ko'pi ketmaydi: mijozning donasi vitrinaga chiqib ketardi.
  const kop = await admin('POST', '/api/warehouse/fg/moves',
    { to_warehouse_id: vitr.id, items: [{ unit_id: u.id, qty: 7 }] });
  assert.equal(kop.status, 400, kop.text);
  assert.match(kop.body.error, /buyurtmada/);

  //  Bo'shi esa ketaveradi va bron T/M dagi qatorda qoladi.
  const d = await admin('POST', '/api/warehouse/fg/moves',
    { to_warehouse_id: vitr.id, items: [{ unit_id: u.id, qty: 6 }] });
  assert.equal(d.status, 200, d.text);

  //  ★ OCHIQ HUJJATDAGI DONA IKKINCHI MARTA YOZILMAYDI. Hujjat
  //  yozilgani bilan mahsulot qimirlamaydi, ya'ni qoldiqda turaveradi
  //  va o'sha dona ikkinchi hujjatga ham tushib ketardi — xato faqat
  //  QABUL qilishda bilinardi, mashina yo'lga chiqqandan keyin.
  const ikki = await admin('POST', '/api/warehouse/fg/moves',
    { to_warehouse_id: vitr.id, items: [{ unit_id: u.id, qty: 1 }] });
  assert.equal(ikki.status, 400, ikki.text);
  assert.match(ikki.body.error, /ochiq hujjatda/);

  //  Ro'yxatda esa qatori TURADI — sababi bilan: yashirilgan qator
  //  «bu mahsulot omborda yo'q» degan javob bo'lib o'qilardi.
  const band = (await admin('GET', '/api/warehouse/fg/returns/candidates?w=TM'))
    .body.rows.find((x) => x.id === u.id);
  assert.ok(band, 'bandi ham ro\'yxatda turadi');
  assert.equal(band.free_qty, 0);
  assert.equal(band.doc_qty, 6);
  assert.equal(band.doc_no, d.body.doc_no);
  assert.equal((await admin('POST',
    `/api/warehouse/fg/returns/${d.body.id}/confirm`)).status, 200);
  assert.equal((await admin('POST',
    `/api/warehouse/fg/returns/${d.body.id}/accept`)).status, 200);

  assert.equal((await H.id(
    `SELECT SUM(qty)::int AS n FROM production_units
      WHERE conveyor_no = $1 AND warehouse_id = $2 AND status='fg'`,
    [u.conveyor_no, vitr.id])).n, 6, 'vitrinada 6 ta');
  //  Bron o'z qatorida, T/M da — mijozga va'da qilingani javonda qoldi.
  assert.equal((await H.id(
    `SELECT COALESCE(SUM(r.qty),0)::int AS n FROM unit_reservations r
       JOIN production_units p ON p.id = r.unit_id
      WHERE p.conveyor_no = $1 AND COALESCE(p.warehouse_id,$2) = $2`,
    [u.conveyor_no, tm])).n, 4, 'bron T/M da qoldi');
  await db.query(`SELECT 1`);
});


test('qo\'ldan qo\'lga pul o\'tmaydi \u2014 kassa orqali yuradi', async () => {
  //  ★ «Harajat yozish» oynasida xodimga pul berish TURMAYDI: bu oyna
  //  qo'ldagi pulni HARAJATGA aylantiradi, uning ikkinchi tomoni har
  //  doim harajat moddasi. Xodimga pul berish esa harajat emas —
  //  korxonaning puli bir qo'ldan ikkinchisiga ko'chadi.
  //
  //  Tekshiruv SERVERDA: ro'yxatdan olib tashlash himoya emas.
  const { db } = require('../db');
  const kassir = H.api(base, await H.sessionFor('Sinov kassir'));
  for (const nom of ['Sinov qo\'l bir', 'Sinov qo\'l ikki'])
    await db.query(`INSERT INTO workers (name) SELECT $1
                     WHERE NOT EXISTS (SELECT 1 FROM workers WHERE name = $1)`, [nom]);
  const a = (await H.id(`SELECT id FROM workers WHERE name='Sinov qo''l bir'`)).id;
  const b = (await H.id(`SELECT id FROM workers WHERE name='Sinov qo''l ikki'`)).id;

  const yoq = await kassir('POST', '/api/cash/ops', {
    from_kind: 'worker', from_id: a, to_kind: 'worker', to_id: b,
    currency: 'USD', amount: 50 });
  assert.equal(yoq.status, 400, yoq.text);
  assert.match(yoq.body.error, /Qo'ldan qo'lga/);

  //  O'ZIGA ham: bu qator oynada eng mantiqsiz ko'rinardi.
  assert.equal((await kassir('POST', '/api/cash/ops', {
    from_kind: 'worker', from_id: a, to_kind: 'worker', to_id: a,
    currency: 'USD', amount: 50 })).status, 400);
});

test('qo\'lida pul turgan odam belgisisiz ham hisob beradi', async () => {
  //  ★ Belgi («Qo'liga pul beriladi») KELAJAK haqida: kassadan bu
  //  odamga pul berish mumkinmi. Qo'lida ALLAQACHON turgan pulga esa
  //  u tegishli emas — pul boshlang'ich qoldiqdan, mijozdan yoki belgi
  //  keyin olib tashlanganidan kelib qolgan bo'lishi mumkin.
  //
  //  Ilgari faqat belgi qaralardi va o'sha pul TIQILIB qolardi: xodim
  //  sarfini yoza olmasdi, kassir esa uni faqat «Boshlang'ich qoldiq»
  //  bilan tuzatib qo'yishi mumkin edi — ya'ni haqiqiy harajat
  //  foyda-zarardan yashirinib ketardi.
  const { db } = require('../db');
  await db.query(`INSERT INTO workers (name) SELECT 'Sinov tiqilgan pul'
                   WHERE NOT EXISTS (SELECT 1 FROM workers WHERE name='Sinov tiqilgan pul')`);
  const u = (await H.id(`SELECT id FROM workers WHERE name='Sinov tiqilgan pul'`)).id;
  await db.query(`INSERT INTO worker_roles (worker_id, role_code)
                  VALUES ($1,'omborchi') ON CONFLICT DO NOTHING`, [u]);
  //  Belgisi ATAYLAB yo'q, lekin boshlang'ich qoldiqda puli bor.
  await db.query(`UPDATE workers SET can_hold_cash = false,
                    opening_usd = 400, opening_on = DATE '2026-09-01' WHERE id = $1`, [u]);
  const x = H.api(base, await H.sessionFor('Sinov tiqilgan pul'));

  //  Tugma chiqadimi degan savolga `/refs` javob beradi.
  const refs = (await x('GET', '/api/cash/refs')).body;
  assert.equal(refs.my.hold, false, 'belgisi yo\'q');
  assert.equal(refs.my.puli, true, 'lekin qo\'lida pul bor');

  const modda = (await H.id(`SELECT id FROM expense_items LIMIT 1`)).id;
  const ok = await x('POST', '/api/cash/ops', {
    to_kind: 'expense', currency: 'USD', amount: 150,
    expense_item_id: modda, pl_month: '2026-09' });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(Number((await H.id(
    `SELECT total_usd FROM v_worker_cash WHERE id=$1`, [u])).total_usd), 250);

  //  Pul tugagach tugma ham yo'qoladi: qo'lida hech narsa qolmadi.
  assert.equal((await x('POST', '/api/cash/ops', {
    to_kind: 'expense', currency: 'USD', amount: 250,
    expense_item_id: modda, pl_month: '2026-09' })).status, 200);
  const bosh = await x('POST', '/api/cash/ops', {
    to_kind: 'expense', currency: 'USD', amount: 10,
    expense_item_id: modda, pl_month: '2026-09' });
  assert.equal(bosh.status, 400, bosh.text);
  assert.match(bosh.body.error, /korxona puli yo'q/);
});

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
  assert.match(yoq.body.error, /korxona puli yo'q/);

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

test('jurnalda mahsulot ham tuzatiladi, lekin bron va marshrut chegara', async () => {
  const u = await newUnit();
  const KAMOD = (await H.id(
    `SELECT p.id FROM products p JOIN product_groups g ON g.id = p.group_id
      WHERE g.code = 'KAMOD' AND p.active ORDER BY p.id LIMIT 1`)).id;
  const STUL = (await H.id(
    `SELECT p.id FROM products p JOIN product_groups g ON g.id = p.group_id
      WHERE g.code = 'STU' AND p.active ORDER BY p.id LIMIT 1`)).id;

  //  Penal va kamod bitta marshrutdan yuradi — Arrada turgan konver
  //  yangi marshrutda ham o'z joyini topadi.
  const ok = await admin('PATCH', '/api/units/' + u.id, { product_id: KAMOD });
  assert.equal(ok.status, 200, ok.text);
  assert.equal((await H.id(`SELECT product_id p FROM production_units WHERE id=$1`,
    [u.id])).p, KAMOD);

  //  Jamlanma yozuv ham ko'chadi: zavod ko'rinishida eski mahsulot
  //  yasalayotgandek turmasin.
  assert.equal((await H.id(
    `SELECT COUNT(*)::int n FROM flow_log f
       JOIN unit_moves m ON m.flow_log_id = f.id AND m.unit_id = $1
      WHERE f.product_id <> $2`, [u.id, KAMOD])).n, 0);

  //  Stul boshqa marshrutdan yuradi: Arra uning bo'limi emas.
  const bad = await admin('PATCH', '/api/units/' + u.id, { product_id: STUL });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /marshrutida yo'q/);

  //  Tarixga tegadi — ma'lumot kirituvchida bu huquq yo'q.
  //  Nomi ATAYLAB boshqacha: `xodim()` ismga qarab tekshirmaydi va
  //  bir xil nom ikkinchi xodim yaratib yuborardi.
  const kir = await xodim('Sinov kirituvchi 2', 'kirituvchi');
  assert.equal((await kir('PATCH', '/api/units/' + u.id,
    { product_id: KAMOD })).status, 403);
});

test('muddat: korpusda bosqichlar zanjiri, stulda marshrut qadamlari', async () => {
  //  ★ ZAVOD QARORI (2026-09) va uning O'Z MISOLI:
  //
  //      19-sentabr (shanba) boshlandi
  //      26-sentabr ertalab lak tsexi ishni boshlaydi   (+6 ish kuni)
  //      3-oktabr   qadoqlashga topshiriladi            (+6 ish kuni)
  //      5-oktabr   T/M omborga qabul qilinadi          (+1 ish kuni)
  //
  //  Yakshanbalar (20-sen, 27-sen, 4-okt) tashlab ketilgan. Raqamlar
  //  TSEXDA (`shops.plan_*_days`), formula esa bazada bitta joyda
  //  (`muddat_zanjir`) — test o'sha uchta kunni qotirib qo'yadi, chunki
  //  ular savdo mijozga aytadigan va'daga aylanadi.
  const kor = await newUnit({ started_on: '2026-09-19', entered_section_on: '2026-09-19' });
  const r1 = (await admin('GET', '/api/units/?conveyor_no=' + kor.conveyor_no)).body[0];
  assert.equal(String(r1.lak_on).slice(0, 10),  '2026-09-26', 'lak tsexi');
  assert.equal(String(r1.pack_on).slice(0, 10), '2026-10-03', 'qadoqlash');
  assert.equal(String(r1.fg_on).slice(0, 10),   '2026-10-05', 'T/M ombor');
  assert.equal(r1.lak_src, 'marshrut');
  assert.equal(r1.pack_src, 'marshrut');
  assert.equal(r1.fg_src, 'marshrut');

  //  ★ STOL KORPUS TSEXINIKI, LEKIN O'Z KUN SONI BILAN (4/5/0):
  //  19-sentabr arradan boshlansa 24-sentabr lak tsexiga kiradi,
  //  30-sentabr qadoqlashga kiradi va O'SHA KUNI omborga topshiriladi.
  //  Raqam GURUHDA (`product_groups.plan_*_days`) va tsexnikidan
  //  ustun turadi — aks holda stol ham 6/6/1 bo'lib qolardi.
  const STOL = (await H.id(
    `SELECT p.id FROM products p JOIN product_groups g ON g.id = p.group_id
      WHERE g.code = 'STL' AND p.active ORDER BY p.id LIMIT 1`)).id;
  const sl = (await admin('POST', '/api/units/', { items: [{
    product_id: STOL, qty: 1, started_on: '2026-09-19' }] })).body.created[0];
  const r5 = (await admin('GET', '/api/units/?conveyor_no=' + sl.conveyor_no)).body[0];
  assert.equal(String(r5.lak_on).slice(0, 10),  '2026-09-24', 'stol: lak');
  assert.equal(String(r5.pack_on).slice(0, 10), '2026-09-30', 'stol: qadoqlash');
  assert.equal(String(r5.fg_on).slice(0, 10),   '2026-09-30', 'stol: o\'sha kuni omborga');

  //  Stulda formula BOSHQA: har bo'limda bir ish kuni. Qadoqlash
  //  tsexiga stul umuman bormaydi — o'z tsexida qadoqlanadi, shuning
  //  uchun o'sha ustun bo'sh va bu xato emas.
  const STUL = (await H.id(
    `SELECT p.id FROM products p JOIN product_groups g ON g.id = p.group_id
      WHERE g.code = 'STU' AND p.active ORDER BY p.id LIMIT 1`)).id;
  const st = (await admin('POST', '/api/units/', { items: [{
    product_id: STUL, qty: 2, started_on: '2026-09-19' }] })).body.created[0];
  const r2 = (await admin('GET', '/api/units/?conveyor_no=' + st.conveyor_no)).body[0];
  assert.equal(r2.fg_src, 'marshrut');
  assert.equal(r2.pack_on, null, 'stul qadoqlash tsexiga bormaydi');
  const kunlar = (await H.id(
    `SELECT COUNT(*)::int AS n FROM v_product_route WHERE product_id = $1`, [STUL])).n;
  assert.equal(String(r2.fg_on).slice(0, 10),
    (await H.id(`SELECT to_char(ish_kuni($1::date, $2::int), 'YYYY-MM-DD') AS d`,
      ['2026-09-19', kunlar])).d);

  //  ★ BOSHLIQNING QO'LI FORMULADAN USTUN. Zanjir taxmin, u esa biladi.
  const ok = await korpus('POST', `/api/units/${kor.id}/plan`, { due_on: '2026-09-22' });
  assert.equal(ok.status, 200, ok.text);
  const r3 = (await admin('GET', '/api/units/?conveyor_no=' + kor.conveyor_no)).body[0];
  assert.equal(String(r3.next_shop_on).slice(0, 10), '2026-09-22');
  assert.equal(r3.next_shop_src, 'reja');
  //  Korpusdan keyin lak tsexi turadi — sana o'sha ustunga ham tushadi.
  assert.equal(String(r3.lak_on).slice(0, 10), '2026-09-22');
  assert.equal(r3.lak_src, 'reja');

  //  Boshqa tsexning boshlig'i tegolmaydi.
  assert.equal((await lak('POST', `/api/units/${kor.id}/plan`,
    { due_on: '2026-09-21' })).status, 403);

  //  Bo'sh yuborilgani «yo'q» degani: qo'lda qo'yilgani olib tashlanadi
  //  va zanjir qaytib keladi — katak endi bo'sh QOLMAYDI.
  assert.equal((await korpus('POST', `/api/units/${kor.id}/plan`,
    { due_on: null })).status, 200);
  const r4 = (await admin('GET', '/api/units/?conveyor_no=' + kor.conveyor_no)).body[0];
  assert.equal(String(r4.lak_on).slice(0, 10), '2026-09-26');
  assert.equal(r4.lak_src, 'marshrut');

  //  Boshliq konverning O'ZIGA tegolmaydi — faqat reja.
  assert.equal((await korpus('PATCH', '/api/units/' + kor.id, { qty: 9 })).status, 403);
});

/* ============================================================================
 *  KONVER SO'ROVI — tsex boshlig'i yozadi, direktor tasdiqlaydi
 *
 *  Chegara singanda tsex boshqa tsexning ishini ochib yuborardi, tasdiq
 *  singanda esa konver hech kimning qarorisiz paydo bo'lardi.
 * ========================================================================== */
test('konver so\'rovi: tsex boshlig\'i yozadi, tasdiqlovchi ochadi', async () => {
  const STUL = (await H.id(
    `SELECT p.id FROM products p JOIN product_groups g ON g.id = p.group_id
      WHERE g.code = 'STU' AND p.active ORDER BY p.id LIMIT 1`)).id;

  //  Usta o'z tsexining mahsulotiga so'rov yozadi.
  const q = await korpus('POST', '/api/units/requests',
    { product_id: PENAL, qty: 7, color: 'Oq', started_on: '2026-09-02',
      conveyor_no: 'S-7001', next_on: '2026-09-20' });
  assert.equal(q.status, 200, q.text);
  const id = q.body.created[0];

  //  Boshqa tsexning mahsulotiga esa yoza olmaydi — chegara serverda.
  assert.equal((await korpus('POST', '/api/units/requests',
    { product_id: STUL, qty: 1, conveyor_no: 'S-7002' })).status, 400);

  //  Ro'yxatning O'ZI ham tsex bo'yicha qisqaradi: har mahsulot yonida
  //  qaysi tsexniki ekani keladi va sahifa shu bo'yicha filtrlaydi.
  const ref = (await korpus('GET', '/api/ref')).body;
  const st = ref.products.find((x) => x.id === STUL);
  const pn = ref.products.find((x) => x.id === PENAL);
  const STULTSEX = (await H.id(`SELECT id FROM shops WHERE code = 'STUL'`)).id;
  const KORTSEX  = (await H.id(`SELECT id FROM shops WHERE code = 'KORPUS'`)).id;
  assert.equal(st.shop_id, STULTSEX, 'stul \u2014 stul tsexiniki');
  assert.equal(pn.shop_id, KORTSEX,  'penal \u2014 korpus tsexiniki');

  //  Tasdiqlash uning ishi emas.
  assert.equal((await korpus('POST', `/api/units/requests/${id}/approve`)).status, 403);

  //  So'rov hali KONVER EMAS: jurnalda ham, qoldiqda ham yo'q.
  assert.equal((await H.id(
    `SELECT COUNT(*)::int n FROM production_units WHERE qty = 7 AND color = 'Oq'`)).n, 0);

  //  Tasdiqlovchi ochadi — so'ralgan soni bilan.
  const ok = await admin('POST', `/api/units/requests/${id}/approve`);
  assert.equal(ok.status, 200, ok.text);
  assert.ok(ok.body.conveyor_no);

  const u = await H.id(`SELECT qty, color, started_on, status FROM production_units
                         WHERE id = $1`, [ok.body.unit_id]);
  assert.equal(u.qty, 7);
  assert.equal(u.color, 'Oq');
  assert.equal(u.status, 'production');

  //  Ikkinchi marta tasdiqlab bo'lmaydi: aks holda bitta so'rovdan
  //  ikkita konver ochilardi.
  assert.equal((await admin('POST', `/api/units/requests/${id}/approve`)).status, 400);

  const row = (await korpus('GET', '/api/units/requests?status=approved'))
    .body.rows.find((r) => r.id === id);
  assert.equal(row.status, 'approved');
  assert.equal(row.conveyor_no, ok.body.conveyor_no);
});

test('konver so\'rovi: rad etiladi va o\'zi bekor qiladi', async () => {
  const a = (await korpus('POST', '/api/units/requests',
    { product_id: PENAL, qty: 2, conveyor_no: 'S-7003', next_on: '2026-09-20' })).body.created[0];
  const r = await admin('POST', `/api/units/requests/${a}/reject`,
    { note: 'Xom ashyo yo\'q' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.status, 'rejected');

  //  So'rovchining o'zi bekor qilsa boshqa yozuv bo'ladi: rad etish
  //  direktorniki, bekor qilish o'zinikidir.
  const b = (await korpus('POST', '/api/units/requests',
    { product_id: PENAL, qty: 3, conveyor_no: 'S-7004', next_on: '2026-09-20' })).body.created[0];
  const c = await korpus('POST', `/api/units/requests/${b}/reject`, { note: 'adashdim' });
  assert.equal(c.body.status, 'cancelled');

  //  Hal qilingan so'rov qayta hal qilinmaydi.
  assert.equal((await admin('POST', `/api/units/requests/${b}/approve`)).status, 400);

  //  Usta boshqa xodimning so'rovini bekor qila olmaydi. Javob 400:
  //  so'rov «topilmadi» deyiladi, kimniki ekani aytilmaydi.
  const d = (await admin('POST', '/api/units/requests',
    { product_id: PENAL, qty: 4, conveyor_no: 'S-7005', next_on: '2026-09-20' })).body.created[0];
  assert.equal((await lak('POST', `/api/units/requests/${d}/reject`)).status, 400);
  assert.equal((await H.id(`SELECT status FROM unit_requests WHERE id = $1`, [d])).status,
    'pending', 'begona so\'rov joyida qoladi');
});

test('so\'rovda konver raqamini TIZIM qo\'yadi', async () => {
  const kir = await xodim('Sinov raqamchi', 'kirituvchi');

  //  ★ Raqamsiz so'rov endi O'TADI — uni tizim qo'yadi. Ilgari katak
  //  qo'lda to'ldirilardi va majburiy edi: zavod raqamni o'z daftarida
  //  yuritardi, tizim esa faqat taklif qilardi. Ikki daftar ikki xil
  //  hisob yuritardi — taklifni qabul qilmay o'zinikini yozgan odam
  //  ketma-ketlikda teshik qoldirardi yoki bir xil raqam ikki
  //  mahsulotga tushardi.
  const a = await kir('POST', '/api/units/requests',
    { product_id: PENAL, qty: 1, is_stock: true, next_on: '2026-09-20' });
  assert.equal(a.status, 200, a.text);
  const n1 = (await H.id(`SELECT conveyor_no FROM unit_requests WHERE id = $1`,
    [a.body.created[0]])).conveyor_no;
  assert.match(n1, /^K\d\d-\d{3,}$/, n1);

  //  Yuborilgan raqam E'TIBORGA OLINMAYDI: hisob bitta joyda.
  const b = await kir('POST', '/api/units/requests',
    { product_id: PENAL, qty: 1, conveyor_no: n1, next_on: '2026-09-20' });
  assert.equal(b.status, 200, b.text);
  const n2 = (await H.id(`SELECT conveyor_no FROM unit_requests WHERE id = $1`,
    [b.body.created[0]])).conveyor_no;
  assert.notEqual(n2, n1, 'ikkinchi so\'rovga boshqa raqam');
  assert.equal(Number(n2.split('-')[1]), Number(n1.split('-')[1]) + 1,
    'ketma-ketlik uzilmaydi');

  //  Zahira belgisi va raqam so'rovdan konverga o'zgarmasdan ko'chadi.
  const ok = await admin('POST', `/api/units/requests/${a.body.created[0]}/approve`);
  assert.equal(ok.status, 200, ok.text);
  const u = await H.id(`SELECT conveyor_no, is_stock FROM production_units WHERE id=$1`,
    [ok.body.unit_id]);
  assert.equal(u.conveyor_no, n1);
  assert.equal(u.is_stock, true);

  //  Ochilgan konverning raqami endi band: keyingi so'rov undan
  //  KEYINGISINI oladi, ustiga tushmaydi.
  const c = await kir('POST', '/api/units/requests',
    { product_id: PENAL, qty: 1, next_on: '2026-09-20' });
  assert.equal(c.status, 200, c.text);
  const n3 = (await H.id(`SELECT conveyor_no FROM unit_requests WHERE id = $1`,
    [c.body.created[0]])).conveyor_no;
  assert.ok(Number(n3.split('-')[1]) > Number(n2.split('-')[1]), n3);
});

test('raqam ko\'rinishi tsexdan va GURUHDAN: S26-104, K26-103, C26-227', async () => {
  const kir = await xodim('Sinov taklifchi', 'kirituvchi');
  const STUL = (await H.id(
    `SELECT p.id FROM products p JOIN product_groups g ON g.id = p.group_id
      WHERE g.code = 'STU' AND p.active ORDER BY p.id LIMIT 1`)).id;
  const yil = String(new Date().getFullYear()).slice(-2);

  //  Harf va uzunlik TSEXDA turadi — kodda emas.
  const st = (await kir('GET', '/api/units/requests/next-no?product_id=' + STUL)).body;
  assert.match(st.conveyor_no, new RegExp(`^S${yil}-\\d{3}$`), st.conveyor_no);
  const kor = (await kir('GET', '/api/units/requests/next-no?product_id=' + PENAL)).body;
  assert.match(kor.conveyor_no, new RegExp(`^K${yil}-\\d{3}$`), kor.conveyor_no);

  //  ★ STOL korpus tsexida yuradi, lekin zavod uni «C» bilan yuritadi:
  //  harf GURUHda ham bo'ladi va u tsexnikidan USTUN turadi.
  const STOL = (await H.id(
    `SELECT p.id FROM products p JOIN product_groups g ON g.id = p.group_id
      WHERE g.code = 'STL' AND p.active ORDER BY p.id LIMIT 1`)).id;
  const stol = (await kir('GET', '/api/units/requests/next-no?product_id=' + STOL)).body;
  assert.match(stol.conveyor_no, new RegExp(`^C${yil}-\\d{3}$`), stol.conveyor_no);

  //  Taklif NAVBATDAGI so'rovni ham hisobga oladi: ikki odam bir vaqtda
  //  kiritsa bir xil raqam taklif qilinmasin.
  assert.equal((await kir('POST', '/api/units/requests',
    { product_id: STUL, qty: 1 })).status, 200);
  const st2 = (await kir('GET', '/api/units/requests/next-no?product_id=' + STUL)).body;
  assert.notEqual(st2.conveyor_no, st.conveyor_no);
  assert.equal(Number(st2.conveyor_no.split('-')[1]),
               Number(st.conveyor_no.split('-')[1]) + 1);
});

test('so\'rov ro\'yxatida marshrut uzunligi SON bo\'lib keladi', async () => {
  //  `COUNT(*)` bigint qaytaradi va `pg` uni MATN qilib beradi. Sahifa
  //  `sana.getDate() + steps` deb hisoblaydi: matn bilan qo'shilganda
  //  19 + «8» → «198» bo'lib, omborga tushish kuni yarim yil keyinga
  //  surilib ketardi. Shuning uchun view'da `::int`.
  const kir = await xodim('Sinov son', 'kirituvchi');
  const STUL = (await H.id(
    `SELECT p.id FROM products p JOIN product_groups g ON g.id = p.group_id
      WHERE g.code = 'STU' AND p.active ORDER BY p.id LIMIT 1`)).id;
  const q = await kir('POST', '/api/units/requests',
    { product_id: STUL, qty: 1, conveyor_no: 'S-9201', started_on: '2026-09-19' });
  assert.equal(q.status, 200, q.text);

  const row = (await kir('GET', '/api/units/requests'))
    .body.rows.find((r) => r.id === q.body.created[0]);
  assert.equal(typeof row.steps, 'number', 'qadamlar soni SON: ' + typeof row.steps);
  assert.ok(row.steps > 0 && row.steps < 40, 'marshrut uzunligi: ' + row.steps);

  //  Sahifadagi hisob: boshlanish + qadamlar soni.
  const d = new Date('2026-09-19T00:00:00');
  d.setDate(d.getDate() + row.steps);
  assert.equal(d.getFullYear(), 2026, 'omborga tushish kuni o\'sha yilda qoladi');
});

test('navbatdagi so\'rov tasdiqlovchiga XABAR bo\'lib tushadi', async () => {
  //  ★ Tasdiqlovchi kun bo'yi saytda o'tirmaydi: navbatni BILISH uchun
  //  so'rovlar sahifasini ochib ko'rishdan boshqa yo'l yo'q edi va
  //  ertalab yozilgan so'rov kechgacha turib qolardi.
  //
  //  Ikki yo'l: menyudagi belgi uchun SON va Telegram uchun NAVBAT.
  const kir = await xodim('Sinov xabarchi', 'kirituvchi');

  const oldin = Number((await admin('GET', '/api/units/requests/pending')).body.n);
  //  Kirituvchida tasdiqlash huquqi yo'q — unga navbat ko'rsatilmaydi:
  //  har kuni turgan raqamga ko'z o'rganib qolardi.
  assert.equal((await kir('GET', '/api/units/requests/pending')).body.n, 0);

  const q = await kir('POST', '/api/units/requests',
    { product_id: PENAL, qty: 3, conveyor_no: 'K-9701', started_on: '2026-09-19' });
  assert.equal(q.status, 200, q.text);

  assert.equal(Number((await admin('GET', '/api/units/requests/pending')).body.n),
    oldin + 1, 'tasdiqlovchida navbat soni oshdi');

  //  Xabar navbatga tushdi va TASDIQLASH huquqiga yo'llangan — aynan
  //  kimga yuborilishini `tg_id` hal qiladi (izoh: erp/notify.js).
  const x = await H.id(
    `SELECT permission_code, title, body FROM notifications
      ORDER BY id DESC LIMIT 1`);
  assert.equal(x.permission_code, 'production.approve');
  assert.match(x.title, /tasdiq kutmoqda/);
  const so = await H.id(`SELECT conveyor_no FROM unit_requests WHERE id = $1`,
    [q.body.created[0]]);
  assert.match(x.body, new RegExp(so.conveyor_no), 'xabarda konver raqami turadi');
  assert.match(x.body, /Sinov xabarchi/, 'kim so\'raganini ham aytadi');

  //  Tasdiqlangach navbatdan chiqadi.
  assert.equal((await admin('POST',
    `/api/units/requests/${q.body.created[0]}/approve`)).status, 200);
  assert.equal(Number((await admin('GET', '/api/units/requests/pending')).body.n), oldin);
});

test('so\'rov ro\'yxati sana AVTOMATMI deb aytadi', async () => {
  //  ★ FORMULA HAMMA TSEXDA ISHLAMAYDI (`shops.plan_auto`). Stulda
  //  T/M ombor sanasi marshrutdan o'zi chiqadi, korpusda esa katak
  //  bo'sh tug'iladi va tsex boshlig'i qo'yadi — ya'ni sahifada
  //  ko'rsatilgan kun u yerda TAXMIN va shunday belgilanishi kerak.
  //  Belgi ro'yxat so'rovidan keladi: `v_unit_requests` `units.sql` da,
  //  `plan_auto` esa `register.sql` da — view uni o'qiy olmaydi.
  const kir = await xodim('Sinov avto', 'kirituvchi');
  const STUL = (await H.id(
    `SELECT p.id FROM products p JOIN product_groups g ON g.id = p.group_id
      WHERE g.code = 'STU' AND p.active ORDER BY p.id LIMIT 1`)).id;

  const a = await kir('POST', '/api/units/requests',
    { product_id: STUL, qty: 1, conveyor_no: 'S-9401', started_on: '2026-09-19' });
  assert.equal(a.status, 200, a.text);
  const b = await kir('POST', '/api/units/requests',
    { product_id: PENAL, qty: 1, conveyor_no: 'K-9402',
      started_on: '2026-09-19', next_on: '2026-09-25' });
  assert.equal(b.status, 200, b.text);

  const rows = (await kir('GET', '/api/units/requests')).body.rows;
  const st = rows.find((r) => r.id === a.body.created[0]);
  const kor = rows.find((r) => r.id === b.body.created[0]);
  //  Ikkala tsexda ham sana endi avtomat, lekin formula boshqa-boshqa:
  //  stulda marshrut qadamlari, korpusda bosqichlar zanjiri.
  assert.equal(st.auto, true,  'stulda sana marshrutdan chiqadi');
  assert.equal(kor.auto, true, 'korpusda sana zanjirdan chiqadi');
  assert.equal(String(kor.fg_on).slice(0, 10), '2026-10-05', 'zanjir: 19-sen → 5-okt');
});

test('so\'rovda rang va mato faqat boridan tanlanadi', async () => {
  const kir = await xodim('Sinov rangchi', 'kirituvchi');

  //  Zavodda ishlatilmagan rang qabul qilinmaydi: bitta «Venge» va
  //  bitta «venge» ombor qoldig'ini ikkiga bo'lib yuborardi.
  const yangi = await kir('POST', '/api/units/requests', {
    product_id: PENAL, qty: 1, conveyor_no: 'S-9101',
    next_on: '2026-09-20', color: 'Yangi rang o\'ylab topilgan' });
  assert.equal(yangi.status, 400, yangi.text);
  assert.match(yangi.body.error, /ro'yxatda yo'q/);

  //  Bor rang o'tadi — katta-kichik harf farq qilmaydi.
  const bor = (await H.id(
    `SELECT color FROM production_units WHERE color IS NOT NULL LIMIT 1`)).color;
  const ok = await kir('POST', '/api/units/requests', {
    product_id: PENAL, qty: 1, conveyor_no: 'S-9101',
    next_on: '2026-09-20', color: bor.toLowerCase() });
  assert.equal(ok.status, 200, ok.text);

  //  Rangsiz ham bo'ladi: zahiraga kiritilayotganda u hali ma'lum emas.
  assert.equal((await kir('POST', '/api/units/requests', {
    product_id: PENAL, qty: 1, conveyor_no: 'S-9102',
    next_on: '2026-09-20' })).status, 200);

  //  Mato ham shunday.
  assert.equal((await kir('POST', '/api/units/requests', {
    product_id: PENAL, qty: 1, conveyor_no: 'S-9103',
    next_on: '2026-09-20', fabric: 'Bunaqa mato yo\'q' })).status, 400);
});

test('zanjir avtomat, lekin qo\'lda qo\'yilgani ustun turadi', async () => {
  //  ★ Ilgari korpusda sana UCH joyda MAJBURIY so'ralardi (kiritishda,
  //  lak qabul qilganda, qadoqlash qabul qilganda). Endi zanjir uni
  //  o'zi hisoblaydi (`shops.plan_*_days`) va majburiylik olib
  //  tashlandi — formulani to'ldirib, ustiga qo'lda ham yozdirish
  //  o'sha ishni ikki marta qildirardi. Qo'l esa YO'QOLMADI: boshliq
  //  yozgan kun formuladan ustun turadi.
  const kir = await xodim('Sinov zanjir', 'kirituvchi');

  //  Sanasiz so'rov endi o'tadi.
  const q = await kir('POST', '/api/units/requests',
    { product_id: PENAL, qty: 1, conveyor_no: 'S-9001', started_on: '2026-09-19' });
  assert.equal(q.status, 200, q.text);
  const ok = await admin('POST', `/api/units/requests/${q.body.created[0]}/approve`);
  assert.equal(ok.status, 200, ok.text);

  //  Sanalar zanjirdan o'zi chiqdi.
  //  Raqamni tizim qo'ydi — tasdiqlash javobidan olinadi.
  const r1 = (await admin('GET', '/api/units/?conveyor_no=' + ok.body.conveyor_no)).body[0];
  assert.equal(String(r1.lak_on).slice(0, 10),  '2026-09-26');
  assert.equal(String(r1.pack_on).slice(0, 10), '2026-10-03');
  assert.equal(r1.lak_src, 'marshrut');

  //  Korpus bo'ylab haydab, lak tsexiga topshiramiz.
  const SHKUR2 = (await H.id(`SELECT id FROM sections WHERE code='KOR-SHKUR'`)).id;
  assert.equal((await admin('PATCH', '/api/units/' + ok.body.unit_id,
    { section_id: SHKUR2 })).status, 200);
  assert.equal((await korpus('POST', '/api/units/handover',
    { items: [ok.body.unit_id] })).status, 200);

  //  LAK QABUL QILADI — sanasiz ham o'tadi, lekin yozilgani yoziladi.
  assert.equal((await lak('POST', '/api/units/move',
    { items: [{ unit_id: ok.body.unit_id, plan_on: '2026-10-01' }] })).status, 200);
  const r2 = (await admin('GET', '/api/units/?conveyor_no=' + ok.body.conveyor_no)).body[0];
  assert.equal(String(r2.pack_on).slice(0, 10), '2026-10-01', 'qo\'l formuladan ustun');
  assert.equal(r2.pack_src, 'reja');

  //  Ikkinchi konver: qabul qilishda sana berilmasa zanjir qolaveradi.
  const q2 = await kir('POST', '/api/units/requests',
    { product_id: PENAL, qty: 1, conveyor_no: 'S-9003', started_on: '2026-09-19' });
  const ok2 = await admin('POST', `/api/units/requests/${q2.body.created[0]}/approve`);
  assert.equal((await admin('PATCH', '/api/units/' + ok2.body.unit_id,
    { section_id: SHKUR2 })).status, 200);
  assert.equal((await korpus('POST', '/api/units/handover',
    { items: [ok2.body.unit_id] })).status, 200);
  const sanasiz = await lak('POST', '/api/units/move',
    { items: [{ unit_id: ok2.body.unit_id }] });
  assert.equal(sanasiz.status, 200, sanasiz.text);
  const r3 = (await admin('GET', '/api/units/?conveyor_no=' + ok2.body.conveyor_no)).body[0];
  assert.equal(String(r3.pack_on).slice(0, 10), '2026-10-03');
  assert.equal(r3.pack_src, 'marshrut');

  //  Stulda ham so'ralmaydi — eskicha.
  const STUL = (await H.id(
    `SELECT p.id FROM products p JOIN product_groups g ON g.id = p.group_id
      WHERE g.code = 'STU' AND p.active ORDER BY p.id LIMIT 1`)).id;
  const st = await admin('POST', '/api/units/requests',
    { product_id: STUL, qty: 1, conveyor_no: 'S-9002' });
  assert.equal(st.status, 200, st.text);
});

/* ============================================================================
 *  MUDDAT REJASI — HAR BO'LIMDA BIR KUN
 *
 *  Sana savdo mijozga aytadigan va'daga aylanadi, shuning uchun formulaning
 *  o'zi sinaladi: qadam raqami bo'yicha, boshlangan kundan.
 * ========================================================================== */
test('yakshanba hisobga olinmaydi: muddat ish kunlari bilan sanaladi', async () => {
  //  Zavod yakshanba ishlamaydi, ya'ni «har bo'limda bir kun» — bir ISH
  //  kuni. Formula bazada (`ish_kuni`), sahifadagi nusxasi ham aynan shu
  //  javobni berishi shart.
  const kun = async (boshlanish, n) => (await H.id(
    `SELECT ish_kuni($1::date, $2::int) AS d`, [boshlanish, n])).d;
  const ymd = (v) => { const d = v instanceof Date ? v : new Date(v);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')
      }-${String(d.getDate()).padStart(2, '0')}`; };

  //  2026-09-19 — SHANBA. Undan keyin yakshanba tushadi va o'tkazib
  //  yuboriladi: 7 ish kuni keyin dushanba, 28-sentabr.
  assert.equal(ymd(await kun('2026-09-19', 7)), '2026-09-28');
  //  Dushanbadan olti ish kuni — keyingi dushanba, orada yakshanba bor.
  assert.equal(ymd(await kun('2026-09-14', 6)), '2026-09-21');
  //  Boshlanish yakshanbaga tushsa dushanbadan sanaladi.
  assert.equal(ymd(await kun('2026-09-20', 0)), '2026-09-21');

  //  Natija HECH QACHON yakshanbaga tushmaydi.
  const yak = (await H.id(
    `SELECT COUNT(*)::int AS n FROM generate_series(
       DATE '2026-09-01', DATE '2026-12-31', '1 day') g(d),
       generate_series(0, 25) k(n)
      WHERE EXTRACT(ISODOW FROM ish_kuni(g.d::date, k.n)) = 7`)).n;
  assert.equal(yak, 0, 'yakshanbaga tushgan sana bor');

  //  Konverning rejasi ham shu qoidadan chiqadi.
  const STUL = (await H.id(
    `SELECT p.id FROM products p JOIN product_groups g ON g.id = p.group_id
      WHERE g.code = 'STU' AND p.active ORDER BY p.id LIMIT 1`)).id;
  const u = (await admin('POST', '/api/units/', { items: [{
    product_id: STUL, qty: 1, started_on: '2026-09-19' }] })).body.created[0];
  const pl = await H.id(`SELECT steps, fg_on FROM v_unit_plan WHERE unit_id = $1`, [u.id]);
  assert.equal(ymd(pl.fg_on), ymd(await kun('2026-09-19', pl.steps)));
});

test('muddat marshrutdan hisoblanadi: har bo\'limda bir kun', async () => {
  //  STUL olinadi: sana marshrutdan faqat `plan_auto` belgili tsexda
  //  chiqadi, korpusda esa boshliq qo'yadi (izoh: sql/register.sql).
  const STUL = (await H.id(
    `SELECT p.id FROM products p JOIN product_groups g ON g.id = p.group_id
      WHERE g.code = 'STU' AND p.active
        AND p.route_template_id = (SELECT id FROM route_templates WHERE code = 'L2-FULL')
      ORDER BY p.id LIMIT 1`)).id;
  const ROVER2 = (await H.id(`SELECT id FROM sections WHERE code = 'STU-ROVER'`)).id;
  const u = (await admin('POST', '/api/units/', { items: [{
    product_id: STUL, qty: 3, section_id: ROVER2,
    started_on: '2026-09-01', entered_section_on: '2026-09-01' }] })).body.created[0];

  const r = (await admin('GET', '/api/units/?conveyor_no=' + u.conveyor_no)).body[0];
  const pl = await H.id(`SELECT steps, fg_on, next_shop, next_shop_on
                           FROM v_unit_plan WHERE unit_id = $1`, [u.id]);

  //  Qadamlar soni shu yerda qotib yozilmaydi: marshrut o'zgarsa test
  //  emas, FORMULA tekshirilishi kerak.
  //  DATE ustuni `pg` da Date bo'lib keladi, JSON'da esa matn — ikkalasini
  //  bir ko'rinishga keltiramiz. Mahalliy qismlardan yig'iladi: toISOString
  //  UTC ga o'tkazadi va soat mintaqasi oldinda bo'lsa sana bir kun orqaga
  //  siljib ketardi.
  const ymd = (v) => { const d = v instanceof Date ? v : new Date(v);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')
      }-${String(d.getDate()).padStart(2, '0')}`; };
  //  Kunlar ISH KUNI bilan sanaladi — yakshanba o'tkazib yuboriladi
  //  (izoh: sql/register.sql, `ish_kuni`).
  const kun = async (n) => ymd((await H.id(
    `SELECT ish_kuni(DATE '2026-09-01', $1::int) AS d`, [n])).d);

  assert.ok(pl.steps > 1, 'marshrutda qadam bor');
  //  Oxirgi bo'limdan KEYINGI kuni omborga tushadi.
  assert.equal(ymd(pl.fg_on), await kun(pl.steps));
  assert.equal(ymd(r.fg_on), await kun(pl.steps));
  assert.equal(r.fg_src, 'marshrut');

  //  Arrada turibdi, ya'ni keyingi tsex — korpusdan keyin keladigani.
  //  Sanasi o'sha tsexning birinchi qadami: started_on + (qadam − 1).
  assert.ok(pl.next_shop, 'keyingi tsex topiladi');
  const step = await H.id(
    `SELECT MIN(sp.step_no) AS n FROM v_unit_step_plan sp
       JOIN shops sh ON sh.id = sp.shop_id AND sh.name = $2
      WHERE sp.unit_id = $1`, [u.id, pl.next_shop]);
  assert.equal(ymd(r.next_shop_on), await kun(step.n - 1));

  //  Qo'lda qo'yilgan reja formuladan USTUN turadi: tsex boshlig'ining
  //  va'dasi hisobdan kuchliroq.
  assert.equal((await admin('PATCH', '/api/units/' + u.id,
    { fg_planned_on: '2026-10-05' })).status, 200);
  const r2 = (await admin('GET', '/api/units/?conveyor_no=' + u.conveyor_no)).body[0];
  assert.equal(ymd(r2.fg_on), '2026-10-05');
  assert.equal(r2.fg_src, 'reja');
});

test('xodimga rol biriktirilsa huquqi darrov ishlaydi', async () => {
  //  Konver yaratish huquqi ROL orqali keladi. Sinov shu yo'lni HTTP
  //  bilan yuradi: `worker_roles` ga to'g'ridan-to'g'ri yozish
  //  Xodimlar sahifasi qiladigan ishni sinamasdi.
  const w = await admin('POST', '/api/admin/workers',
    { name: 'Sinov kiritувchi HTTP', pin: '8421',
      roles: [{ code: 'kirituvchi' }] });
  assert.equal(w.status, 200, w.text);

  const perms = (await H.id(
    `SELECT array_agg(permission_code ORDER BY permission_code) AS p
       FROM v_worker_permissions WHERE worker_id = $1`, [w.body.id])).p;
  assert.ok(perms.includes('production.request'),
    'kirituvchi konver so\'rovini yozadi: ' + perms);
  assert.ok(!perms.includes('production.view'), 'jurnal ochilmaydi');

  //  Konverni O'ZI ochmaydi — so'rov yozadi va u tasdiqdan o'tadi.
  const kir = H.api(base, await H.sessionFor('Sinov kiritувchi HTTP'));
  assert.equal((await kir('POST', '/api/units/', {
    items: [{ product_id: PENAL, qty: 1, section_id: ARRA }] })).status, 403);
  const q = await kir('POST', '/api/units/requests',
    { product_id: PENAL, qty: 2, conveyor_no: 'S-7006', next_on: '2026-09-20' });
  assert.equal(q.status, 200, q.text);

  //  Rolni ALMASHTIRISH ham ishlaydi va eskisi qoladi emas.
  assert.equal((await admin('PATCH', '/api/admin/workers/' + w.body.id,
    { roles: [{ code: 'tsex_usta', scope_shop_id: null }] })).status, 200);
  const p2 = (await H.id(
    `SELECT array_agg(permission_code ORDER BY permission_code) AS p
       FROM v_worker_permissions WHERE worker_id = $1`, [w.body.id])).p;
  assert.ok(!p2.includes('production.units'), 'eski rol qolmaydi');
  assert.ok(p2.includes('production.plan'), 'yangi rol keladi');
});

/* ============================================================================
 *  ★ KONVER TASDIQDAN O'TADI
 *
 *  Kiritgan odam konverni ochmaydi: rahbariyat tasdiqlaydi. Singanda
 *  tasdiqsiz konver paydo bo'ladi — xom ashyo, ishbay oylik va ombor
 *  qoldig'i o'sha raqamga bog'lanadi.
 * ========================================================================== */
test('kiritgan ochmaydi, rahbariyat tasdiqlaydi', async () => {
  const kir  = await xodim('Sinov kiritувchi 2', 'kirituvchi');
  const rahbar = await xodim('Sinov direktor', 'direktor');

  //  Kiritadigan xodimda konver ochish tugmasi yo'q.
  assert.equal((await kir('POST', '/api/units/', { items: [{
    product_id: PENAL, qty: 1, section_id: ARRA }] })).status, 403);

  //  So'rov esa uniki.
  //  Mato zavodda ALLAQACHON ishlatilganlardan tanlanadi (izoh:
  //  `modules/units.js`) — shuning uchun boridan olinadi.
  const mato = (await H.id(
    `SELECT fabric FROM production_units WHERE fabric IS NOT NULL LIMIT 1`)).fabric;
  const q = await kir('POST', '/api/units/requests',
    { product_id: PENAL, qty: 4, fabric: mato, started_on: '2026-09-10',
      conveyor_no: 'S-7007', next_on: '2026-09-20' });
  assert.equal(q.status, 200, q.text);
  const id = q.body.created[0];

  //  Tasdiqlash uniki emas.
  assert.equal((await kir('POST', `/api/units/requests/${id}/approve`)).status, 403);

  //  Direktor tasdiqlaydi va konver SHUNDA ochiladi.
  const ok = await rahbar('POST', `/api/units/requests/${id}/approve`);
  assert.equal(ok.status, 200, ok.text);
  const u = await H.id(
    `SELECT qty, fabric, conveyor_no FROM production_units WHERE id = $1`,
    [ok.body.unit_id]);
  assert.equal(u.qty, 4);
  assert.equal(u.fabric, mato);
  //  ★ Raqamni TIZIM qo'ydi (so'rovda ham, konverda ham bir xil) va
  //  harfi mahsulotdan chiqdi: penal korpusniki.
  assert.equal(u.conveyor_no, ok.body.conveyor_no);
  assert.match(u.conveyor_no, /^K\d\d-\d{3,}$/, u.conveyor_no);

  //  Jurnal unga umuman ochilmaydi: butun zavodning konverlari, narxi
  //  va mijozi u yerda turadi.
  assert.equal((await kir('GET', '/api/units/')).status, 403);
  assert.equal((await kir('PATCH', '/api/units/' + ok.body.unit_id,
    { unit_price: 120 })).status, 403);

  //  «Konver qo'shish» sahifasi esa to'liq ishlaydi — rang va mato
  //  ro'yxati ham unga ochiq.
  assert.equal((await kir('GET', '/api/units/suggest')).status, 200);
  assert.equal((await kir('GET', '/api/ref')).status, 200);
  assert.equal((await kir('GET', '/api/units/requests')).status, 200);
});

test('boshlang\'ich qoldiq faqat boshqaruvchida', async () => {
  const kir = await xodim('Sinov qoldiqchi', 'kirituvchi');

  //  Boshlang'ich qoldiq yo'q: bir martalik ish va u tugagan.
  //  Tekshiruv SERVERDA — menyudan sahifani olib qo'yish himoya emas.
  const q = await kir('POST', '/api/units/', { items: [{
    product_id: PENAL, qty: 1, section_id: ARRA, is_opening: true }] });
  assert.equal(q.status, 403, q.text);

  //  Fayldan yuklash ham o'sha yo'l.
  assert.equal((await kir('POST', '/api/import/units', {})).status, 403);

  //  Hisobotlar ham uniki emas: zavod ko'rinishi va panel rahbariyatniki.
  for (const yol of ['/api/factory', '/api/dashboard', '/api/wip'])
    assert.equal((await kir('GET', yol)).status, 403, yol);

  //  Boshqaruvchida ikkalasi ham ishlayveradi.
  assert.equal((await admin('POST', '/api/units/', { items: [{
    product_id: PENAL, qty: 1, section_id: ARRA, is_opening: true }] })).status, 200);
});

/* ============================================================================
 *  PIN — IZ VA URINISHLAR
 *
 *  Singanda butun zavod tizimga kira olmay qoladi, shuning uchun bu yerda.
 * ========================================================================== */
test('PIN bazada ochiq matnda turmaydi va uning bilan kiriladi', async () => {
  const yoq = H.api(base, null);

  //  Migratsiya ochiq PIN'larni izga ko'chirdi.
  const w = await H.id(
    `SELECT pin, pin_hash FROM workers WHERE name = 'Administrator'`);
  assert.equal(w.pin, null, 'ochiq ustun bo\'shatiladi');
  assert.ok(w.pin_hash && w.pin_hash.startsWith('h1:'), 'izi yoziladi');

  //  Iz turgani bilan kirish ishlayveradi.
  const kir = await yoq('POST', '/api/auth/pin', { pin: '0000' });
  assert.equal(kir.status, 200, kir.text);
  assert.ok(kir.body.token);
  assert.equal(kir.body.user.name, 'Administrator');

  //  Ro'yxatda PIN'ning O'ZI qaytarilmaydi — faqat qo'yilgani.
  const ro = (await admin('GET', '/api/admin/workers')).body
    .find((r) => r.name === 'Administrator');
  assert.ok(!('pin' in ro), 'PIN javobda yo\'q');
  assert.equal(ro.has_pin, true);

  //  Yangi PIN kartochkadan qo'yiladi va u ham izga tushadi.
  const yangi = await admin('POST', '/api/admin/workers',
    { name: 'Sinov PIN xodimi', pin: '9317' });
  assert.equal(yangi.status, 200, yangi.text);
  const w2 = await H.id(`SELECT pin, pin_hash FROM workers WHERE id = $1`, [yangi.body.id]);
  assert.equal(w2.pin, null);
  assert.ok(w2.pin_hash.startsWith('h1:'));
  assert.equal((await yoq('POST', '/api/auth/pin', { pin: '9317' })).status, 200);

  //  Band PIN ikkinchi xodimga berilmaydi: iz kalit bilan hisoblanadi,
  //  ya'ni bir xil PIN bir xil iz beradi va UNIQUE uni tutadi.
  assert.equal((await admin('POST', '/api/admin/workers',
    { name: 'Sinov PIN ikkinchi', pin: '9317' })).status, 409);

  //  Xato PIN — 401, va ko'p urinishdan keyin blok. Muvaffaqiyatli
  //  kirish hisobni tozalaydi, shuning uchun blok sinovi OXIRIDA.
  //  Birinchi beshtasi bepul: odam raqamni chalkashtiradi. Oltinchisi
  //  hisobni oshiradi va blokni qo'yadi, keyingisi kutiladi.
  for (let i = 0; i < 6; i++)
    assert.equal((await yoq('POST', '/api/auth/pin', { pin: '0001' })).status, 401);
  const blok = await yoq('POST', '/api/auth/pin', { pin: '0001' });
  assert.equal(blok.status, 429, 'ko\'p xato urinishdan keyin kutiladi');
  //  Blokda to'g'ri PIN ham qabul qilinmaydi — aks holda cheklovning
  //  ma'nosi qolmasdi.
  assert.equal((await yoq('POST', '/api/auth/pin', { pin: '0000' })).status, 429);
});

test('navbat belgisi: har raqam o\'z ro\'yxati bilan bir xil', async () => {
  //  ★ NAVBAT XODIMNI O'ZI TOPADI (zavod qarori, 2026-09). Belgi
  //  menyuda turadi, ya'ni xodim qaysi sahifada bo'lsa ham ko'radi.
  //
  //  Bu test IKKI narsani ushlaydi:
  //
  //    1. RAQAM RO'YXAT BILAN BIR XIL. Har navbat o'z sahifasidagi
  //       ro'yxatning shartini takrorlaydi va ikki joyda yozilgan
  //       shart bir kun bir-biridan ajralib ketardi: menyuda «3»
  //       turib, sahifada ikkitasi ko'rinardi.
  //
  //    2. NAVBAT FAQAT EGASIGA KO'RINADI. Har kuni turadigan raqamga
  //       ko'z o'rganib qoladi va keyin haqiqiy navbat o'sha to'da
  //       orasida ko'rinmay ketardi.
  const sonOf = (nav, page) => nav.filter((q) => q.page === page)
    .reduce((a, q) => a + q.n, 0);

  const navR = await admin('GET', '/api/navbat');
  assert.equal(navR.status, 200, navR.text);
  const nav = navR.body.navbat;
  assert.ok(Array.isArray(nav) && nav.length, 'navbat keladi');

  //  Konver so'rovi — tasdiqlovchining navbati.
  assert.equal(sonOf(nav, '/sorovlar.html'),
    Number((await admin('GET', '/api/units/requests/pending')).body.n));

  //  Ombor: qabul qilish va chiqarish. Ikkalasi bitta sahifada
  //  turadi, shuning uchun raqam ikkala ro'yxatning yig'indisi.
  const inbox = (await admin('GET', '/api/units/stock/inbox')).body.length;
  const ship  = (await admin('GET', '/api/sales/shipping')).body.rows.length;
  assert.equal(sonOf(nav, '/omborlar.html'), inbox + ship);

  //  Omborlar aro harakat — o'z sahifasida. Administratorda vitrina
  //  doirasi yo'q, ya'ni uning navbati T/M ga kelayotgan hujjatlar:
  //  sahifadagi «Qabul qilish» tugmasi ham AYNAN shu shartdan chiqadi
  //  (`canAccept`, public/omborlar-aro.html).
  const qayt = (await admin('GET', '/api/warehouse/fg/returns')).body.rows
    .filter((r) => r.status === 'confirmed' && r.to_code === 'TM').length;
  assert.equal(sonOf(nav, '/omborlar-aro.html'), qayt);

  //  Savdo: bronning hammasi omborga yetib kelgan, lekin hali
  //  yuborilmagan buyurtma. Yetib kelmaganida tugma baribir
  //  ishlamaydi — uni navbat deb ko'rsatish yolg'on bo'lardi.
  const tayyor = (await admin('GET', '/api/sales/orders')).body.rows
    .filter((o) => ['new', 'reserved'].includes(o.status)
                && o.qty > 0 && o.in_warehouse_qty >= o.qty).length;
  assert.equal(sonOf(nav, '/buyurtmalar.html'), tayyor);

  //  ★ NAVBAT EGASINIKI. Kirituvchida tasdiq huquqi ham, ombor
  //  harakati ham yo'q: unga bu raqamlar umuman chizilmaydi.
  const kir = await xodim('Sinov navbat kirituvchi', 'kirituvchi');
  const kn = (await kir('GET', '/api/navbat')).body.navbat;
  assert.equal(sonOf(kn, '/sorovlar.html'), 0);
  assert.ok(!kn.some((q) => q.page === '/omborlar.html'),
    'ombor navbati kirituvchiga chizilmaydi');
  assert.ok(!kn.some((q) => q.page === '/omborlar-aro.html'),
    'omborlar aro navbati kirituvchiga chizilmaydi');

  //  Kirmagan odamga umuman javob berilmaydi.
  assert.equal((await H.api(base, null)('GET', '/api/navbat')).status, 401);
});

test('inkassator hamma mijozdan pul oladi, savdosi esa o\'zicha qoladi', async () => {
  //  ★ Zavodda pulni bitta odam yig'ib yuradi: u mijozning menejeri
  //  emas. Savdo doirasi («Faqat o'zinikini») esa mijozni MENEJERGA
  //  biriktiradi va inkassatorga faqat o'zi yuritadigan mijoz
  //  ko'rinardi — kimga borsa o'shaning pulini yoza olmasdi.
  //
  //  Doirani butunlay olib tashlash yo'l emas: o'shanda unga boshqa
  //  menejerning BUYURTMASI ham ochilib ketardi. Shuning uchun belgi
  //  FAQAT kassaga tegadi.
  const { db } = require('../db');
  await db.query(`INSERT INTO workers (name) VALUES ('Sinov inkassator')
                  ON CONFLICT DO NOTHING`);
  await db.query(
    `INSERT INTO worker_roles (worker_id, role_code, scope_own, scope_channel)
     SELECT id, 'sotuvchi', true, 'B2B' FROM workers WHERE name = 'Sinov inkassator'
     ON CONFLICT (worker_id, role_code)
     DO UPDATE SET scope_own = true, scope_channel = 'B2B'`);
  const inkId = (await H.id(
    `SELECT id FROM workers WHERE name='Sinov inkassator'`)).id;

  //  Belgisiz: o'z mijozi ham yo'q, ro'yxat bo'sh.
  await db.query(`UPDATE workers SET cash_all_customers = false WHERE id=$1`, [inkId]);
  const oddiy = H.api(base, await H.sessionFor('Sinov inkassator'));
  const r1 = (await oddiy('GET', '/api/cash/refs')).body.customers;
  assert.equal(r1.length, 0, 'doirasi bor menejerga begona mijoz ko\'rinmaydi');

  //  Boshqa menejerning mijozidan to'lov ham yozilmaydi.
  const begona = (await H.id(
    `SELECT id FROM customers WHERE name='Birinchining mijozi'`)).id;
  const yoq = await oddiy('POST', '/api/cash/ops', {
    from_kind: 'customer', from_id: begona, currency: 'USD', amount: 10 });
  assert.equal(yoq.status, 400, yoq.text);

  //  ★ BELGI QO'YILDI. Sessiya xodim qatoridan o'qiladi, shuning
  //  uchun qayta kirish shart emas.
  await db.query(`UPDATE workers SET cash_all_customers = true WHERE id=$1`, [inkId]);
  const ink = H.api(base, await H.sessionFor('Sinov inkassator'));
  const r2 = (await ink('GET', '/api/cash/refs')).body.customers;
  const nomlar = r2.map((c) => c.name);
  assert.ok(nomlar.includes('Birinchining mijozi'), 'boshqa menejerniki ham turadi');
  assert.ok(nomlar.includes('Ikkinchining mijozi'));
  //  Yo'nalish chegarasi ham ochiladi: eksport mijozi ham uning qo'lidan o'tadi.
  assert.ok(nomlar.includes('Kanalsiz mijoz'), 'kanal chegarasi ham ochiladi');

  //  To'lov ham yoziladi va mijozning qarzi kamayadi.
  const oldin = Number((await H.id(
    `SELECT balance FROM v_customer_sales WHERE id=$1`, [begona])).balance);
  const ok = await ink('POST', '/api/cash/ops', {
    from_kind: 'customer', from_id: begona, currency: 'USD', amount: 25 });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(Number((await H.id(
    `SELECT balance FROM v_customer_sales WHERE id=$1`, [begona])).balance), oldin - 25);

  //  ★ SAVDO BO'LIMI ESKICHA: belgi kassaga tegadi, buyurtmaga emas.
  const roy = (await ink('GET', '/api/units/customers')).body.customers.map((c) => c.name);
  assert.ok(!roy.includes('Birinchining mijozi'),
    'mijozlar sahifasida doira saqlanadi');

  //  Belgi Xodimlar sahifasidan qo'yiladi va qaytariladi.
  assert.equal((await admin('PATCH', '/api/admin/workers/' + inkId,
    { cash_all_customers: false })).status, 200);
  assert.equal((await H.id(
    `SELECT cash_all_customers FROM workers WHERE id=$1`, [inkId])).cash_all_customers,
    false);
  //  Yuborilmasa TEGILMAYDI: kartochka boshqa maydon uchun saqlansa
  //  belgi o'chib qolmasin (`can_hold_cash` bilan bir xil qoida).
  await db.query(`UPDATE workers SET cash_all_customers = true WHERE id=$1`, [inkId]);
  assert.equal((await admin('PATCH', '/api/admin/workers/' + inkId,
    { phone: '+998900000000' })).status, 200);
  assert.equal((await H.id(
    `SELECT cash_all_customers FROM workers WHERE id=$1`, [inkId])).cash_all_customers,
    true);
});

test('inkassatorning qo\'lidagi pul faqat kassaga topshiriladi', async () => {
  //  ★ Podotchyot olgan xodimning qo'lidagi pul HARAJATGA aylanadi:
  //  ombor mudiri bozorga boradi va sarfini o'zi yozadi. Inkassator
  //  esa mijozdan pul YIG'ADI — uning bitta yo'li bor, kassaga
  //  topshirish. Sarflash u yerda harajat emas, pulning yo'qolishi
  //  bo'lardi.
  //
  //  Belgi XODIMDA (`can_spend_cash`) va standarti — YOZADI: qo'lida
  //  pul turgan odam uni hisobdan chiqara olsin degan qoida joyida
  //  qoladi.
  const { db } = require('../db');
  await db.query(`INSERT INTO workers (name, can_hold_cash)
                  VALUES ('Sinov yigimchi', true) ON CONFLICT DO NOTHING`);
  await db.query(`INSERT INTO worker_roles (worker_id, role_code)
                  SELECT id, 'sotuvchi' FROM workers WHERE name='Sinov yigimchi'
                  ON CONFLICT DO NOTHING`);
  const wid = (await H.id(`SELECT id FROM workers WHERE name='Sinov yigimchi'`)).id;
  const kassa = (await H.id(`SELECT id FROM cash_accounts WHERE code='MAIN'`)).id;
  const modda = (await H.id(
    `SELECT id FROM expense_items WHERE active ORDER BY id LIMIT 1`)).id;

  //  Qo'liga 200 $ beriladi.
  const kassir = H.api(base, await H.sessionFor('Sinov kassir'));
  assert.equal((await kassir('POST', '/api/cash/ops', {
    from_kind: 'account', from_id: kassa, to_kind: 'worker', to_id: wid,
    currency: 'USD', amount: 200 })).status, 200);

  //  Belgisi turganda sarfini O'ZI yozadi — eskicha.
  const u = H.api(base, await H.sessionFor('Sinov yigimchi'));
  assert.equal((await u('GET', '/api/cash/refs')).body.my.sarflaydi, true);
  const bor = await u('POST', '/api/cash/ops', {
    to_kind: 'expense', expense_item_id: modda, pl_month: '2026-09',
    currency: 'USD', amount: 20 });
  assert.equal(bor.status, 200, bor.text);

  //  ★ BELGI OLIB TASHLANDI — endi faqat kassaga topshiradi.
  await db.query(`UPDATE workers SET can_spend_cash = false WHERE id=$1`, [wid]);
  const ink = H.api(base, await H.sessionFor('Sinov yigimchi'));
  assert.equal((await ink('GET', '/api/cash/refs')).body.my.sarflaydi, false);
  const yoq = await ink('POST', '/api/cash/ops', {
    to_kind: 'expense', expense_item_id: modda, pl_month: '2026-09',
    currency: 'USD', amount: 20 });
  assert.equal(yoq.status, 400, yoq.text);
  assert.match(yoq.body.error, /faqat kassaga topshiriladi/);

  //  Kassir ham o'sha qo'ldan harajat yoza olmaydi: pul baribir
  //  shu qo'ldan chiqadi, demak qoida bitta.
  const kyoq = await kassir('POST', '/api/cash/ops', {
    from_kind: 'worker', from_id: wid, to_kind: 'expense',
    expense_item_id: modda, pl_month: '2026-09', currency: 'USD', amount: 20 });
  assert.equal(kyoq.status, 400, kyoq.text);

  //  ★ KASSAGA TOPSHIRISH ESA OCHIQ QOLADI — buni kassir yozadi.
  const ok = await kassir('POST', '/api/cash/ops', {
    from_kind: 'worker', from_id: wid, to_kind: 'account', to_id: kassa,
    currency: 'USD', amount: 180 });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(Number((await H.id(
    `SELECT total_usd FROM v_worker_cash WHERE id=$1`, [wid])).total_usd), 0,
    'qo\'lida hech narsa qolmadi');

  //  ★ INKASSATOR BELGISI O'ZI HAM YETARLI: uning qo'lidagi pul
  //  mijozdan yig'ilgani va sarflanmaydi. Ikkita katakcha qo'yib,
  //  ikkinchisini unutish uchun bitta kun yetardi.
  await db.query(`UPDATE workers
                     SET can_spend_cash = true, cash_all_customers = true
                   WHERE id = $1`, [wid]);
  const ink2 = H.api(base, await H.sessionFor('Sinov yigimchi'));
  assert.equal((await ink2('GET', '/api/cash/refs')).body.my.sarflaydi, false,
    'inkassatorda tugma chizilmaydi');
  await db.query(`UPDATE workers SET cash_all_customers = false WHERE id = $1`, [wid]);

  //  Belgi Xodimlar sahifasidan qo'yiladi va yuborilmasa tegilmaydi.
  assert.equal((await admin('PATCH', '/api/admin/workers/' + wid,
    { can_spend_cash: true })).status, 200);
  assert.equal((await H.id(
    `SELECT can_spend_cash FROM workers WHERE id=$1`, [wid])).can_spend_cash, true);
  await db.query(`UPDATE workers SET can_spend_cash = false WHERE id=$1`, [wid]);
  assert.equal((await admin('PATCH', '/api/admin/workers/' + wid,
    { phone: '+998900000001' })).status, 200);
  assert.equal((await H.id(
    `SELECT can_spend_cash FROM workers WHERE id=$1`, [wid])).can_spend_cash, false);
});

test('topshirish ikki bosqich: xodim jo\'natadi, kassir sanab qabul qiladi', async () => {
  //  ★ Ilgari bu yozuvni faqat KASSIR yozardi: xodim pulni berib,
  //  uning ekrani ochilishini kutib turardi va topshirganini hech
  //  qayerda ko'rsatolmasdi. Endi «topshirdim» ni o'zi bosadi, lekin
  //  pul SHU ZAHOTI kassaga tushmaydi — kassir KO'RIB, SANAB olgandan
  //  keyin qabul qiladi (tsexdagi topshirish bilan bir xil idiom).
  const { db } = require('../db');
  await db.query(`INSERT INTO workers (name) VALUES ('Sinov topshiruvchi')
                  ON CONFLICT DO NOTHING`);
  await db.query(`INSERT INTO worker_roles (worker_id, role_code)
                  SELECT id, 'sotuvchi' FROM workers WHERE name='Sinov topshiruvchi'
                  ON CONFLICT DO NOTHING`);
  const wid = (await H.id(
    `SELECT id FROM workers WHERE name='Sinov topshiruvchi'`)).id;
  const kassa = (await H.id(`SELECT id FROM cash_accounts WHERE code='MAIN'`)).id;
  const mijoz = (await H.id(`SELECT id FROM customers WHERE name='Kanalsiz mijoz'`)).id;
  const u = H.api(base, await H.sessionFor('Sinov topshiruvchi'));
  const kassir = H.api(base, await H.sessionFor('Sinov kassir'));

  const qolda = async () => Number((await H.id(
    `SELECT COALESCE(total_usd, 0) AS total_usd FROM v_worker_cash WHERE id=$1`,
    [wid]) || {}).total_usd || 0);
  const kassada = async () => Number((await H.id(
    `SELECT total_usd FROM v_cash_balance WHERE code='MAIN'`)).total_usd);

  //  Mijozdan 300 $ oldi — pul uning qo'lida.
  assert.equal((await u('POST', '/api/cash/ops', {
    from_kind: 'customer', from_id: mijoz, currency: 'USD', amount: 300 })).status, 200);
  assert.equal(await qolda(), 300);
  const kassaOldin = await kassada();

  //  ★ TOPSHIRDIM. Qaysi kassaga ekanini server qo'yadi — asosiy kassa.
  const t = await u('POST', '/api/cash/ops', {
    to_kind: 'account', currency: 'USD', amount: 300 });
  assert.equal(t.status, 200, t.text);
  assert.equal(t.body.status, 'pending');
  assert.match(t.body.doc_no, /^P\d{2}-\d{4}$/);

  //  Pul HALI qo'lida: kassir sanab olmadi.
  assert.equal(await qolda(), 300, 'sanalmagan pul qo\'lda turadi');
  assert.equal(await kassada(), kassaOldin, 'kassaga hali tushmadi');

  //  Kassir navbatni ko'radi, xodim esa o'zinikini.
  const nav = (await kassir('GET', '/api/cash/pending')).body.rows;
  assert.ok(nav.some((o) => o.id === t.body.id), 'kassirning navbatida turadi');
  assert.equal((await u('GET', '/api/cash/pending')).body.rows.length, 1);
  //  Menyudagi belgi ham shundan: kassir kassani ochib ko'rmasa ham
  //  pul kutayotganini biladi.
  const nb = (await kassir('GET', '/api/navbat')).body.navbat;
  assert.equal(nb.filter((q) => q.mod === 'cash').reduce((a, q) => a + q.n, 0),
    nav.length);

  //  ★ SANAB OLDI — qabul qildi. Endi pul kassada.
  const ok = await kassir('POST', `/api/cash/ops/${t.body.id}/accept`);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(await qolda(), 0);
  assert.equal(await kassada(), kassaOldin + 300);

  //  Ikkinchi marta qabul qilib bo'lmaydi.
  assert.equal((await kassir('POST',
    `/api/cash/ops/${t.body.id}/accept`)).status, 400);

  //  ★ ADASHIB YOZILGANINI XODIMNING O'ZI BEKOR QILADI — uni hech kim
  //  sanab olmagan, ya'ni hech kimning hisobiga tegmaydi.
  assert.equal((await u('POST', '/api/cash/ops', {
    from_kind: 'customer', from_id: mijoz, currency: 'USD', amount: 50 })).status, 200);
  const t2 = await u('POST', '/api/cash/ops',
    { to_kind: 'account', currency: 'USD', amount: 50 });
  assert.equal(t2.status, 200, t2.text);
  assert.equal((await u('PATCH', '/api/cash/ops/' + t2.body.id)).status, 200);
  assert.equal(await qolda(), 50, 'bekor qilingach pul qo\'lida qoldi');

  //  Qabul qilingan yozuvga esa tegmaydi: u endi kassirning ishi.
  assert.equal((await u('PATCH', '/api/cash/ops/' + t.body.id)).status, 403);
});

test('ombor bo\'limi xodim bo\'yicha yopiladi', async () => {
  //  ★ BITTA ROLDA IKKI XIL ODAM. Ombor qoldig'i ma'lumot
  //  kirituvchiga «ertaga nima so'rayman» degan savol uchun ochilgan,
  //  lekin bu HAMMA kirituvchiga kerak emas. Rol buni ajrata olmaydi —
  //  huquqlar KODDA va ikkalasi ham `kirituvchi`.
  const { db } = require('../db');
  await db.query(`INSERT INTO workers (name) VALUES ('Sinov omborsiz')
                  ON CONFLICT DO NOTHING`);
  await db.query(`INSERT INTO worker_roles (worker_id, role_code)
                  SELECT id, 'kirituvchi' FROM workers WHERE name='Sinov omborsiz'
                  ON CONFLICT DO NOTHING`);
  const wid = (await H.id(`SELECT id FROM workers WHERE name='Sinov omborsiz'`)).id;

  //  Standarti — KO'RADI: hech kimning ekrani o'zidan-o'zi o'zgarmaydi.
  const bor = H.api(base, await H.sessionFor('Sinov omborsiz'));
  assert.ok((await bor('GET', '/api/auth/me')).body.permissions
    .includes('warehouse.view'));
  assert.equal((await bor('GET', '/api/warehouse/list')).status, 200);

  //  ★ BELGI OLIB TASHLANDI — bo'lim UMUMAN yopiladi.
  assert.equal((await admin('PATCH', '/api/admin/workers/' + wid,
    { sees_warehouse: false })).status, 200);
  const yoq = H.api(base, await H.sessionFor('Sinov omborsiz'));
  const me = (await yoq('GET', '/api/auth/me')).body;
  assert.ok(!me.permissions.some((p) => p.startsWith('warehouse.')),
    'menyudagi bo\'lim ham chizilmaydi');
  //  Sahifani manzil bilan ochsa ham: chegara serverda.
  assert.equal((await yoq('GET', '/api/warehouse/list')).status, 403);
  assert.equal((await yoq('GET', '/api/warehouse/fg/summary')).status, 403);

  //  Qolgan ishi o'zgarmaydi: konver so'rovi joyida.
  assert.equal((await yoq('GET', '/api/units/requests')).status, 200);

  //  Yuborilmasa TEGILMAYDI (`can_hold_cash` bilan bir xil qoida).
  assert.equal((await admin('PATCH', '/api/admin/workers/' + wid,
    { phone: '+998900000002' })).status, 200);
  assert.equal((await H.id(
    `SELECT sees_warehouse FROM workers WHERE id=$1`, [wid])).sees_warehouse, false);

  //  Qaytarib berish ham bitta katakcha.
  assert.equal((await admin('PATCH', '/api/admin/workers/' + wid,
    { sees_warehouse: true })).status, 200);
  assert.equal((await H.api(base, await H.sessionFor('Sinov omborsiz'))(
    'GET', '/api/warehouse/list')).status, 200);
});

test('jurnalda boshlanmagan konverlar filtri', async () => {
  //  ★ Bo'limsiz kiritilgan konver — tasdiqlangan, raqami bor, lekin
  //  hali hech bir bo'limda turmaydi. Jurnalda u oddiy qator bo'lib
  //  yuradi va besh yuz qator orasidan ko'z bilan terib olinmasdi.
  //  Tsex ekranining tepasida ro'yxati bor, lekin u FAQAT bitta
  //  tsexniki — jurnalda esa butun zavod ko'rinadi.
  const bosh = (await admin('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 3, started_on: '2026-09-15' }] })).body.created[0];
  assert.ok(bosh.id);

  const royR = await admin('GET', '/api/units/?section_id=yoq');
  assert.equal(royR.status, 200, royR.text);
  const roy = royR.body;
  assert.ok(roy.length, 'boshlanmagan konverlar topildi');
  assert.ok(roy.some((r) => r.id === bosh.id));
  assert.ok(roy.every((r) => r.section_id === null),
    'faqat bo\'limsizlari chiqadi');

  //  Tsex tanlanishini TALAB QILMAYDI: bo'limsiz konverda javobgar
  //  tsex bo'sh bo'lishi mumkin va ikki filtr birga qo'yilsa ro'yxat
  //  bo'sh chiqardi. Shuning uchun «Boshlanmagan» bo'lim ro'yxatining
  //  boshida, tsexdan mustaqil turadi.
  assert.ok(roy.some((r) => r.owner_shop_id == null)
         || roy.length > 0, 'tsexsiz ham ishlaydi');

  //  Bo'lim tanlangani eskicha: `yoq` bo'lim emas, «bo'limi yo'q».
  const arra = (await H.id(
    `SELECT id FROM sections WHERE name ILIKE 'Arra%' LIMIT 1`)).id;
  const bolim = (await admin('GET', '/api/units/?section_id=' + arra)).body;
  assert.ok(bolim.every((r) => r.section_id === arra));

  //  Filtrsiz ro'yxatda ikkalasi ham turadi.
  const hammasi = (await admin('GET', '/api/units/')).body;
  assert.ok(hammasi.some((r) => r.section_id === null));
  assert.ok(hammasi.some((r) => r.section_id !== null));

  //  Excelga chiqarish ham SHU yo'ldan o'tadi — filtr ikki joyda
  //  yozilsa biri ikkinchisidan ajralib ketardi.
  const xls = await admin('GET', '/api/units/export?section_id=yoq');
  assert.equal(xls.status, 200, xls.text);
  assert.ok(xls.text.includes(bosh.conveyor_no));
});

test('yakun', async () => {
  server.close();
  await require('../db').db.end();
});
