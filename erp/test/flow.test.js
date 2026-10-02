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

//  ★ XOM ASHYOSIZ BO'LIMDAN O'TKAZILMAYDI (izoh: modules/units.js,
//  sql/materials.sql). `needs_material` belgili bo'limda (Arra, Lak
//  karkas, Qadoqlash, Qoplash, Zborka karkas) konver material
//  yozilmasdan keyingi bo'limga o'tmaydi.
//
//  Quyidagi testlarning ko'pchiligi material haqida EMAS — ularda
//  konver shunchaki yo'lda yurishi kerak. Shuning uchun o'tkazishdan
//  oldin «bu bo'limda biriktirilmaydi» belgisi qo'yiladi: ekranda
//  usta bosadigan tugmaning AYNAN o'zi. Qoidaning O'ZI alohida
//  testda tekshiriladi.
const xomsiz = () => require('../db').db.query(
  `INSERT INTO unit_no_material (unit_id, section_id)
   SELECT u.id, u.current_section_id
     FROM production_units u
     JOIN sections s ON s.id = u.current_section_id AND s.needs_material
    WHERE u.status = 'production'
   ON CONFLICT DO NOTHING`);

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
  await xomsiz();
  const ok = await korpus('POST', '/api/units/move', { items: [{ unit_id: u.id }] });
  assert.equal(ok.status, 200, ok.text);
  assert.equal((await H.id(`SELECT current_section_id s FROM production_units WHERE id=$1`,
    [u.id])).s, ROVER);

  // Marshrutdan tashqari bo'lim — stul tsexinikini olamiz: penal u yerdan
  // o'tmaydi. (Qadoqlash bo'limi penalning marshrutida BOR, shuning uchun
  // u bu qoidani sinash uchun yaramaydi.) Admin orqali: tsex ustasida
  // avval doira tekshiriladi va marshrut qoidasiga navbat yetmaydi.
  const STUZBOR = (await H.id(`SELECT id FROM sections WHERE code='STU-ZBOR'`)).id;
  await xomsiz();
  const bad = await admin('POST', '/api/units/move',
    { items: [{ unit_id: u.id, section_id: STUZBOR }] });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /marshrutda yo'q/);
});

test('jo\'natilmagan konverni keyingi tsex qabul qila olmaydi', async () => {
  const u = await newUnit({ section_id: SHKUR });

  await xomsiz();
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
  await xomsiz();
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
  await xomsiz();
  assert.equal((await qad('POST', '/api/units/move', { items: [{ unit_id: u.id }] })).status, 200);

  const row = await H.id(`SELECT status FROM production_units WHERE id=$1`, [u.id]);
  assert.equal(row.status, 'production', 'ombor qabul qilmaguncha ishlab chiqarishda');
  assert.equal((await H.id(
    `SELECT COALESCE((SELECT qty FROM fg_stock WHERE product_id=$1),0) q`, [PENAL])).q, before);

  //  Qaytarish ham qoldiqqa tegmaydi — u oshmagan edi. Huquqi
  //  `production.undo`, ya'ni FAQAT administratorda: usta bosa
  //  olmaydi (pastda alohida tekshiriladi).
  const admin1 = H.api(base, tokenAdmin);
  assert.equal((await admin1('POST', '/api/units/undo', { unit_id: u.id })).status, 200);
  assert.equal((await H.id(
    `SELECT COALESCE((SELECT qty FROM fg_stock WHERE product_id=$1),0) q`, [PENAL])).q, before);
});

test('T/M ombor: jo\'natdim → qabul qildim → jurnaldan chiqadi', async () => {
  const QADOYNA = (await H.id(`SELECT id FROM sections WHERE code='QAD-OYNA'`)).id;
  const u = await newUnit({ section_id: QADOYNA });
  const qad = H.api(base, await H.sessionFor('Qadoqlash ustasi'));
  await xomsiz();
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
  const back = await H.api(base, tokenAdmin)('POST', '/api/units/undo',
    { unit_id: u.id });
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
  await xomsiz();
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
  await xomsiz();
  assert.equal((await savdo('POST', '/api/units/move',
    { items: [{ unit_id: bor.id }] })).status, 403);
  // Omborda: qoldiq ochiq, qabul qilish va kirim/chiqim tarixi yopiq
  assert.equal((await savdo('GET', '/api/warehouse/fg/summary')).status, 200);
  assert.equal((await savdo('POST', '/api/units/stock/accept',
    { items: [bor.id] })).status, 403, 'savdo omborga qabul qila olmaydi');
  assert.equal((await savdo('GET', '/api/units/stock/moves')).status, 403);
  //  ★ MIJOZNI HAR MENEJER QO'SHMAYDI (izoh: sql/units.sql): mijoz
  //  bazasi savdoning o'qi va bitta mijoz ikki nom bilan kirsa qarzi
  //  ham ikkiga bo'linib qolardi. Belgi XODIMDA — rol buni ajrata
  //  olmaydi: `savdo_boshliq` ning huquqlari `sotuvchi` nikiga aynan
  //  teng. Standarti BELGILANMAGAN, ya'ni menejerda tugma yo'q.
  assert.equal((await savdo('POST', '/api/units/customers',
    { name: 'Savdo qo\'shgan mijoz' })).status, 403,
    'belgisi yo\'q xodim mijoz qo\'shmaydi');
  //  Fayldan yuklash ham QO'SHISH yo'li — ikkinchi eshik ochiq
  //  qolmaydi. Fayl CSV bo'lib boradi, shuning uchun yordamchi emas,
  //  to'g'ridan-to'g'ri `fetch`.
  {
    const r = await fetch(base + '/api/import/customers', {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv',
                 Authorization: 'Bearer ' + (await H.sessionFor('Sinov sotuvchi')) },
      body: 'Nomi\nFayldan mijoz\n',
    });
    assert.equal(r.status, 403, 'fayldan yuklash ham yopiq');
  }

  //  Belgi qo'yilsa o'sha zahoti ochiladi — kodga na ism, na lavozim
  //  yozilmaydi (4-qoida).
  {
    const { db } = require('../db');
    await db.query(
      `UPDATE workers SET can_add_customer = true WHERE name = 'Sinov sotuvchi'`);
  }
  assert.equal((await savdo('POST', '/api/units/customers',
    { name: 'Savdo qo\'shgan mijoz' })).status, 200);
  //  Mijozni TAHRIRLASH belgidan qat'i nazar ochiq: menejer o'z
  //  mijozining telefonini to'g'rilaydi, yangi qator ochmaydi.
  {
    const { db } = require('../db');
    await db.query(
      `UPDATE workers SET can_add_customer = false WHERE name = 'Sinov sotuvchi'`);
    const c = (await H.id(
      `SELECT id FROM customers WHERE name = 'Savdo qo''shgan mijoz'`)).id;
    assert.equal((await savdo('PATCH', '/api/units/customers/' + c,
      { phone: '+998900000000' })).status, 200, 'tahrirlash ochiq qoladi');
  }

  // Konverni omborga kiritamiz: rang va mato bilan, chunki jamlanma
  // aynan shular bo'yicha guruhlanadi.
  const QADOYNA = (await H.id(`SELECT id FROM sections WHERE code='QAD-OYNA'`)).id;
  const u = await newUnit({ section_id: QADOYNA, color: 'Venge', fabric: 'Velvet-12' });
  const qad = H.api(base, await H.sessionFor('Qadoqlash ustasi'));
  await xomsiz();
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

test('stul o\'z tsexidan chiqmaydi: marshrut boshidan oxirigacha stulniki', async () => {
  //  ★ ZAVOD QARORI (2026-09). Ilgari stul lak ishini BO'YOQLASH
  //  tsexining kabinasida olardi va o'sha yerdan qaytib kelardi:
  //  konver begona tsexning bo'limida turar, uni kim yuritishi esa
  //  `owner_shop_id` bilan hal qilinardi. Endi stul tsexining O'Z
  //  astar va lak bo'limlari bor — marshrut ularga ko'chdi va savol
  //  umuman qolmadi.
  const STU_SHKUR = (await H.id(`SELECT id FROM sections WHERE code='STU-SHKUR'`)).id;
  const STU_AST   = (await H.id(`SELECT id FROM sections WHERE code='STU-AST'`)).id;
  const STUL_ID   = (await H.id(`SELECT id FROM shops WHERE code='STUL'`)).id;
  const OWEN = (await H.id(`SELECT id FROM products WHERE sku='STU-OWEN'`)).id;

  const r = await admin('POST', '/api/units/', {
    items: [{ product_id: OWEN, qty: 1, section_id: STU_SHKUR }] });
  assert.equal(r.status, 200, r.text);
  const u = r.body.created[0];

  //  Keyingi qadam — O'Z tsexining astar bo'limi, ya'ni topshirish ham
  //  so'ralmaydi: konver hech kimning qo'liga o'tmayapti.
  const stul = H.api(base, await H.sessionFor('Stul ustasi'));
  await xomsiz();
  const mv = await stul('POST', '/api/units/move', { items: [{ unit_id: u.id }] });
  assert.equal(mv.status, 200, mv.text);
  assert.equal((await H.id(`SELECT current_section_id s FROM production_units WHERE id=$1`,
    [u.id])).s, STU_AST, 'astar bo\'limi ham stul tsexiniki');

  //  Lak tsexi ustasining ekranida stul YO'Q — endi hech qachon
  const lakBoard = await lak('GET', '/api/units/board');
  assert.equal(lakBoard.status, 200, lakBoard.text);
  const lakda = lakBoard.body.sections.flatMap((sc) => sc.units).map((x) => x.conveyor_no);
  assert.ok(!lakda.includes(u.conveyor_no), 'lak ustasiga stul ko\'rinmaydi');
  assert.ok(!lakBoard.body.inbox.some((x) => x.conveyor_no === u.conveyor_no),
    'qabul qilish ro\'yxatida ham yo\'q');

  //  Stul boshlig'ining ekranidagi ustunlarning HAMMASI o'z tsexiniki:
  //  begona tsexning bo'limi endi ro'yxatda turmaydi.
  const stulBoard = await stul('GET', '/api/units/board');
  assert.equal(stulBoard.body.shop.id, STUL_ID);
  const kolonka = stulBoard.body.sections.find((sc) => sc.id === STU_AST);
  assert.ok(kolonka, 'astar bo\'limi stul ekranida ustun bo\'lib turadi');
  assert.ok(kolonka.units.some((x) => x.conveyor_no === u.conveyor_no));
  const begona = (await H.id(
    `SELECT COUNT(*)::int AS n FROM sections WHERE id = ANY($1) AND shop_id <> $2`,
    [stulBoard.body.sections.map((sc) => sc.id), STUL_ID])).n;
  assert.equal(begona, 0, 'stul ekranida begona tsexning bo\'limi yo\'q');

  //  Lak ustasi uni qimirlata olmaydi
  await xomsiz();
  const urinish = await lak('POST', '/api/units/move', { items: [{ unit_id: u.id }] });
  assert.equal(urinish.status, 400, urinish.text);
  assert.match(urinish.body.error, /doirangizda emas/);

  //  Marshrutni oxirigacha o'zi olib boradi: STU-ASTSH → STU-LAK →
  //  STU-QOPL → STU-QAD.
  for (let i = 0; i < 4; i++) {
    await xomsiz();
    const step = await stul('POST', '/api/units/move', { items: [{ unit_id: u.id }] });
    assert.equal(step.status, 200, `${i + 1}-qadam: ${step.text}`);
  }
  const oxir = await H.id(
    `SELECT sc.code, u.lak_on IS NOT NULL AS lak_yozildi
       FROM production_units u JOIN sections sc ON sc.id = u.current_section_id
      WHERE u.id = $1`, [u.id]);
  assert.equal(oxir.code, 'STU-QAD', 'qadoqlashgacha bir o\'zi o\'tkazdi');
  //  ★ LAK SANASI BARIBIR YOZILADI. Belgi ilgari faqat TSEXda turardi
  //  (`shops.milestone`), stul esa endi lak tsexiga kirmaydi — sana
  //  jimgina yo'qolib qolardi. Shuning uchun belgi BO'LIMda ham bor
  //  (`sections.milestone`, STU-LAK) va o'qilishi bitta joyda:
  //  COALESCE(bo'limniki, tsexniki).
  assert.ok(oxir.lak_yozildi, 'lak bo\'limiga kirish sanasi yozildi');
});

test('jurnaldagi tsex filtri konverni egasiga qarab ajratadi', async () => {
  const STU_SHKUR = (await H.id(`SELECT id FROM sections WHERE code='STU-SHKUR'`)).id;
  const BOY_AST1  = (await H.id(`SELECT id FROM sections WHERE code='BOY-AST1'`)).id;
  const STUL_ID   = (await H.id(`SELECT id FROM shops WHERE code='STUL'`)).id;
  const BOYOQ_ID  = (await H.id(`SELECT id FROM shops WHERE code='BOYOQ'`)).id;
  const OWEN = (await H.id(`SELECT id FROM products WHERE sku='STU-OWEN'`)).id;

  //  Stul o'z tsexida, penal esa lak tsexida
  const s = (await admin('POST', '/api/units/',
    { items: [{ product_id: OWEN, qty: 1, section_id: STU_SHKUR }] })).body.created[0];
  const pen = (await admin('POST', '/api/units/',
    { items: [{ product_id: PENAL, qty: 1, section_id: BOY_AST1 }] })).body.created[0];

  const kodlar = async (shopId) =>
    (await admin('GET', '/api/units/?shop_id=' + shopId)).body.map((x) => x.conveyor_no);

  const lakda = await kodlar(BOYOQ_ID);
  assert.ok(lakda.includes(pen.conveyor_no), 'penal lak tsexi filtrida chiqadi');
  assert.ok(!lakda.includes(s.conveyor_no), 'stul lak tsexi filtrida chiqmaydi');

  const stulda = await kodlar(STUL_ID);
  assert.ok(stulda.includes(s.conveyor_no), 'stul o\'z tsexi filtrida chiqadi');
  assert.ok(!stulda.includes(pen.conveyor_no));

  //  ★ BEGONA TSEX QOLMADI: lak tsexining bo'limlari endi hech qaysi
  //  boshqa tsexning ro'yxatida turmaydi. Mexanizmning O'ZI joyida
  //  (`run_by`, `owner_shop_id`) — kerak bo'lganda qaytadi, lekin
  //  hozir zavodda bitta ham shunday marshrut yo'q.
  const ref = await admin('GET', '/api/ref');
  const ast = ref.body.sections.find((x) => x.id === BOY_AST1);
  assert.deepEqual(ast.run_by, [], 'lak bo\'limi faqat o\'z tsexiniki');
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
  assert.equal(bosh.next_section, 'Shkurka karkas',
    'tugmada marshrutning birinchi bo\'limi');

  // Bo'lim ustunlarida ham, qabul qilish ro'yxatida ham takrorlanmaydi
  assert.ok(!board.body.sections.some((sc) => sc.units.some((x) => x.id === u.id)));
  assert.ok(!board.body.inbox.some((x) => x.id === u.id));

  // Bitta bosishda birinchi bo'limga chiqadi
  await xomsiz();
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
  await xomsiz();
  const r1 = await korpus('POST', '/api/units/move',
    { items: [{ unit_id: u.id, qty: 3 }] });
  assert.equal(r1.status, 200, r1.text);
  assert.deepEqual(await holat(),
    [{ part: 1, qty: 7, bolim: 'KOR-ARRA' }, { part: 2, qty: 3, bolim: 'KOR-ROVER' }]);

  // Yana 2 tasi — Roverdagi bo'lakka QO'SHILADI, uchinchi qator ochilmaydi
  await xomsiz();
  assert.equal((await korpus('POST', '/api/units/move',
    { items: [{ unit_id: u.id, qty: 2 }] })).status, 200);
  assert.deepEqual(await holat(),
    [{ part: 1, qty: 5, bolim: 'KOR-ARRA' }, { part: 2, qty: 5, bolim: 'KOR-ROVER' }]);

  // Qolgan 5 tasi ham o'tdi — bitta 10 lik qator qoladi
  await xomsiz();
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

  await xomsiz();
  const r = await korpus('POST', '/api/units/move', { items: [{ unit_id: u.id, qty: 3 }] });
  const yangi = r.body.moved[0].unit_id;
  assert.notEqual(yangi, u.id, 'bo\'lak alohida qator bo\'ldi');
  assert.deepEqual(await holat(),
    [{ qty: 5, bolim: 'KOR-ARRA' }, { qty: 3, bolim: 'KOR-ROVER' }]);

  //  ★ ORQAGA QAYTARISH — FAQAT ADMINISTRATORDA (`production.undo`,
  //  zavod qarori 2026-10): harakat yozuvi ham, jamlanma hisobot ham
  //  o'chadi, ya'ni tarix qayta yoziladi. Tsex boshlig'ida bu yo'l
  //  yo'q — u konverni keyingi bo'limdan qaytarib o'tkazadi.
  assert.equal((await korpus('POST', '/api/units/undo', { unit_id: yangi })).status, 403,
    'tsex boshlig\'i orqaga sura olmaydi');

  // Qaytarish: 3 tasi Arraga qaytadi va 5 taga qo'shiladi
  assert.equal((await H.api(base, tokenAdmin)('POST', '/api/units/undo',
    { unit_id: yangi })).status, 200);
  assert.deepEqual(await holat(), [{ qty: 8, bolim: 'KOR-ARRA' }],
    'sakkiztasi yana bitta qator bo\'lib Arrada turibdi');
});

test('noto\'g\'ri son o\'tkazilmaydi', async () => {
  const u = await newUnit({ qty: 4 });
  for (const [qty, kutilgan] of [[0, /noldan katta/], [-2, /noldan katta/],
                                 [5, /o'tkazib bo'lmaydi/], [1.5, /butun/]]) {
    await xomsiz();
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
  await xomsiz();
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
  await xomsiz();
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
  //
  //  Ikki belgi bir-biridan MUSTAQIL: «Faqat o'zinikini» NIMANI
  //  ko'rishini aytadi, «Mijoz qo'shadi» esa yangi qator ocha
  //  oladimi (izoh: sql/units.sql) — zavod ikkalasini bitta odamga
  //  ham qo'yishi mumkin.
  await db.query(
    `UPDATE workers SET can_add_customer = true WHERE name = 'Oz menejer bir'`);
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
  await xomsiz();
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
  //  Sana ATAYLAB yoziladi: bo'sh qoldirilsa server CURRENT_DATE qo'yadi
  //  va pastdagi tarix so'rovi sentabr oralig'i bilan yuboriladi — ya'ni
  //  suite oktabrda yurganda harakat o'sha oraliqdan tushib qolardi va
  //  test KALENDAR almashgani uchun qizil bo'lardi.
  assert.equal((await mudir('POST', '/api/warehouse/fg/transfer',
    { unit_id: vitr.id, to_code: 'VITR-PALMA', moved_on: '2026-09-11' })).status, 200);
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

//  ★ SANOQ — javondagi dona hisobdagidan kam ham, ko'p ham chiqadi va
//  ikkalasini JAVONNI SANAGAN odam to'g'rilaydi (zavod qarori, 2026-10).
test('sanoq: ombor mudiri konverning sonini to\'g\'rilaydi — kam ham, ko\'p ham', async () => {
  const mudir = H.api(base, await H.sessionFor('Sinov ombor mudiri'));
  const RANG = 'Inventar sinov rangi';
  const u = (await admin('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 4, color: RANG, is_opening: true, fg_on: '2026-09-05' },
  ] })).body.created[0];
  const qoldiq = async () => (await mudir('GET',
    `/api/warehouse/fg/summary?w=TM&q=${encodeURIComponent(RANG)}`)).body;
  assert.equal((await qoldiq()).total.qty, 4);

  //  Sabab MAJBURIY: raqam jimgina o'zgarmasin
  const sabsiz = await mudir('POST', '/api/warehouse/fg/count',
    { unit_id: u.id, to_qty: 2 });
  assert.equal(sabsiz.status, 400);
  assert.match(sabsiz.body.error, /Sabab/);

  //  KAM chiqdi: 4 → 2
  assert.equal((await mudir('POST', '/api/warehouse/fg/count',
    { unit_id: u.id, to_qty: 2, note: 'sanoq' })).status, 200);
  assert.equal((await qoldiq()).total.qty, 2, 'qoldiq darrov kamaydi');

  //  KO'P chiqdi: 2 → 5, to'dalab yuborilgan ro'yxat bilan
  const kop = await mudir('POST', '/api/warehouse/fg/count',
    { items: [{ unit_id: u.id, to_qty: 5 }], note: 'sanoq — ortiqcha' });
  assert.equal(kop.status, 200, kop.text);
  assert.equal(kop.body.saved, 1);
  assert.equal((await qoldiq()).total.qty, 5, 'ortiqcha chiqqani hisobga olindi');

  //  Farqi yo'q qator — to'g'rilanadigan narsa qolmadi
  assert.equal((await mudir('POST', '/api/warehouse/fg/count',
    { unit_id: u.id, to_qty: 5, note: 'sanoq' })).status, 400);

  //  NOL bu yerda bekor qilish EMAS: javonda umuman yo'q konver sanoq
  //  xatosi emas, zarar — va uning hujjati tizimda hali yo'q.
  const nol = await mudir('POST', '/api/warehouse/fg/count',
    { unit_id: u.id, to_qty: 0, note: 'javonda yo\'q' });
  assert.equal(nol.status, 400);
  assert.match(nol.body.error, /noldan katta/);

  //  Savdo omborni O'QIYDI, lekin sanoq yozmaydi
  const savdo = H.api(base, await H.sessionFor('Sinov sotuvchi'));
  assert.equal((await savdo('POST', '/api/warehouse/fg/count',
    { unit_id: u.id, to_qty: 3, note: 'sanoq' })).status, 403);

  //  ★ SANOQ VARAG'I: `product_id` siz ham so'raladi — mudir javon
  //  oldiga bitta ro'yxat bilan boradi, har qatorda konver raqami va
  //  soni turadi.
  const varaq = (await mudir('GET',
    `/api/warehouse/fg/units?w=TM&q=${encodeURIComponent(RANG)}`)).body.rows;
  assert.equal(varaq.length, 1, 'varaq mahsulot tanlanmasa ham keladi');
  assert.equal(varaq[0].qty, 5);
  assert.equal(varaq[0].conveyor_no, u.conveyor_no);
  assert.ok(varaq[0].product, 'varaqda mahsulot nomi ham turadi');
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
  await xomsiz();
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

  //  ★ Stul so'rovini KIRITUVCHI yoza olmaydi: stol va stulni faqat
  //  savdo so'raydi (zavod qarori, 2026-09).
  const notSavdo = await kir('POST', '/api/units/requests',
    { product_id: STUL, qty: 1, color: 'Oq', fabric: 'Velvet-12' });
  assert.equal(notSavdo.status, 400, notSavdo.text);
  assert.match(notSavdo.body.error, /savdo/i);

  //  Stulga konver ochilsa STOL va KORPUS hisobi QIMIRLAMAYDI.
  assert.equal((await admin('POST', '/api/units/requests',
    { product_id: STUL, qty: 1, color: 'Oq', fabric: 'Velvet-12' })).status, 200);
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

test('narxdan past sotilmaydi \u2014 direktor tasdiqlaydi', async () => {
  //  ★ ZAVOD QARORI (2026-09). Zavodda ikki narx bor: ulgurji va
  //  chakana. Menejer qator yozganda narx o'zi to'ladi va uni
  //  OSHIRISH mumkin, TUSHIRISH esa yo'q — faqat direktor ruxsati
  //  bilan. Ismi kodga yozilmaydi: belgi XODIMDA.
  const { db } = require('../db');
  //  O'Z mijozi: bu test buyurtma yozadi va qarzdorlik lentasiga
  //  tegmasligi kerak — keyingi testlar o'sha raqamlarni sanaydi.
  await db.query(`INSERT INTO customers (name) VALUES ('Sinov narx mijozi')
                   ON CONFLICT (lower(name)) DO NOTHING`);
  const mijoz = (await H.id(
    `SELECT id FROM customers WHERE name = 'Sinov narx mijozi'`)).id;
  const yozilgan = [];

  await db.query(`UPDATE products SET price_opt = 100, price_retail = 130
                   WHERE id = $1`, [PENAL]);

  //  Ulgurji menejer (standart) va chakana menejer.
  const opt = await xodim('Sinov narx ulgurji', 'sotuvchi');
  //  ★ MIJOZGA CHIQARISHGA RUXSAT — alohida belgi (izoh:
  //  sql/sales.sql). Bu test CHEGIRMA qoidasi haqida, shuning uchun
  //  menejerga belgi qo'yiladi: aks holda `/send` chegirmagacha
  //  yetib bormay, boshqa sababdan rad etilardi.
  await db.query(
    `UPDATE workers SET can_release = true WHERE name = 'Sinov narx ulgurji'`);
  await xodim('Sinov narx chakana', 'sotuvchi');
  await db.query(
    `UPDATE worker_roles SET price_kind = 'retail'
      WHERE role_code = 'sotuvchi'
        AND worker_id = (SELECT id FROM workers WHERE name = 'Sinov narx chakana')`);
  const ret = H.api(base, await H.sessionFor('Sinov narx chakana'));

  //  Har menejer FAQAT o'z narxini ko'radi: ekranda bitta raqam.
  const pOpt = (await opt('GET', '/api/sales/products')).body.rows
    .find((p) => p.id === PENAL);
  const pRet = (await ret('GET', '/api/sales/products')).body.rows
    .find((p) => p.id === PENAL);
  assert.equal(Number(pOpt.price), 100);
  assert.equal(Number(pRet.price), 130);

  //  ★ SAHIFA RANG RO'YXATINI SHU BELGIGA QARAB OCHADI (zavod
  //  qarori, 2026-09). Savdo stol va stulni ishlab chiqarishga
  //  SO'RAY oladi va so'ralgan konver hali yasalmagan: u mijoz
  //  aytgan rangda bo'yaladi. Ilgari ro'yxat faqat MAVJUD
  //  konverning rangi bilan cheklanardi va mijoz to'rtinchi rangni
  //  so'rasa menejer uni yoza olmasdi.
  assert.equal(pOpt.can_request, false, 'penalga so\'rov yozilmaydi');
  const stulId = (await H.id(`SELECT id FROM products WHERE sku='STU-LAURA'`)).id;
  const pStul = (await opt('GET', '/api/sales/products')).body.rows
    .find((p) => p.id === stulId);
  assert.equal(pStul.can_request, true, 'stulga yoziladi');
  assert.equal(typeof pStul.needs_fabric, 'boolean');

  //  Chegaradan YUQORI narx jim o'tadi.
  const yaxshi = await opt('POST', '/api/sales/orders', { customer_id: mijoz,
    items: [{ product_id: PENAL, qty: 1, unit_price: 120 }] });
  assert.equal(yaxshi.status, 200, yaxshi.text);
  yozilgan.push(yaxshi.body.id);
  assert.equal((await opt('GET', '/api/sales/orders/' + yaxshi.body.id))
    .body.order.discount_status, null, 'tasdiq so\'ralmaydi');

  //  Chegaradan PAST narx — buyurtma tasdiq kutadi.
  const past = await opt('POST', '/api/sales/orders', { customer_id: mijoz,
    items: [{ product_id: PENAL, qty: 1, unit_price: 90 }] });
  assert.equal(past.status, 200, past.text);
  const z = past.body.id;
  yozilgan.push(z);
  assert.equal((await opt('GET', '/api/sales/orders/' + z))
    .body.order.discount_status, 'pending');

  //  ★ CHAKANA MENEJERGA CHEGARA BOSHQA: 120 unda ham past.
  const r2 = await ret('POST', '/api/sales/orders', { customer_id: mijoz,
    items: [{ product_id: PENAL, qty: 1, unit_price: 120 }] });
  yozilgan.push(r2.body.id);
  assert.equal((await ret('GET', '/api/sales/orders/' + r2.body.id))
    .body.order.discount_status, 'pending', 'chakana chegarasi 130');

  //  ★ TASDIQLANMAGAN CHEGIRMA OMBORGA O'TMAYDI — qaytib bo'lmaydigan
  //  nuqta: ombordan mahsulot chiqadi va mijozning qarzi yoziladi.
  const qator = (await opt('GET', '/api/sales/orders/' + z)).body.items[0];
  const u = (await admin('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 1, color: 'Oq', is_opening: true,
      fg_on: '2026-09-01' }] })).body.created[0];
  assert.equal((await opt('POST', `/api/sales/orders/${z}/assign`,
    { item_id: qator.id, unit_id: u.id, qty: 1 })).status, 200);
  assert.equal((await opt('PATCH', '/api/sales/orders/' + z,
    { ship_to: 'ZAVOD' })).status, 200);
  const yubor = await opt('POST', `/api/sales/orders/${z}/send`);
  assert.equal(yubor.status, 400, yubor.text);
  assert.match(yubor.body.error, /direktor/i);

  //  Menejerning O'ZIDA ruxsat yo'q.
  assert.equal((await opt('POST', `/api/sales/orders/${z}/discount`,
    { approve: true })).status, 403);

  //  Rad etishda sabab majburiy: menejer nega bo'lmaganini bilmasa,
  //  o'sha narxni ertaga yana yozardi.
  assert.equal((await admin('POST', `/api/sales/orders/${z}/discount`,
    { approve: false })).status, 400);

  //  Direktor tasdiqlaydi — shundan keyin omborga o'tadi.
  const ok = await admin('POST', `/api/sales/orders/${z}/discount`,
    { approve: true, note: 'Doimiy mijoz' });
  assert.equal(ok.status, 200, ok.text);
  assert.equal((await opt('POST', `/api/sales/orders/${z}/send`)).status, 200);

  //  ★ NARX O'ZGARSA TASDIQ QAYTA SO'RALADI: aks holda tasdiqlatib
  //  olib, keyin narxni yana tushirish yetardi.
  const z2 = (await opt('POST', '/api/sales/orders', { customer_id: mijoz,
    items: [{ product_id: PENAL, qty: 1, unit_price: 95 }] })).body.id;
  yozilgan.push(z2);
  assert.equal((await admin('POST', `/api/sales/orders/${z2}/discount`,
    { approve: true })).status, 200);
  const q2 = (await opt('GET', '/api/sales/orders/' + z2)).body.items[0];
  assert.equal((await opt('PATCH', '/api/sales/orders/' + z2,
    { items: [{ id: q2.id, product_id: PENAL, qty: 1, unit_price: 80 }] })).status, 200);
  assert.equal((await opt('GET', '/api/sales/orders/' + z2))
    .body.order.discount_status, 'pending', 'narx tushirilsa tasdiq qayta so\'raladi');

  //  ★ NARX RO'YXATI FAQAT DIREKTORDA: ko'rish ham, o'zgartirish ham.
  //  `production.manage` yetarli emas \u2014 u katalog huquqi va ishlab
  //  chiqarish boshlig'ida ham bor.
  const ich = await xodim('Sinov narx boshliq', 'ishlab_boshl');
  assert.equal((await ich('GET', '/api/catalog/prices')).status, 403);
  assert.equal((await admin('GET', '/api/catalog/prices')).status, 200);

  //  Katalog javobida ham narx YO'Q: ekranda yashirish himoya emas.
  const kat = (await ich('GET', '/api/catalog')).body.products[0];
  assert.ok(!('price_opt' in kat), 'narx javobdan olib tashlanadi');
  assert.ok('price_opt' in (await admin('GET', '/api/catalog')).body.products[0],
    'direktorga esa keladi');

  //  Narxga tegish ham rad etiladi \u2014 tekshiruv SERVERDA.
  const teg = await ich('PATCH', '/api/catalog/products/' + PENAL,
    { price_opt: 1 });
  assert.equal(teg.status, 403, teg.text);
  //  Katalogning QOLGAN maydonlari unga ochiq qolaveradi.
  assert.equal((await ich('PATCH', '/api/catalog/products/' + PENAL,
    { active: true })).status, 200);

  //  Narxi QO'YILMAGAN mahsulotda chegara yo'q: bo'lmagan raqamni
  //  majburlab bo'lmaydi va buyurtma to'xtab qolmasligi kerak.
  await db.query(`UPDATE products SET price_opt = NULL, price_retail = NULL
                   WHERE id = $1`, [PENAL]);
  const z3 = await opt('POST', '/api/sales/orders', { customer_id: mijoz,
    items: [{ product_id: PENAL, qty: 1, unit_price: 5 }] });
  yozilgan.push(z3.body.id);
  assert.equal((await opt('GET', '/api/sales/orders/' + z3.body.id))
    .body.order.discount_status, null, 'narxsiz mahsulotda chegara yo\'q');

  //  ★ TEST O'ZIDAN KEYIN TOZALAYDI: ombor navbati, qarzdorlik lentasi
  //  va jo'natish ro'yxati keyingi testlarda sanaladi — bu yerda
  //  qolgan buyurtma o'sha raqamlarni siljitib yuborardi.
  assert.equal((await opt('POST', `/api/sales/orders/${z}/unsend`)).status, 200);
  for (const id of yozilgan)
    await opt('PATCH', '/api/sales/orders/' + id, { status: 'cancelled' });
});

test("xom ashyo importi: ta'minotchi biriktiriladi, takror birlashadi", async () => {
  //  ★ BITTA MATERIALDA BIR NECHTA TA'MINOTCHI (zavod qarori,
  //  2026-09): zavod ro'yxatida bitta MDF to'rtta odamdan keladi.
  //
  //  ★ TAKROR QATOR — XATO EMAS: ro'yxat ilgari har ishlatiladigan
  //  bo'lim uchun alohida qatorda yuritilgan edi va o'sha ustun olib
  //  tashlangach bir xil qatorlar qolib ketdi. Ilgari bitta takror
  //  butun faylni saqlanmay qoldirardi.
  const t1 = (await H.id(`INSERT INTO suppliers (name) VALUES ('Sinov Mdf Bir')
                          RETURNING id`)).id;
  const t2 = (await H.id(`INSERT INTO suppliers (name) VALUES ('Sinov Mdf Ikki')
                          RETURNING id`)).id;

  const csv = [
    "Mahsulot nomi;Birligi;Ta'minotchi",
    //  Bir xil nom IKKI qatorda, ta'minotchisi har xil — birlashadi
    'Sinov faner 10mm;list;Sinov Mdf Bir',
    'Sinov faner 10mm;list;Sinov Mdf Ikki',
    //  Katakda ikkitasi: vergul ham, «/» ham ajratadi
    'Sinov faner 15mm;list;Sinov Mdf Bir / Sinov Mdf Ikki',
    //  Ro'yxatda YO'Q ta'minotchi — material baribir saqlanadi
    'Sinov yelim;kg;Sinov Yo\'q Odam',
  ];

  const pre = await (await post('/api/import/materials', csv)).json();
  assert.equal(pre.bad, 0, JSON.stringify(pre.rows));
  assert.equal(pre.total, 3, 'ikkita bir xil nom bitta materialga birlashadi');
  assert.equal(pre.merged, 1);
  assert.equal(pre.links, 4, 'ikkitasida 2 tadan, uchinchisida yo\'q');
  //  Topilmagani XATO emas, lekin JIM ham emas
  assert.deepEqual(pre.supplier_missing, [{ name: "Sinov Yo'q Odam", n: 1 }]);

  const saved = await (await post('/api/import/materials?save=1', csv)).json();
  assert.equal(saved.saved, 3);
  assert.equal(saved.links, 4);

  const list = (await admin('GET', '/api/materials?q=Sinov faner')).body.rows;
  const m10 = list.find((r) => r.name === 'Sinov faner 10mm');
  const m15 = list.find((r) => r.name === 'Sinov faner 15mm');
  assert.deepEqual(m10.suppliers.map((x) => x.name).sort(),
    ['Sinov Mdf Bir', 'Sinov Mdf Ikki'], 'ikki qatordagi ta\'minotchi qo\'shildi');
  assert.deepEqual(m15.suppliers.map((x) => x.name).sort(),
    ['Sinov Mdf Bir', 'Sinov Mdf Ikki'], '«/» ham ajratadi');
  const yelim = (await admin('GET', '/api/materials?q=Sinov yelim')).body.rows[0];
  assert.deepEqual(yelim.suppliers, [], 'topilmagan ta\'minotchi biriktirilmaydi');

  //  ★ QAYTA YUKLASH bog'lanishni IKKILANTIRMAYDI va o'chirmaydi.
  const qayta = await (await post('/api/import/materials?save=1', csv)).json();
  assert.equal(qayta.saved, 3);
  assert.equal((await H.id(
    `SELECT COUNT(*)::int AS id FROM material_suppliers ms
       JOIN materials m ON m.id = ms.material_id
      WHERE m.name LIKE 'Sinov faner%'`)).id, 4, 'takrorlanmaydi');

  //  ★ KARTOCHKADAN to'liq ro'yxat yuboriladi, ayirmani SERVER chiqaradi.
  assert.equal((await admin('PATCH', '/api/materials/' + m10.id,
    { suppliers: [t2] })).status, 200);
  const keyin = (await admin('GET', '/api/materials?q=Sinov faner 10mm')).body.rows[0];
  assert.deepEqual(keyin.suppliers.map((x) => x.id), [t2],
    'belgilanmagani olib tashlanadi');
  //  Bo'shatish ham mumkin: «tegma» emas, «yo'q» degani
  assert.equal((await admin('PATCH', '/api/materials/' + m10.id,
    { suppliers: [] })).status, 200);
  assert.deepEqual((await admin('GET', '/api/materials?q=Sinov faner 10mm'))
    .body.rows[0].suppliers, []);
  assert.ok(t1);
});

test('xom ashyo qoldig\'i: boshlang\'ich qoldiq va harakat', async () => {
  //  ★ Qoldiq HARAKATdan yig'iladi, alohida ustun yo'q: ustun bo'lsa
  //  u harakat bilan ajralib ketardi — bitta unutilgan UPDATE va
  //  ombor raqami haqiqatdan uzilib qolardi.
  const xom = await xodim('Sinov qoldiq xodim', 'xom_ombor');
  const wh = (await H.id(
    `SELECT id FROM warehouses WHERE code = 'TSEX-KOR-ARRA'`)).id;
  const m = (await xom('POST', '/api/materials',
    { name: 'Petlya Blum 110', uom: 'dona', category: 'FURN' })).body;

  const a = await xom('POST', '/api/materials/opening', {
    on: '2026-09-01',
    items: [{ warehouse_id: wh, material_id: m.id, qty: 250 }] });
  assert.equal(a.status, 200, a.text);
  assert.equal(a.body.saved, 1);

  const st = (await xom('GET', '/api/materials/stock')).body.rows
    .find((r) => r.material_id === m.id);
  assert.ok(st, 'qoldiqda turadi');
  assert.equal(Number(st.qty), 250);
  assert.equal(st.warehouse_id, wh);

  //  ★ BIR MARTALIK: ikkinchi marta yozilsa qoldiq jimgina ikki
  //  barobar bo'lib ketardi.
  const b = await xom('POST', '/api/materials/opening',
    { items: [{ warehouse_id: wh, material_id: m.id, qty: 10 }] });
  assert.equal(b.status, 400, b.text);
  assert.match(b.body.error, /allaqachon/);
  assert.equal(Number((await xom('GET', '/api/materials/stock')).body.rows
    .find((r) => r.material_id === m.id).qty), 250, 'qoldiq qimirlamadi');

  //  Tayyor mahsulot ombori xom ashyo ombori EMAS: konver u yerda
  //  sanaladi, material bu yerda — aralashtirib bo'lmaydi.
  const tm = (await H.id(`SELECT id FROM warehouses WHERE code = 'TM'`)).id;
  const yoq = await xom('POST', '/api/materials/opening',
    { items: [{ warehouse_id: tm, material_id: m.id, qty: 5 }] });
  assert.equal(yoq.status, 400, yoq.text);

  //  ★ NARX HARAKAT QATORIDA, materialda emas (izoh: sql/materials.sql).
  //  So'mda yozilgani hujjatning kursi bilan dollarga aylanadi va
  //  o'sha qator bilan qotib qoladi.
  const m2 = (await xom('POST', '/api/materials',
    { name: 'Sinov LDSP narx', uom: 'list', category: 'LDSP' })).body;
  const n1 = await xom('POST', '/api/materials/opening', {
    on: '2026-09-01', ccy: 'UZS', rate: 12500,
    items: [{ warehouse_id: wh, material_id: m2.id, qty: 100, price: 250000 }] });
  assert.equal(n1.status, 200, n1.text);
  const sn = (await xom('GET', '/api/materials/stock')).body.rows
    .find((r) => r.material_id === m2.id);
  //  250 000 / 12 500 = 20 $ · 100 list = 2 000 $
  assert.equal(Number(sn.price), 20);
  assert.equal(Number(sn.amount), 2000);

  //  Narxsiz qator QOLDIQDA turadi, lekin summaga qo'shilmaydi: nol
  //  deb hisoblansa omborning qiymati jimgina pasayib borardi.
  assert.equal(st.price, null, 'narxsiz qator narxsiz qoladi');
  assert.equal(st.amount, null);

  //  Kursi yo'q so'm QABUL QILINMAYDI: dollarga aylanmaydigan narx
  //  qatorni qiymatsiz qoldirardi va buni hech narsa aytmasdi.
  const m3 = (await xom('POST', '/api/materials',
    { name: 'Sinov kurssiz', uom: 'kg' })).body;
  const kz = await xom('POST', '/api/materials/opening', {
    ccy: 'UZS', items: [{ warehouse_id: wh, material_id: m3.id, qty: 5, price: 100 }] });
  assert.equal(kz.status, 400, kz.text);
  assert.match(kz.body.error, /[Kk]urs/);

  //  ★ XOM ASHYO OMBORI RO'YXATDA OCHIQ va MATERIAL sanaydi, konver
  //  emas: ikkalasini bitta raqamga qo'shib bo'lmaydi. Boshlang'ich
  //  qoldiq omborning ICHIDA kiritiladi, ya'ni yopiq kartochka ishni
  //  to'xtatardi.
  //  ★ KARTOCHKALAR TURI BO'YICHA GURUHLANADI (izoh:
  //  modules/warehouse.js): uchta savol — nima SOTILADI, zavodga nima
  //  KELADI va tsexda nima TURIBDI. Guruh SERVERDA hal qilinadi:
  //  sahifada ikkinchi marta yozilsa ertaga qo'shilgan ombor bir
  //  ekranda bir guruhda, boshqasida boshqasida turardi.
  const wl = (await admin('GET', '/api/warehouse/list')).body.rows;
  const gr = (kod) => wl.find((r) => r.code === kod).guruh;
  assert.equal(gr('TM'), 'fg');
  assert.equal(gr('VITR-ABU'), 'fg', 'vitrina ham tayyor mahsulot');
  assert.equal(gr('XOM'), 'zavod');
  assert.equal(gr('TSEX-KOR-ARRA'), 'tsex', 'tsexi bor ombor \u2014 tsexniki');

  const kart = (await xom('GET', '/api/warehouse/list')).body.rows
    .find((r) => r.code === 'TSEX-KOR-ARRA');
  assert.ok(kart, 'xom ashyo ombori mudirning ro\'yxatida turadi');
  assert.equal(kart.unit, 'nom');
  assert.equal(kart.href, '/materiallar.html?w=TSEX-KOR-ARRA');
  assert.equal(kart.units, 2, 'ikki nomdagi material');
  assert.equal(Number(kart.amount), 2000);
  //  T/M ombor esa unga ochilmaydi: `perm IS NULL` — «warehouse.view
  //  yetarli» degani va u ham HUQUQ. Bo'sh katak har kimga ochiq deb
  //  o'qilsa ekranda ochilmaydigan kartochka turardi.
  assert.ok(!(await xom('GET', '/api/warehouse/list')).body.rows
    .some((r) => r.code === 'TM'), 'T/M ombor xom ashyo xodimiga yo\'q');

  //  Harakat tarixida «qayerdan» ochiq aytiladi: boshlang'ich qoldiq.
  const mv = (await xom('GET', '/api/materials/moves')).body.rows
    .find((r) => r.material === 'Petlya Blum 110');
  assert.ok(mv, 'harakat yozildi');
  assert.equal(mv.from_kind, 'opening');
  assert.equal(mv.to_kind, 'warehouse');

  //  ★ «SHU BO'LIM QAYSI MATERIALNI ISHLATADI» — bo'lim ombori
  //  orqali (zavod qarori, 2026-09). Ro'yxat E'LON QILINMAYDI: ombor
  //  mudiri Arraga material berdi — o'sha zahoti Arraning
  //  ro'yxatida turadi.
  const arra = (await xom('GET', '/api/materials/ref')).body.warehouses
    .find((w) => w.id === wh);
  assert.equal(arra.section, 'Arra', 'ombor bo\'limga biriktirilgan');

  assert.ok((await xom('GET', '/api/materials?warehouse_id=' + wh))
    .body.rows.some((r) => r.id === m.id), 'Arra ro\'yxatida turadi');
  const zbor = (await H.id(
    `SELECT id FROM warehouses WHERE code = 'TSEX-STU-ZBOR'`)).id;
  assert.ok(!(await xom('GET', '/api/materials?warehouse_id=' + zbor))
    .body.rows.some((r) => r.id === m.id), 'boshqa bo\'limda yo\'q');

  //  ★ DOIRA CHEGARA: stul tsexining boshlig'iga korpus tsexining
  //  ombori ko'rinmaydi.
  const { db } = require('../db');
  const stulShop = (await H.id(`SELECT id FROM shops WHERE code = 'STUL'`)).id;
  await xodim('Sinov qoldiq stul', 'tsex_usta');
  await db.query(
    `UPDATE worker_roles SET scope_shop_id = $1
      WHERE role_code = 'tsex_usta'
        AND worker_id = (SELECT id FROM workers WHERE name = 'Sinov qoldiq stul')`,
    [stulShop]);
  const usta = H.api(base, await H.sessionFor('Sinov qoldiq stul'));
  assert.ok(!(await usta('GET', '/api/materials/stock')).body.rows
    .some((r) => r.warehouse_id === wh), 'boshqa tsexning ombori ko\'rinmaydi');
  assert.ok(!(await usta('GET', '/api/materials/ref')).body.warehouses
    .some((w) => w.id === wh), 'ro\'yxatda ham yo\'q');

  //  ★ OMBORNING JAVOBGAR TSEXI — MEXANIZM JOYIDA, LEKIN BO'SH
  //  (zavod qarori, 2026-09). «Lak karkas ombori» avval LAK tsexiga
  //  biriktirilgan edi; zavod qarorni QAYTARDI — uni STUL tsexining
  //  boshlig'i yuritadi, ya'ni ustun bo'sh va ombor turgan joyining
  //  tsexiniki bo'lib qoladi.
  //
  //  Ustun ham, `COALESCE` ham olib tashlanmadi: kerak bo'lganda
  //  bitta katakcha to'ldiriladi (4-qoida).
  const lakOmbor = await H.id(
    `SELECT w.id, s.code AS turgan, o.code AS yuritadi
       FROM warehouses w JOIN shops s ON s.id = w.shop_id
       LEFT JOIN shops o ON o.id = w.owner_shop_id
      WHERE w.code = 'TSEX-STU-LAK'`);
  assert.equal(lakOmbor.turgan, 'STUL', 'ombor stul tsexida turadi');
  assert.equal(lakOmbor.yuritadi, null, 'stul tsexi boshlig\'i yuritadi');

  //  Stul boshlig'i uni KO'RADI, lak boshlig'i esa YO'Q: ustun
  //  bo'shagach chegara ombor TURGAN joyining tsexidan chiqadi.
  const lakShop = (await H.id(`SELECT id FROM shops WHERE code = 'BOYOQ'`)).id;
  await xodim('Sinov lak usta', 'tsex_usta');
  await db.query(
    `UPDATE worker_roles SET scope_shop_id = $1
      WHERE role_code = 'tsex_usta'
        AND worker_id = (SELECT id FROM workers WHERE name = 'Sinov lak usta')`,
    [lakShop]);
  const lakUsta = H.api(base, await H.sessionFor('Sinov lak usta'));
  assert.ok(!(await lakUsta('GET', '/api/materials/ref')).body.warehouses
    .some((w) => w.id === lakOmbor.id), 'lak boshlig\'ida ko\'rinmaydi');
  assert.ok((await usta('GET', '/api/materials/ref')).body.warehouses
    .some((w) => w.id === lakOmbor.id), 'stul boshlig\'ida ko\'rinadi');

  //  ★ OMBOR DOIRASI — XODIM BELGISI (izoh: sql/materials.sql). Tsex
  //  doirasi ikki savolga birdan javob berardi: xodim qaysi
  //  KONVERNI yuritadi va qaysi OMBORNI ko'radi. Zavodda ular
  //  ajraldi — korpus boshlig'i ayni paytda ta'minotchi.
  const hammasi = async (a) => (await a('GET', '/api/materials/ref'))
    .body.warehouses.length;
  const oz = await hammasi(lakUsta);
  await db.query(
    `UPDATE workers SET mat_scope = 'all' WHERE name = 'Sinov lak usta'`);
  const barchasi = await hammasi(lakUsta);
  assert.ok(barchasi > oz, 'barcha ombor: doira o\'qilmaydi');

  //  «Faqat zavod omborlari» — xom ashyo mudiri uchun: boshlang'ich
  //  qoldiq kiritilgach tsex omborlari yopiladi.
  await db.query(
    `UPDATE workers SET mat_scope = 'factory' WHERE name = 'Sinov lak usta'`);
  const zavodOnly = (await lakUsta('GET', '/api/materials/ref')).body.warehouses;
  assert.ok(zavodOnly.length, 'zavod omborlari qoladi');
  assert.ok(zavodOnly.every((w) => !w.shop_id), 'tsex ombori qolmaydi');
  await db.query(
    `UPDATE workers SET mat_scope = NULL WHERE name = 'Sinov lak usta'`);

  //  ★ FURNITURA GURUHDA: sp, penal va kamodga yig'iladi, stol va
  //  stulga yo'q (zavod qarori) — belgi bazada, kodda emas.
  const furn = await H.id(
    `SELECT string_agg(code, ',' ORDER BY code) AS c FROM product_groups
      WHERE needs_hardware`);
  assert.equal(furn.c, 'KAMOD,PENAL,SP');

  //  ★ SARFLANIB BO'LINGANI HAM O'SHA BO'LIMNIKI: ro'yxat
  //  HARAKATDAN chiqadi, qoldiqdan emas. `v_material_stock` nol
  //  qoldiqni tashlab yuboradi (`HAVING SUM <> 0`) — ro'yxat undan
  //  olinsa bugun javonda turgani bilan cheklanib qolardi va
  //  ertaga yana so'raladigan material yo'qolardi.
  await db.query(
    `INSERT INTO material_moves (material_id, qty, from_kind, from_id,
                                 to_kind, to_id)
          VALUES ($1, 250, 'warehouse', $2, 'writeoff', NULL)`,
    [m.id, wh]);
  assert.ok(!(await xom('GET', '/api/materials/stock')).body.rows
    .some((r) => r.material_id === m.id && r.warehouse_id === wh),
    'qoldiq nolga tushdi');
  assert.ok((await xom('GET', '/api/materials?warehouse_id=' + wh))
    .body.rows.some((r) => r.id === m.id),
    'sarflanib bo\'lingani ham Arraning ro\'yxatida qoladi');
});

test('ta\'minotchilar ro\'yxati faylga chiqadi', async () => {
  //  ★ Ta'minotchi NOMI boshqa fayllarda KALIT bo'lib ishlatiladi: xom
  //  ashyo spravochnigida har materialning yonida u yoziladi va import
  //  nomi bo'yicha topadi. Bir harf farq qilsa butun fayl to'xtaydi,
  //  ya'ni odam bazadagi AYNAN qanday yozilganini ko'ra olishi kerak.
  const { db } = require('../db');
  await db.query(`INSERT INTO suppliers (name, category) VALUES ('Sinov MDF yetkazuvchi', 'MDF')
                   ON CONFLICT (lower(name)) DO NOTHING`);
  const r = await admin('GET', '/api/purchasing/suppliers/export');
  assert.equal(r.status, 200, r.text);
  //  Fayl BOM bilan yuboriladi (Excel usiz o'zbek harflarini buzib
  //  ochadi) — lekin `fetch().text()` BOM ni o'zi olib tashlaydi,
  //  shuning uchun u bu yerda tekshirilmaydi: jurnal eksporti bilan
  //  bir xil kod va u zavodda ishlab turibdi.
  assert.match(r.text, /^\uFEFF?Nomi;Telefon/);
  assert.match(r.text, /Sinov MDF yetkazuvchi/);
});

test('tsex ekranida oy boshidan beri chiqarilgani', async () => {
  //  ★ ZAVOD QARORI (2026-09): hisob TSEXDAN CHIQQANDA yoziladi,
  //  bo'limdan o'tganda emas — aks holda bitta konver o'n to'qqiz
  //  marta «ishlab chiqarilgan» bo'lib qo'shilardi.
  const ARRA = (await H.id(`SELECT id FROM sections WHERE code='KOR-ARRA'`)).id;
  const korpus = (await H.id(`SELECT id FROM shops WHERE code='KORPUS'`)).id;
  const oyi = async (shop) => (await admin('GET', '/api/units/board?shop_id=' + shop))
    .body.oy;
  const bor = async (shop, nom) => (await oyi(shop)).find((r) => r.product === nom);

  const oldin = await bor(korpus, 'Milano');
  const edi = oldin ? Number(oldin.qty) : 0;

  //  Soni ataylab boshqa testlarникidan farq qiladi: baza UMUMIY va
  //  «qty = 7 AND color = 'Oq'» bilan qator sanaydigan test bor —
  //  bu yerda yaratilgan konver o'sha hisobga qo'shilib ketardi.
  const u = (await admin('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 6, color: 'Oq chiqim', section_id: ARRA }] }))
    .body.created[0];

  //  Tsex ICHIDAGI harakat hisobga qo'shilmaydi: mahsulot hali
  //  tsexdan chiqmagan.
  await xomsiz();
  await admin('POST', '/api/units/move', { items: [{ unit_id: u.id }] });
  assert.equal((await bor(korpus, 'Milano'))?.qty ?? 0, edi,
    'bo\'limdan bo\'limga o\'tish sanalmaydi');

  //  Boshqa TSEXGA o'tkazilgani sanaladi — bir marta.
  for (let i = 0; i < 30; i++) {
    const d = (await admin('GET', '/api/units/board?shop_id=' + korpus)).body;
    const r = d.sections.flatMap((x) => x.units).find((x) => x.id === u.id);
    if (!r) break;
    if (r.next_shop_id && r.next_shop_id !== korpus) {
      await admin('POST', '/api/units/handover', { items: [u.id] });
      await xomsiz();
      await admin('POST', '/api/units/move', { items: [{ unit_id: u.id }] });
      break;
    }
    await xomsiz();
    await admin('POST', '/api/units/move', { items: [{ unit_id: u.id }] });
  }
  assert.equal(Number((await bor(korpus, 'Milano')).qty), edi + 6,
    'boshqa tsexga o\'tkazilgani bir marta qo\'shiladi');

  //  ★ T/M OMBORGA TOPSHIRILGANI HAM SANALADI. U `unit_moves` ga
  //  yozilmaydi (mudir qabul qilganda `fg_on` qo'yiladi, konver esa
  //  o'z bo'limida turaveradi) — faqat birinchi yo'l sanalsa
  //  qadoqlash tsexida raqam HAR DOIM nol bo'lib turardi.
  const qad = (await H.id(`SELECT id FROM shops WHERE code='QADOQ'`)).id;
  const qOld = (await bor(qad, 'Milano'))?.qty ?? 0;
  for (let i = 0; i < 40; i++) {
    const shops = (await admin('GET', '/api/units/board')).body.shops;
    let topildi = false;
    for (const sh of shops) {
      const d = (await admin('GET', '/api/units/board?shop_id=' + sh.id)).body;
      const r = d.sections.flatMap((x) => x.units).find((x) => x.id === u.id);
      if (!r) continue;
      topildi = true;
      if (r.next_shop_id && r.next_shop_id !== sh.id) {
        await admin('POST', '/api/units/handover', { items: [u.id] });
        await xomsiz();
        await admin('POST', '/api/units/move', { items: [{ unit_id: u.id }] });
      } else if (!r.next_section_id) {
        await admin('POST', '/api/units/handover', { items: [u.id] });
        await admin('POST', '/api/units/stock/accept', { items: [{ unit_id: u.id }] });
      } else {
        await xomsiz();
        await admin('POST', '/api/units/move', { items: [{ unit_id: u.id }] });
      }
      break;
    }
    if (!topildi) break;
  }
  assert.equal(Number((await bor(qad, 'Milano')).qty), Number(qOld) + 6,
    'T/M omborga topshirilgani qadoqlash tsexiga yoziladi');

  //  O'lchov birligi GURUHDAN: penal KOMPLEKT bilan sanaladi va uni
  //  stulning DONASI bilan qo'shib bo'lmaydi.
  assert.equal((await bor(qad, 'Milano')).uom, 'komplekt');
});

test('konverga xom ashyo biriktirish: tsex boshlig\'ining ekranidan', async () => {
  //  ★ ZAVOD QARORI (2026-09): sarfni TSEX BOSHLIG'I yozadi, konverni
  //  keyingi bo'limga o'tkazadigan ekranning O'ZIDA. Materialni
  //  konverga kim sarflaganini faqat tsexda turgan odam biladi.
  const { db } = require('../db');
  const ARRA = (await H.id(`SELECT id FROM sections WHERE code='KOR-ARRA'`)).id;
  const u = (await admin('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 8, color: 'Oq', section_id: ARRA }] })).body.created[0];

  const xom = await xodim('Sinov sarf ombori', 'xom_ombor');
  const wh  = (await H.id(
    `SELECT id FROM warehouses WHERE code='TSEX-KOR-ARRA'`)).id;
  const m = (await xom('POST', '/api/materials',
    { name: 'Sinov sarf LDSP', uom: 'list', category: 'LDSP' })).body;
  await xom('POST', '/api/materials/opening', {
    on: '2026-09-01', ccy: 'USD',
    items: [{ warehouse_id: wh, material_id: m.id, qty: 50, price: 20 }] });

  //  Huquqi `materials.request` — tsex boshlig'ida u allaqachon bor.
  const boss = await xodim('Sinov sarf boshlig\'i', 'tsex_usta');
  const korpus = (await H.id(`SELECT id FROM shops WHERE code='KORPUS'`)).id;
  await db.query(
    `UPDATE worker_roles SET scope_shop_id = $1
      WHERE role_code = 'tsex_usta'
        AND worker_id = (SELECT id FROM workers WHERE name = 'Sinov sarf boshlig''i')`,
    [korpus]);
  const usta = H.api(base, await H.sessionFor('Sinov sarf boshlig\'i'));

  //  ★ OMBOR RO'YXATI TARTIBLANADI: konver turgan BO'LIMNING ombori
  //  birinchi turadi va sahifa o'shani oladi. Qattiq tanlab
  //  qo'yilmaydi — har bo'limda ham ombor bo'lishi shart emas.
  const d = (await usta('GET', '/api/materials/unit/' + u.id)).body;
  assert.equal(d.warehouses[0].id, wh, 'bo\'lim ombori birinchi turadi');
  assert.equal(d.rows.length, 0);

  const ok = await usta('POST', '/api/materials/unit/' + u.id + '/consume',
    { items: [{ material_id: m.id, qty: 12 }] });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body.saved, 1);

  //  Qoldiq SHU BILAN kamayadi — ikkinchi jadval yozilmadi.
  assert.equal(Number((await xom('GET', '/api/materials/stock')).body.rows
    .find((r) => r.material_id === m.id && r.warehouse_id === wh).qty), 38);

  const keyin = (await usta('GET', '/api/materials/unit/' + u.id)).body;
  assert.equal(keyin.rows.length, 1);
  assert.equal(Number(keyin.rows[0].qty), 12);
  assert.equal(keyin.rows[0].status, 'ok');

  //  ★ QOLDIQDAN KO'P SARFLASH TO'XTATILMAYDI: material allaqachon
  //  kesilgan va yozuvni rad etish taxtani qaytarmaydi. Minusga
  //  tushgan qoldiq kirim hujjati yozilmaganining BELGISI bo'ladi.
  const kop = await usta('POST', '/api/materials/unit/' + u.id + '/consume',
    { items: [{ material_id: m.id, qty: 100 }] });
  assert.equal(kop.status, 200, kop.text);
  assert.equal(Number((await xom('GET', '/api/materials/stock')).body.rows
    .find((r) => r.material_id === m.id && r.warehouse_id === wh).qty), -62);

  //  O'CHIRILMAYDI, bekor qilinadi: qoldiqdan chiqadi, tarixda qoladi.
  const oxirgi = (await usta('GET', '/api/materials/unit/' + u.id)).body.rows[0];
  assert.equal((await usta('POST', '/api/materials/consume/' + oxirgi.id + '/cancel'))
    .status, 200);
  assert.equal(Number((await xom('GET', '/api/materials/stock')).body.rows
    .find((r) => r.material_id === m.id && r.warehouse_id === wh).qty), 38,
    'bekor qilingani qoldiqqa qaytdi');
  assert.equal((await usta('GET', '/api/materials/unit/' + u.id)).body.rows
    .find((r) => r.id === oxirgi.id).status, 'cancelled', 'tarixda qoladi');
  //  Ikkinchi marta bekor qilib bo'lmaydi — u allaqachon hech qaysi
  //  hisobda yo'q.
  assert.equal((await usta('POST', '/api/materials/consume/' + oxirgi.id + '/cancel'))
    .status, 404);

  //  ★ DOIRA CHEGARA: stul tsexining boshlig'i korpus konveriga
  //  material yoza olmaydi — ro'yxatni chetlab id yuborsa ham.
  const stul = (await H.id(`SELECT id FROM shops WHERE code='STUL'`)).id;
  await xodim('Sinov sarf stul', 'tsex_usta');
  await db.query(
    `UPDATE worker_roles SET scope_shop_id = $1
      WHERE role_code = 'tsex_usta'
        AND worker_id = (SELECT id FROM workers WHERE name = 'Sinov sarf stul')`,
    [stul]);
  const begona = H.api(base, await H.sessionFor('Sinov sarf stul'));
  assert.equal((await begona('GET', '/api/materials/unit/' + u.id)).status, 403);
  assert.equal((await begona('POST', '/api/materials/unit/' + u.id + '/consume',
    { items: [{ material_id: m.id, qty: 1 }] })).status, 403);
  //  Boshqa tsexning ombori ham tanlanmaydi: ro'yxat doira bilan
  //  chegaralangan va id qo'lda yuborilsa ham qabul qilinmaydi.
  assert.equal((await usta('POST', '/api/materials/unit/' + u.id + '/consume',
    { warehouse_id: (await H.id(
        `SELECT id FROM warehouses WHERE code='TSEX-STU-ZBOR'`)).id,
      items: [{ material_id: m.id, qty: 1 }] })).status, 400);
});

test('xom ashyo: spravochnik, tsex omborlari va fayldan yuklash', async () => {
  //  ★ HAR RANG ALOHIDA MATERIAL (zavod qarori): «LDSP 16mm oq» va
  //  «LDSP 16mm venge» — ikkita qator, har birining o'z qoldig'i.
  //  Rang ustun EMAS: ustun bo'lsa qoldiq material bo'yicha yig'ilib,
  //  «oq LDSP tugadi» degan savolga javob bo'lmasdi.

  //  Tsex omborlari TSEXGA bog'langan: mas'ul kodga yozilmaydi
  //  (4-qoida), u ombor tsexidan va xodimning doirasidan chiqadi.
  const tsexOmbor = (await H.id(
    `SELECT COUNT(*)::int AS n FROM warehouses w JOIN shops s ON s.id = w.shop_id
      WHERE w.kind = 'material' AND w.code LIKE 'TSEX-%'`)).n;
  assert.equal(tsexOmbor, 6, 'oltita tsex ombori');

  //  ★ QADOQLASH OMBORI — ZAVOD OMBORI (zavod qarori, 2026-09).
  //  Mol unga TA'MINOTCHIDAN keladi, ya'ni kirim yoziladigan joy
  //  bo'lishi kerak: kirim faqat zavod omboriga (`shop_id IS NULL`)
  //  yoziladi va tsex ombori bo'lib turgani ishni to'xtatardi.
  //  Yurituvchi esa o'sha-o'sha — qadoqlash boshlig'i.
  const qadOmbor = await H.id(
    `SELECT w.shop_id, s.code AS yurituvchi, sc.code AS bolim
       FROM warehouses w
       LEFT JOIN shops s     ON s.id  = w.owner_shop_id
       LEFT JOIN sections sc ON sc.id = w.section_id
      WHERE w.code = 'TSEX-QAD'`);
  assert.equal(qadOmbor.shop_id, null, 'tsexga biriktirilmagan');
  assert.equal(qadOmbor.yurituvchi, 'QADOQ', 'qadoqlash boshlig\'i yuritadi');
  assert.equal(qadOmbor.bolim, 'QAD-QAD', 'konverga sarf shu bo\'limdan');

  //  Tayyor mahsulot sahifalariga tsex omborlari CHIQMAYDI: qoida
  //  ombor qatorida (`warehouses.perm`), kodda emas — `materials.view`
  //  bo'lmagan xodim ularni umuman ko'rmaydi.
  assert.equal((await H.id(
    `SELECT COUNT(*)::int AS n FROM warehouses
      WHERE code LIKE 'TSEX-%' AND perm = 'materials.view'`)).n, 7);
  const savdoOmbor = (await (await xodim('Sinov xom savdo', 'sotuvchi'))
    ('GET', '/api/warehouse/list')).body.rows;
  assert.ok(!savdoOmbor.some((w) => String(w.code).startsWith('TSEX-')),
    'tsex ombori tayyor mahsulot ro\'yxatida turmaydi');

  //  Spravochnikni xom ashyo ombori xodimi yuritadi.
  const xom = await xodim('Sinov xom ombor', 'xom_ombor');
  const ref = await xom('GET', '/api/materials/ref');
  assert.equal(ref.status, 200, ref.text);
  assert.ok(ref.body.uoms.length && ref.body.categories.length);
  assert.equal(ref.body.warehouses.filter(
    (w) => String(w.code).startsWith('TSEX-')).length, 7);

  const m = await xom('POST', '/api/materials',
    { name: 'LDSP 16mm oq', uom: 'list', category: 'LDSP' });
  assert.equal(m.status, 200, m.text);

  //  Bir xil nom IKKINCHI marta kirmaydi: qoldiq ikkiga bo'linardi.
  const takror = await xom('POST', '/api/materials',
    { name: 'ldsp 16mm OQ', uom: 'list' });
  assert.equal(takror.status, 400, takror.text);

  //  Rang boshqa bo'lsa — BOSHQA material, u kiraveradi.
  assert.equal((await xom('POST', '/api/materials',
    { name: 'LDSP 16mm venge', uom: 'list', category: 'LDSP' })).status, 200);

  //  Fayldan yuklash: avval TEKSHIRIB ko'rsatiladi, keyin saqlanadi.
  //  Ustunlar SARLAVHADAN topiladi, tartibi muhim emas.
  const fayl = ["Turkumi;Nomi;O'lchov birligi",
                'Mato;Mato Velvet qora;metr',
                'Furnitura;Petlya Blum;dona'];
  const kor = await (await post('/api/import/materials', fayl)).json();
  assert.equal(kor.total, 2);
  assert.equal(kor.bad, 0, JSON.stringify(kor.rows));

  const saq = await (await post('/api/import/materials?save=1', fayl)).json();
  assert.equal(saq.saved, 2);

  //  Notanish o'lchov birligi butun faylni to'xtatadi: yarim kirgan
  //  ro'yxat eng yomoni — qaysi biri o'tgani bilinmay qoladi.
  assert.equal((await post('/api/import/materials?save=1',
    ['Nomi;Birlik', 'Smala;bochka'])).status, 400);
  assert.ok(!(await xom('GET', '/api/materials?q=Smala')).body.rows.length,
    'xato fayldan hech narsa saqlanmaydi');

  //  Tsex boshlig'i ro'yxatni KO'RADI (nimani so'rasa bo'ladi), lekin
  //  spravochnikni yuritmaydi.
  const usta = await xodim('Sinov xom usta', 'tsex_usta');
  assert.equal((await usta('GET', '/api/materials')).status, 200);
  assert.equal((await usta('POST', '/api/materials',
    { name: 'Ruxsatsiz material', uom: 'dona' })).status, 403);

  //  Material O'CHIRILMAYDI — faolsizlantiriladi: u eski hujjatlarda
  //  turgan bo'lishi mumkin (harajat moddasi bilan bir xil qoida).
  assert.equal((await xom('PATCH', '/api/materials/' + m.body.id,
    { active: false })).status, 200);
  const royxat = (await xom('GET', '/api/materials')).body.rows;
  assert.ok(!royxat.some((r) => r.id === m.body.id), 'faolsizi ro\'yxatda yo\'q');
  assert.ok((await xom('GET', '/api/materials?all=1')).body.rows
    .some((r) => r.id === m.body.id), 'faolsizi ham so\'ralsa keladi');
});

test('stol va stulni FAQAT savdo so\'raydi, rangi bilan', async () => {
  //  ★ ZAVOD QARORI (2026-09). Stol va stul mijozning so'rovi bilan
  //  ishlanadi: nechta va qaysi rangda kerakligini savdo biladi, tsex
  //  esa bilmaydi. Korpus (sp, penal, kamod) eskicha qoladi — uning
  //  rejasi oldindan tuziladi.
  const savdo = await xodim('Sinov sorov savdo', 'sotuvchi');
  const kir   = await xodim('Sinov sorov kir', 'kirituvchi');
  const grp = async (code) => (await H.id(
    `SELECT p.id FROM products p JOIN product_groups g ON g.id = p.group_id
      WHERE g.code = $1 AND p.active ORDER BY p.id LIMIT 1`, [code])).id;
  const STUL = await grp('STU'), STOL = await grp('STL');

  //  Kirituvchi stulga so'rov yoza olmaydi — chegara SERVERDA.
  const k = await kir('POST', '/api/units/requests',
    { product_id: STUL, qty: 2, color: 'Oq', fabric: 'Velvet-12' });
  assert.equal(k.status, 400, k.text);
  assert.match(k.body.error, /savdo/i);

  //  Savdo esa korpusga yoza olmaydi: u ishlab chiqarishniki.
  const p = await savdo('POST', '/api/units/requests',
    { product_id: PENAL, qty: 2, color: 'Oq' });
  assert.equal(p.status, 400, p.text);
  assert.match(p.body.error, /ishlab chiqarish/i);

  //  ★ RANG VA MATO MAJBURIY: rangsiz konver tsexda javobsiz savol
  //  bo'lib turardi.
  const rangsiz = await savdo('POST', '/api/units/requests',
    { product_id: STUL, qty: 2 });
  assert.equal(rangsiz.status, 400, rangsiz.text);
  assert.match(rangsiz.body.error, /rang va mato/);

  //  Stulda mato ham so'raladi, stolda esa YO'Q — zavodda stol
  //  matosiz yuradi (`product_groups.needs_fabric`).
  const matosiz = await savdo('POST', '/api/units/requests',
    { product_id: STUL, qty: 2, color: 'Oq' });
  assert.equal(matosiz.status, 400, matosiz.text);
  assert.match(matosiz.body.error, /mato tanlanmagan/);

  const stol = await savdo('POST', '/api/units/requests',
    { product_id: STOL, qty: 1, color: 'Oq' });
  assert.equal(stol.status, 200, stol.text);

  //  ★ ZAHIRA majburiylikni yechadi: buyurtmasiz ishlanayotgan
  //  mahsulotning rangi mijoz aytganda ma'lum bo'ladi.
  const zahira = await savdo('POST', '/api/units/requests',
    { product_id: STUL, qty: 3, is_stock: true });
  assert.equal(zahira.status, 200, zahira.text);

  const tola = await savdo('POST', '/api/units/requests',
    { product_id: STUL, qty: 2, color: 'Oq', fabric: 'Velvet-12' });
  assert.equal(tola.status, 200, tola.text);

  //  Korpusda rang so'ralmaydi — qoida faqat savdo so'raydigan
  //  guruhga tegadi va u BAZADA (`sales_can_request`).
  const korp = await kir('POST', '/api/units/requests',
    { product_id: PENAL, qty: 1, next_on: '2026-10-10' });
  assert.equal(korp.status, 200, korp.text);

  //  Tasdiqlagandan keyin konver ODATDAGI yo'ldan ochiladi.
  const ok = await admin('POST',
    `/api/units/requests/${tola.body.created[0]}/approve`);
  assert.equal(ok.status, 200, ok.text);
  assert.match(ok.body.conveyor_no, /^S\d\d-\d{3,}$/, ok.body.conveyor_no);
});

test('savdo stulga so\'rov yozadi, penalga emas', async () => {
  const mijoz = (await H.id(`SELECT id FROM customers WHERE name='Kanalsiz mijoz'`)).id;
  const STUL = (await H.id(
    `SELECT p.id FROM products p JOIN product_groups g ON g.id = p.group_id
      WHERE g.code = 'STU' AND p.active ORDER BY p.id LIMIT 1`)).id;

  const z = (await admin('POST', '/api/sales/orders', { customer_id: mijoz, items: [
    { product_id: STUL,  qty: 5, color: 'Oq', fabric: 'Velvet-12' },
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
  await xomsiz();
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
  assert.equal(qator_.places[1].boshlanmagan, false, 'Arrada — boshlangan');

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

  //  ★ MIJOZ SO'RAGAN DONAGA KONVER BIRIKTIRILGAN BO'LISHI SHART.
  //  Yuqoridagi tekshiruv boshqa savolga javob beradi — BIRIKTIRILGANI
  //  omborga keldimi. Qatorga konver umuman biriktirilmagan bo'lsa u
  //  savolga tushmasdi ham: buyurtma 15 ta bo'lib, 13 tasiga konver
  //  biriktirilgan holda chiqib ketaverardi va yuk xatida 15 ta
  //  yozilgan bo'lardi — mijoz imzolagan hujjat balansdan farq qilardi.
  const oz = (await admin('PATCH', '/api/sales/orders/' + z.id,
    { items: [{ id: qator.id, product_id: PENAL, qty: 8, color: 'Sut',
                unit_price: 250 }] }));
  assert.equal(oz.status, 400, 'yuborilgan buyurtma tahrirlanmaydi');
  //  Qatorni oshirish uchun avval qaytarib olinadi
  assert.equal((await admin('POST', `/api/sales/orders/${z.id}/unsend`)).status, 200);
  assert.equal((await admin('PATCH', '/api/sales/orders/' + z.id,
    { items: [{ id: qator.id, product_id: PENAL, qty: 8, color: 'Sut',
                unit_price: 250 }] })).status, 200);
  assert.equal((await admin('POST', `/api/sales/orders/${z.id}/send`)).status, 200);

  const kam = await mudir('POST', `/api/sales/orders/${z.id}/ship`,
    { ship_on: '2026-10-04' });
  assert.equal(kam.status, 400, kam.text);
  assert.match(kam.body.error, /Konver biriktirilmagan/);
  assert.match(kam.body.error, /2 ta/, 'yetishmayotgani soni bilan yoziladi');

  //  Qatorni qaytarib 6 ta qilamiz — endi to'liq
  assert.equal((await admin('POST', `/api/sales/orders/${z.id}/unsend`)).status, 200);
  assert.equal((await admin('PATCH', '/api/sales/orders/' + z.id,
    { items: [{ id: qator.id, product_id: PENAL, qty: 6, color: 'Sut',
                unit_price: 250 }] })).status, 200);
  assert.equal((await admin('POST', `/api/sales/orders/${z.id}/send`)).status, 200);

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

//  ── KUNLIK JO'NATMA REJASI ────────────────────────────────
//
//  Mudir ertalab ro'yxatdan bugun ketadiganini O'ZI oladi, kun davomida
//  esa «nechtasi chiqdi, nechtasi qoldi» ko'rinib turadi. Hisob BITTA
//  joyda (`GET /api/sales/day`) — ombor sahifasi ham, bosh sahifa ham
//  shundan oladi, ya'ni test raqamni RO'YXATNING uzunligi bilan
//  solishtiradi (menyudagi navbat belgisi bilan bir xil qoida).
test('mudir buyurtmani bugunga oladi va kun hisobi ro\'yxat bilan bir xil', async () => {
  const mudir = H.api(base, await H.sessionFor('Sinov ombor mudiri'));
  const mijoz = (await H.id(`SELECT id FROM customers WHERE name='Kanalsiz mijoz'`)).id;
  const bugun = new Date().toISOString().slice(0, 10);

  const u = (await admin('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 3, color: 'Sut', unit_price: 100,
      is_opening: true, fg_on: '2026-09-02' },
  ] })).body.created[0];
  const z = (await admin('POST', '/api/sales/orders', {
    customer_id: mijoz, ship_to: 'ZAVOD',
    items: [{ product_id: PENAL, qty: 3, color: 'Sut', unit_price: 100 }] })).body;
  const qator = (await admin('GET', '/api/sales/orders/' + z.id)).body.items[0];
  await admin('POST', `/api/sales/orders/${z.id}/assign`,
    { item_id: qator.id, unit_id: u.id, qty: 3 });

  //  Omborga yuborilmagan buyurtma rejaga OLINMAYDI: chiqarilmaydigan
  //  narsani «bugun ketadi» deb belgilash kunning hisobini yolg'on
  //  qilardi.
  assert.equal((await mudir('POST', `/api/sales/orders/${z.id}/plan-day`,
    { on: bugun })).status, 400);

  await admin('POST', `/api/sales/orders/${z.id}/send`, {});
  const oldin = (await mudir('GET', '/api/sales/day')).body;

  assert.equal((await mudir('POST', `/api/sales/orders/${z.id}/plan-day`,
    { on: bugun })).status, 200);
  const k = (await mudir('GET', '/api/sales/day')).body;
  assert.equal(k.olindi, oldin.olindi + 1);
  assert.equal(k.olindi, k.rows.length, 'raqam ro\'yxat bilan bir xil');
  assert.equal(k.chiqdi + k.qoldi, k.olindi, 'olindi = chiqdi + qoldi');
  assert.ok(k.rows.some((r) => r.order_no === z.order_no && r.status === 'to_ship'));

  //  Mudirning ro'yxatida bugunga olingani TEPADA turadi va kim
  //  olgani yoziladi.
  const ro = (await mudir('GET', '/api/sales/shipping')).body.rows;
  assert.equal(ro[0].order_no, z.order_no, 'olingani tepada');
  assert.equal(String(ro[0].plan_on).slice(0, 10), bugun);
  assert.ok(ro[0].plan_by_name, 'kim olgani yoziladi');

  //  Chiqarib yuborilgach o'sha kunning «chiqdi» siga o'tadi — olingan
  //  soni esa o'zgarmaydi: kun shuncha reja bilan boshlangan.
  assert.equal((await mudir('POST', `/api/sales/orders/${z.id}/ship`,
    { ship_on: bugun })).status, 200);
  const k2 = (await mudir('GET', '/api/sales/day')).body;
  assert.equal(k2.olindi, k.olindi);
  assert.equal(k2.chiqdi, k.chiqdi + 1);
  assert.equal(k2.qoldi, k.qoldi - 1);
  assert.equal(k2.olindi, k2.rows.length);

  //  Savdo qaytarib olsa rejadan ham chiqadi: chiqarilmaydigan buyurtma
  //  mudirning bugungi hisobida turishi yolg'on bo'lardi.
  const u2 = (await admin('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 1, color: 'Sut', unit_price: 100,
      is_opening: true, fg_on: '2026-09-02' },
  ] })).body.created[0];
  const z2 = (await admin('POST', '/api/sales/orders', {
    customer_id: mijoz, ship_to: 'ZAVOD',
    items: [{ product_id: PENAL, qty: 1, color: 'Sut', unit_price: 100 }] })).body;
  const qator2 = (await admin('GET', '/api/sales/orders/' + z2.id)).body.items[0];
  await admin('POST', `/api/sales/orders/${z2.id}/assign`,
    { item_id: qator2.id, unit_id: u2.id, qty: 1 });
  assert.equal((await admin('POST', `/api/sales/orders/${z2.id}/send`, {})).status, 200);
  await mudir('POST', `/api/sales/orders/${z2.id}/plan-day`, { on: bugun });
  assert.equal((await mudir('GET', '/api/sales/day')).body.olindi, k2.olindi + 1);
  assert.equal((await admin('POST', `/api/sales/orders/${z2.id}/unsend`, {})).status, 200);
  assert.equal((await mudir('GET', '/api/sales/day')).body.olindi, k2.olindi);
  assert.equal((await H.id(
    `SELECT plan_on FROM orders WHERE id = $1`, [z2.id])).plan_on, null);
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
  //  ★ ORALIQNING JAMI RAQAMI QOTIB QO'YILMAYDI, va bu ataylab. Kunlik
  //  reja testi mahsulotni AYNAN bugungi kun bilan chiqaradi — u boshqa
  //  sana bilan ishlay olmaydi ham — ya'ni suite oktabrda yurganda o'sha
  //  summa ham shu oraliqqa tushadi. Qotib qolgan 1500 sinovni
  //  KALENDARGA bog'lab qo'yardi: kod o'zgarmasa ham, kun almashgani
  //  uchun qizil bo'lardi.
  //
  //  Shuning uchun aylanma TAFSILOT bilan solishtiriladi — ikki hisob
  //  bitta narsani aytishi kerak, aks holda qaysi biri to'g'ri degan
  //  savol chiqadi.
  const okt_t = (await admin('GET',
    `/api/sales/debts/${mijoz}?from=2026-10-01&to=2026-10-31`)).body;
  assert.equal(Number(r.debit), Number(okt_t.total.debit),
    'jadval va tafsilot bitta raqamni aytadi');

  //  ★ Tekshirilayotgan narsa esa ANIQ: sotilgan narx chiqarishda
  //  konverga KO'CHADI (modules/sales.js). Konverning o'zida narx yo'q
  //  edi (tsexdan kelgan ikkitasi), lekin mijoz yuk xatidagi summani
  //  to'laydi — 6 × 250 = 1500. Shuning uchun raqam o'sha ikki KUN
  //  bo'yicha sanaladi: sanalari testlarda qo'lda yozilgan, ya'ni
  //  kalendar almashsa ham joyida qoladi.
  const KUN = ['2026-10-04', '2026-10-06'];
  const kochgan = okt_t.rows
    .filter((x) => KUN.includes(String(x.on_date).slice(0, 10)))
    .reduce((a, x) => a + Number(x.debit), 0);
  assert.equal(kochgan, 1500, String(kochgan));
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

  //  ★ BOSHLANG'ICH QARZ HAR DOIM «DAVR BOSHIGA» DA (zavod qarori,
  //  2026-10). Oraliq uning sanasidan ham oldin boshlansa ham u
  //  AYLANMAGA tushmaydi: «oy ichida qancha mahsulot chiqdi» degan
  //  savolga javob shundan chiqadi. Shart SANA bo'yicha emas, kind
  //  ustuni bo'yicha — ya'ni javob oraliqqa bog'liq emas.
  const butun = (await admin('GET',
    '/api/sales/debts?from=1900-01-01&to=2030-01-01')).body.rows
    .find((x) => x.id === mijoz);
  assert.equal(Number(butun.opening), 500, 'boshlang\'ich qarz davr boshida');
  assert.equal(
    Number(butun.opening) + Number(butun.debit) - Number(butun.credit),
    Number(r2.closing), 'boshiga + qarzdor \u2212 haqdor = oxiriga');

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
  //  Ishorali maydon TOMONGA ajraladi — manfiy boshlang'ich qarz
  //  qarzdor ustunidagi minus emas, HAQDOR yozuvi bo'ladi. U «davr
  //  boshiga» da turadi va aylanmaga qo'shilmaydi (zavod qarori,
  //  2026-10): sanasi oraliq ichiga tushgani bu javobni o'zgartirmaydi.
  assert.equal(Number(t2.opening_credit), 200,
    'ortiqcha to\'lov davr boshining haqdor tomonida');
  assert.equal(Number(t2.opening_debit), 0, 'qarzdor tomonda minus turmaydi');
  assert.equal(Number(t2.credit), 0, 'aylanmaga qo\'shilmaydi');
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

//  ★ KURSDA TIYIN BOR, SUMMADA YO'Q (zavod qarori, 2026-09). Bank
//  ko'chirmasida ikki raqam turadi: 9 000 000 so'm va 762 $. Butun
//  kurs (11 811) bilan javob 762,26 bo'lib chiqadi va mijozning
//  qarzidan yigirma olti tiyin ortiq ayriladi — hujjat balansdan farq
//  qiladi. Kurs BO'LUVCHI, ya'ni uning tiyinlari javobning tiyinlarini
//  hal qiladi; ustun boshidanoq to'rt xonali va ekrandagi katak ham
//  endi shuni oladi (kursHisobla, public/kassa-form.js).
test("kurs to'rt xonali — dollardagi raqam butun chiqadi", async () => {
  const kassir = H.api(base, await H.sessionFor('Sinov kassir'));
  const mijoz = (await H.id(`SELECT id FROM customers ORDER BY id LIMIT 1`)).id;
  const acc = (await H.id(`SELECT id FROM cash_accounts WHERE code='MAIN'`)).id;
  const yon = { from_kind: 'customer', from_id: mijoz,
                to_kind: 'account', to_id: acc, currency: 'UZS' };
  const saldo = () => H.id(
    `SELECT balance AS id FROM v_customer_sales WHERE id=$1`, [mijoz]);
  const oldin = Number((await saldo()).id);

  //  Butun kurs: 9 000 000 / 11 807 = 762,26 — ortiqcha yigirma olti tiyin.
  const yalpi = await kassir('POST', '/api/cash/ops',
    { ...yon, amount: 9000000, rate: 11807 });
  assert.equal(yalpi.status, 200, yalpi.text);
  assert.equal(Number(yalpi.body.amount_usd), 762.26);

  //  Dollardan chiqarilgan kurs: 9 000 000 / 762 = 11 811,0236.
  const kurs = Number((9000000 / 762).toFixed(4));
  assert.equal(kurs, 11811.0236);
  const aniq = await kassir('POST', '/api/cash/ops',
    { ...yon, amount: 9000000, rate: kurs });
  assert.equal(aniq.status, 200, aniq.text);
  assert.equal(Number(aniq.body.amount_usd), 762, 'bank yozgan raqamning ozi');

  //  Kurs QOTIB qoladi — tiyinlari bilan: ertaga kurs o'zgarsa kechagi
  //  to'lov qayta hisoblanmaydi (izoh: sql/cash.sql).
  assert.equal(Number((await H.id(
    `SELECT rate AS id FROM cash_ops WHERE id = $1`, [aniq.body.id])).id), 11811.0236);

  //  Sinov o'zidan keyin iz qoldirmaydi: ikkala to'lov ham bekor
  //  qilinadi va mijozning saldosi joyiga qaytadi.
  for (const r of [yalpi, aniq])
    assert.equal((await kassir('PATCH', '/api/cash/ops/' + r.body.id)).status, 200);
  assert.equal(Number((await saldo()).id), oldin, 'saldo joyiga qaytdi');
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

//  ★ YO'NALISH SERVERDAN KELADI. Lenta bitta JOY haqida va o'sha joy
//  kim ekanini server aytadi (`side`) — sahifa esa har qatorda
//  «kirimmi yoki chiqimmi» degan savolga SHU tomondan javob beradi.
//  Ilgari sahifa yo'nalishni turiga qarab taxmin qilardi va xodimning
//  qo'lidagi pul sahifasida (`?a=w12`) kassadan olingan avans CHIQIM
//  bo'lib ko'rinardi: minus bilan, «Kim» ustunida esa o'sha xodimning
//  O'Z ismi turardi.
test('xodimning qo\'lidagi pul sahifasida kassadan olingani KIRIM', async () => {
  const kassir = H.api(base, await H.sessionFor('Sinov kassir'));
  const xodim = (await H.id(`SELECT id FROM workers WHERE name='Korpus ustasi'`)).id;
  const kassa = (await H.id(`SELECT id FROM cash_accounts WHERE code='MAIN'`)).id;

  const ok = await kassir('POST', '/api/cash/ops', {
    from_kind: 'account', from_id: kassa, to_kind: 'worker', to_id: xodim,
    currency: 'USD', amount: 50 });
  assert.equal(ok.status, 200, ok.text);

  //  Xodimning qo'li — TOMON: qabul qiluvchi shu joy, ya'ni kirim
  const w = await kassir('GET', `/api/cash/ops?a=w${xodim}&dir=in`);
  assert.equal(w.status, 200, w.text);
  assert.deepEqual(w.body.side, { kind: 'worker', id: xodim },
    'yo\'nalish shu tomondan o\'lchanadi');
  const qator = w.body.rows.find(r => r.id === ok.body.id);
  assert.ok(qator, 'kassadan olingan pul xodimda KIRIM bo\'lib turadi');
  assert.equal(qator.to_id, xodim, 'qabul qiluvchi tomon — o\'sha xodim');

  //  Kassada esa AYNAN o'sha operatsiya chiqim: bitta harakat ikki
  //  joyda ikki xil ko'rinadi va ikkalasi ham to'g'ri.
  const k = await kassir('GET', '/api/cash/ops?a=MAIN&dir=out');
  assert.deepEqual(k.body.side, { kind: 'account', id: kassa });
  assert.ok(k.body.rows.some(r => r.id === ok.body.id), 'kassada chiqim');
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
    await xomsiz();
    let mv = await admin('POST', '/api/units/move', { items: [it] });
    if (mv.status !== 200) {
      assert.equal((await admin('POST', '/api/units/handover',
        { items: [u.id] })).status, 200);
      await xomsiz();
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

  //  ★ QABUL QILADIGAN TOMON RAD HAM ETADI (zavod qarori, 2026-09).
  //  Mashina keldi, lekin javonda hujjatda yozilgani yo'q. Ilgari
  //  qabul qiluvchida BITTA tugma bor edi va doira ham faqat MANBA
  //  omborni qarardi: vitrinaga biriktirilgan sotuvchi o'ziga
  //  kelayotgan hujjatni rad eta olmasdi — manba T/M, uning
  //  doirasida esa faqat o'z nuqtasi turardi.
  const d2 = await mudir('POST', '/api/warehouse/fg/moves',
    { to_warehouse_id: vitr.id, items: [{ unit_id: u.id, qty: 1 }] });
  assert.equal(d2.status, 200, d2.text);
  assert.equal((await mudir('POST',
    `/api/warehouse/fg/returns/${d2.body.id}/confirm`)).status, 200);

  //  Sabab MAJBURIY: nega qabul qilinmaganini jo'natgan odam
  //  bilishi kerak (konver so'rovi bilan bir xil qoida).
  assert.equal((await sotuvchi2('POST',
    `/api/warehouse/fg/returns/${d2.body.id}/reject`, {})).status, 400);

  const rad = await sotuvchi2('POST',
    `/api/warehouse/fg/returns/${d2.body.id}/reject`,
    { note: 'Javonda yo\'q edi' });
  assert.equal(rad.status, 200, rad.text);

  //  Holati «rad etildi» — «bekor qilindi» emas: hujjatni boshqa odam
  //  yopdi (konver so'rovi bilan bir xil idiom).
  const h2 = await H.id(
    `SELECT status, decide_note FROM wh_returns WHERE id = $1`, [d2.body.id]);
  assert.equal(h2.status, 'rejected');
  assert.match(h2.decide_note, /Javonda/);

  //  Mahsulot QIMIRLAMAYDI: rad etilgan hujjat qoldiqqa tegmaydi.
  assert.equal((await H.id(
    `SELECT SUM(qty)::int AS n FROM production_units
      WHERE conveyor_no = $1 AND warehouse_id = $2 AND status='fg'`,
    [u.conveyor_no, vitr.id])).n, 4, 'vitrinada baribir 4 ta');

  //  Yopilgan hujjat ikkinchi marta yopilmaydi.
  assert.equal((await sotuvchi2('POST',
    `/api/warehouse/fg/returns/${d2.body.id}/reject`,
    { note: 'yana' })).status, 400);
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




//  ★ MENEJER RO'YXATIDA FAQAT SAVDO XODIMI (zavod qarori, 2026-09).
//  Zavodning oltmish oltita xodimi kiritilgach butun shtat chiqadigan
//  ro'yxat ishlatib bo'lmaydigan bo'lib qoldi: menejer tanlash uchun
//  qorovul va shkurkachining orasidan izlash kerak edi.
test('menejer ro\'yxati: faqat savdo xodimi va allaqachon biriktirilgani',
  async () => {
  //  Shtatdagi odam: PIN'i ham, roli ham yo'q
  const opr = (await admin('POST', '/api/admin/workers',
    { name: 'Sinov Shkurkachi Menejer', staff_group: 'Ishlab chiqarish',
      position: 'Shkurkachi' })).body.id;
  const sav = (await admin('POST', '/api/admin/workers',
    { name: 'Sinov Savdo Menejer', pin: '7731',
      roles: [{ code: 'sotuvchi' }] })).body.id;

  const ro = async () => (await admin('GET', '/api/units/customers')).body.managers;

  let m = await ro();
  assert.ok(m.some((x) => x.id === sav), 'savdo xodimi ro\'yxatda');
  assert.ok(!m.some((x) => x.id === opr), 'shkurkachi ro\'yxatda yo\'q');

  //  ★ ALLAQACHON BIRIKTIRILGANI QOLADI — roli bo'lmasa ham: aks
  //  holda eski kartochka ochilganda menejeri ro'yxatdan tushib,
  //  saqlashda jimgina o'chib ketardi.
  const c = await admin('POST', '/api/units/customers',
    { name: 'Sinov Menejer Mijozi', manager_id: opr });
  assert.equal(c.status, 200, c.text);

  m = await ro();
  const bor = m.find((x) => x.id === opr);
  assert.ok(bor, 'biriktirilgan xodim ro\'yxatda qoladi');
  assert.equal(bor.is_sales, false, 'lekin savdo emasligi belgisi bilan');

  //  Savdo huquqi berilsa ro'yxatga O'ZI qo'shiladi: chegara
  //  huquqdan chiqadi, lavozimdan emas.
  assert.equal((await admin('PATCH', '/api/admin/workers/' + opr,
    { roles: [{ code: 'sotuvchi' }] })).status, 200);
  assert.equal((await ro()).find((x) => x.id === opr).is_sales, true);
});

//  ★ OYLIK KIMGA BERILGANI YOZILADI (zavod qarori, 2026-09).
//  Ta'minotchiga to'lovdan farqi: xodim TOMON BO'LMAYDI — pul
//  korxonadan chiqib ketadi, ya'ni tomoni harajat moddasi.
test('oylik: kimga berilgani so\'raladi va qo\'lidagi pulga qo\'shilmaydi', async () => {
  const kassir = H.api(base, await H.sessionFor('Administrator'));

  //  Shtatdagi odam — PIN'siz, dasturga kirmaydi, lekin oylik oladi
  const xodim = (await admin('POST', '/api/admin/workers',
    { name: 'Sinov Oylik Oluvchi', staff_group: 'Ishlab chiqarish',
      position: 'Shkurkachi' })).body.id;

  const refs = (await kassir('GET', '/api/cash/refs')).body;
  const modda = refs.items.find((x) => x.group_code === 'MAOSH');
  assert.ok(modda, 'maosh moddasi bor');
  assert.equal(modda.needs_worker, true, 'oylik moddasi xodim so\'raydi');
  //  Ro'yxat SPRAVOCHNIK: dasturga kirmaydigan odam ham turadi
  assert.ok(refs.staff.some((x) => x.id === xodim),
    'PIN\'siz xodim ham ro\'yxatda');

  const kassa = refs.accounts.find((a) => a.code === 'MAIN').id;
  const yoz = (extra) => kassir('POST', '/api/cash/ops', {
    from_kind: 'account', from_id: kassa, to_kind: 'expense',
    currency: 'USD', amount: 300, pl_month: '2026-09',
    expense_item_id: modda.id, ...extra });

  //  Xodimsiz yozib bo'lmaydi
  const bosh = await yoz({});
  assert.equal(bosh.status, 400, bosh.text);
  assert.match(bosh.body.error, /Xodim tanlanmagan/);

  //  Ro'yxatni chetlab, bo'lmagan id yuborilsa ham qabul qilinmaydi
  assert.equal((await yoz({ staff_id: 999999 })).status, 400);

  const ok = await yoz({ staff_id: xodim });
  assert.equal(ok.status, 200, ok.text);

  //  ★ QO'LIDAGI PULGA QO'SHILMAYDI: odam maoshini olgani uchun
  //  korxonaga qarzdor bo'lib qolmasligi kerak.
  const qol = await H.id(
    `SELECT COALESCE(total_usd, 0) AS s FROM v_worker_cash WHERE id = $1`, [xodim]);
  assert.equal(Number(qol ? qol.s : 0), 0, 'oylik podotchyot emas');

  //  Lentada ismi bilan turadi
  const op = await H.id(
    `SELECT staff_id, staff_name, to_kind FROM v_cash_ops WHERE doc_no = $1`,
    [ok.body.doc_no]);
  assert.equal(op.to_kind, 'expense', 'tomoni harajat moddasi');
  assert.equal(op.staff_id, xodim);
  assert.equal(op.staff_name, 'Sinov Oylik Oluvchi');

  //  Foyda-zararda o'z moddasida turadi
  const pl = (await kassir('GET', '/api/cash/pl?from=2026-09&to=2026-09')).body;
  assert.ok(pl.rows.some((x) => x.item_id === modda.id),
    'oylik foyda-zararda o\'z moddasida');

  //  Xodim so'ramaydigan moddada katak umuman so'ralmaydi
  const boshqa = refs.items.find((x) => !x.needs_worker && !x.needs_supplier);
  assert.equal((await kassir('POST', '/api/cash/ops', {
    from_kind: 'account', from_id: kassa, to_kind: 'expense',
    currency: 'USD', amount: 10, pl_month: '2026-09',
    expense_item_id: boshqa.id })).status, 200, 'boshqa harajat eskicha yoziladi');
});

//  ★ OYLIK MODDASINING DOIRASI. «Oylik korpus» ni tanlagan kassirga
//  butun shtat kerak emas — javob o'sha tsexning xodimlari orasida.
//  Doira MODDADA turadi (`expense_items.shop_id` / `staff_group`),
//  kodda emas: zavod boshqa tsexga bog'lasa bitta katakcha o'zgaradi.
//  Ro'yxatni SAHIFA qisqartiradi, shuning uchun test doiraning
//  O'ZINI tekshiradi: nimaga tayanib qisqarayotgani shu.
test('oylik moddasi o\'z tsexi bilan keladi', async () => {
  const kassir = H.api(base, await H.sessionFor('Sinov kassir'));
  const refs = (await kassir('GET', '/api/cash/refs')).body;

  const tsex = refs.items.find((x) => x.name === 'Oylik korpus');
  const korpus = (await H.id(`SELECT id, name FROM shops WHERE code='KORPUS'`));
  assert.equal(tsex.shop_id, korpus.id, 'oylik korpus \u2014 korpus tsexi');
  assert.equal(tsex.scope_name, korpus.name, 'ekranda tsexning nomi yoziladi');
  assert.equal(tsex.staff_group, null, 'tsex bo\'yicha, guruh bo\'yicha emas');

  //  Guruh bo'yicha: AUP ham, savdo ham tsex emas
  const guruh = refs.items.find((x) => x.name === 'Oylik AUP');
  assert.equal(guruh.shop_id, null);
  assert.equal(guruh.staff_group, 'AUP');
  assert.equal(guruh.scope_name, 'AUP');

  //  Doirasi yo'q modda ro'yxatni QISQARTIRMAYDI: sarmoya ham,
  //  tibbiy yordam ham zavodning har qanday xodimiga beriladi.
  //  Tsexi yo'q, lekin oyligi alohida ko'rinishi kerak bo'lgan ikkitasi
  const omb = refs.items.find((x) => x.name === 'Oylik ombor');
  assert.equal(omb.staff_group, 'Ombor');
  assert.equal(omb.shop_id, null, 'ombor tsex emas');
  const itr = refs.items.find((x) => x.name === 'Oylik muhandis-texnik xodimlar');
  assert.equal(itr.staff_group, 'ITR');
  assert.equal(itr.shop_id, null, 'texnolog butun ishlab chiqarishga xizmat qiladi');

  //  Modda kutayotgan guruh Xodimlar sahifasidagi ro'yxatda TURADI,
  //  hali hech kimda bo'lmasa ham: aks holda qo'lda terilib, «ITR» va
  //  «itr » ikkita guruh bo'lib qolardi va modda ikkalasini ham
  //  topmasdi.
  const meta = (await H.api(base, await H.sessionFor('Administrator'))(
    'GET', '/api/admin/roles')).body;
  assert.ok(meta.staff_groups.includes('ITR'),
    'yangi moddaning guruhi ro\'yxatda turadi');

  //  ★ BUTUN GURUH XODIM SO'RAYDI — yangi qo'shilgani ham. Ilgari bu
  //  `migration_flags` bilan bir marta qo'yilardi va bayroqdan KEYIN
  //  qo'shilgan modda belgisiz qolardi: «Oylik ombor» va «Oylik
  //  muhandis-texnik xodimlar» tanlanganda xodim katagi UMUMAN
  //  ochilmasdi va kassir «kimga berildi» ni yoza olmasdi.
  const maosh = refs.items.filter((x) => x.group_code === 'MAOSH');
  assert.ok(maosh.length >= 10, 'oylik moddalari joyida');
  assert.deepEqual(maosh.filter((x) => !x.needs_worker).map((x) => x.name), [],
    'MAOSH guruhidagi HAR modda xodim so\'raydi');

  const hamma = refs.items.find((x) => x.name === 'Xodimlarga sarmoya');
  assert.equal(hamma.needs_worker, true, 'u ham xodim so\'raydi');
  assert.equal(hamma.shop_id, null);
  assert.equal(hamma.staff_group, null);
  assert.equal(hamma.scope_name, null, 'doira yo\'q \u2014 yozilmaydi ham');

  //  Xodimlar ro'yxati solishtirish uchun kerak bo'lgan ikki ustunni
  //  ham beradi — sahifa ularni moddaning doirasi bilan taqqoslaydi.
  const w = refs.staff.find((x) => x.name === 'Sinov Oylik Oluvchi');
  assert.ok(w, 'shtat ro\'yxatida turadi');
  assert.ok('shop_id' in w && 'staff_group' in w, 'doira ustunlari keladi');
});

//  ★ TSEXI BOR XODIMGA O'Z TSEXINING MODDASI. Guruh cheklovi «faqat
//  oylik yozadi» deb aytadi, lekin QAYSI oylik ekanini aytmasdi: lak
//  tsexining boshlig'i ro'yxatda korpus, stul va qadoqlash oyliklarini
//  ham ko'rardi va adashib boshqa tsexning qatoriga yozib qo'yishi
//  mumkin edi — foyda-zararda esa uni ajratib bo'lmasdi.
test('tsex boshlig\'i faqat O\'Z tsexining oyligini yozadi', async () => {
  const { db } = require('../db');
  const kassir = H.api(base, await H.sessionFor('Sinov kassir'));
  const kassa = (await H.id(`SELECT id FROM cash_accounts WHERE code='MAIN'`)).id;
  const lak = (await H.id(`SELECT id FROM shops WHERE code='BOYOQ'`)).id;

  await db.query(`INSERT INTO workers (name, can_hold_cash)
                  SELECT 'Sinov lak boshlig''i', true
                   WHERE NOT EXISTS (SELECT 1 FROM workers
                                      WHERE name='Sinov lak boshlig''i')`);
  const b = (await H.id(
    `SELECT id FROM workers WHERE name='Sinov lak boshlig''i'`)).id;
  await db.query(`UPDATE workers SET can_hold_cash = true WHERE id=$1`, [b]);
  //  Doira ROLDA: xodim NIMANI ko'rishini u cheklaydi
  await db.query(`INSERT INTO worker_roles (worker_id, role_code, scope_shop_id)
                  VALUES ($1,'tsex_usta',$2) ON CONFLICT DO NOTHING`, [b, lak]);
  await db.query(`DELETE FROM worker_expense_groups WHERE worker_id=$1`, [b]);
  await db.query(`INSERT INTO worker_expense_groups (worker_id, group_code)
                  VALUES ($1,'MAOSH')`, [b]);

  const bosh = H.api(base, await H.sessionFor('Sinov lak boshlig\'i'));
  assert.equal((await kassir('POST', '/api/cash/ops', {
    from_kind: 'account', from_id: kassa, to_kind: 'worker', to_id: b,
    currency: 'USD', amount: 500 })).status, 200);

  //  Doira sahifaga ham keladi — ro'yxat shu bilan qisqaradi
  const refs = (await bosh('GET', '/api/cash/refs')).body;
  assert.deepEqual(refs.my.shop_ids, [lak], 'doira xodimning o\'ziga keladi');
  assert.deepEqual(refs.my.groups, ['MAOSH'], 'faqat oylik guruhi');

  const modda = async (nom) => (await H.id(
    `SELECT id FROM expense_items WHERE name=$1`, [nom])).id;
  //  MAOSH guruhi kimga berilganini ham so'raydi (`needs_worker`)
  const yoz = (id) => bosh('POST', '/api/cash/ops', {
    to_kind: 'expense', currency: 'USD', amount: 10, staff_id: b,
    op_date: '2026-09-25', expense_item_id: id, pl_month: '2026-09' });

  //  Boshqa tsexning oyligi — YO'Q
  const stul = await yoz(await modda('Oylik stul'));
  assert.equal(stul.status, 400, stul.text);
  assert.match(stul.body.error, /ochilmagan/);

  //  Tsexga bog'lanmagan modda ham o'sha guruhda TURMAYDI: guruhda
  //  uning tsexiniki bor, ya'ni qoida ishga tushadi.
  const sarmoya = await yoz(await modda('Xodimlarga sarmoya'));
  assert.equal(sarmoya.status, 400, sarmoya.text);

  //  O'ziniki — yoziladi
  const ok = await yoz(await modda('Oylik lak'));
  assert.equal(ok.status, 200, ok.text);

  //  ★ DOIRASI YO'Q XODIMDA HECH NARSA QISQARMAYDI: ombor mudiri va
  //  ta'minotchi tsexga biriktirilmagan va ular hamma moddani
  //  eskicha yozaveradi.
  const erkin = H.api(base, await H.sessionFor('Sinov tsex boshlig\'i'));
  assert.deepEqual((await erkin('GET', '/api/cash/refs')).body.my.shop_ids, [],
    'doirasi yo\'q xodimda ro\'yxat qisqarmaydi');
});

//  ★ XODIMLAR FAYLDAN. Zavodda oltmish kishi ishlaydi, tizimga esa
//  o'ntasi kiradi — qolgani PIN'siz shtatda turadi va ularning oyligi
//  ishbay hisobdan chiqadi. Fayl shuning uchun PIN'ni ham, rolni ham
//  o'qimaydi: PIN yozilgan Excel pochtada va stol ustida qolardi.
test('xodimlarni fayldan yuklash: bo\'lim tsex ichida izlanadi', async () => {
  const fayl = [
    "T/R;F.I.SH;Guruh;Tsex;Bo'lim;Lavozim",
    //  «Qadoqlash» nomli bo'lim IKKITA tsexda bor — faqat nom
    //  bo'yicha izlansa odam begona tsexga tushib, ishbay oyligi
    //  boshqa bo'limga yozilardi.
    "1;Sinov Qadoqchi Stul;Ishlab chiqarish;Stul tsexi;Qadoqlash;Qadoqlovchi",
    "2;Sinov Qadoqchi Qad;Ishlab chiqarish;Qadoqlash tsexi;Qadoqlash;Qadoqlovchi",
    //  Bo'limi ro'yxatda yo'q: XATO emas, ogohlantirish — odam
    //  baribir kiritiladi, aks holda bitta noto'g'ri yozilgan nom
    //  butun ro'yxatni to'xtatardi.
    "3;Sinov Qorovul;AUP;;Ma'muriy-xo'jalik bo'limi;Qorovul",
  ];
  const pre = await (await post('/api/import/workers', fayl)).json();
  assert.equal(pre.total, 3);
  assert.equal(pre.bad, 0, JSON.stringify(pre.rows));
  assert.equal(pre.no_section.length, 0, 'tsexsiz qatorda bo\'lim izlanmaydi');

  const done = await (await post('/api/import/workers?save=1', fayl)).json();
  assert.equal(done.saved, 3);
  assert.equal(done.created, 3);

  const joy = async (ism) => H.id(
    `SELECT w.staff_group, w.position, w.dept, sc.code AS section, sh.code AS shop,
            (w.pin IS NOT NULL OR w.pin_hash IS NOT NULL) AS pinli
       FROM workers w
       LEFT JOIN sections sc ON sc.id = w.section_id
       LEFT JOIN shops    sh ON sh.id = w.shop_id
      WHERE w.name = $1`, [ism]);

  const st = await joy('Sinov Qadoqchi Stul');
  assert.equal(st.section, 'STU-QAD', 'stulning qadoqlashi');
  assert.equal(st.shop, 'STUL', 'tsex bo\'limdan chiqadi');
  assert.equal(st.position, 'Qadoqlovchi');
  assert.ok(!st.pinli, 'fayldan kelgan xodimda PIN yo\'q');

  const qd = await joy('Sinov Qadoqchi Qad');
  assert.equal(qd.section, 'QAD-QAD', 'qadoqlash tsexiniki');
  assert.equal(qd.shop, 'QADOQ');

  //  Ishlab chiqarish bo'limi bo'lmagan odam ham kiradi: matni
  //  yoziladi, `section_id` esa bo'sh qoladi.
  const qr = await joy('Sinov Qorovul');
  assert.equal(qr.section, null);
  assert.equal(qr.shop, null);
  assert.equal(qr.dept, 'Ma\'muriy-xo\'jalik bo\'limi');
  assert.equal(qr.staff_group, 'AUP');

  //  Qayta yuklash nusxa ochmaydi va bo'sh katak tegmaydi
  const yana = await (await post('/api/import/workers?save=1', [
    "F.I.SH;Lavozim", 'Sinov Qorovul;'])).json();
  assert.equal(yana.saved, 1);
  assert.equal(yana.created, 0);
  assert.equal((await H.id(
    `SELECT COUNT(*)::int n FROM workers WHERE name='Sinov Qorovul'`)).n, 1);
  assert.equal((await joy('Sinov Qorovul')).position, 'Qorovul',
    'bo\'sh katak yozilganini o\'chirmaydi');

  //  ★ BO'LIMI TOPILMASA — OGOHLANTIRISH, XATO EMAS
  const noto = await (await post('/api/import/workers', [
    "F.I.SH;Tsex;Bo'lim", "Sinov Bolimsiz;Stul tsexi;Bunaqa bo'lim yo'q"])).json();
  assert.equal(noto.bad, 0);
  assert.equal(noto.no_section.length, 1);
  assert.match(noto.no_section[0], /Sinov Bolimsiz/);

  //  Faylda takrorlangan ism — XATO: oylik qaysi biriga yozilishi
  //  noaniq qolardi.
  const takror = await (await post('/api/import/workers', [
    'F.I.SH', 'Sinov Egizak', 'Sinov Egizak'])).json();
  assert.equal(takror.bad, 1);
  assert.match(takror.rows[1].errors[0], /takrorlangan/);
  assert.equal((await post('/api/import/workers?save=1',
    ['F.I.SH', 'Sinov Egizak', 'Sinov Egizak'])).status, 400);
  assert.equal((await H.id(
    `SELECT COUNT(*)::int n FROM workers WHERE name='Sinov Egizak'`)).n, 0,
    'xato bo\'lsa bitta xodim ham kirmaydi');

  //  Kartochkadan ham qo'yiladi va bo'lim tanlansa tsex O'ZI aniqlanadi
  const lak = (await H.id(`SELECT id FROM sections WHERE code='STU-LAK'`)).id;
  const w = await admin('POST', '/api/admin/workers',
    { name: 'Sinov Shtat Kartochka', section_id: lak,
      staff_group: 'Ishlab chiqarish', position: 'Lakchi' });
  assert.equal(w.status, 200, w.text);
  const k = await joy('Sinov Shtat Kartochka');
  assert.equal(k.shop, 'STUL', 'tsex bo\'limdan chiqadi, alohida so\'ralmaydi');

  //  Bo'sh yuborilgani «tegma» emas, «yo'q» degani
  assert.equal((await admin('PATCH', '/api/admin/workers/' + w.body.id,
    { section_id: null, position: '' })).status, 200);
  const k2 = await joy('Sinov Shtat Kartochka');
  assert.equal(k2.section, null);
  assert.equal(k2.shop, null);
  assert.equal(k2.position, null);

  //  ★ TSEX BO'LIMSIZ HAM QO'YILADI: tsex boshlig'ining bo'limi
  //  YO'Q — u butun tsexga mas'ul. Ilgari tsexni faqat bo'lim orqali
  //  tanlash mumkin edi va boshliqning tsexi bo'sh qolib ketardi.
  const stul = (await H.id(`SELECT id FROM shops WHERE code='STUL'`)).id;
  const b = await admin('POST', '/api/admin/workers',
    { name: 'Sinov Tsex Boshlig\'i', shop_id: stul,
      staff_group: 'Ishlab chiqarish', position: 'Stul tsex boshlig\'i' });
  assert.equal(b.status, 200, b.text);
  const bj = await joy('Sinov Tsex Boshlig\'i');
  assert.equal(bj.shop, 'STUL', 'tsexi bo\'limsiz yozildi');
  assert.equal(bj.section, null, 'bo\'limi yo\'q — u butun tsexga mas\'ul');

  //  Bo'lim tanlansa tsex O'SHANIKI bo'lib qoladi: ikkalasi
  //  qarama-qarshi bo'lib qolmaydi.
  const korArra = (await H.id(`SELECT id FROM sections WHERE code='KOR-ARRA'`)).id;
  assert.equal((await admin('PATCH', '/api/admin/workers/' + b.body.id,
    { shop_id: stul, section_id: korArra })).status, 200);
  const bj2 = await joy('Sinov Tsex Boshlig\'i');
  assert.equal(bj2.shop, 'KORPUS', 'bo\'lim tsexdan ustun');

  //  Bo'lmagan tsex qabul qilinmaydi
  assert.equal((await admin('PATCH', '/api/admin/workers/' + b.body.id,
    { shop_id: 999999 })).status, 400);

  //  Boshqa maydon saqlanganda shtat o'chib qolmaydi
  assert.equal((await admin('PATCH', '/api/admin/workers/' + w.body.id,
    { section_id: lak, staff_group: 'Ishlab chiqarish' })).status, 200);
  assert.equal((await admin('PATCH', '/api/admin/workers/' + w.body.id,
    { phone: '+998900000000' })).status, 200);
  assert.equal((await joy('Sinov Shtat Kartochka')).section, 'STU-LAK',
    'telefon saqlansa bo\'lim o\'chmaydi');
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

  //  ★ «Hammasi» oralig'ida ham boshlang'ich qarz «DAVR BOSHIGA» da
  //  turadi va HAQDOR aylanmasiga qo'shilmaydi (zavod qarori,
  //  2026-10). Ilgari u «kelgan mol» bilan bitta raqamga qo'shilardi
  //  va «oy ichida qancha mol keldi» degan savolga javob yo'q edi.
  //  Shart SANA bo'yicha emas, kind ustuni bo'yicha — ya'ni oraliq
  //  uning kunidan oldin boshlansa ham javob o'zgarmaydi.
  const hammasi = (await admin(
    'GET', '/api/purchasing/debts?from=1900-01-01&to=2026-12-31')).body;
  const h = hammasi.rows.find((x) => x.id === tam);
  assert.equal(Number(h.opening_credit), 800, 'davr boshida turadi');
  assert.equal(Number(h.credit), 0, 'haqdor aylanmada kelgan mol yo\'q');
  assert.equal(Number(h.debit), 250);
  assert.equal(Number(h.closing_credit), 550);
  //  boshiga + haqdor − qarzdor = oxiriga
  assert.equal(
    Number(h.opening) + Number(h.credit) - Number(h.debit),
    Number(h.closing), 'tenglama saqlanadi');
  //  Yig'indi ham o'sha ustunda: kartochka jadval bilan bitta raqamni
  //  aytishi kerak (menyudagi navbat belgisi bilan bir xil qoida).
  const yig = hammasi.rows.reduce((a, x) => a + Number(x.opening_credit), 0);
  assert.equal(Number(hammasi.total.opening_credit).toFixed(2), yig.toFixed(2));
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

  //  Arrada turibdi, ya'ni oldinda lak tsexi turadi — «keyingi tsexga
  //  qachon beraman» degan savolning javobi o'sha zanjirdan chiqadi va
  //  lak kuni bilan bir xil bo'ladi.
  assert.equal(String(r1.next_shop_on).slice(0, 10), '2026-09-26',
    'keyingi tsexga o\'tish kuni ham zanjirdan');
  assert.equal(r1.next_shop_src, 'marshrut');

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
  assert.equal((await admin('POST', '/api/units/requests',
    { product_id: STUL, qty: 1, color: 'Oq', fabric: 'Velvet-12' })).status, 200);
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
  const q = await admin('POST', '/api/units/requests',
    { product_id: STUL, qty: 1, conveyor_no: 'S-9201', started_on: '2026-09-19',
      color: 'Oq', fabric: 'Velvet-12' });
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

test('navbat xabarlari Telegram navbatiga ham tushadi', async () => {
  //  ★ ZAVOD QARORI (2026-09). Menyudagi raqam faqat sayt ochiq
  //  bo'lganda ko'rinadi: ertalab jo'natilgan konver tsex boshlig'i
  //  ekranni ochmaguncha kechgacha qabul qilinmay turardi. Endi har
  //  navbat Telegramga ham yoziladi.
  //
  //  ★ KIMGA BORISHI NAVBAT BILAN BIR XIL — shart ikki joyda yozilsa
  //  bir kun ajralib ketardi: menyuda bir odam ko'radi, xabar esa
  //  boshqasiga borardi va buni hech narsa aytmasdi.
  const { db } = require('../db');
  //  Har tekshiruv FAQAT shu harakat yozganini qaraydi: baza toza
  //  emas va oldingi testlar ham xabar qoldirgan.
  const belgi = async () => Number((await H.id(
    `SELECT COALESCE(MAX(id), 0)::int AS n FROM notifications`)).n);
  const yangi = async (dan, t) => (await db.query(
    `SELECT n.worker_id, n.permission_code, n.title, n.body, w.name
       FROM notifications n LEFT JOIN workers w ON w.id = n.worker_id
      WHERE n.id > $1 AND n.title LIKE $2 ORDER BY n.id`, [dan, t])).rows;

  //  ── 1. TSEXGA JO'NATILDI → qabul qiluvchi TSEXGA
  const u = await newUnit({ section_id: SHKUR });
  const b1 = await belgi();
  assert.equal((await korpus('POST', '/api/units/handover',
    { items: [u.id] })).status, 200);
  const x1 = await yangi(b1, '%qabul qilishingizni kutmoqda');
  assert.ok(x1.length, 'xabar yozildi');
  const ismlar = x1.map((r) => r.name);
  assert.ok(ismlar.includes("Bo'yoq ustasi"),
    `keyingi tsexning boshlig'iga: ${ismlar.join(', ')}`);
  assert.match(x1[0].body, new RegExp(u.conveyor_no), 'konver raqami turadi');
  assert.match(x1[0].body, /Korpus ustasi/, 'kim jo\'natgani ham');
  //  ★ MAHSULOT NOMI VA TURI HAM (zavod qarori, 2026-09): qabul
  //  qiluvchi boshliq «K26-0041 · 10 ta» ni o'qib nima kelayotganini
  //  bilmasdi, zavodda esa bitta nom ikki guruhda uchraydi.
  {
    const p = await H.id(
      `SELECT p.name, g.name AS tur FROM production_units u
         JOIN products p ON p.id = u.product_id
         JOIN product_groups g ON g.id = p.group_id
        WHERE u.id = $1`, [u.id]);
    assert.match(x1[0].body, new RegExp(p.name), 'mahsulot nomi turadi');
    assert.match(x1[0].body, new RegExp(`\\(${p.tur}\\)`), 'turi ham turadi');
  }

  //  Jo'natgan odamning O'ZIGA yozilmaydi: qabul qilish keyingi
  //  tsexning ishi va unga bu xabar emas. Doirasi YO'Q xodimga ham
  //  (administrator) — butun zavodning topshirig'i unga hech qachon
  //  tinmaydigan xabar bo'lib qolardi (navbat 2 bilan bir xil qoida).
  assert.ok(!ismlar.includes('Korpus ustasi'), 'jo\'natganning o\'ziga emas');
  assert.ok(!ismlar.includes('Administrator'), 'doirasi yo\'q xodimga emas');

  //  ── 2. T/M OMBORGA JO'NATILDI → ombor mudirining navbati
  const qad = H.api(base, await H.sessionFor('Qadoqlash ustasi'));
  const u2 = await newUnit({ section_id: QADQAD });
  const b2 = await belgi();
  assert.equal((await qad('POST', '/api/units/handover',
    { items: [u2.id] })).status, 200);
  const x2 = await yangi(b2, '%T/M omborga qabul qilishni kutmoqda');
  assert.ok(x2.length, 'omborga jo\'natilgani yozildi');
  assert.match(x2[0].body, new RegExp(u2.conveyor_no));
  //  HAR oluvchida qabul qilish huquqi bor: qoldiqni savdo ham
  //  ko'radi, lekin mahsulotni omborga u kiritmaydi (navbat 4 bilan
  //  bir xil shart).
  for (const r of x2) {
    const huquq = await H.id(
      `SELECT COUNT(*)::int AS n FROM v_worker_permissions
        WHERE worker_id = $1
          AND permission_code = ANY(ARRAY['warehouse.move','warehouse.manage',
                                          'production.manage'])`, [r.worker_id]);
    assert.ok(Number(huquq.n) > 0, `${r.name}: qabul qilish huquqi yo'q`);
  }

  //  ── 3. YANGI BUYURTMA → konverning EGASI bo'lgan tsexga
  await require('../db').db.query(
    `INSERT INTO customers (name) VALUES ('Sinov xabar mijozi')
       ON CONFLICT (lower(name)) DO NOTHING`);
  const mijoz = (await H.id(
    `SELECT id FROM customers WHERE name = 'Sinov xabar mijozi'`)).id;
  const u3 = await newUnit({ section_id: ARRA, qty: 4 });
  const z = await admin('POST', '/api/sales/orders',
    { customer_id: mijoz, items: [{ product_id: PENAL, qty: 2, unit_price: 500 }] });
  assert.equal(z.status, 200, z.text);
  const qator = (await admin('GET', '/api/sales/orders/' + z.body.id)).body.items[0];
  const b3 = await belgi();
  assert.equal((await admin('POST', `/api/sales/orders/${z.body.id}/assign`,
    { item_id: qator.id, unit_id: u3.id, qty: 2 })).status, 200);
  const x3 = await yangi(b3, 'Konverga yangi buyurtma');
  assert.ok(x3.length, 'bron xabari yozildi');
  assert.ok(x3.map((r) => r.name).includes('Korpus ustasi'),
    'konver EGASI bo\'lgan tsexga');
  assert.match(x3[0].body, new RegExp(u3.conveyor_no));
  assert.match(x3[0].body, /Sinov xabar mijozi/);

  //  ── 4. TOPSHIRILGAN PUL → kassirga (huquq bo'yicha)
  const pulchi = await xodim('Sinov pul topshiruvchi', 'sotuvchi');
  await require('../db').db.query(
    `UPDATE workers SET can_hold_cash = true, opening_usd = 100
      WHERE name = 'Sinov pul topshiruvchi'`);
  const b4 = await belgi();
  const op = await pulchi('POST', '/api/cash/ops',
    { to_kind: 'account', currency: 'USD', amount: 50 });
  assert.equal(op.status, 200, op.text);
  assert.equal(op.body.status, 'pending');
  const x4 = await yangi(b4, 'Pul topshirildi%');
  assert.equal(x4.length, 1, 'bitta xabar — huquq bo\'yicha yo\'llanadi');
  assert.equal(x4[0].permission_code, 'cash.manage', 'kassirga');
  assert.match(x4[0].body, /Sinov pul topshiruvchi/);
});

test('chegirma tasdiq kutayotgani XABAR bo\'lib tushadi', async () => {
  //  ★ ZAVOD QARORI (2026-09). Ilgari hech narsa aytmasdi: menejer
  //  narxni tushirib saqlardi, buyurtma «Chegirma kutmoqda» bo'lib
  //  turardi va direktor buni faqat buyurtmalar ro'yxatini o'zi ochib
  //  ko'rganda bilardi. Menyudagi raqam bor edi, lekin u sayt ochiq
  //  bo'lgandagina ko'rinadi — konver so'rovi bilan bir xil sabab.
  const { db } = require('../db');
  await db.query(`UPDATE products SET price_opt = 100 WHERE id = $1`, [PENAL]);
  await db.query(`INSERT INTO customers (name) VALUES ('Sinov chegirma mijozi')
                   ON CONFLICT (lower(name)) DO NOTHING`);
  const mijoz = (await H.id(
    `SELECT id FROM customers WHERE name = 'Sinov chegirma mijozi'`)).id;

  const men = await xodim('Sinov chegirmachi', 'sotuvchi');
  const son = async () => Number((await H.id(
    `SELECT COUNT(*)::int AS n FROM notifications
      WHERE permission_code = 'sales.discount'`)).n);

  //  Chegaradan YUQORI narx — xabar YO'Q: tasdiq ham so'ralmaydi.
  const oldin = await son();
  const yaxshi = await men('POST', '/api/sales/orders', { customer_id: mijoz,
    items: [{ product_id: PENAL, qty: 2, unit_price: 120 }] });
  assert.equal(yaxshi.status, 200, yaxshi.text);
  assert.equal(await son(), oldin, 'chegara ustida xabar yozilmaydi');

  //  Chegaradan PAST — xabar navbatga tushadi.
  const z = await men('POST', '/api/sales/orders', { customer_id: mijoz,
    items: [{ product_id: PENAL, qty: 2, unit_price: 90 }] });
  assert.equal(z.status, 200, z.text);
  assert.equal(await son(), oldin + 1, 'xabar navbatga tushdi');

  const x = await H.id(
    `SELECT permission_code, module, title, body FROM notifications
      WHERE permission_code = 'sales.discount' ORDER BY id DESC LIMIT 1`);
  assert.equal(x.module, 'sales');
  assert.match(x.title, /Chegirma tasdiq kutmoqda/);
  const no = (await men('GET', '/api/sales/orders/' + z.body.id)).body.order.order_no;
  assert.match(x.body, new RegExp(no), 'xabarda zakaz raqami turadi');
  assert.match(x.body, /Sinov chegirma mijozi/, 'mijozi ham');
  //  «Chegirma kutmoqda» ning o'zi direktorning savoliga javob
  //  bermaydi: QAYSI mahsulot, qanchaga va chegarasi qancha edi.
  assert.match(x.body, /90/, 'yozilgan narx');
  assert.match(x.body, /100/, 'chegara narxi');
  assert.match(x.body, /Sinov chegirmachi/, 'kim yozgani');

  //  ★ TAKROR SAQLASH XABARNI TAKRORLAMAYDI: buyurtma tahrirlanganda
  //  shart qaytadan hisoblanadi va menejer qatorni uch marta tuzatsa
  //  direktorga uchta bir xil xabar ketardi.
  const q = (await men('GET', '/api/sales/orders/' + z.body.id)).body.items[0];
  assert.equal((await men('PATCH', '/api/sales/orders/' + z.body.id,
    { items: [{ id: q.id, product_id: PENAL, qty: 3, unit_price: 90 }] })).status, 200);
  assert.equal(await son(), oldin + 1, 'ikkinchi xabar yozilmaydi');

  //  Tasdiqlangandan KEYIN yana tushirilsa — bu yangi savol, yangi
  //  xabar (narx o'zgarsa tasdiq qayta so'raladi degan qoida).
  assert.equal((await admin('POST', `/api/sales/orders/${z.body.id}/discount`,
    { approve: true })).status, 200);
  assert.equal((await men('PATCH', '/api/sales/orders/' + z.body.id,
    { items: [{ id: q.id, product_id: PENAL, qty: 3, unit_price: 80 }] })).status, 200);
  assert.equal(await son(), oldin + 2, 'qayta tushirilgani yangi xabar');

  //  Chegirmaga RUXSATI BOR odam yozsa tasdiq ham, xabar ham yo'q:
  //  u baribir o'zi tasdiqlaydigan qarorni ikki marta bosmaydi.
  const d = await admin('POST', '/api/sales/orders', { customer_id: mijoz,
    items: [{ product_id: PENAL, qty: 1, unit_price: 70 }] });
  assert.equal(d.status, 200, d.text);
  assert.equal(await son(), oldin + 2, 'direktornikiga xabar yozilmaydi');
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

  const a = await admin('POST', '/api/units/requests',
    { product_id: STUL, qty: 1, conveyor_no: 'S-9401', started_on: '2026-09-19',
      color: 'Oq', fabric: 'Velvet-12' });
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
  await xomsiz();
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
  await xomsiz();
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
    { product_id: STUL, qty: 1, conveyor_no: 'S-9002',
      color: 'Oq', fabric: 'Velvet-12' });
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

  //  ★ STUL O'Z TSEXIDAN CHIQMAYDI (zavod qarori, 2026-09): marshrut
  //  Rover karkasdan Qadoqlashgacha bitta tsexda yuradi, ya'ni
  //  «keyingi tsex» degan savol yo'q va sanasi ham taxmin qilinmaydi.
  //  Korpusda esa u bor — o'sha yerda sinaladi («muddat: korpusda
  //  bosqichlar zanjiri»).
  assert.equal(pl.next_shop, null, 'stul marshruti bitta tsexda');
  assert.equal(r.next_shop_on, null);
  const begona = await H.id(
    `SELECT COUNT(*)::int AS n FROM v_unit_step_plan sp
       JOIN sections sc ON sc.id = sp.section_id
      WHERE sp.unit_id = $1
        AND sc.shop_id <> (SELECT id FROM shops WHERE code = 'STUL')`, [u.id]);
  assert.equal(begona.n, 0, 'marshrutning hamma qadami stul tsexida');

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

test('mijozga chiqarishga ruxsatni faqat belgisi bor xodim beradi', async () => {
  //  ★ ZAVOD QARORI (2026-09): buyurtmani har menejer yozadi, lekin
  //  CHIQISH kunini bitta odam nazorat qiladi — aks holda ikki
  //  menejer bir kunga ikkita mashinalik mahsulot chiqarib yuborardi.
  const { db } = require('../db');
  const men = await xodim('Sinov ruxsatsiz menejer', 'sotuvchi');
  await db.query(
    `UPDATE worker_roles SET scope_own = false
      WHERE worker_id = (SELECT id FROM workers WHERE name = 'Sinov ruxsatsiz menejer')`);
  const m = H.api(base, await H.sessionFor('Sinov ruxsatsiz menejer'));

  const mijoz = (await admin('POST', '/api/units/customers',
    { name: 'Sinov ruxsat mijozi', channel: 'B2B' })).body;
  const z = (await admin('POST', '/api/sales/orders', {
    customer_id: mijoz.id, ship_to: 'ZAVOD',
    items: [{ product_id: PENAL, qty: 1, color: 'Oq' }] })).body;
  const qator = (await admin('GET', '/api/sales/orders/' + z.id)).body.items[0];
  const u = (await admin('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 1, color: 'Oq', is_opening: true,
      fg_on: '2026-09-01' }] })).body.created[0];
  await admin('POST', `/api/sales/orders/${z.id}/assign`,
    { item_id: qator.id, unit_id: u.id, qty: 1 });

  //  Belgisi yo'q menejer rad etiladi — tugmani yashirish himoya emas,
  //  tekshiruv SERVERDA.
  const yoq = await m('POST', `/api/sales/orders/${z.id}/send`);
  assert.equal(yoq.status, 400, yoq.text);
  assert.match(yoq.body.error, /ruxsat/i);

  //  T/M ombor mudiriga u KO'RINMAYDI ham: hali savdoning qo'lida.
  assert.ok(!(await admin('GET', '/api/sales/shipping')).body.rows
    .some((r) => r.id === z.id), 'ruxsatsiz buyurtma mudirga chiqmaydi');

  //  ★ TO'DALAB BERISHDA BITTASI YIQILSA QOLGANI O'TAVERADI (izoh:
  //  modules/sales.js): o'nta buyurtmadan birida chegirma
  //  tasdiqlanmagan bo'lsa, qolgan to'qqiztasini ham rad etish kunni
  //  to'xtatardi. Yiqilgani NOMI bilan qaytariladi.
  //
  //  Ruxsat BU YERDA ham tekshiriladi — ikki yo'l bitta funksiyadan
  //  o'tadi, ya'ni belgisiz odam to'dalab ham yubora olmaydi.
  const toda = await m('POST', '/api/sales/orders/send', { ids: [z.id] });
  assert.equal(toda.status, 200, toda.text);
  assert.equal(toda.body.saved, 0, 'ruxsatsiz odamda bittasi ham o\'tmaydi');
  assert.match(toda.body.errors[0].error, /ruxsat/i);
  assert.equal(toda.body.errors[0].order_no, z.order_no, 'qaysi biri \u2014 nomi bilan');

  //  Belgi qo'yilgach o'sha odam o'tkazadi.
  await db.query(
    `UPDATE workers SET can_release = true WHERE name = 'Sinov ruxsatsiz menejer'`);
  const m2 = H.api(base, await H.sessionFor('Sinov ruxsatsiz menejer'));
  const ok = await m2('POST', `/api/sales/orders/${z.id}/send`);
  assert.equal(ok.status, 200, ok.text);
  assert.ok((await admin('GET', '/api/sales/shipping')).body.rows
    .some((r) => r.id === z.id), 'endi mudir ko\'radi');

  //  To'dalab berish ham o'sha funksiyadan o'tadi: ikkinchi marta
  //  yuborilgan buyurtma rad etiladi va sababi nomi bilan yoziladi.
  const qayta = await m2('POST', '/api/sales/orders/send', { ids: [z.id] });
  assert.equal(qayta.body.saved, 0);
  assert.match(qayta.body.errors[0].error, /[Aa]llaqachon/);
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
  //
  //  ★ RAQAM «TAYYOR» TABINING O'ZI BILAN solishtiriladi — shartni
  //  test QAYTA YOZMAYDI. Ilgari shu yerda navbatning sharti
  //  ko'chirilgan edi va aynan shuning uchun farq tutilmagan:
  //  menyuda «2» turar, tabni ochgan odam esa bo'sh ro'yxat
  //  ko'rardi. Test ro'yxatning O'ZINI so'rasa bunday ajralish
  //  birinchi ishga tushirishdayoq qizil bo'ladi.
  //  ★ SAHIFADA IKKITA NAVBAT BOR (tayyor buyurtma va chegirma
  //  tasdig'i), shuning uchun har biri O'Z ro'yxati bilan alohida
  //  solishtiriladi. Yig'indi bilan solishtirilsa ikkala shart ham
  //  jimgina tekshirilmay qolardi: biri ko'payib, ikkinchisi
  //  kamayganda raqam baribir to'g'ri chiqardi.
  const navda = (izoh) => nav.find(
    (q) => q.page === '/buyurtmalar.html' && izoh.test(q.izoh))?.n;

  const tayyor = (await admin('GET', '/api/sales/orders?status=reserved'))
    .body.rows;
  assert.equal(navda(/chiqarishga berilmagan/), tayyor.length,
    'menyudagi raqam «Tayyor» tabidagi qatorlar soni bilan bir xil');

  //  Chegirma navbatining o'z ro'yxati yo'q — u holat emas, qatorning
  //  ustidagi belgi — shuning uchun buyurtmalar ro'yxatining O'ZIDAN
  //  sanaladi (`discount_status`, `v_sales_orders` da bor).
  const kutayotgan = (await admin('GET', '/api/sales/orders')).body.rows
    .filter((o) => o.discount_status === 'pending'
                && !['shipped', 'cancelled'].includes(o.status)).length;
  assert.equal(navda(/chegirma tasdig'ini kutmoqda/), kutayotgan,
    'chegirma navbati ro\'yxatdagi bilan bir xil');
  //  Tabdagi har qator haqiqatan ham chiqarishga tayyor: hammasi
  //  javonda va hali yuborilmagan.
  for (const o of tayyor) {
    assert.equal(o.holat, 'reserved');
    assert.ok(o.qty > 0 && o.in_warehouse_qty >= o.qty,
      `${o.order_no}: hammasi omborda emas`);
  }

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

test("adashib yozilgan boshlang'ich qoldiq bekor qilinadi", async () => {
  //  ★ ZAVOD QARORI (2026-09). Qoldiq bir martalik ish va o'sha bir
  //  martada adashish oson: material boshqa omborga tushib qolardi
  //  va uni hisobdan chiqaradigan yo'l YO'Q edi — yagona usul
  //  «minus» qilib ikkinchi marta yozish bo'lardi, ya'ni tarixda
  //  ikkita yolg'on qator qolardi.
  const xom = await xodim('Sinov ochirish xodim', 'xom_ombor');
  const wh = (await H.id(
    `SELECT id FROM warehouses WHERE code = 'TSEX-STU-ZBOR'`)).id;
  const m = (await xom('POST', '/api/materials',
    { name: 'Sinov Ochirish Yelim', uom: 'kg', category: 'BOSHQA' })).body;
  assert.equal((await xom('POST', '/api/materials/opening', {
    items: [{ material_id: m.id, qty: 30, warehouse_id: wh, price: 4 }] })).status,
    200);

  const qoldiq = async () => {
    const r = (await xom('GET', '/api/materials/stock?warehouse_id=' + wh))
      .body.rows.find((x) => x.material_id === m.id);
    return r ? Number(r.qty) : 0;
  };
  assert.equal(await qoldiq(), 30);

  const mv = (await xom('GET', '/api/materials/moves?material_id=' + m.id))
    .body.rows[0];
  assert.equal(mv.from_kind, 'opening');

  //  O'CHIRILMAYDI, BEKOR QILINADI: qoldiqdan chiqadi, tarixda
  //  o'chirilgan holida qoladi (kassadagi operatsiya bilan bir xil).
  assert.equal((await xom('POST',
    `/api/materials/moves/${mv.id}/cancel`)).status, 200);
  assert.equal(await qoldiq(), 0, 'qoldiqdan chiqdi');
  const keyin = (await xom('GET', '/api/materials/moves?material_id=' + m.id))
    .body.rows.find((x) => x.id === mv.id);
  assert.ok(keyin, 'tarixda qoladi');
  assert.equal(keyin.status, 'cancelled');

  //  Ikkinchi marta bekor qilinmaydi.
  assert.equal((await xom('POST',
    `/api/materials/moves/${mv.id}/cancel`)).status, 404);

  //  ★ FAQAT QOLDIQ QATORI: kirim HUJJAT bilan bekor qilinadi (u
  //  ta'minotchining qarziga ham tegadi) — yakka qatorni bekor
  //  qilish hujjatni haqiqatdan ajratib qo'yardi.
  await admin('POST', '/api/purchasing/suppliers',
    { name: 'Sinov Ochirish Mdf', category: 'MDF' });
  const tam = (await H.id(
    `SELECT id FROM suppliers WHERE name = 'Sinov Ochirish Mdf'`)).id;
  const zavod = (await H.id(`SELECT id FROM warehouses WHERE code = 'XOM'`)).id;
  const k = await xom('POST', '/api/materials/receipts', {
    supplier_id: tam, warehouse_id: zavod,
    items: [{ material_id: m.id, qty: 10, price: 3 }] });
  assert.equal(k.status, 200, k.text);
  const kmv = (await xom('GET', '/api/materials/moves?material_id=' + m.id))
    .body.rows.find((x) => x.doc_kind === 'receipt');
  assert.ok(kmv, 'kirim qatori turadi');
  assert.equal((await xom('POST',
    `/api/materials/moves/${kmv.id}/cancel`)).status, 404,
    'kirim qatori bu yo\'ldan bekor qilinmaydi');

  //  Huquqi yo'q xodimda ham yo'q: tugmani yashirish himoya emas.
  const usta2 = await xodim('Sinov ochirish usta', 'tsex_usta');
  const yana = (await xom('GET', '/api/materials/moves?material_id=' + m.id))
    .body.rows.find((x) => x.from_kind === 'opening' && x.status === 'ok');
  if (yana) assert.equal((await usta2('POST',
    `/api/materials/moves/${yana.id}/cancel`)).status, 403);

  //  ★ KONVERGA SARFNI HAM OMBOR MUDIRI BEKOR QILADI. Ilgari bu
  //  faqat tsex boshlig'ining ekranida edi (▣ oynasi) — mudir esa
  //  ombor tarixida xato qatorni ko'rib turib, telefon qilishdan
  //  boshqa yo'l topmasdi. Qoldiq shu paytgacha minusda turardi.
  const u = await newUnit();
  const sarf = await admin('POST', `/api/materials/unit/${u.id}/consume`, {
    warehouse_id: wh, items: [{ material_id: m.id, qty: 5 }] });
  assert.equal(sarf.status, 200, sarf.text);
  const smv = (await xom('GET', '/api/materials/moves?material_id=' + m.id))
    .body.rows.find((x) => x.to_kind === 'unit' && x.status === 'ok');
  assert.ok(smv, 'sarf qatori turadi');
  //  Ombor tarixidagi «×» aynan shu yo'ldan o'tadi.
  assert.equal((await xom('POST',
    `/api/materials/consume/${smv.id}/cancel`)).status, 200);
  const skeyin = (await xom('GET', '/api/materials/moves?material_id=' + m.id))
    .body.rows.find((x) => x.id === smv.id);
  assert.equal(skeyin.status, 'cancelled', 'tarixda qoladi');
});

test("bron ko'chgan dona bilan birga yuradi", async () => {
  //  ★ ZAVOD QARORI (2026-09). 16 talik konverning 8 tasi
  //  buyurtmada edi; boshliq 8 tasini keyingi bo'limga o'tkazdi — va
  //  buyurtma ORQADA qolib, bo'sh bo'lak oldinga ketdi. Mijozga
  //  va'da qilingan sana ham shundan buziladi: omborga tushish kuni
  //  QATORNING qadamidan hisoblanadi.
  const { db } = require('../db');
  await db.query(`INSERT INTO customers (name) VALUES ('Sinov bron mijozi')
                   ON CONFLICT (lower(name)) DO NOTHING`);
  const mijoz = (await H.id(
    `SELECT id FROM customers WHERE name = 'Sinov bron mijozi'`)).id;

  const u = await newUnit({ qty: 16 });
  const z = await admin('POST', '/api/sales/orders',
    { customer_id: mijoz, items: [{ product_id: PENAL, qty: 8, unit_price: 100 }] });
  const qator = (await admin('GET', '/api/sales/orders/' + z.body.id)).body.items[0];
  assert.equal((await admin('POST', `/api/sales/orders/${z.body.id}/assign`,
    { item_id: qator.id, unit_id: u.id, qty: 8 })).status, 200);

  const bronlar = async () => (await db.query(
    `SELECT p.id, p.qty, p.current_section_id,
            COALESCE((SELECT SUM(r.qty) FROM unit_reservations r
                       WHERE r.unit_id = p.id), 0)::int AS bron
       FROM production_units p
      WHERE p.conveyor_no = $1 AND p.status = 'production'
      ORDER BY p.id`, [u.conveyor_no])).rows;

  //  ── 8 tasi keyingi bo'limga: bron ular BILAN ketadi.
  await xomsiz();
  assert.equal((await korpus('POST', '/api/units/move',
    { items: [{ unit_id: u.id, qty: 8 }] })).status, 200);
  let q = await bronlar();
  assert.equal(q.length, 2, 'konver ikki bo\'lakka bo\'lindi');
  const ketgan = q.find((x) => x.current_section_id === ROVER);
  const qolgan = q.find((x) => x.current_section_id === ARRA);
  assert.equal(Number(ketgan.qty), 8);
  assert.equal(ketgan.bron, 8, 'bron ko\'chgan dona bilan ketdi');
  assert.equal(qolgan.bron, 0, 'qolgan bo\'lak bo\'sh');

  //  Umumiy bron o'zgarmadi: mijozga va'da qilingan dona o'sha.
  assert.equal(q.reduce((a, x) => a + x.bron, 0), 8);

  //  ★ VA ENG YOMONI: bo'lak o'z bo'lagi bilan UCHRASHGANDA eski
  //  qator o'chadi, `unit_reservations` esa `ON DELETE CASCADE` —
  //  butun bron JIMGINA yo'qolardi. Qolgan 8 tasini ham o'sha
  //  bo'limga o'tkazamiz: ikkala bo'lak qo'shiladi.
  await xomsiz();
  assert.equal((await korpus('POST', '/api/units/move',
    { items: [{ unit_id: qolgan.id }] })).status, 200);
  q = await bronlar();
  assert.equal(q.length, 1, 'bo\'laklar qo\'shildi');
  assert.equal(Number(q[0].qty), 16);
  assert.equal(q[0].bron, 8, 'bron yo\'qolmadi');

  //  Savdo tomonida ham o'sha raqam: buyurtma hali to'liq bron.
  const o = (await admin('GET', '/api/sales/orders/' + z.body.id)).body;
  assert.equal(Number(o.order.assigned_qty), 8, 'buyurtmada 8 ta qoldi');
});

test('talabnoma: tsexga material zavod omboridan beriladi', async () => {
  //  ★ ZAVOD QARORI (2026-09). Tsex boshlig'i xom ashyoni OG'ZAKI
  //  so'ramaydi — hujjat yozadi. Material faqat CHIQARILGANDA
  //  ko'chadi: yo'ldagi material ikkala qoldiqda ham to'g'ri turadi
  //  (vitrinadan qaytarish bilan bir xil sabab).
  const { db } = require('../db');
  const xom = await xodim('Sinov talab xodim', 'xom_ombor');
  await xodim('Sinov talab boshliq', 'tsex_usta');
  //  Tsex boshlig'ining DOIRASI bor: u faqat o'z tsexining omboriga
  //  so'raydi, lekin zavod omborini ko'rishi SHART — aks holda
  //  so'rash uchun manba qolmasdi.
  await db.query(
    `UPDATE worker_roles SET scope_shop_id = (SELECT id FROM shops WHERE code='KORPUS')
      WHERE role_code = 'tsex_usta'
        AND worker_id = (SELECT id FROM workers WHERE name = 'Sinov talab boshliq')`);
  const boshliq = H.api(base, await H.sessionFor('Sinov talab boshliq'));

  const zavod = (await H.id(`SELECT id FROM warehouses WHERE code = 'XOM'`)).id;
  const tsexWh = (await H.id(
    `SELECT id FROM warehouses WHERE code = 'TSEX-KOR-ARRA'`)).id;

  //  ★ ZAVOD OMBORI DOIRADAN QAT'I NAZAR KELADI (faqat manba uchun).
  const ref = (await boshliq('GET', '/api/materials/ref')).body;
  assert.ok((ref.factory_warehouses || []).some((w) => w.id === zavod),
    'zavod ombori manba ro\'yxatida turadi');
  assert.ok(!ref.warehouses.some((w) => w.id === zavod),
    'ko\'radigan ro\'yxatida esa yo\'q — doira o\'z kuchida');

  const m = (await xom('POST', '/api/materials',
    { name: 'Sinov Talab Yelim', uom: 'kg', category: 'BOSHQA' })).body;
  //  Omborda 100 kg bor.
  assert.equal((await xom('POST', '/api/materials/opening', {
    items: [{ material_id: m.id, qty: 100, warehouse_id: zavod }] })).status, 200);

  //  ── Talabnoma: tsex ombori MANZIL, zavod ombori MANBA.
  const t = await boshliq('POST', '/api/materials/requests', {
    shop_warehouse_id: tsexWh, factory_warehouse_id: zavod,
    need_on: '2026-10-01',
    items: [{ material_id: m.id, qty: 40 }] });
  assert.equal(t.status, 200, t.text);
  assert.match(t.body.doc_no, /^T\d\d-\d{4}$/, 'raqam T26-0001 shaklida');

  //  Teskari yo'nalish rad etiladi: mol zavodga ta'minotchidan
  //  kiradi, tsexga esa undan talabnoma bilan beriladi.
  const teskari = await boshliq('POST', '/api/materials/requests', {
    shop_warehouse_id: zavod, factory_warehouse_id: tsexWh,
    items: [{ material_id: m.id, qty: 5 }] });
  assert.equal(teskari.status, 400, teskari.text);

  //  Boshqa tsexning omboriga so'rab bo'lmaydi — doira CHEGARA.
  const begona = (await H.id(
    `SELECT id FROM warehouses WHERE code = 'TSEX-STU-ZBOR'`)).id;
  assert.equal((await boshliq('POST', '/api/materials/requests', {
    shop_warehouse_id: begona, factory_warehouse_id: zavod,
    items: [{ material_id: m.id, qty: 5 }] })).status, 400);

  //  ── Material HALI ko'chmagan: hujjat yozilgani — berilgani emas.
  const qoldiq = async (whId) => {
    const r = (await xom('GET', '/api/materials/stock?warehouse_id=' + whId))
      .body.rows.find((x) => x.material_id === m.id);
    return r ? Number(r.qty) : 0;
  };
  assert.equal(await qoldiq(zavod), 100, 'zavodda hali 100');
  assert.equal(await qoldiq(tsexWh), 0, 'tsexda hali yo\'q');

  //  «Tayyorladim» — javondan yig'ib qo'ydi, material baribir joyida.
  assert.equal((await xom('POST',
    `/api/materials/requests/${t.body.id}/ready`)).status, 200);
  assert.equal(await qoldiq(zavod), 100, 'tayyorlash qoldiqqa tegmaydi');

  //  ★ BERILGAN SONI ALOHIDA: 40 so'ralgan, 25 ta berildi.
  const d = await xom('POST', `/api/materials/requests/${t.body.id}/done`, {
    items: [{ material_id: m.id, qty: 25 }] });
  assert.equal(d.status, 200, d.text);
  assert.equal(await qoldiq(zavod), 75, 'zavoddan 25 chiqdi');
  assert.equal(await qoldiq(tsexWh), 25, 'tsexga 25 kirdi');

  const r2 = (await xom('GET', '/api/materials/requests')).body.rows
    .find((x) => x.id === t.body.id);
  assert.equal(r2.status, 'done');
  assert.equal(Number(r2.items[0].qty), 40, 'so\'ralgani saqlanadi');
  assert.equal(Number(r2.items[0].issued_qty), 25, 'berilgani alohida');

  //  Ikkinchi marta chiqarib bo'lmaydi.
  assert.equal((await xom('POST',
    `/api/materials/requests/${t.body.id}/done`, {})).status, 400);

  //  ── Qaytarish: o'sha hujjat, teskari yo'nalishda.
  const q = await boshliq('POST', '/api/materials/requests', {
    kind: 'return', shop_warehouse_id: tsexWh, factory_warehouse_id: zavod,
    items: [{ material_id: m.id, qty: 10 }] });
  assert.equal(q.status, 200, q.text);
  assert.match(q.body.doc_no, /^Q\d\d-\d{4}$/, 'qaytarish Q bilan');
  //  Qaytarishda «tayyorlash» bosqichi YO'Q.
  assert.equal((await xom('POST',
    `/api/materials/requests/${q.body.id}/ready`)).status, 400);
  assert.equal((await xom('POST',
    `/api/materials/requests/${q.body.id}/done`, {})).status, 200);
  assert.equal(await qoldiq(tsexWh), 15, 'tsexdan 10 qaytdi');
  assert.equal(await qoldiq(zavod), 85, 'zavodga qaytib keldi');

  //  ★ «QADOQLASH OMBORI» — ZAVOD OMBORI, LEKIN TSEXNIKI (zavod
  //  qarori, 2026-09). Ta'minotchidan mol to'g'ridan-to'g'ri unga
  //  keladi (`shop_id` yo'q), lekin uni QADOQLASH tsexi yuritadi
  //  (`owner_shop_id`). Ilgari talabnoma faqat `shop_id` bor omborga
  //  yozilardi: o'sha tsexning boshlig'ida ro'yxat BUTUNLAY bo'sh
  //  chiqar va u talabnoma umuman yoza olmasdi.
  await xodim('Sinov qadoq boshliq', 'tsex_usta');
  await db.query(
    `UPDATE worker_roles SET scope_shop_id = (SELECT id FROM shops WHERE code='QADOQ')
      WHERE role_code = 'tsex_usta'
        AND worker_id = (SELECT id FROM workers WHERE name = 'Sinov qadoq boshliq')`);
  const qadBoshliq = H.api(base, await H.sessionFor('Sinov qadoq boshliq'));
  const qadWh = (await H.id(`SELECT id FROM warehouses WHERE code = 'TSEX-QAD'`)).id;

  //  Ekranda ko'rinadi: qabul qiladigan ro'yxat `shop_id` EMAS,
  //  `COALESCE(owner_shop_id, shop_id)` bo'yicha quriladi.
  const qadRef = (await qadBoshliq('GET', '/api/materials/ref')).body;
  assert.ok(qadRef.warehouses.some((w) => w.id === qadWh),
    'qadoqlash ombori o\'z boshlig\'iga ko\'rinadi');

  const qt = await qadBoshliq('POST', '/api/materials/requests', {
    shop_warehouse_id: qadWh, factory_warehouse_id: zavod,
    items: [{ material_id: m.id, qty: 3 }] });
  assert.equal(qt.status, 200, qt.text);

  //  ★ O'ZI YOZGAN HUJJAT O'Z RO'YXATIDA TURADI. View `to_shop` ni
  //  ham javobgar tsexdan oladi — aks holda u BO'SH bo'lib, hujjat
  //  doira filtridan tushib qolardi va menyudagi navbat ham
  //  yonmasdi.
  assert.ok((await qadBoshliq('GET', '/api/materials/requests')).body.rows
    .some((x) => x.id === qt.body.id), 'hujjat o\'z ro\'yxatida');

  //  O'zidan o'ziga hujjat bo'lmaydi: «Qadoqlash ombori» ikkala
  //  ro'yxatda ham turadi (zavodniki ham, tsexniki ham).
  assert.equal((await qadBoshliq('POST', '/api/materials/requests', {
    shop_warehouse_id: qadWh, factory_warehouse_id: qadWh,
    items: [{ material_id: m.id, qty: 1 }] })).status, 400);

  //  Boshqa tsexning ombori esa baribir yopiq — doira CHEGARA.
  assert.equal((await qadBoshliq('POST', '/api/materials/requests', {
    shop_warehouse_id: tsexWh, factory_warehouse_id: zavod,
    items: [{ material_id: m.id, qty: 1 }] })).status, 400);

  //  ★ MANBANI TIZIM TOPADI VA HAR OMBOR ALOHIDA HUJJAT BO'LADI
  //  (zavod qarori, 2026-09). Tsex boshlig'i «qaysi zavod omboridan»
  //  degan savolga javob bermaydi: material qaysi javonda turganini
  //  ombor biladi. Ikki xil ombordagi material BITTA hujjatga
  //  tushirilsa uni ikki xodim chiqarishi kerak bo'lardi — biri o'z
  //  javonidagini berar, qolgani «berilmadi» bo'lib osilib qolardi.
  const furn = (await H.id(`SELECT id FROM warehouses WHERE code = 'FURN'`)).id;
  const m2 = (await xom('POST', '/api/materials',
    { name: 'Sinov Talab Petlya', uom: 'dona', category: 'BOSHQA' })).body;
  assert.equal((await xom('POST', '/api/materials/opening', {
    items: [{ material_id: m2.id, qty: 50, warehouse_id: furn }] })).status, 200);

  //  Ekran ham shu javobni oladi: boshliq saqlashdan OLDIN qaysi
  //  ombordan kelishini o'qiydi.
  const manba = (await boshliq('GET',
    `/api/materials/requests/source?ids=${m.id},${m2.id}&to=${tsexWh}`)).body.rows;
  assert.equal(manba.find((x) => x.material_id === m.id).warehouse_id, zavod);
  assert.equal(manba.find((x) => x.material_id === m2.id).warehouse_id, furn);

  //  Ombor YUBORILMAYDI — server o'zi topadi va guruhlaydi.
  const avto = await boshliq('POST', '/api/materials/requests', {
    shop_warehouse_id: tsexWh,
    items: [{ material_id: m.id, qty: 2 }, { material_id: m2.id, qty: 3 }] });
  assert.equal(avto.status, 200, avto.text);
  assert.equal(avto.body.docs.length, 2, 'ikki ombor — ikki hujjat');
  const whlar = avto.body.docs.map((d) => d.doc_no).sort();
  assert.equal(new Set(whlar).size, 2, 'raqamlari ham boshqa');

  //  Har hujjatda FAQAT o'z omborining qatori turadi.
  const royxat = (await xom('GET', '/api/materials/requests')).body.rows;
  const kutilgan = new Map([[zavod, m.id], [furn, m2.id]]);
  for (const d of avto.body.docs) {
    const h = royxat.find((x) => x.id === d.id);
    assert.equal(h.lines, 1, 'hujjatda bitta qator');
    assert.equal(h.to_warehouse_id, tsexWh, 'manzil — tsex ombori');
    assert.equal(h.items[0].material_id, kutilgan.get(h.from_warehouse_id),
      'qator O\'Z omborining materiali');
  }
  assert.equal(new Set(avto.body.docs.map((d) =>
    royxat.find((x) => x.id === d.id).from_warehouse_id)).size, 2,
    'ikki hujjat ikki xil ombordan');

  //  ★ YETMAGANI XARID ZAYAVKASIGA TUSHADI (zavod qarori, 2026-09).
  //  Ilgari zanjir shu yerda uzilardi: ombor xodimi borini berib,
  //  qolgani haqida OG'ZAKI aytardi va ta'minotchining esidan
  //  chiqsa tsex ertaga yana so'rardi.
  const m3 = (await xom('POST', '/api/materials',
    { name: 'Sinov Zayavka Lak', uom: 'kg', category: 'BOSHQA' })).body;
  assert.equal((await xom('POST', '/api/materials/opening', {
    items: [{ material_id: m3.id, qty: 4, warehouse_id: zavod }] })).status, 200);

  //  Omborda 4 bor, 10 so'raldi → 6 zayavkaga.
  const kam = await boshliq('POST', '/api/materials/requests', {
    shop_warehouse_id: tsexWh, need_on: '2026-10-05',
    items: [{ material_id: m3.id, qty: 10 }] });
  assert.equal(kam.status, 200, kam.text);
  assert.equal(kam.body.docs[0].orders.length, 1, 'bitta zayavka yasaldi');

  const zayRoy = (await xom('GET', '/api/materials/orders')).body.rows;
  const z = zayRoy.find((x) => x.doc_no === kam.body.docs[0].orders[0].doc_no);
  assert.ok(z, 'zayavka ro\'yxatda');
  assert.match(z.doc_no, /^X\d\d-\d{4}$/, 'raqam X26-0001 shaklida');
  assert.equal(z.status, 'new');
  assert.equal(z.warehouse_id, zavod, 'mol SHU omborga kerak');
  assert.equal(Number(z.items[0].qty), 6, 'faqat YETMAGANI');
  assert.equal(z.items[0].request_id, kam.body.docs[0].id,
    'qaysi talabnomadan chiqqani saqlanadi');

  //  Omborda YETARLI bo'lsa zayavka umuman yasalmaydi: har
  //  talabnomaga bittadan bo'sh hujjat qo'shilsa ro'yxat bir haftada
  //  ishlatib bo'lmaydigan bo'lardi.
  const yetar = await boshliq('POST', '/api/materials/requests', {
    shop_warehouse_id: tsexWh, items: [{ material_id: m3.id, qty: 1 }] });
  assert.equal(yetar.body.docs[0].orders.length, 0, 'yetarli — zayavka yo\'q');

  //  ★ TA'MINOTCHISIZ «BUYURTMA BERDIM» BO'LMAYDI: kimga
  //  aytilganini bilmagan hujjat keyin javobsiz qolardi.
  assert.equal((await xom('POST',
    `/api/materials/orders/${z.id}/ordered`)).status, 400);
  const sup1 = (await H.id(`INSERT INTO suppliers (name)
    VALUES ('Sinov Zayavka Lak Ta''minotchi') RETURNING id`)).id;
  assert.equal((await xom('POST', `/api/materials/orders/${z.id}/supplier`,
    { supplier_id: sup1 })).status, 200);
  assert.equal((await xom('POST',
    `/api/materials/orders/${z.id}/ordered`)).status, 200);
  assert.equal((await xom('POST',
    `/api/materials/orders/${z.id}/done`)).status, 200);
  //  Yopilgan hujjat ikkinchi marta o'zgarmaydi.
  assert.equal((await xom('POST',
    `/api/materials/orders/${z.id}/done`)).status, 400);

  //  ★ BITTA TA'MINOTCHI BO'LSA O'ZI BIRIKTIRILADI. Bir nechta yoki
  //  yo'q bo'lsa bo'sh qoladi: zavodda MDF to'rt odamdan keladi va
  //  qaysi biridan olish NARXGA qarab hal qilinadi — tizim taxmin
  //  qilmaydi.
  await db.query(
    `INSERT INTO material_suppliers (material_id, supplier_id) VALUES ($1, $2)`,
    [m3.id, sup1]);
  const avtoSup = await boshliq('POST', '/api/materials/requests', {
    shop_warehouse_id: tsexWh, items: [{ material_id: m3.id, qty: 99 }] });
  const z2 = (await xom('GET', '/api/materials/orders')).body.rows
    .find((x) => x.doc_no === avtoSup.body.docs[0].orders[0].doc_no);
  assert.equal(z2.supplier_id, sup1, "bitta ta'minotchi — o'zi biriktiriladi");

  //  ── Rad etish: sabab SHART, aks holda boshliq nega
  //  bo'lmaganini bilmay, ertaga yana yozardi.
  const r3 = await boshliq('POST', '/api/materials/requests', {
    shop_warehouse_id: tsexWh, factory_warehouse_id: zavod,
    items: [{ material_id: m.id, qty: 5 }] });
  assert.equal((await xom('POST',
    `/api/materials/requests/${r3.body.id}/reject`, {})).status, 400);
  assert.equal((await xom('POST',
    `/api/materials/requests/${r3.body.id}/reject`,
    { note: 'Omborda yo\'q' })).status, 200);
  const r4 = (await xom('GET', '/api/materials/requests')).body.rows
    .find((x) => x.id === r3.body.id);
  assert.equal(r4.status, 'rejected', 'boshqa odam rad etdi');

  //  ★ NAVBAT RAQAMI RO'YXAT BILAN BIR XIL: ikki joyda yozilgan
  //  shart bir kun ajralib ketardi.
  const kutmoqda = (await xom('GET', '/api/materials/requests')).body.rows
    .filter((x) => ['new', 'ready'].includes(x.status)).length;
  const nav = (await xom('GET', '/api/navbat')).body.navbat
    .filter((x) => /talabnoma/.test(x.izoh || ''))
    .reduce((a, x) => a + x.n, 0);
  assert.equal(nav, kutmoqda, 'menyudagi raqam ro\'yxat bilan bir xil');
});

test("ta'minot xabarlari: kirim hujjati va kunlik saldo", async () => {
  //  ★ ZAVOD QARORI (2026-09): kirim yozilgan zahoti u Telegramga
  //  ketsin — qatorlari, summasi va ta'minotchining YANGI qarzi bilan;
  //  ustiga har kuni ertalab saldo. «M26-0001 yozildi» degan xabar
  //  qarzni AYTMASDI va nazorat qiladigan odam sahifani ochib
  //  ko'rishi kerak bo'lardi.
  //
  //  ★ KIMGA BORISHI ROLDAN EMAS, XODIM BELGISIDAN: kirimni xom ashyo
  //  mudiri YOZADI, o'qiydigan odam esa boshqa (4-qoida).
  const { db } = require('../db');
  const xom = await xodim("Sinov taminot xodim", 'xom_ombor');
  await xodim("Sinov taminot boshlig", 'ishlab_boshl');
  const kuzatuvchi = (await H.id(
    `SELECT id, supply_reports FROM workers WHERE name = 'Sinov taminot boshlig'`));
  //  Standarti BO'SH: xabar qilinadigan ish emas, kuzatuv — uni kim
  //  o'qishini zavod o'zi hal qiladi.
  assert.equal(kuzatuvchi.supply_reports, false, 'standarti bo\'sh');

  const wh = (await H.id(`SELECT id FROM warehouses WHERE code = 'XOM'`)).id;
  await admin('POST', '/api/purchasing/suppliers',
    { name: 'Sinov Xabar Mdf', category: 'MDF' });
  const tam = (await H.id(
    `SELECT id FROM suppliers WHERE name = 'Sinov Xabar Mdf'`)).id;
  const m = (await xom('POST', '/api/materials',
    { name: 'Sinov Xabar LDSP', uom: 'list', category: 'LDSP' })).body;

  const belgi = async () => Number((await H.id(
    `SELECT COALESCE(MAX(id), 0)::int AS n FROM notifications`)).n);
  const yangi = async (dan) => (await db.query(
    `SELECT n.worker_id, n.title, n.body FROM notifications n
      WHERE n.id > $1 AND n.title LIKE 'Kirim %' ORDER BY n.id`, [dan])).rows;

  //  ── Belgisi YO'Q: xabar umuman yozilmaydi.
  const b0 = await belgi();
  const k0 = await xom('POST', '/api/materials/receipts', {
    supplier_id: tam, warehouse_id: wh,
    items: [{ material_id: m.id, qty: 10, price: 5 }] });
  assert.equal(k0.status, 200, k0.text);
  assert.equal((await yangi(b0)).length, 0, 'belgisiz xodimga yozilmaydi');

  //  ── Belgi qo'yiladi (Xodimlar sahifasidagi katakcha).
  assert.equal((await admin('PATCH', '/api/admin/workers/' + kuzatuvchi.id,
    { supply_reports: true })).status, 200);

  const b1 = await belgi();
  const k = await xom('POST', '/api/materials/receipts', {
    supplier_id: tam, warehouse_id: wh, doc_on: '2026-09-12',
    items: [{ material_id: m.id, qty: 100, price: 20 }] });
  assert.equal(k.status, 200, k.text);

  const x = await yangi(b1);
  assert.equal(x.length, 1, 'faqat belgisi bor xodimga');
  assert.equal(x[0].worker_id, kuzatuvchi.id);
  assert.match(x[0].title, new RegExp(k.body.doc_no), 'hujjat raqami');
  assert.match(x[0].title, /Sinov Xabar Mdf/, 'ta\'minotchi');
  //  Qatorlar: nomi, soni, narxi va summasi — «nima keldi va
  //  qanchaga» degan savolga javob hujjatni ochmasdan bo'lsin.
  assert.match(x[0].body, /Sinov Xabar LDSP/, 'material nomi');
  assert.match(x[0].body, /100 list/, 'soni va o\'lchov birligi');
  assert.match(x[0].body, /20,00/, 'narxi');
  assert.match(x[0].body, /2 000,00/, 'summasi');
  //  ★ YANGI QARZ: 10 × 5 + 100 × 20 = 2 050. Qarz SHU
  //  tranzaksiyadan o'qiladi — hovuzdan yangi ulanish hali
  //  yozilmagan kirimni ko'rmasdi va xabarda ESKI qarz turardi.
  assert.match(x[0].body, /qarzimiz: 2 050,00/, 'kirimdan KEYINGI qarz');

  //  ── Kunlik saldo: qarzi bor ta'minotchilar, ikki tomon alohida.
  const saldo = await require('../modules/materials').saldoXabari();
  assert.ok(saldo, 'saldo xabari quriladi');
  assert.match(saldo.title, /Ta'minotchilar saldosi/);
  assert.match(saldo.body, /Qarzimiz:/);
  assert.match(saldo.body, /Sinov Xabar Mdf — 2 050,00 \$/);

  //  Nol qarzli ta'minotchi yozilmaydi: o'ttiz ikkita qatorning yarmi
  //  nol bo'lsa javob o'sha to'da orasida ko'rinmay ketardi.
  await admin('POST', '/api/purchasing/suppliers',
    { name: 'Sinov Nol Taminot', category: 'MDF' });
  assert.ok(!/Sinov Nol Taminot/.test(
    (await require('../modules/materials').saldoXabari()).body),
    'qarzi yo\'q ta\'minotchi yozilmaydi');

  //  Navbatga qo'yilishi ham shu belgidan.
  const b2 = await belgi();
  const n = await require('../modules/materials').saldoYubor();
  assert.equal(n, 1, 'belgisi bor bitta xodimga');
  const s2 = (await db.query(
    `SELECT title, worker_id FROM notifications WHERE id > $1`, [b2])).rows;
  assert.equal(s2.length, 1);
  assert.equal(s2[0].worker_id, kuzatuvchi.id);

  //  ★ «HOZIR YUBORISH»: jadval kuniga bir marta yuradi va belgini
  //  endi qo'ygan odam ishlaganini ertalabgacha bila olmasdi.
  //  Yuboradigan joy BITTA — matn jadvalnikidan farq qilmaydi.
  const b3 = await belgi();
  const yub = await admin('POST', '/api/materials/supply-report');
  assert.equal(yub.status, 200, yub.text);
  assert.equal(yub.body.workers, 1);
  const s3 = (await db.query(
    `SELECT title, body, worker_id FROM notifications WHERE id > $1`, [b3])).rows;
  assert.equal(s3.length, 1);
  assert.equal(s3[0].worker_id, kuzatuvchi.id);
  assert.equal(s3[0].title, s2[0].title, 'matn jadvalnikiga teng');

  //  Belgisi bor xodim qolmasa SABAB yoziladi: tugmani bosgan odam
  //  «yuborildi» degan javobni olib, keyin xabar kelmaganini
  //  kutib o'tirmasin.
  await db.query(`UPDATE workers SET supply_reports = false WHERE id = $1`,
                 [kuzatuvchi.id]);
  const yoq = await admin('POST', '/api/materials/supply-report');
  assert.equal(yoq.status, 400);
  assert.match(yoq.body.error, /Ta'minot xabarlarini oladi/);
});

test("kirim hujjati: ombor to'ladi, ta'minotchining qarzi oshadi", async () => {
  //  ★ MOL TA'MINOTCHIDAN KELDI (zavod qarori). Kirim IKKITA ishni
  //  birga qiladi: omborni to'ldiradi va ta'minotchining oldidagi
  //  qarzni oshiradi. Ikkalasi ham SHU testda tekshiriladi — biri
  //  ishlab, ikkinchisi jim qolsa farq faqat oy oxirida, solishtirma
  //  dalolatnomada bilinardi.
  const { db } = require('../db');
  const xom = await xodim('Sinov kirim xodim', 'xom_ombor');
  //  ★ KIRIM FAQAT ZAVOD OMBORIGA (zavod qarori, 2026-09) — pastda.
  const wh = (await H.id(
    `SELECT id FROM warehouses WHERE code = 'XOM'`)).id;
  const tsexWh = (await H.id(
    `SELECT id FROM warehouses WHERE code = 'TSEX-KOR-ARRA'`)).id;

  await admin('POST', '/api/purchasing/suppliers',
    { name: 'Sinov Kirim Mdf', category: 'MDF' });
  const tam = (await H.id(
    `SELECT id FROM suppliers WHERE name = 'Sinov Kirim Mdf'`)).id;
  const qarz = async () => Number((await H.id(
    `SELECT balance FROM v_supplier_debt WHERE id = $1`, [tam])).balance);
  assert.equal(await qarz(), 0, 'yangi ta\'minotchida qarz yo\'q');

  const m = (await xom('POST', '/api/materials',
    { name: 'Sinov Kirim LDSP', uom: 'list', category: 'LDSP' })).body;

  //  ★ NARX MAJBURIY — aynan shu yeri boshlang'ich qoldiqdan FARQ
  //  qiladi: kirimda narx QARZNING O'ZI. Narxsiz qator omborni
  //  to'ldirib, qarzni oshirmasdi.
  const narxsiz = await xom('POST', '/api/materials/receipts', {
    supplier_id: tam, warehouse_id: wh,
    items: [{ material_id: m.id, qty: 10 }] });
  assert.equal(narxsiz.status, 400, narxsiz.text);
  assert.match(narxsiz.body.error, /narx/i);

  //  Ta'minotchisiz kirim ham yo'q: mol keldi-yu, qarz hech qayerda
  //  yozilmasdi.
  assert.equal((await xom('POST', '/api/materials/receipts', {
    warehouse_id: wh,
    items: [{ material_id: m.id, qty: 10, price: 20 }] })).status, 400);

  //  So'mdagi hujjatga kurs SHART: kursi yo'q so'm dollarga
  //  aylanmaydi va hujjat qiymatsiz qolardi.
  assert.equal((await xom('POST', '/api/materials/receipts', {
    supplier_id: tam, warehouse_id: wh, ccy: 'UZS',
    items: [{ material_id: m.id, qty: 10, price: 250000 }] })).status, 400);

  //  ★ KIRIM FAQAT ZAVOD OMBORIGA: mol ta'minotchidan ZAVODGA keladi,
  //  tsexga esa undan talabnoma bilan beriladi. Ikkala yo'l ochiq
  //  qolsa material zavod qoldig'idan o'tmagan holda tsexda paydo
  //  bo'lardi va «ombordan nima chiqdi» degan savol javobsiz qolardi.
  //  Tekshiruv SERVERDA: ochilmani qisqartirish himoya emas.
  const tsexga = await xom('POST', '/api/materials/receipts', {
    supplier_id: tam, warehouse_id: tsexWh,
    items: [{ material_id: m.id, qty: 10, price: 20 }] });
  assert.equal(tsexga.status, 400, tsexga.text);
  assert.match(tsexga.body.error, /tsex ombori/);

  //  ── Hujjat yoziladi: 100 list × 250 000 so'm, kurs 12 500 = 2 000 $
  const k = await xom('POST', '/api/materials/receipts', {
    supplier_id: tam, warehouse_id: wh, doc_on: '2026-09-10',
    supplier_doc: 'NK-77', ccy: 'UZS', rate: 12500,
    items: [{ material_id: m.id, qty: 100, price: 250000 }] });
  assert.equal(k.status, 200, k.text);
  assert.match(k.body.doc_no, /^M\d\d-\d{4}$/, 'raqam M26-0001 shaklida');
  assert.equal(k.body.lines, 1);

  //  1. OMBOR to'ldi.
  const st = (await xom('GET', '/api/materials/stock')).body.rows
    .find((r) => r.material_id === m.id);
  assert.equal(Number(st.qty), 100, 'qoldiq oshdi');
  assert.equal(Number(st.price), 20, '250 000 / 12 500 = 20 $');
  assert.equal(Number(st.amount), 2000);

  //  2. TA'MINOTCHINING QARZI oshdi — aynan o'sha summaga.
  assert.equal(await qarz(), 2000, 'kelgan mol qarzga tushdi');

  //  Lentada ham turadi va HAQDOR tomonda: ta'minotchi passiv hisob,
  //  bizning qarzimiz oshdi. Qatorda hujjatning o'zi yoziladi.
  const lenta = (await admin('GET',
    '/api/purchasing/debts/' + tam + '?from=2026-09-01&to=2026-09-30')).body;
  const qator = lenta.rows.find((r) => r.kind === 'receipt');
  assert.ok(qator, 'kirim lentada turadi');
  assert.equal(Number(qator.credit), 2000, 'haqdor tomonda');
  assert.equal(Number(qator.debit), 0);
  assert.equal(qator.doc_no, k.body.doc_no);
  assert.match(qator.note, /NK-77/, 'ta\'minotchining hujjat raqami ham');

  //  Hujjat ICHIDA nima borligi ro'yxatda turadi — ochib ko'rmasdan.
  const ro = (await xom('GET', '/api/materials/receipts')).body.rows
    .find((r) => r.id === k.body.id);
  assert.equal(ro.lines, 1);
  assert.equal(Number(ro.amount), 2000);
  assert.equal(ro.items[0].material, 'Sinov Kirim LDSP');
  assert.equal(Number(ro.items[0].qty), 100);

  //  ── Bekor qilish: qoldiqdan HAM, qarzdan HAM chiqadi. Ikkinchisi
  //  qolib ketsa hujjat qarzdan chiqar, material esa omborda
  //  turaverardi.
  const b = await xom('POST',
    '/api/materials/receipts/' + k.body.id + '/cancel', { note: 'adashib' });
  assert.equal(b.status, 200, b.text);
  assert.ok(!(await xom('GET', '/api/materials/stock')).body.rows
    .some((r) => r.material_id === m.id), 'qoldiqdan chiqdi');
  assert.equal(await qarz(), 0, 'qarzdan ham chiqdi');

  //  Tarixda QOLADI: pulga tegadigan o'chirilgan qator savol
  //  qoldirardi — «men yozgan edim-ku».
  const bekor = (await xom('GET', '/api/materials/receipts')).body.rows
    .find((r) => r.id === k.body.id);
  assert.equal(bekor.status, 'cancelled');
  assert.equal(bekor.cancel_note, 'adashib');
  //  Ikkinchi marta bekor qilib bo'lmaydi — u allaqachon hech qaysi
  //  hisobda yo'q.
  assert.equal((await xom('POST',
    '/api/materials/receipts/' + k.body.id + '/cancel', {})).status, 400);

  //  ★ DOIRA CHEGARA, ro'yxatni yashirish emas: boshqa tsexning
  //  omboriga id ni qo'lda yuborib ham kirim yozib bo'lmaydi.
  const stulShop = (await H.id(`SELECT id FROM shops WHERE code = 'STUL'`)).id;
  await xodim('Sinov kirim stul', 'xom_ombor');
  await db.query(
    `UPDATE worker_roles SET scope_shop_id = $1
      WHERE role_code = 'xom_ombor'
        AND worker_id = (SELECT id FROM workers WHERE name = 'Sinov kirim stul')`,
    [stulShop]);
  const stul = H.api(base, await H.sessionFor('Sinov kirim stul'));
  assert.equal((await stul('POST', '/api/materials/receipts', {
    supplier_id: tam, warehouse_id: wh,
    items: [{ material_id: m.id, qty: 5, price: 20 }] })).status, 400,
    'doirasi bor xodimga zavod ombori ko\'rinmaydi');

  //  Tsex boshlig'ida `materials.manage` yo'q: u sarfni yozadi, mol
  //  qabul qilishni emas.
  const usta = await xodim('Sinov kirim usta', 'tsex_usta');
  assert.equal((await usta('POST', '/api/materials/receipts', {
    supplier_id: tam, warehouse_id: wh,
    items: [{ material_id: m.id, qty: 5, price: 20 }] })).status, 403);
});

test('buyurtmalar: tab yonidagi jami summa ro\'yxat bilan bir xil', async () => {
  //  ★ TAB BO'YICHA JAMI SUMMA (zavod qarori, 2026-09). Qatorda summa
  //  ilgari ham bor edi, lekin menejerning savoli boshqa: «bu tabda
  //  jami qancha pul turibdi».
  //
  //  ★ RAQAM RO'YXAT BILAN BIR XIL BO'LISHI SHART — menyudagi navbat
  //  belgisi bilan AYNAN bir xil qoida va shu sababdan test ham bir
  //  xil: yig'indi RO'YXATNING o'zidan qayta hisoblanadi. Ikki joyda
  //  yozilgan shart bir kun ajralib ketardi: chipda bitta raqam,
  //  jadvalda boshqasi.
  assert.equal((await admin('POST', '/api/units/customers',
    { items: [{ name: 'Sinov jami mijoz' }] })).status, 200);
  const mijoz = (await H.id(
    `SELECT id FROM customers WHERE name = 'Sinov jami mijoz'`)).id;
  const prod = (await H.id(
    `SELECT id FROM products WHERE active ORDER BY id LIMIT 1`)).id;

  //  Narxi yozilgan ikkita qator: 3 × 150 + 2 × 100 = 650 $.
  const z = await admin('POST', '/api/sales/orders', {
    customer_id: mijoz,
    items: [{ product_id: prod, qty: 3, unit_price: 150 },
            { product_id: prod, qty: 2, unit_price: 100 }] });
  assert.equal(z.status, 200, z.text);

  const javob = (await admin('GET', '/api/sales/orders')).body;
  assert.ok(Array.isArray(javob.jami), 'jami serverdan keladi');

  const yangi = javob.rows.find((o) => o.id === z.body.id);
  assert.ok(yangi, 'buyurtma ro\'yxatda');
  assert.equal(Number(yangi.amount), 650, 'qatordagi summa');

  //  Konver biriktirilmagan, ya'ni buyurtma «Boshlanmagan» tabida.
  assert.equal(yangi.holat, 'draft');

  //  Chipdagi raqam RO'YXATDAN qayta hisoblanganiga teng bo'lishi
  //  kerak. Ro'yxat 500 qator bilan cheklangan, shuning uchun
  //  taqqoslash FAQAT shu holat bo'yicha va ro'yxat to'lmaganda
  //  ma'noga ega — sinov bazasida u har doim shunday.
  const chip = javob.jami.find((x) => x.holat === 'draft');
  assert.ok(chip, '«Boshlanmagan» tabining yig\'indisi bor');
  const royxatdan = javob.rows.filter((o) => o.holat === 'draft')
    .reduce((a, o) => a + Number(o.amount || 0), 0);
  assert.equal(Number(chip.amount), royxatdan,
    'chipdagi summa ro\'yxatdagining yig\'indisiga teng');
  assert.equal(chip.orders,
    javob.rows.filter((o) => o.holat === 'draft').length);

  //  ★ YIG'INDI HOLAT FILTRIDAN QAT'I NAZAR keladi: tab tanlangan
  //  bo'lsa ham qolgan tablarning raqami turishi kerak, aks holda
  //  menejer «chiqib ketganida qancha» degan javobni olish uchun
  //  tabni bosib ko'rishi kerak bo'lardi (ombor tarixidagi
  //  kirim/chiqim filtri bilan bir xil qoida).
  const faqatDraft = (await admin('GET', '/api/sales/orders?status=draft')).body;
  assert.ok(faqatDraft.rows.every((o) => o.holat === 'draft'), 'ro\'yxat qisqardi');
  assert.deepEqual(
    faqatDraft.jami.map((x) => x.holat).sort(),
    javob.jami.map((x) => x.holat).sort(),
    'yig\'indi esa hamma tab uchun keladi');

  //  Mijoz qidiruvi esa yig'indiga TA'SIR QILADI: «shu mijozga
  //  qancha» degan savolga javob kerak, butun savdo aylanmasi emas.
  const bittaMijoz = (await admin(
    'GET', '/api/sales/orders?q=Sinov jami mijoz')).body;
  assert.equal(Number(bittaMijoz.jami.find((x) => x.holat === 'draft').amount), 650);

  //  ★ «HAMMASI» DAGI SUMMA — FAQAT ZAVODDA TURGANI (zavod qarori,
  //  2026-09). Server har holatni ALOHIDA beradi, sahifa esa to'rttasini
  //  qo'shadi: boshlanmagan + ishlab chiqarilmoqda + tayyor + mijozga
  //  chiqarilsin. Chiqib ketgani o'tgan savdo (puli allaqachon
  //  mijozning qarzida), bekor qilingani esa umuman yo'q — ikkalasi
  //  qo'shilsa raqam har oy o'sib borardi va «hozir qancha pullik
  //  buyurtma turibdi» degan savolga hech qachon javob bermasdi.
  //
  //  Ikkala holat ham javobda O'Z qatori bilan qolishi shart: sahifa
  //  ularni chipda alohida ko'rsatadi va server ularni tashlab yuborsa
  //  «chiqib ketganida qancha» degan javob yo'qolardi.
  const holatlar = javob.jami.map((x) => x.holat);
  for (const h of ['draft', 'waiting', 'reserved', 'to_ship',
                   'shipped', 'cancelled']) {
    const bor = javob.rows.some((o) => o.holat === h);
    if (bor) assert.ok(holatlar.includes(h), h + ' yig\'indisi keladi');
  }
});

test("konver so'rovini kim yozishi XODIMDA belgilanadi", async () => {
  //  ★ BELGI XODIMDA, ROLDA EMAS (zavod qarori, 2026-09). Stol va
  //  stul so'rovini endi SAVDO yozadi, ya'ni o'sha tsexning
  //  boshlig'iga «Konver qo'shish» sahifasi ortiqcha bo'lib qoldi —
  //  korpus boshlig'iga esa kerak. Rol buni ajrata olmaydi: ikkalasi
  //  ham `tsex_usta` va rol huquqlari KODDA turadi.
  const { db } = require('../db');
  const yozadi = await xodim('Sinov sorov yozadi', 'tsex_usta');
  const yozmaydi = await xodim('Sinov sorov yozmaydi', 'tsex_usta');

  //  Standarti — YOZADI: hech kimning ekrani o'zidan-o'zi
  //  o'zgarmaydi va so'rov yozadigan odam qolmay ish to'xtamaydi.
  assert.ok((await yozadi('GET', '/api/auth/me')).body.permissions
    .includes('production.request'), 'standarti — yozadi');

  const id = (await H.id(
    `SELECT id FROM workers WHERE name = 'Sinov sorov yozmaydi'`)).id;
  assert.equal((await admin('PATCH', '/api/admin/workers/' + id,
    { can_request_unit: false })).status, 200);

  //  Belgi olib tashlansa `production.request` UMUMAN o'qilmaydi:
  //  menyudagi havola ham, sahifa ham, API ham BIR VAQTDA yopiladi.
  //  Har sahifaga alohida tekshiruv yozilsa ertaga qo'shilgani
  //  unutilardi (`sees_warehouse` bilan bir xil qoida).
  const yoq = H.api(base, await H.sessionFor('Sinov sorov yozmaydi'));
  const sess = (await yoq('GET', '/api/auth/me')).body;
  assert.ok(!sess.permissions.includes('production.request'),
    'huquq umuman o\'qilmaydi');
  assert.equal(sess.can_request_unit, false);

  //  Tekshiruv SERVERDA: sahifani chetlab so'rov yuborsa ham 403.
  const prod = (await H.id(
    `SELECT p.id FROM products p JOIN product_groups g ON g.id = p.group_id
      WHERE p.active AND NOT COALESCE(g.sales_can_request, false)
      ORDER BY p.id LIMIT 1`)).id;
  assert.equal((await yoq('POST', '/api/units/requests',
    { items: [{ product_id: prod, qty: 2 }] })).status, 403);

  //  Belgisi turgan boshliqda esa yo'l ochiq qolaveradi.
  assert.ok((await yozadi('GET', '/api/units/requests')).status === 200);

  //  ★ FAQAT SHU HUQUQ olib tashlanadi: `production.approve` yoki
  //  `sales.manage` bor odamda sahifa o'sha huquqlar bilan ochiq
  //  qolaveradi — belgi ularga tegmaydi. Aks holda direktorning
  //  katagi belgilanmagani uchun tasdiqlash ham yopilib qolardi.
  await db.query(
    `UPDATE workers SET can_request_unit = false WHERE name = 'Administrator'`);
  const a = (await admin('GET', '/api/auth/me')).body;
  assert.ok(!a.permissions.includes('production.request'));
  assert.ok(a.permissions.includes('production.approve'),
    'tasdiqlash huquqiga tegilmaydi');
  await db.query(
    `UPDATE workers SET can_request_unit = true WHERE name = 'Administrator'`);
});

//  ★ NOMI BO'SHLIQ BILAN KELGAN O'ZGARUVCHI (izoh: `erp/env.js`).
//  Railway sozlamasiga nom yopishtirilganda oxirida probel qolib
//  ketgan edi va zaxira Telegramga ketmay qolgandi: ekranda ikkala
//  nom bir xil ko'rinadi, kod esa tozasini o'qiydi.
test("o'zgaruvchi nomidagi ortiqcha bo'shliq o'qiladi", () => {
  const tozala = require('../env');
  const eski = { ...process.env };
  try {
    process.env['ZELTA_SINOV '] = 'bor';
    delete process.env.ZELTA_SINOV;
    //  Bo'shini to'ldiradi.
    assert.deepEqual(tozala(() => {}), ['ZELTA_SINOV']);
    assert.equal(process.env.ZELTA_SINOV, 'bor');

    //  ★ TO'LDIRILGANI USTUN: ataylab qo'yilgan qiymat tasodifiy
    //  nusxa bilan almashtirilmaydi.
    process.env.ZELTA_SINOV2 = 'asl';
    process.env['ZELTA_SINOV2 '] = 'nusxa';
    assert.deepEqual(tozala(() => {}), []);
    assert.equal(process.env.ZELTA_SINOV2, 'asl');
  } finally {
    for (const k of Object.keys(process.env))
      if (!(k in eski)) delete process.env[k];
  }
});

//  ★ XOM ASHYOSIZ BO'LIMDAN O'TKAZILMAYDI (zavod qarori, 2026-09).
//  Konver ketgandan keyin o'sha bo'limda nima sarflangani BOSHQA
//  hech qachon yozilmaydi: usta keyingi ishga o'tadi va kecha nima
//  ishlatilgani esida qolmaydi. Tannarx esa aynan shu yozuvlardan
//  yig'iladi.
test("xom ashyosiz bo'limdan o'tkazilmaydi", async () => {
  const { db } = require('../db');
  const u = await newUnit();          //  Arra — `needs_material` belgili
  const arra = (await H.id(`SELECT id FROM sections WHERE code='KOR-ARRA'`)).id;

  //  Belgisiz bo'limda tekshiruv YO'Q: yig'ish ba'zan qo'l mehnati va
  //  usta har konverda bir xil javobni qaytarib yurmasin.
  assert.equal((await H.id(
    `SELECT needs_material::text AS id FROM sections WHERE id=$1`, [arra])).id,
    'true');

  const rad = await korpus('POST', '/api/units/move', { items: [{ unit_id: u.id }] });
  assert.equal(rad.status, 400, rad.text);
  assert.match(rad.body.error, /xom ashyo biriktirilmagan/);
  //  ★ SAHIFA BELGIGA QARAB TUGMA CHIZADI, matnni o'qib emas: matn
  //  ertaga o'zgarsa tugma jimgina yo'qolardi.
  assert.equal(rad.body.code, 'xom-ashyo-yoq');
  assert.equal(rad.body.section_id, arra);

  //  ★ «BU BO'LIMDA BIRIKTIRILMAYDI» — ikkinchi yo'l, va u YOZUV
  //  bo'lib qoladi: kim va qachon aytgani ko'rinib turadi.
  assert.equal((await korpus('POST', `/api/units/${u.id}/no-material`)).status, 200);
  assert.equal((await H.id(
    `SELECT worker_id AS id FROM unit_no_material
      WHERE unit_id = $1 AND section_id = $2`, [u.id, arra])).id != null, true);
  assert.equal((await korpus('POST', '/api/units/move',
    { items: [{ unit_id: u.id }] })).status, 200, 'belgidan keyin o\'tadi');

  //  ★ MATERIAL YOZILGAN BO'LIM ham o'tkazadi — belgisiz.
  const u2 = await newUnit();
  await db.query(
    `INSERT INTO material_moves (material_id, qty, from_kind, from_id,
                                 to_kind, to_id, moved_on, section_id)
     SELECT (SELECT id FROM materials ORDER BY id LIMIT 1), 1,
            'warehouse', (SELECT id FROM warehouses WHERE code='TSEX-KOR-ARRA'),
            'unit', $1, CURRENT_DATE, $2`, [u2.id, arra]);
  assert.equal((await korpus('POST', '/api/units/move',
    { items: [{ unit_id: u2.id }] })).status, 200, 'sarf yozilgan — o\'tadi');

  //  Doira CHEGARA: boshqa tsexning konveriga belgi qo'yilmaydi.
  const u3 = await newUnit();
  const stulUsta = H.api(base, await H.sessionFor('Stul ustasi'));
  assert.equal((await stulUsta('POST', `/api/units/${u3.id}/no-material`)).status, 403);

  //  ★ SAVOL BIR YO'LA BERILADI (zavod qarori, 2026-09). Ilgari xato
  //  BIRINCHI konverda to'xtardi: usta «bu bo'limda biriktirilmaydi» ni
  //  bosardi, belgi bittasiga tushardi va o'tkazish yana to'xtardi —
  //  endi ikkinchisida. Yigirmata tanlanganda bu yigirma bosish va har
  //  safar AYNAN bir xil ko'rinadigan oyna bo'lardi.
  const a = await newUnit();
  const b = await newUnit();
  const c = await newUnit();
  const kop = await korpus('POST', '/api/units/move',
    { items: [{ unit_id: a.id }, { unit_id: b.id }, { unit_id: c.id }] });
  assert.equal(kop.status, 400, kop.text);
  assert.equal(kop.body.code, 'xom-ashyo-yoq');
  assert.deepEqual(kop.body.units.map((x) => x.id).sort(), [a.id, b.id, c.id].sort(),
    'hammasi qaytadi, birinchisi emas');
  for (const x of kop.body.units) {
    assert.ok(x.conveyor_no, 'raqami bilan');
    assert.equal(x.section_id, arra);
  }

  //  Bitta bosish hammasiga belgi qo'yadi va o'tkazish o'tadi.
  const belgi = await korpus('POST', '/api/units/no-material',
    { items: [a.id, b.id, c.id] });
  assert.equal(belgi.status, 200, belgi.text);
  assert.equal((await korpus('POST', '/api/units/move',
    { items: [{ unit_id: a.id }, { unit_id: b.id }, { unit_id: c.id }] })).status, 200,
    'belgidan keyin uchalasi ham o\'tadi');

  //  ★ SARF PAYTIDAGI DONA SONI YOZILADI (`material_moves.unit_qty`).
  //  12 talikdan 4 tasi Zborkaga ketib, o'sha to'rttasiga lak sepilsa,
  //  lak AYNAN to'rttasiniki — Shkurkada qolgan sakkiztasi uni
  //  ko'rmagan. Qatorning `qty` si keyin bo'linib yoki birlashib
  //  o'zgaradi, ya'ni donani keyin hisoblab bo'lmaydi.
  const dona = await newUnit({ qty: 12 });
  const sarf = await korpus('POST', `/api/materials/unit/${dona.id}/consume`,
    { items: [{ material_id: (await H.id(
        `SELECT id FROM materials ORDER BY id LIMIT 1`)).id, qty: 3 }] });
  assert.equal(sarf.status, 200, sarf.text);
  assert.equal((await H.id(
    `SELECT unit_qty::text AS id FROM material_moves
      WHERE to_kind = 'unit' AND to_id = $1`, [dona.id])).id, '12');

  //  Konver bo'lingandan keyin ham yozilgan raqam O'ZGARMAYDI: u
  //  o'sha kunning haqiqati.
  assert.equal((await korpus('POST', '/api/units/move',
    { items: [{ unit_id: dona.id, qty: 4 }] })).status, 200);
  assert.equal((await H.id(
    `SELECT qty::text AS id FROM production_units WHERE id = $1`, [dona.id])).id, '8');
  assert.equal((await H.id(
    `SELECT unit_qty::text AS id FROM material_moves
      WHERE to_kind = 'unit' AND to_id = $1`, [dona.id])).id, '12');

  //  Doira to'dalab yuborilganda ham CHEGARA, va bittasi yiqilsa HECH
  //  NARSA yozilmaydi: yarim belgi qo'yilgan to'da keyin qaysi biri
  //  belgilanganini aytmasdi.
  const d = await newUnit();
  assert.equal((await stulUsta('POST', '/api/units/no-material',
    { items: [d.id] })).status, 403);
});

//  ★ BUYURTMALAR RO'YXATI SARALANADI — SERVERDA (zavod qarori,
//  2026-09). Ro'yxat 500 qator bilan cheklangan, ya'ni klientda
//  tartiblash faqat ko'rinib turganini saralardi va «eng katta
//  summa» degan savolga 501-buyurtmani hisobga olmagan javob
//  berardi.
test("buyurtmalar ro'yxati saralanadi", async () => {
  const roy = (yol) => sotuvchi('GET', '/api/sales/orders' + yol);

  const kamayib = (await roy('?sort=amount&dir=desc')).body.rows
    .map((r) => Number(r.amount) || 0);
  const osib = (await roy('?sort=amount&dir=asc')).body.rows
    .map((r) => Number(r.amount) || 0);
  assert.deepEqual(kamayib, [...kamayib].sort((a, b) => b - a), 'kattadan kichikka');
  assert.deepEqual(osib, [...osib].sort((a, b) => a - b), 'kichikdan kattaga');

  //  ★ USTUNLAR RO'YXATI YOPIQ: tashqaridan kelgan nom SQL ga yetib
  //  bormaydi — noma'lum ustun standartga tushadi, xato bermaydi.
  const yomon = await roy("?sort=o.id;DROP TABLE orders--&dir=desc");
  assert.equal(yomon.status, 200);
  const odatiy = await roy('');
  assert.deepEqual(yomon.body.rows.map((r) => r.id),
    odatiy.body.rows.map((r) => r.id), 'noma\'lum ustun — standart tartib');

  //  ★ BO'SH KATAK HAR DOIM OXIRIDA, yo'nalishdan qat'i nazar:
  //  chiqish sanasi yozilmagan buyurtmalar tepaga chiqsa javob
  //  ko'rinmasdi (ombor qoldig'i bilan bir xil qoida).
  for (const yon of ['asc', 'desc']) {
    const sanalar = (await roy('?sort=due_on&dir=' + yon)).body.rows
      .map((r) => r.due_on);
    const birinchiBosh = sanalar.findIndex((d) => d == null);
    if (birinchiBosh >= 0)
      assert.ok(sanalar.slice(birinchiBosh).every((d) => d == null),
        `bo'sh katak oxirida (${yon})`);
  }
});

//  ★ ISHLAB CHIQARISH PANELI: CHIQARILGAN MAHSULOT TSEXDAN
//  CHIQQANDA SANALADI, bo'limdan o'tganda emas (zavod qarori).
//  Bo'lim bo'yicha sanalsa bitta konver o'n to'qqiz marta «ishlab
//  chiqarilgan» bo'lib qo'shilardi. Qoida tsex ekranidagi `oy` bilan
//  AYNAN bir xil manbadan — ikki joyda yozilsa boshliqning ekrani
//  direktornikidan farq qilardi.
test('ishlab chiqarish paneli: chiqarilgan tsexdan chiqqanda sanaladi', async () => {
  const panel = async () => (await admin('GET',
    '/api/units/dashboard?from=' + kun(-30) + '&to=' + kun(1))).body;
  const jamiOf = (d) => d.oylar.reduce((a, r) => a + (Number(r.qty) || 0), 0);

  const oldin = jamiOf(await panel());
  const u = await newUnit();          //  Korpus tsexi, Arra

  //  TSEX ICHIDAGI harakat sanalmaydi: mahsulot zavoddan chiqmadi.
  await xomsiz();
  assert.equal((await korpus('POST', '/api/units/move',
    { items: [{ unit_id: u.id }] })).status, 200);
  assert.equal(jamiOf(await panel()), oldin,
    'tsex ichidagi harakat sanalmaydi');

  //  Bo'lim ham, konver ham ekranda turadi — bu BUGUNGI holat va
  //  oraliqqa bog'liq emas.
  const d = await panel();
  assert.ok(Number(d.wip.yolda) >= 1, 'yo\'lda turgani sanaladi');
  assert.ok(d.bolimlar.some((b) => Number(b.qty) > 0),
    'bo\'limlar navbati to\'ladi');
});

//  ★ KPI: OYLIK REJA VA FAKT. Panel «qancha qildik» degan savolga
//  javob beradi, lekin 76 ming dollar ko'pmi yoki ozmi — buni faqat
//  REJA bilan solishtirganda bilinadi.
test('KPI: reja qo\'yiladi, fakt o\'sha view\'lardan chiqadi', async () => {
  const yil = new Date().getFullYear();
  const oy = `${yil}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;

  const boshi = (await admin('GET', '/api/kpi?year=' + yil)).body;
  assert.equal(boshi.year, yil);
  assert.ok(boshi.bolimlar.some((b) => b.code === 'sales'));
  assert.equal(boshi.yozadi, true, 'administrator reja qo\'yadi');

  //  Reja saqlanadi va o'qilganda qaytadi.
  assert.equal((await admin('POST', '/api/kpi',
    { bolim: 'sales', metric: 'chiqdi', mon: oy, target: 1234 })).status, 200);
  const keyin = (await admin('GET', '/api/kpi?year=' + yil)).body;
  const r = keyin.reja.find((x) => x.bolim === 'sales' && x.metric === 'chiqdi'
                                && x.mon === oy);
  assert.equal(Number(r.target), 1234);

  //  ★ BITTA OYGA BITTA REJA: ikkinchisi USTIGA yoziladi, ikkinchi
  //  qator yaratilmaydi — qaysi biri haqiqiy ekani noaniq qolardi.
  assert.equal((await admin('POST', '/api/kpi',
    { bolim: 'sales', metric: 'chiqdi', mon: oy, target: 2000 })).status, 200);
  const ikki = (await admin('GET', '/api/kpi?year=' + yil)).body.reja
    .filter((x) => x.bolim === 'sales' && x.metric === 'chiqdi' && x.mon === oy);
  assert.equal(ikki.length, 1);
  assert.equal(Number(ikki[0].target), 2000);

  //  Bo'sh yuborilgani «tegma» emas, «yo'q» degani.
  assert.equal((await admin('POST', '/api/kpi',
    { bolim: 'sales', metric: 'chiqdi', mon: oy, target: '' })).status, 200);
  assert.equal((await admin('GET', '/api/kpi?year=' + yil)).body.reja
    .filter((x) => x.bolim === 'sales' && x.metric === 'chiqdi'
                && x.mon === oy).length, 0);

  //  Noma'lum bo'lim va ko'rsatkich qabul qilinmaydi: ro'yxat KODDA
  //  va tashqaridan kelgan nom bazaga yetib bormaydi.
  assert.equal((await admin('POST', '/api/kpi',
    { bolim: 'yoq', metric: 'chiqdi', mon: oy, target: 1 })).status, 400);
  assert.equal((await admin('POST', '/api/kpi',
    { bolim: 'sales', metric: 'yoq', mon: oy, target: 1 })).status, 400);

  //  ★ HUQUQI YO'Q BO'LIMNING REJASI HAM KO'RINMAYDI — u boshqa
  //  odamning raqami. Tsex ustasida savdo ham, moliya ham yo'q.
  const usta = (await korpus('GET', '/api/kpi?year=' + yil));
  if (usta.status === 200)
    assert.ok(!usta.body.bolimlar.some((b) => b.code === 'cash'),
      'tsex ustasiga moliya ko\'rinmaydi');
  assert.equal((await korpus('POST', '/api/kpi',
    { bolim: 'sales', metric: 'chiqdi', mon: oy, target: 1 })).status, 403);
});

//  ★ TO'RTALA PANEL HAM OCHILADI, doirasi bor xodimda ham (zavod
//  qarori, 2026-09). Panel bosh sahifada turadi, ya'ni har kirgan odam
//  uni birinchi bo'lib ochadi — bitta yiqilgan so'rov butun ekranni
//  bo'sh qoldirardi. Doira alohida tekshiriladi: menejerda
//  `channelsOf` va `ownOf` NULL emas, ya'ni so'rovga boshqa
//  parametrlar tushadi va shart boshqa shoxdan o'tadi.
test('to\'rtala panel ham ochiladi — doirasi bor xodimda ham', async () => {
  //  Bosh sahifa qaysi manzilni chaqirsa, test ham O'SHANI chaqiradi
  //  (`erp/public/index.html`, `BLOK`) — `?from=` bilan kelgan so'rov
  //  boshqa shoxdan o'tadi va bitta yiqilgani butun ekranni bo'sh
  //  qoldirardi.
  const oyBoshi = new Date().toISOString().slice(0, 8) + '01';
  const YOL = ['/api/sales/dashboard?from=' + oyBoshi,
               '/api/units/dashboard?from=' + oyBoshi,
               '/api/cash/dashboard', '/api/warehouse/dashboard',
               '/api/materials/dashboard'];
  for (const y of YOL) {
    const r = await admin('GET', y);
    assert.equal(r.status, 200, y + ' — ' + r.text);
    assert.ok(r.body && typeof r.body === 'object', y + ' javob bermadi');
  }

  //  Doirasi bor savdo menejeri: paneli o'ziniki bo'lib ochiladi.
  const { db } = require('../db');
  await db.query(`INSERT INTO workers (name) VALUES ('Panel menejer')
                  ON CONFLICT DO NOTHING`);
  await db.query(
    `INSERT INTO worker_roles (worker_id, role_code, scope_own, scope_channel)
     SELECT id, 'sotuvchi', true, (SELECT code FROM customer_channels LIMIT 1)
       FROM workers WHERE name = 'Panel menejer'
     ON CONFLICT (worker_id, role_code) DO UPDATE
        SET scope_own = true, scope_channel = EXCLUDED.scope_channel`);
  const mng = H.api(base, await H.sessionFor('Panel menejer'));
  const r = await mng('GET', '/api/sales/dashboard');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.ozi, true, 'doirasi bor xodimda menejerlar bloki chizilmaydi');
});

//  ★ KUNLIK XABARLAR — JADVALDAN YUBORILADI (zavod qarori, 2026-09).
//
//  To'rttasi ham `erp/server.js` dagi BITTA jadvaldan chaqiriladi
//  (`KUNLIK`), lekin matnni va kimga borishini modulning O'ZI hal
//  qiladi. Test aynan o'sha funksiyalarni chaqiradi: jadvalni kutib
//  o'tirish testni soatga bog'lab qo'yardi.
test('kunlik xabarlar: menejer qarzi, rahbariyat xulosasi, muddat', async () => {
  const { db } = require('../db');
  const sales = require('../modules/sales');
  const units = require('../modules/units');
  const cash  = require('../modules/cash');

  const belgi = async () => Number((await H.id(
    `SELECT COALESCE(MAX(id), 0)::int AS n FROM notifications`)).n);
  const yangi = async (dan, t) => (await db.query(
    `SELECT n.worker_id, n.title, n.body, w.name
       FROM notifications n LEFT JOIN workers w ON w.id = n.worker_id
      WHERE n.id > $1 AND n.title LIKE $2 ORDER BY n.id`, [dan, t])).rows;

  //  ── 1. MENEJERGA FAQAT O'Z MIJOZLARINING QARZI ──────────────────
  //
  //  Doira so'rovning O'ZIDAN chiqadi (`customers.manager_id`):
  //  xabarning «foydalanuvchisi» yo'q, u jadvaldan yuboriladi va
  //  `ownOf` ni o'qiy olmaydi. Egasi yo'q mijoz hech kimga
  //  yozilmaydi — u hech kimniki emas.
  const mgr = (await H.id(`SELECT id FROM workers WHERE name='Sinov sotuvchi'`)).id;
  await db.query(
    `INSERT INTO customers (name, manager_id, opening_debt, opening_debt_on)
     VALUES ('Qarzli mijoz', $1, 1500, CURRENT_DATE)
     ON CONFLICT (lower(name)) DO UPDATE
        SET manager_id = $1, opening_debt = 1500`, [mgr]);
  await db.query(
    `INSERT INTO customers (name, opening_debt, opening_debt_on)
     VALUES ('Egasiz qarzli', 900, CURRENT_DATE)
     ON CONFLICT (lower(name)) DO UPDATE SET opening_debt = 900, manager_id = NULL`);

  const b1 = await belgi();
  assert.ok(await sales.qarzYubor() > 0, 'menejerga xabar yozildi');
  const x1 = await yangi(b1, 'Mijozlaringiz saldosi%');
  const meniki = x1.find((r) => r.worker_id === mgr);
  assert.ok(meniki, 'o\'sha menejerga yozildi');
  assert.match(meniki.body, /Qarzli mijoz/, 'o\'z mijozi turadi');
  assert.ok(!meniki.body.includes('Egasiz qarzli'),
    'egasi yo\'q mijoz hech kimga yozilmaydi');
  for (const r of x1)
    assert.ok(!r.body.includes('Egasiz qarzli'), `${r.name}: egasiz mijoz`);

  //  ── 2. RAHBARIYAT XULOSASI — belgisi bor xodimga ────────────────
  //
  //  Belgi XODIMDA (`daily_digest`), rolda emas: xulosada butun
  //  zavodning puli turadi va uni kim o'qishini zavod o'zi hal
  //  qiladi (4-qoida). Belgisiz xodimga xabar UMUMAN yozilmaydi.
  const notify = require('../notify');
  await db.query(`UPDATE workers SET daily_digest = false`);
  const b2 = await belgi();
  for (const x of [await require('../modules/materials').saldoXabari(),
                   await sales.mijozSaldoXabari(),
                   await cash.kassaXabari(),
                   await sales.chiqishXabari()]) {
    if (!x) continue;
    assert.equal(await notify.queueDigest(
      { module: 'sales', title: x.title, body: x.body }), 0,
      `${x.title}: belgisiz xodimga yozilmaydi`);
  }
  assert.equal((await yangi(b2, '%')).length, 0, 'hech narsa yozilmadi');

  const dir = (await H.id(`SELECT id FROM workers WHERE name='Administrator'`)).id;
  await db.query(`UPDATE workers SET daily_digest = true WHERE id = $1`, [dir]);
  const b3 = await belgi();
  const xulosa = [await sales.mijozSaldoXabari(), await cash.kassaXabari(),
                  await sales.chiqishXabari()];
  for (const x of xulosa) {
    assert.ok(x, 'xulosa matni bo\'sh emas');
    await notify.queueDigest({ module: 'sales', title: x.title, body: x.body });
  }
  const x3 = await yangi(b3, '%');
  assert.equal(x3.length, 3, 'uchala xabar ham yozildi');
  for (const r of x3) assert.equal(r.worker_id, dir, 'faqat belgisi borga');
  assert.match(x3.find((r) => /^Kassa/.test(r.title)).body,
    /Xodimlar qo'lida/, 'kassa xulosasida xodimlar qo\'lidagi pul ham');
  assert.match(x3.find((r) => /^Kunlik chiqish/.test(r.title)).body,
    /Chiqishni kutmoqda/, 'chiqish xulosasida kutayotgani');

  //  ── 3. «ERTAGA TOPSHIRILADI» ────────────────────────────────────
  //
  //  Sana `v_unit_register` dan: fakt → boshliq qo'ygan reja →
  //  marshrut. Test rejani QO'LDA qo'yadi (`next_shop_planned_on`),
  //  ya'ni formulaning o'zini emas, XABARNI tekshiradi — formulaning
  //  o'z testlari bor.
  //
  //  «Ertaga» — ertangi ISH kuni: yakshanba tashlanadi va shanba kuni
  //  yuborilgan xabar dushanbanikidir. Hisob `ish_kuni()` da, bitta
  //  joyda — test ham o'shandan o'qiydi, nusxasini yozmaydi.
  const um = await newUnit({ section_id: SHKUR });
  await db.query(
    `UPDATE production_units SET next_shop_planned_on = ish_kuni(CURRENT_DATE, 1)
      WHERE id = $1`, [um.id]);
  const b4 = await belgi();
  assert.ok(await units.muddatYubor() > 0, 'muddat xabari yozildi');
  const x4 = await yangi(b4, 'Ertaga topshiriladi%');
  assert.ok(x4.length, 'xabar bor');
  const qator = x4.map((r) => r.body).join('\n');
  assert.match(qator, new RegExp(um.conveyor_no), 'konver raqami');
  assert.match(qator, /→ /, 'qayerga topshirilishi ham yozilgan');
  //  Konverning EGASI bo'lgan tsexga — jo'natish xabari bilan aynan
  //  bir xil doira.
  const ismlar4 = x4.map((r) => r.name);
  assert.ok(ismlar4.includes('Korpus ustasi'),
    `korpus boshlig'iga: ${ismlar4.join(', ')}`);
  assert.ok(!ismlar4.includes('Administrator'), 'doirasi yo\'q xodimga emas');
});

//  ★ «BUYURTMA TAYYOR» — OXIRGI KONVER OMBORGA TUSHGANDA.
//
//  Shart RO'YXATNIKI (`HOLAT = 'reserved'`) va xabar BIR MARTA ketadi:
//  konver ombordan qaytarilib qaytadan qabul qilinsa buyurtma
//  ikkinchi marta «tayyor» bo'lardi.
test('buyurtma tayyor bo\'lganda menejerga bir marta xabar ketadi', async () => {
  const { db } = require('../db');
  const belgi = async () => Number((await H.id(
    `SELECT COALESCE(MAX(id), 0)::int AS n FROM notifications`)).n);

  const mgr = (await H.id(`SELECT id FROM workers WHERE name='Sinov sotuvchi'`)).id;
  const mij = (await admin('POST', '/api/units/customers',
    { name: 'Tayyor xabar mijozi' })).body;

  const z = await admin('POST', '/api/sales/orders', {
    customer_id: mij.id, manager_id: mgr,
    items: [{ product_id: PENAL, qty: 2, unit_price: 100 }] });
  assert.equal(z.status, 200, z.text);
  const qator = (await admin('GET', '/api/sales/orders/' + z.body.id)).body.items[0];

  //  Konver qadoqlashda turadi, jo'natiladi va omborga qabul
  //  qilinadi — xabar aynan QABUL QILISH paytida yoziladi.
  //  Konver CHIQISH bo'limida YARATILMAYDI: `createOne` chiqish
  //  bo'limidagi konverni o'sha zahoti `fg` qilib qo'yadi (boshlang'ich
  //  qoldiq yo'li) va qabul qilish hodisasi umuman bo'lmasdi. Shuning
  //  uchun oldingi bo'limdan boshlanadi va marshrut bo'ylab yuradi.
  const QADOYNA2 = (await H.id(`SELECT id FROM sections WHERE code='QAD-OYNA'`)).id;
  const u = await newUnit({ section_id: QADOYNA2, qty: 2 });
  const bron = await admin('POST', '/api/sales/orders/' + z.body.id + '/assign',
    { item_id: qator.id, unit_id: u.id, qty: 2 });
  assert.equal(bron.status, 200, bron.text);
  const qad = H.api(base, await H.sessionFor('Qadoqlash ustasi'));
  await xomsiz();
  assert.equal((await qad('POST', '/api/units/move',
    { items: [{ unit_id: u.id }] })).status, 200);
  assert.equal((await qad('POST', '/api/units/handover',
    { items: [u.id] })).status, 200);

  const b1 = await belgi();
  const qab = await admin('POST', '/api/units/stock/accept', { items: [u.id] });
  assert.equal(qab.status, 200, qab.text);
  const x1 = (await db.query(
    `SELECT worker_id, title, body FROM notifications
      WHERE id > $1 AND title LIKE 'Buyurtma tayyor%'`, [b1])).rows;
  assert.equal(x1.length, 1, 'bitta xabar');
  assert.equal(x1[0].worker_id, mgr, 'buyurtmaning menejeriga');
  assert.match(x1[0].title, new RegExp(z.body.order_no), 'zakaz raqami sarlavhada');
  assert.match(x1[0].body, /Tayyor xabar mijozi/, 'mijoz nomi');

  //  ★ IKKINCHI MARTA YOZILMAYDI: ombordan qaytarilib, qaytadan
  //  qabul qilinsa buyurtma yana «tayyor» bo'ladi — bir marta
  //  aytilgan gap takrorlansa ko'z unga o'rganib qoladi.
  assert.equal((await admin('POST', '/api/units/stock/accept',
    { items: [u.id], undo: true })).status, 200);
  const b2 = await belgi();
  assert.equal((await admin('POST', '/api/units/stock/accept',
    { items: [u.id] })).status, 200);
  assert.equal((await db.query(
    `SELECT COUNT(*)::int AS n FROM notifications
      WHERE id > $1 AND title LIKE 'Buyurtma tayyor%'`, [b2])).rows[0].n, 0,
    'ikkinchi marta yozilmaydi');
});

//  ★ KIMGA QAYSI XABAR BORADI — XODIMDA (zavod qarori, 2026-09).
//
//  Xabar huquq bo'yicha boradi, ADMINISTRATORDA esa barcha huquq bor:
//  unga zavodning hamma xabari kelardi — talabnoma ham, xarid
//  zayavkasi ham, T/M omborga qabul ham. Huquq bilan tuzatib
//  bo'lmaydi (huquqlar kodda turadi), shuning uchun belgi xodimda.
//
//  Ro'yxat «O'CHIRILGANLAR» niki: qator yo'q = HAMMASI keladi —
//  deploy kuni hech kimning xabari jimgina yo'qolmaydi va ertaga
//  yangi tur qo'shilsa u o'zi keladi.
test('xodim qaysi Telegram xabarini olishi kartochkadan qo\'yiladi', async () => {
  const { db } = require('../db');
  const notify = require('../notify');
  const belgi = async () => Number((await H.id(
    `SELECT COALESCE(MAX(id), 0)::int AS n FROM notifications`)).n);
  const sanoq = async (dan, tur) => Number((await H.id(
    `SELECT COUNT(*)::int AS n FROM notifications
      WHERE id > $1 AND kind = $2`, [dan, tur])).n);

  const admId = (await H.id(`SELECT id FROM workers WHERE name='Administrator'`)).id;
  await db.query(`DELETE FROM worker_notify_off WHERE worker_id = $1`, [admId]);

  //  ── Qator yo'q = keladi.
  const b1 = await belgi();
  await notify.queue({ worker_id: admId, module: 'materials',
                       kind: 'mat_request', title: 'Sinov talabnoma' });
  assert.equal(await sanoq(b1, 'mat_request'), 1, 'belgisiz — keladi');

  //  ── O'chirilsa YOZILMAYDI ham: qator umuman qo'yilmaydi, ya'ni
  //  navbat ham to'lib ketmaydi.
  await db.query(
    `INSERT INTO worker_notify_off (worker_id, kind) VALUES ($1,'mat_request')`,
    [admId]);
  const b2 = await belgi();
  assert.equal(await notify.queue({ worker_id: admId, module: 'materials',
                                    kind: 'mat_request', title: 'Sinov 2' }),
               false, 'yozilmadi deb aytadi');
  assert.equal(await sanoq(b2, 'mat_request'), 0, 'o\'chirilgan tur kelmaydi');

  //  Boshqa tur TEGILMAYDI: ro'yxat tur bo'yicha, xodim bo'yicha emas.
  const b3 = await belgi();
  await notify.queue({ worker_id: admId, module: 'materials',
                       kind: 'mat_order', title: 'Sinov zayavka' });
  assert.equal(await sanoq(b3, 'mat_order'), 1, 'boshqa tur keladi');

  //  ── HUQUQ bo'yicha ketadigan xabarda kimga borishi YUBORISH
  //  paytida hal qilinadi, ya'ni filtr `sendPending` da ham bo'lishi
  //  shart: navbatga qo'yishda qilinsa administratorning huquqi
  //  baribir qatorni yozib qo'yardi.
  await db.query(`UPDATE workers SET tg_id = 777001 WHERE id = $1`, [admId]);
  await db.query(
    `INSERT INTO worker_notify_off (worker_id, kind) VALUES ($1,'cash_pending')
     ON CONFLICT DO NOTHING`, [admId]);
  await db.query(`DELETE FROM notifications WHERE sent_at IS NULL`);
  await notify.queue({ permission_code: 'cash.manage', module: 'cash',
                       kind: 'cash_pending', title: 'Sinov pul' });
  const ketgan = [];
  await notify.sendPending(async (tg) => { ketgan.push(Number(tg)); });
  assert.ok(!ketgan.includes(777001), 'o\'chirilgan tur huquq orqali ham kelmaydi');

  //  Tozalab qo'yamiz: keyingi testlar shu xodimdan xabar kutadi.
  await db.query(`DELETE FROM worker_notify_off WHERE worker_id = $1`, [admId]);
  await db.query(`UPDATE workers SET tg_id = NULL WHERE id = $1`, [admId]);

  //  ── Kartochka TO'LIQ ro'yxat yuboradi, ayirmani SERVER chiqaradi.
  const meta = await admin('GET', '/api/admin/roles');
  assert.ok(Array.isArray(meta.body.notify_kinds) && meta.body.notify_kinds.length,
    'turlar ro\'yxati serverdan keladi');
  const hammasi = meta.body.notify_kinds.map((t) => t.kod);

  const w = (await admin('POST', '/api/admin/workers',
    { name: 'Xabar sinovi', notify_on: hammasi.filter((k) => k !== 'mat_request') }));
  assert.equal(w.status, 200, w.text);
  const roy = (await admin('GET', '/api/admin/workers')).body;
  const qator = roy.find((r) => r.name === 'Xabar sinovi');
  assert.deepEqual(qator.notify_off, ['mat_request'],
    'belgilanmagani o\'chirilganlar ro\'yxatiga tushadi');

  //  Hammasi belgilansa ro'yxat BO'SHAYDI — «qator yo'q = hammasi».
  assert.equal((await admin('PATCH', '/api/admin/workers/' + qator.id,
    { notify_on: hammasi })).status, 200);
  assert.deepEqual(
    (await admin('GET', '/api/admin/workers')).body
      .find((r) => r.id === qator.id).notify_off, [],
    'hammasi yoqilsa qator qolmaydi');
});

//  ★ KARTOCHKADAGI RAQAM RO'YXAT BILAN BIR XIL BO'LISHI SHART.
//
//  Panelda «Minusga tushgan N ta» turadi va raqam bosilsa qoldiq
//  ro'yxati `?minus=1` bilan ochiladi. Shart ikki joyda yozilsa bir
//  kun ajralib ketardi: kartochkada «30» turib, ro'yxat yigirma
//  sakkiztasini ko'rsatardi va qaysi biri javob ekani noaniq
//  qolardi — menyudagi navbat belgisi bilan bir xil qoida va bir
//  xil sabab. Shuning uchun test raqamni RO'YXATNING uzunligi bilan
//  solishtiradi.
test('minusga tushgan qoldiq: kartochkadagi raqam ro\'yxatga teng', async () => {
  const { db } = require('../db');
  const wh = (await H.id(`SELECT id FROM warehouses WHERE code = 'XOM'`));
  const mat = (await H.id(
    `INSERT INTO materials (name, uom) VALUES ('Sinov minus material', 'dona')
     ON CONFLICT (lower(name)) DO UPDATE SET uom = 'dona' RETURNING id`));

  //  Omborga kirmasdan sarflangan material: kirim hujjati yozilmagan
  //  degani va qoldiq minusga tushadi. Zavod qarori: to'xtatilmaydi,
  //  lekin AYTILADI (izoh: CLAUDE.md).
  await db.query(
    `INSERT INTO material_moves (material_id, from_kind, from_id, to_kind, to_id,
                                 qty, moved_on, status)
     VALUES ($1, 'warehouse', $2, 'unit', NULL, 7, CURRENT_DATE, 'ok')`,
    [mat.id, wh.id]);

  const kart = await admin('GET', '/api/materials/dashboard');
  assert.equal(kart.status, 200, kart.text);
  const roy = await admin('GET', '/api/materials/stock?minus=1');
  assert.equal(roy.status, 200, roy.text);

  assert.equal(roy.body.rows.length, Number(kart.body.minus),
    'kartochkadagi raqam ro\'yxat uzunligiga teng');
  assert.ok(Number(kart.body.minus) > 0, 'minusga tushgan qator bor');
  //  Ro'yxatda FAQAT manfiylari turadi va qaysi omborda ekani ham.
  for (const r of roy.body.rows) {
    assert.ok(Number(r.qty) < 0, `${r.material}: manfiy emas`);
    assert.ok(r.warehouse_id, 'qaysi omborda ekani ham keladi');
  }
  assert.ok(roy.body.rows.some((r) => r.material === 'Sinov minus material'));

  //  Filtrsiz ro'yxat KENGROQ: musbat qoldiqlar ham turadi.
  const hammasi = await admin('GET', '/api/materials/stock');
  assert.ok(hammasi.body.rows.length >= roy.body.rows.length,
    'filtrsiz ro\'yxat qisqarmaydi');
});

//  ★ QOLDIQDAN KO'P CHIQARIB BO'LMAYDI — KALIT BILAN (zavod qarori,
//  2026-09; izoh: sql/core.sql).
//
//  Ilgari to'siq yo'q edi va bu ataylab edi: material allaqachon
//  kesilgan, sarfni rad etish taxtani qaytarmaydi. Talabnoma va kirim
//  hujjati yozilgach sabab o'tdi — endi minus qoldiq xato.
//
//  ★ KALIT STANDARTI O'CHIQ: deploy kuni o'ttizga yaqin material
//  minusda turibdi va to'siq darrov yoqilsa tsex to'xtardi. Test
//  IKKALA holatni ham tekshiradi: o'chiq — eskicha ishlaydi,
//  yoqilgan — rad etiladi.
test('kalit yoqilsa kassa va ombor qoldig\'i minusga tushmaydi', async () => {
  const { db } = require('../db');
  const yoq = async (kod, on) => db.query(
    `INSERT INTO app_settings (key, val) VALUES ($1,$2)
     ON CONFLICT (key) DO UPDATE SET val = $2`, [kod, on ? '1' : '']);

  // ── KASSA ────────────────────────────────────────────────────────
  const kassa = (await H.id(`SELECT id FROM cash_accounts WHERE code = 'MAIN'`)).id;
  const item = (await H.id(
    `SELECT id FROM expense_items WHERE active ORDER BY id LIMIT 1`)).id;
  const oy = new Date().toISOString().slice(0, 7) + '-01';
  const chiqim = (summa) => admin('POST', '/api/cash/ops', {
    from_kind: 'account', from_id: kassa, to_kind: 'expense', to_id: item,
    currency: 'USD', amount: summa, rate: 12000, pl_month: oy,
    expense_item_id: item });

  //  Kalit O'CHIQ — eskicha: qoldiqdan ko'p chiqsa ham yoziladi.
  await yoq('minus_cash', false);
  //  Sinov bazasida kassa ALLAQACHON minusda: oldingi testlar
  //  qoldiqdan ko'p sarflagan — aynan shu narsa endi yopiladi.
  //  Shuning uchun summa qoldiqdan emas, qat'iy olinadi.
  const erkin = await chiqim(5000);
  assert.equal(erkin.status, 200, erkin.text);

  //  Kalit YOQILGAN — rad etiladi va SABABI yoziladi: qancha bor va
  //  qancha chiqarilmoqda.
  await yoq('minus_cash', true);
  const rad = await chiqim(999999);
  assert.equal(rad.status, 400, rad.text);
  assert.match(rad.body.error, /chiqarilmoqda/, rad.text);

  //  Qoldiq yetsa o'tadi: to'siq hammasini yopmaydi.
  const qoldiq = Number((await H.id(
    `SELECT COALESCE(usd, 0) AS n FROM v_cash_balance WHERE id = $1`, [kassa])).n);
  if (qoldiq > 1) {
    const oz = await chiqim(1);
    assert.equal(oz.status, 200, oz.text);
  }

  //  ★ MIJOZ QARZIGA TEGILMAYDI: u joy emas, QARZ hisobi va minus
  //  u yerda normal holat (oldindan to'lov).
  const mij = (await H.id(`SELECT id FROM customers ORDER BY id LIMIT 1`)).id;
  const tolov = await admin('POST', '/api/cash/ops', {
    from_kind: 'customer', from_id: mij, to_kind: 'account', to_id: kassa,
    currency: 'USD', amount: 50, rate: 12000 });
  assert.equal(tolov.status, 200, tolov.text);

  await yoq('minus_cash', false);

  // ── OMBOR ────────────────────────────────────────────────────────
  const wh = (await H.id(`SELECT id FROM warehouses WHERE code = 'XOM'`)).id;
  const mat = (await H.id(
    `INSERT INTO materials (name, uom) VALUES ('Kalit sinov material', 'dona')
     ON CONFLICT (lower(name)) DO UPDATE SET uom = 'dona' RETURNING id`)).id;
  const u = await newUnit();
  const sarf = (n) => admin('POST', `/api/materials/unit/${u.id}/consume`, {
    warehouse_id: wh, items: [{ material_id: mat, qty: n }] });

  //  Kalit O'CHIQ — bo'sh ombordan ham sarf yoziladi (eski qoida).
  await yoq('minus_material', false);
  const eski = await sarf(5);
  assert.equal(eski.status, 200, eski.text);

  //  Kalit YOQILGAN — rad etiladi, xabarda NOMI va raqamlar turadi.
  await yoq('minus_material', true);
  const yopiq = await sarf(5);
  assert.equal(yopiq.status, 400, yopiq.text);
  assert.match(yopiq.body.error, /Kalit sinov material/, yopiq.text);
  assert.match(yopiq.body.error, /so'ralmoqda/, yopiq.text);

  //  Kirim yozilsa o'sha zahoti ochiladi — to'siqning YO'LI shu:
  //  «avval kirim yozing» degan xabar bo'sh va'da emas.
  await db.query(
    `INSERT INTO material_moves (material_id, from_kind, from_id,
                                 to_kind, to_id, qty, moved_on, status)
     VALUES ($1, 'opening', NULL, 'warehouse', $2, 20, CURRENT_DATE, 'ok')`,
    [mat, wh]);
  const ochildi = await sarf(5);
  assert.equal(ochildi.status, 200, ochildi.text);

  //  Qolganidan ko'pi baribir yopiq.
  const kop = await sarf(999);
  assert.equal(kop.status, 400, kop.text);

  await yoq('minus_material', false);
});

//  Kalit SAHIFADAN qo'yiladi va faqat administrator yoza oladi:
//  qoida pulga va ombor qoldig'iga tegadi.
test('zavod kalitlari: ko\'radi hamma, yoqadi administrator', async () => {
  const r = await admin('GET', '/api/admin/settings');
  assert.equal(r.status, 200, r.text);
  const kodlar = r.body.rows.map((x) => x.kod);
  assert.ok(kodlar.includes('minus_cash') && kodlar.includes('minus_material'));
  for (const k of r.body.rows) assert.ok(k.nom && k.izoh, `${k.kod}: izohsiz`);

  assert.equal((await admin('PATCH', '/api/admin/settings/minus_cash',
    { on: true })).status, 200);
  assert.equal((await admin('GET', '/api/admin/settings')).body.rows
    .find((x) => x.kod === 'minus_cash').on, true);
  assert.equal((await admin('PATCH', '/api/admin/settings/minus_cash',
    { on: false })).status, 200);

  //  Notanish kalit qabul qilinmaydi: aks holda jadvalda hech kim
  //  o'qimaydigan qator yotib qolardi.
  assert.equal((await admin('PATCH', '/api/admin/settings/yoq-kalit',
    { on: true })).status, 404);

  //  Savdo xodimi ko'ra oladi (nega rad etilganini bilishi kerak),
  //  lekin yoza olmaydi.
  const savdo = H.api(base, await H.sessionFor('Sinov sotuvchi'));
  assert.equal((await savdo('PATCH', '/api/admin/settings/minus_cash',
    { on: true })).status, 403);
});

//  ★ OMBORLAR ARO MATERIAL KO'CHIRISH (zavod qarori, 2026-09).
//
//  Talabnoma zavod omboridan TSEXGA beradi, qaytarish esa tsexdan
//  zavodga. Uchinchi savol ikkalasiga ham to'g'ri kelmaydi: material
//  bir tsexdan IKKINCHI tsexga, yoki zavod omborlari orasida
//  ko'chadi.
//
//  Yangi jadval yozilmadi — hujjatning shakli AYNAN bir xil, faqat
//  `kind = 'move'`. Ikkinchi mexanizm bo'lsa ro'yxat, bekor qilish,
//  doira va qoldiq hisobi ikki nusxada yozilardi.
test('omborlar aro material ko\'chiriladi', async () => {
  const { db } = require('../db');
  const xom = (await H.id(`SELECT id FROM warehouses WHERE code='XOM'`)).id;
  const mdf = (await H.id(
    `SELECT id FROM warehouses WHERE kind='material' AND shop_id IS NULL
       AND owner_shop_id IS NULL AND id <> $1 AND is_active
     ORDER BY sort LIMIT 1`, [xom])).id;
  const mat = (await H.id(
    `INSERT INTO materials (name, uom) VALUES ('Ko''chirish sinovi', 'dona')
     ON CONFLICT (lower(name)) DO UPDATE SET uom = 'dona' RETURNING id`)).id;

  //  Manbaga 50 dona qo'yamiz.
  await db.query(
    `INSERT INTO material_moves (material_id, from_kind, from_id,
                                 to_kind, to_id, qty, moved_on, status)
     VALUES ($1, 'opening', NULL, 'warehouse', $2, 50, CURRENT_DATE, 'ok')`,
    [mat, xom]);
  const qoldiq = async (w) => Number((await H.id(
    `SELECT COALESCE(SUM(CASE WHEN to_id = $2 THEN qty ELSE -qty END), 0) AS n
       FROM material_moves
      WHERE material_id = $1 AND status = 'ok'
        AND (to_id = $2 OR from_id = $2)
        AND (to_kind = 'warehouse' OR from_kind = 'warehouse')`, [mat, w])).n);
  assert.equal(await qoldiq(xom), 50);

  //  ── O'ZIDAN O'ZIGA HUJJAT BO'LMAYDI ─────────────────────────────
  const ozi = await admin('POST', '/api/materials/requests', {
    kind: 'move', from_warehouse_id: xom, to_warehouse_id: xom,
    items: [{ material_id: mat, qty: 10 }] });
  assert.equal(ozi.status, 400, ozi.text);
  assert.match(ozi.body.error, /bir xil ombor/);

  //  ── HUJJAT YOZILADI ─────────────────────────────────────────────
  const zayOldin = Number((await H.id(
    `SELECT COUNT(*)::int AS n FROM mat_orders`)).n);
  const d = await admin('POST', '/api/materials/requests', {
    kind: 'move', from_warehouse_id: xom, to_warehouse_id: mdf,
    items: [{ material_id: mat, qty: 20 }] });
  assert.equal(d.status, 200, d.text);
  const doc = d.body.rows ? d.body.rows[0] : d.body;
  const id = doc.id || d.body.id;
  assert.ok(id, d.text);

  //  Raqami ALOHIDA harf bilan: talabnoma T, qaytarish Q, ko'chirish N.
  const h = await H.id(
    `SELECT doc_no, kind, from_warehouse_id, to_warehouse_id, need_on
       FROM mat_requests WHERE id = $1`, [id]);
  assert.match(h.doc_no, /^N\d{2}-\d{4}$/, h.doc_no);
  assert.equal(h.kind, 'move');
  assert.equal(h.from_warehouse_id, xom);
  assert.equal(h.to_warehouse_id, mdf);
  //  «Qachon kerak» faqat TALABNOMADA: ko'chirish zavod ichida yuradi.
  assert.equal(h.need_on, null);

  //  ★ XARID ZAYAVKASI YOZILMAYDI: mol zavod ichida ko'chadi, sotib
  //  olish haqida savol yo'q.
  //  Zayavka hujjat raqami bilan bog'lanadi; ko'chirishda u umuman
  //  yozilmaydi, shuning uchun SHU hujjatdan keyin yangi zayavka
  //  paydo bo'lmagani tekshiriladi.
  assert.equal(zayOldin, Number((await H.id(
    `SELECT COUNT(*)::int AS n FROM mat_orders`)).n),
    'ko\'chirishga zayavka yozilmaydi');

  //  Hujjat yozilgani bilan material QIMIRLAMAYDI.
  assert.equal(await qoldiq(xom), 50, 'hali ko\'chmagan');
  assert.equal(await qoldiq(mdf), 0);

  //  ── BAJARILADI: material SHUNDA ko'chadi ────────────────────────
  const ok = await admin('POST', `/api/materials/requests/${id}/done`, {});
  assert.equal(ok.status, 200, ok.text);
  assert.equal(await qoldiq(xom), 30, 'manbadan ayrildi');
  assert.equal(await qoldiq(mdf), 20, 'manzilga qo\'shildi');

  //  ── DOIRA CHEGARA: tsex boshlig'iga zavod ombori yopiq ──────────
  //  Uning yo'li TALABNOMA, ko'chirish emas.
  const usta = H.api(base, await H.sessionFor('Korpus ustasi'));
  const yoq = await usta('POST', '/api/materials/requests', {
    kind: 'move', from_warehouse_id: xom, to_warehouse_id: mdf,
    items: [{ material_id: mat, qty: 5 }] });
  assert.equal(yoq.status, 400, yoq.text);
  assert.match(yoq.body.error, /doirangizda emas/);

  //  ── QOLDIQ KALITI: yoqilganda qoldiqdan ko'p ko'chirilmaydi ─────
  await db.query(
    `INSERT INTO app_settings (key, val) VALUES ('minus_material','1')
     ON CONFLICT (key) DO UPDATE SET val = '1'`);
  const k = await admin('POST', '/api/materials/requests', {
    kind: 'move', from_warehouse_id: xom, to_warehouse_id: mdf,
    items: [{ material_id: mat, qty: 999 }] });
  assert.equal(k.status, 200, k.text);
  const kid = k.body.rows ? k.body.rows[0].id : k.body.id;
  const rad = await admin('POST', `/api/materials/requests/${kid}/done`, {});
  assert.equal(rad.status, 400, rad.text);
  assert.match(rad.body.error, /Ko'chirish sinovi/);
  await db.query(`UPDATE app_settings SET val = '' WHERE key = 'minus_material'`);
});

//  ★ BO'SHAB QOLGAN QATOR O'CHADI — ILINGAN HAMMASI TIRIK QATORGA
//  KO'CHADI (izoh: `birlashtir`, modules/units.js). Bo'laklar
//  uchrashganda qator birlashadi va bo'shab qolgani o'chiriladi.
//  Ilgari faqat `unit_moves` ko'chirilardi: so'rovdan ochilgan
//  konverni o'tkazmoqchi bo'lgan usta ekranda FK xatosini ko'rardi
//  («update or delete on table "production_units" violates foreign key
//  constraint "unit_requests_unit_id_fkey"») va konverni umuman
//  o'tkaza olmasdi.
test("bo'laklar birlashganda so'rov va sarf tirik qatorga ko'chadi", async () => {
  const { db } = require('../db');

  //  So'rovdan ochilgan konver: `unit_requests.unit_id` unga ilinadi.
  const kir = await xodim('Sinov birlashuv', 'kirituvchi');
  const q = await kir('POST', '/api/units/requests',
    { product_id: PENAL, qty: 6, started_on: '2026-09-19' });
  assert.equal(q.status, 200, q.text);
  const ok = await admin('POST',
    `/api/units/requests/${q.body.created[0]}/approve`);
  assert.equal(ok.status, 200, ok.text);
  const id = ok.body.unit_id;
  assert.equal((await H.id(
    `SELECT unit_id AS id FROM unit_requests WHERE unit_id = $1`, [id])).id, id,
    "so'rov konverga ilingan");

  //  Arraga qo'yamiz va unga xom ashyo sarfini yozamiz — u ham
  //  ko'chishi kerak (tannarx o'sha yozuvdan yig'iladi).
  assert.equal((await admin('PATCH', '/api/units/' + id,
    { section_id: ARRA })).status, 200);
  await db.query(
    `INSERT INTO material_moves (material_id, qty, from_kind, from_id,
                                 to_kind, to_id, moved_on, section_id)
     SELECT (SELECT id FROM materials ORDER BY id LIMIT 1), 1,
            'warehouse', (SELECT id FROM warehouses WHERE code='TSEX-KOR-ARRA'),
            'unit', $1, CURRENT_DATE, $2`, [id, ARRA]);

  //  Avval 2 tasi Roverga (yangi bo'lak), keyin qolgan 4 tasi — shunda
  //  ESKI qator bo'shaydi va o'chiriladi.
  assert.equal((await korpus('POST', '/api/units/move',
    { items: [{ unit_id: id, qty: 2 }] })).status, 200);
  const qolgan = await korpus('POST', '/api/units/move',
    { items: [{ unit_id: id }] });
  assert.equal(qolgan.status, 200, qolgan.text);

  //  Eski qator o'chdi, tirigida oltitasi turibdi.
  assert.equal((await H.id(
    `SELECT COUNT(*)::text AS id FROM production_units WHERE id = $1`, [id])).id, '0');
  const tirik = qolgan.body.moved[0].unit_id;
  assert.equal((await H.id(
    `SELECT qty::text AS id FROM production_units WHERE id = $1`, [tirik])).id, '6');

  //  So'rov ham, sarf ham tirik qatorda — ikkalasi ham yo'qolmadi.
  assert.equal((await H.id(
    `SELECT unit_id AS id FROM unit_requests WHERE unit_id = $1`, [tirik])).id, tirik);
  assert.equal((await H.id(
    `SELECT COUNT(*)::text AS id FROM material_moves
      WHERE to_kind = 'unit' AND to_id = $1`, [tirik])).id, '1');
});

//  ★ HAMMA MAHSULOT ZAVODDA YASALMAYDI (zavod qarori, 2026-09).
//  Matras ta'minotchidan TAYYOR holda keladi va do'konda alohida
//  sotiladi. U ham KONVER, faqat tsexda emas, OMBORDA tug'iladi:
//  marshruti yo'q, ya'ni tsex ekranida ko'rinmaydi va muddat
//  hisoblanmaydi — lekin ombor qoldig'i, bron va yuk xati eskicha
//  ishlaydi (izoh: sql/warehouse.sql).
test('matras ta\'minotchidan kirim hujjati bilan keladi', async () => {
  const { db } = require('../db');

  //  Guruh va mahsulot migratsiyadan keladi, marshrutsiz.
  const mat = (await H.id(`SELECT id FROM products WHERE sku = 'MATRAS'`)).id;
  assert.equal((await H.id(
    `SELECT COALESCE(route_template_id::text, 'yoq') AS id
       FROM products WHERE sku = 'MATRAS'`)).id, 'yoq', 'marshruti yo\'q');
  //  Sotib olinadigan mahsulotlar ro'yxati BAZADAN chiqadi.
  const ol = await admin('GET', '/api/warehouse/fg/buyable');
  assert.equal(ol.status, 200, ol.text);
  assert.ok(ol.body.rows.some((r) => r.id === mat), 'matras ro\'yxatda');

  await admin('POST', '/api/purchasing/suppliers',
    { name: 'Sinov Matras Zavodi', category: 'BOSHQA' });
  const tam = (await H.id(
    `SELECT id FROM suppliers WHERE name = 'Sinov Matras Zavodi'`)).id;
  const qarz = async () => Number((await H.id(
    `SELECT balance AS id FROM v_supplier_debt WHERE id = $1`, [tam])).id);
  const oldin = await qarz();

  //  Ta'minotchisiz ham, narxsiz ham o'tmaydi: kirimda narx —
  //  QARZNING O'ZI.
  assert.equal((await admin('POST', '/api/warehouse/fg/receipts',
    { items: [{ product_id: mat, qty: 2, price: 50 }] })).status, 400);
  assert.equal((await admin('POST', '/api/warehouse/fg/receipts',
    { supplier_id: tam, items: [{ product_id: mat, qty: 2 }] })).status, 400);

  const k = await admin('POST', '/api/warehouse/fg/receipts', {
    supplier_id: tam, doc_on: '2026-09-20', supplier_doc: 'NAK-77',
    items: [{ product_id: mat, qty: 4, price: 60 },
            { product_id: mat, qty: 2, price: 55, color: 'Oq' }] });
  assert.equal(k.status, 200, k.text);
  assert.match(k.body.doc_no, /^F\d\d-\d{4}$/, 'hujjat raqami F bilan');
  assert.equal(k.body.lines, 2);
  assert.equal(k.body.qty, 6);
  //  4 × 60 + 2 × 55 = 350
  assert.equal(Number(k.body.amount), 350);

  //  Konverlar T/M omborda va raqami MT bilan.
  const rows = (await db.query(
    `SELECT u.conveyor_no, u.status, u.qty, u.buy_price,
            u.unit_price, w.code AS wh
       FROM production_units u
       LEFT JOIN warehouses w ON w.id = u.warehouse_id
      WHERE u.fg_receipt_id = $1 ORDER BY u.id`, [k.body.id])).rows;
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.match(r.conveyor_no, /^MT\d\d-\d{4}$/, 'raqami MT bilan');
    assert.equal(r.status, 'fg', 'darrov omborda');
    assert.equal(r.wh, 'TM', 'faqat T/M ombor');
    //  ★ SOTIB OLINGAN NARX `unit_price` GA YOZILMAYDI: u sotuv
    //  narxi va matras mijozga TANNARXIDA chiqib ketardi.
    assert.equal(r.unit_price, null, 'sotuv narxi bo\'sh qoladi');
    assert.ok(Number(r.buy_price) > 0, 'olingan narx yozildi');
  }

  //  Ta'minotchining qarzi o'sha zahoti oshdi — xom ashyo kirimi
  //  bilan bir xil: kirim omborni to'ldiradi VA qarzni oshiradi.
  assert.equal(await qarz(), oldin + 350, 'qarz kirimga oshdi');
  //  Lentada ham hujjat raqami bilan turadi.
  const lenta = (await db.query(
    `SELECT kind, credit, doc_no FROM v_supplier_ledger
      WHERE supplier_id = $1 AND doc_no = $2`, [tam, k.body.doc_no])).rows;
  assert.equal(lenta.length, 1, 'lentada bitta qator');
  assert.equal(Number(lenta[0].credit), 350, 'haqdor tomonda');

  //  ★ VA ENG MUHIMI — SOTILADI. Matrasning butun ma'nosi shu:
  //  savdo uni T/M ombordagi oddiy qoldiq bo'lib ko'radi va buyurtmaga
  //  biriktiradi. Alohida jadval yozilganda bu ro'yxat ikkinchi
  //  manbadan ham o'qishi kerak bo'lardi.
  const qoldiq = (await admin('GET', '/api/sales/stock')).body.rows
    .filter((r) => r.product_id === mat && r.src === 'fg');
  assert.ok(qoldiq.length, 'matras savdoning qoldig\'ida turibdi');
  assert.equal(qoldiq.reduce((a, r) => a + Number(r.free), 0), 6,
    'oltitasi ham bo\'sh');


  //  ★ PANJARAGA TUSHMAYDI: «Zara matras» degan narsa zavodda yo'q.
  //  Ustun ekranda chizilmaydi, lekin tekshiruv SERVERDA — id ni
  //  qo'lda yuborsa ham qabul qilinmaydi.
  const guruh = (await H.id(
    `SELECT id FROM product_groups WHERE code = 'MATRAS'`)).id;
  const fason = (await H.id(`SELECT id FROM fasons ORDER BY id LIMIT 1`)).id;
  const kesim = await admin('POST', '/api/catalog/products',
    { group_id: guruh, fason_id: fason });
  assert.equal(kesim.status, 400, kesim.text);
  assert.match(kesim.body.error, /yasalmaydi/);

  //  ★ BOSHLANG'ICH QOLDIQ — KIRIM HUJJATI EMAS. Javonda tizim ishga
  //  tushishidan oldin turgan matras hech kimning qarzi emas: uni
  //  kirim bilan kiritish ta'minotchining qarzini yolg'on oshirardi.
  //  Yo'li oddiy qoldiq sahifasi: bo'limsiz, to'g'ridan-to'g'ri
  //  omborga.
  const qarzOldin = await qarz();
  const oq = await admin('POST', '/api/units/', { items: [
    { product_id: mat, qty: 3, is_opening: true,
      fg_on: '2026-09-01', warehouse_code: 'TM' }] });
  assert.equal(oq.status, 200, oq.text);
  const q = oq.body.created[0];
  //  Raqamni TIZIM qo'yadi: matrasda zavodning daftardagi raqami yo'q.
  assert.match(q.conveyor_no, /^Q\d\d-\d{4}$/, 'raqami Q bilan');
  const uq = await H.id(
    `SELECT status || ' ' || COALESCE(current_section_id::text, '-') AS id
       FROM production_units WHERE id = $1`, [q.id]);
  assert.equal(uq.id, 'fg -', 'darrov omborda, bo\'limsiz');
  //  Ta'minotchining qarzi OSHMAYDI — kirim hujjatidan farqi shu.
  assert.equal(await qarz(), qarzOldin, 'qoldiq qarzga tegmaydi');

  //  Bekor qilish: sabab so'raladi, konverlar ham birga chiqadi.
  assert.equal((await admin('POST',
    `/api/warehouse/fg/receipts/${k.body.id}/cancel`)).status, 400, 'sababsiz');
  assert.equal((await admin('POST',
    `/api/warehouse/fg/receipts/${k.body.id}/cancel`,
    { note: 'adashib yozildi' })).status, 200);
  assert.equal(await qarz(), oldin, 'qarz joyiga qaytdi');
  assert.equal((await H.id(
    `SELECT COUNT(*)::text AS id FROM production_units
      WHERE fg_receipt_id = $1 AND status <> 'cancelled'`, [k.body.id])).id, '0',
    'konverlar ham bekor bo\'ldi');
});

//  ★ KONVER PASPORTI — BITTA RAQAM, BUTUN MANZARA (izoh: modules/units.js).
//  Konver BO'LINADI va bo'laklari uch xil joyda turadi: bir qismi tsexda,
//  bir qismi javonda, bir qismi allaqachon mijozda. Zavodning savoli esa
//  bitta: «S26-474 qayerda?» — javobi ham bitta ekranda bo'lishi kerak.
test('konver raqami bo\'yicha qidiruv: bo\'laklari qayerdaligini aytadi', async () => {
  const mudir   = H.api(base, await H.sessionFor('Sinov ombor mudiri'));
  const mijoz   = (await H.id(`SELECT id FROM customers WHERE name='Kanalsiz mijoz'`)).id;
  const QADOYNA = (await H.id(`SELECT id FROM sections WHERE code='QAD-OYNA'`)).id;

  //  10 talik konver qadoqlashga keladi.
  const u = (await admin('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 10, color: 'Sut', unit_price: 250,
      section_id: QADOYNA }] })).body.created[0];
  const qad = H.api(base, await H.sessionFor('Qadoqlash ustasi'));
  await xomsiz();
  await qad('POST', '/api/units/move', { items: [{ unit_id: u.id }] });
  assert.equal((await qad('POST', '/api/units/handover', { items: [u.id] })).status, 200);

  //  Oltitasi javonga qo'yiladi — to'rttasi tsexda qoladi.
  const qabul = await mudir('POST', '/api/units/stock/accept',
    { items: [{ unit_id: u.id, qty: 6 }] });
  assert.equal(qabul.status, 200, qabul.text);
  const omborda = qabul.body.done[0].unit_id || qabul.body.done[0].id;

  //  To'rttasi mijozga chiqib ketadi — javonda ikkitasi qoladi.
  const z = (await admin('POST', '/api/sales/orders', {
    customer_id: mijoz, ship_to: 'ZAVOD', due_on: kun(90),
    items: [{ product_id: PENAL, qty: 4, color: 'Sut', unit_price: 250 }] })).body;
  const qator = (await admin('GET', '/api/sales/orders/' + z.id)).body.items[0];
  assert.equal((await admin('POST', `/api/sales/orders/${z.id}/assign`,
    { item_id: qator.id, unit_id: omborda, qty: 4 })).status, 200);
  assert.equal((await admin('POST', `/api/sales/orders/${z.id}/send`)).status, 200);
  assert.equal((await mudir('POST', `/api/sales/orders/${z.id}/ship`,
    { ship_on: '2026-10-04' })).status, 200);

  //  ★ ENDI BITTA SO'ROV BUTUN JAVOBNI BERADI.
  const t = await admin('GET', '/api/units/track?no=' + u.conveyor_no);
  assert.equal(t.status, 200, t.text);
  assert.equal(t.body.found, true);
  assert.equal(t.body.conveyor_no, u.conveyor_no);
  assert.equal(t.body.total, 10, 'nechta yasalgan');
  assert.equal(t.body.tsexda, 4);
  assert.equal(t.body.omborda, 2);
  assert.equal(t.body.chiqdi, 4);
  assert.equal(t.body.uom, 'komplekt', 'o\'lchov birligi guruhdan');

  //  Tartib: avval tsexda turgani, keyin javondagi, oxirida chiqqani.
  const r = t.body.rows;
  assert.equal(r.length, 3, 'uch bo\'lak');
  assert.equal(r[0].status, 'production');
  assert.match(r[0].joy, /Qadoqlash/, 'bo\'limi tsexi bilan yoziladi');
  assert.equal(r[1].status, 'fg');
  //  Ombor nomi BAZADAN keladi, kodda yozilmaydi (4-qoida): zavod
  //  uni qayta nomlasa ekrandagi yozuv o'zi o'zgaradi.
  assert.equal(r[1].joy, 'Tayyor mahsulot ombori');
  assert.equal(r[1].warehouse_code, 'TM');
  assert.equal(r[2].status, 'shipped');
  assert.equal(r[2].joy, 'Mijozda — Kanalsiz mijoz');
  //  ★ CHIQIB KETGAN BO'LAKDA YUK XATI OCHILADI: «kimga» degan
  //  savoldan keyingi savol «qaysi hujjat bilan» bo'ladi.
  assert.equal(r[2].order_no, z.order_no);
  assert.equal(r[2].order_id, z.id, 'yuk xatining id si');

  //  Katta-kichik harfga qaramaydi: usta raqamni qanday yozsa shunday.
  const kichik = await admin('GET',
    '/api/units/track?no=' + u.conveyor_no.toLowerCase());
  assert.equal(kichik.body.found, true, 'kichik harf bilan ham topiladi');

  //  Yo'q raqam — XATO EMAS: qidiruv natijasi bo'sh bo'lishi mumkin.
  const yoq = await admin('GET', '/api/units/track?no=K99-9999');
  assert.equal(yoq.status, 200);
  assert.equal(yoq.body.found, false);
  assert.equal((await admin('GET', '/api/units/track')).status, 400, 'raqamsiz');

  //  Sahifa savdoga ham, omborga ham, tsexga ham ochiq: «mahsulotim
  //  qayerda» degan savol uchalasida ham bir xil.
  assert.equal((await mudir('GET', '/api/units/track?no=' + u.conveyor_no))
    .status, 200, 'ombor mudiri ham ko\'radi');
  assert.equal((await korpus('GET', '/api/units/track?no=' + u.conveyor_no))
    .status, 200, 'tsex ustasi ham ko\'radi');
});

//  ★ CHIQIB KETGAN BUYURTMANI FAQAT ADMINISTRATOR TUZATADI (izoh:
//  modules/sales.js, `fixShipped`). Jo'natilgan buyurtma savdo uchun
//  yopiq bo'lib qolaveradi: uning summasi mijozning qarzi va u mijoz
//  imzolagan hujjat bilan bir xil turishi kerak. Lekin xato bo'ladi
//  va tuzatadigan yo'l umuman yo'q edi.
test('chiqib ketgan buyurtmani faqat administrator tuzatadi', async () => {
  const mudir = H.api(base, await H.sessionFor('Sinov ombor mudiri'));
  const mijoz = (await H.id(`SELECT id FROM customers WHERE name='Kanalsiz mijoz'`)).id;
  const ikki  = (await H.id(`SELECT id FROM customers WHERE name='B2B mijozi'`)).id;

  const u = (await admin('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 2, color: 'Sut', unit_price: 100,
      is_opening: true, fg_on: '2026-09-02' }] })).body.created[0];

  const z = (await admin('POST', '/api/sales/orders', {
    customer_id: mijoz, ship_to: 'ZAVOD', due_on: kun(90),
    items: [{ product_id: PENAL, qty: 2, color: 'Sut', unit_price: 300 }] })).body;
  const q = (await admin('GET', '/api/sales/orders/' + z.id)).body.items[0];
  assert.equal((await admin('POST', `/api/sales/orders/${z.id}/assign`,
    { item_id: q.id, unit_id: u.id, qty: 2 })).status, 200);
  assert.equal((await admin('POST', `/api/sales/orders/${z.id}/send`)).status, 200);
  assert.equal((await mudir('POST', `/api/sales/orders/${z.id}/ship`,
    { ship_on: '2026-10-05' })).status, 200);

  const bal = async (id) => Number((await H.id(
    `SELECT COALESCE(balance, 0) AS id FROM v_customer_sales WHERE id = $1`,
    [id])).id);
  //  Balans MIJOZNING butun tarixidan yig'iladi — boshqa testlar ham
  //  shu mijozga chiqargan, shuning uchun AYIRMA qaraladi.
  const bal0 = await bal(mijoz), ikki0 = await bal(ikki);

  const qator = (n, extra = {}) => ({
    items: [{ id: q.id, product_id: PENAL, qty: 2, color: 'Sut', unit_price: n }],
    ...extra });

  //  Savdo menejeriga yopiq: huquq FAQAT administratorda.
  const sot = H.api(base, await H.sessionFor('Sinov sotuvchi'));
  const yopiq = await sot('PATCH', '/api/sales/orders/' + z.id, qator(250));
  assert.equal(yopiq.status, 400, yopiq.text);
  assert.match(yopiq.body.error, /jo'natilgan/);

  //  ★ NARX TUZATILADI va KONVERGA ham ko'chadi — aks holda
  //  tuzatishning ma'nosi yo'qolardi: hujjat balansdan yana farq
  //  qilib qolardi.
  const ok = await admin('PATCH', '/api/sales/orders/' + z.id, qator(250));
  assert.equal(ok.status, 200, ok.text);
  assert.equal(Number((await H.id(
    `SELECT unit_price AS id FROM order_items WHERE id = $1`, [q.id])).id), 250);
  assert.equal(Number((await H.id(
    `SELECT unit_price AS id FROM production_units
      WHERE order_no = $1 AND status = 'shipped'`, [z.order_no])).id), 250,
    'konverga ham ko\'chdi');
  //  2 × 300 → 2 × 250: qarz 100 dollarga kamaydi.
  assert.equal(await bal(mijoz) - bal0, -100, 'balans o\'sha zahoti to\'g\'rilandi');

  //  Soni, mahsuloti, rangi va qatorlar ro'yxati QOTIB turadi:
  //  mahsulot zavoddan chiqib bo'lgan.
  const son = await admin('PATCH', '/api/sales/orders/' + z.id, {
    items: [{ id: q.id, product_id: PENAL, qty: 5, color: 'Sut', unit_price: 250 }] });
  assert.equal(son.status, 400, son.text);
  assert.match(son.body.error, /faqat NARX/);

  const yangi = await admin('PATCH', '/api/sales/orders/' + z.id, {
    items: [{ id: q.id, product_id: PENAL, qty: 2, color: 'Sut', unit_price: 250 },
            { product_id: PENAL, qty: 1, color: 'Sut', unit_price: 100 }] });
  assert.equal(yangi.status, 400, yangi.text);
  assert.match(yangi.body.error, /qator qo'shilmaydi/);

  //  Holat QAYTARILMAYDI: mahsulot mijozda, omborga qaytmaydi.
  const orqa = await admin('PATCH', '/api/sales/orders/' + z.id,
    { status: 'reserved' });
  assert.equal(orqa.status, 400, orqa.text);
  assert.match(orqa.body.error, /holati qaytarilmaydi/);

  //  ★ MIJOZ ALMASHSA KONVER HAM KO'CHADI — aks holda qarz IKKI
  //  odamda yolg'on bo'lardi: yangisida ko'rinmas, eskisida turib
  //  qolardi.
  assert.equal((await admin('PATCH', '/api/sales/orders/' + z.id,
    { customer_id: ikki })).status, 200);
  assert.equal(await bal(mijoz) - bal0, -600, 'eski mijozdan chiqdi');
  assert.equal(await bal(ikki) - ikki0, 500, 'yangi mijozga o\'tdi');
});

//  ★ CHIQIB KETGAN BUYURTMADA KONVER RAQAMI KO'RINADI (izoh:
//  modules/sales.js, `GET /orders/:id`). Chiqarishda bron o'chiriladi
//  va buyurtma «qaysi konver ketdi» degan savolga javob bermay
//  qolardi: raqamni bilish uchun ombor tarixini ochib qidirish kerak
//  edi, savdo xodimida esa o'sha sahifa yo'q.
test('chiqib ketgan buyurtmada konver raqami ko\'rinadi', async () => {
  const mudir = H.api(base, await H.sessionFor('Sinov ombor mudiri'));
  const mijoz = (await H.id(`SELECT id FROM customers WHERE name='Kanalsiz mijoz'`)).id;

  const u = (await admin('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 1, color: 'Sut', unit_price: 90,
      is_opening: true, fg_on: '2026-09-03' }] })).body.created[0];

  const z = (await admin('POST', '/api/sales/orders', {
    customer_id: mijoz, ship_to: 'ZAVOD', due_on: kun(90),
    items: [{ product_id: PENAL, qty: 1, color: 'Sut', unit_price: 90 }] })).body;
  const q = (await admin('GET', '/api/sales/orders/' + z.id)).body.items[0];
  assert.equal((await admin('POST', `/api/sales/orders/${z.id}/assign`,
    { item_id: q.id, unit_id: u.id, qty: 1 })).status, 200);

  //  Chiqmasdan oldin — bron orqali, joyi bilan.
  const oldin = (await admin('GET', '/api/sales/orders/' + z.id)).body.units;
  assert.equal(oldin.length, 1);
  assert.equal(oldin[0].conveyor_no, u.conveyor_no);
  assert.equal(oldin[0].status, 'fg');

  assert.equal((await admin('POST', `/api/sales/orders/${z.id}/send`)).status, 200);
  assert.equal((await mudir('POST', `/api/sales/orders/${z.id}/ship`,
    { ship_on: '2026-10-06' })).status, 200);

  //  Chiqqandan KEYIN bron yo'q, lekin raqam baribir keladi —
  //  `production_units.order_no` matnidan.
  const keyin = (await admin('GET', '/api/sales/orders/' + z.id)).body.units;
  assert.equal(keyin.length, 1, 'chiqib ketgach ham ro\'yxat bo\'sh emas');
  const k = keyin[0];
  assert.equal(k.conveyor_no, u.conveyor_no);
  assert.equal(k.status, 'shipped');
  assert.equal(k.qty, 1);
  //  Nomi KONVERDAN keladi: qator bog'lanishi yo'q, ekran esa
  //  mahsulotni yozishi kerak.
  assert.ok(k.product, 'mahsulot nomi konverdan');
  assert.ok(k.product_type, 'turi ham');
  assert.equal(String(k.ship_on).slice(0, 10), '2026-10-06');
  assert.ok(k.ship_by_name, 'kim chiqargani ham yoziladi');
  //  Bron o'chgan — raqam AYNAN order_no dan kelgani shundan bilinadi.
  assert.equal((await H.id(
    `SELECT COUNT(*)::text AS id FROM unit_reservations r
       JOIN order_items i ON i.id = r.order_item_id
      WHERE i.order_id = $1`, [z.id])).id, '0');
});

//  ★ KELIB, O'SHA DAVRDA CHIQIB KETGANI HAM QATOR BO'LIB TURADI, lekin
//  qoldig'i NOL va konver ro'yxati BO'SH. Qoldiq jadvali ikki manbadan
//  yig'iladi: hozir javonda turgani va oraliqda qimirlagani. Mudirning
//  «davr ichida nima o'tdi» degan savoliga javob kerak, shuning uchun
//  qator yo'qolmaydi — lekin ekranda sababi yozilib turishi kerak
//  (`yoqIzoh`), aks holda u tushunarsiz qoldiq bo'lib o'qiladi.
//
//  Test ENG OXIRIDA turadi: u mahsulotni vitrinaga ko'chiradi va
//  vitrinalarning yig'indisi boshqa testlarda tekshiriladi —
//  o'rtada tursa o'sha raqamlarga qo'shilib ketardi.
test('kelib, o\'sha davrda chiqib ketgan mahsulot qatori nol qoldiq bilan turadi', async () => {
  const mudir = H.api(base, await H.sessionFor('Sinov ombor mudiri'));

  //  T/M omborga kiritiladi va o'sha oraliqning ichida vitrinaga
  //  ko'chiriladi: T/M uchun bu kirim va chiqim, qoldiq esa nol.
  const u = (await admin('POST', '/api/units/', { items: [
    { product_id: PENAL, qty: 2, color: 'Nol-qoldiq', is_opening: true,
      fg_on: '2026-09-12' },
  ] })).body.created[0];
  assert.equal((await mudir('POST', '/api/warehouse/fg/transfer',
    { unit_id: u.id, to_code: 'VITR-ABU', moved_on: '2026-09-13' })).status, 200);

  const d = (await mudir(
    'GET', '/api/warehouse/fg/summary?w=TM&q=Nol-qoldiq&from=2026-09-01&to=2026-09-30')).body;
  const row = d.rows.find((r) => r.color === 'Nol-qoldiq');
  assert.ok(row, 'davr ichida qimirlagani qator bo\'lib turadi');
  assert.equal(row.qty, 0, 'javonda hech narsa qolmagan');
  assert.equal(row.kirdi, 2, 'oraliqda kirgan');
  assert.equal(row.chiqdi, 2, 'o\'sha oraliqda chiqib ketgan');

  //  Qator ochilganda konver ro'yxati BO'SH: u hozir javonda turganini
  //  o'qiydi. Ekrandagi izoh aynan shu holat uchun yozildi.
  const det = await mudir('GET',
    `/api/warehouse/fg/units?w=TM&product_id=${PENAL}&color=Nol-qoldiq`);
  assert.equal(det.status, 200, det.text);
  assert.equal(det.body.rows.length, 0, 'omborda konver qolmagan');

  //  Oraliq tashqarisida qator umuman chiqmaydi: harakat ham, qoldiq
  //  ham yo'q — ya'ni nol qator o'zidan-o'zi turib qolmaydi.
  const tashqari = (await mudir(
    'GET', '/api/warehouse/fg/summary?w=TM&q=Nol-qoldiq&from=2099-01-01')).body;
  assert.equal(tashqari.rows.length, 0, 'oraliq tashqarisida qator yo\'q');
});

//  ★ MENEJER FILTRI — SERVERDA, va yig'indi ham o'sha filtrdan chiqadi.
//  Savdo bo'lim boshlig'ining savoli «kimning mijozi qancha qarzdor»:
//  klientda qisqartirilsa kartochkalardagi summa baribir butun zavodni
//  qo'shib turardi va javob noto'g'ri bo'lardi.
//
//  Test oxirida turadi: ikkita mijoz qo'shadi va ularning boshlang'ich
//  qarzi qarzdorlik yig'indisiga tushadi — o'rtada tursa oldingi
//  testlarning raqamlariga qo'shilib ketardi.
test('qarzdorlik menejer bo\'yicha filtrlanadi', async () => {
  const mgr = (await H.id(`SELECT id FROM workers WHERE name = 'Sinov sotuvchi'`)).id;
  assert.equal((await admin('POST', '/api/units/customers', { items: [
    { name: 'Qarzdor menejerli', opening_debt: 700, opening_debt_on: '2026-09-01' },
    { name: 'Qarzdor menejersiz', opening_debt: 900, opening_debt_on: '2026-09-01' },
  ] })).status, 200);
  const meniki = (await H.id(
    `SELECT id FROM customers WHERE name = 'Qarzdor menejerli'`)).id;
  const ozga = (await H.id(
    `SELECT id FROM customers WHERE name = 'Qarzdor menejersiz'`)).id;
  await H.id(`UPDATE customers SET manager_id = $2 WHERE id = $1`, [meniki, mgr]);
  await H.id(`UPDATE customers SET manager_id = NULL WHERE id = $1`, [ozga]);

  const q = 'from=1900-01-01&to=2030-01-01';
  const hammasi = (await admin('GET', `/api/sales/debts?${q}`)).body;
  assert.ok(hammasi.rows.some((r) => r.id === meniki), 'filtrsiz ikkalasi ham turadi');
  assert.ok(hammasi.rows.some((r) => r.id === ozga));

  const faqat = (await admin('GET', `/api/sales/debts?${q}&manager_id=${mgr}`)).body;
  assert.ok(faqat.rows.some((r) => r.id === meniki), 'o\'z mijozi qoladi');
  assert.ok(!faqat.rows.some((r) => r.id === ozga), 'boshqasi chiqib ketadi');
  assert.ok(faqat.rows.every((r) => r.manager_name === 'Sinov sotuvchi'),
    faqat.rows.map((r) => r.manager_name).join(','));

  //  ★ YIG'INDI RO'YXATNING O'ZIDAN qayta hisoblanganiga teng: shart
  //  ikki joyda yozilsa kartochkadagi raqam jadvaldan ajralib ketardi
  //  (menyudagi navbat belgisi bilan bir xil qoida).
  const yig = faqat.rows.reduce((a, r) => a + Number(r.closing), 0);
  assert.equal(Number(faqat.total.closing).toFixed(2), yig.toFixed(2));
  assert.ok(Number(faqat.total.closing) < Number(hammasi.total.closing),
    'filtrlangan yig\'indi kichikroq');

  //  Noma'lum menejer — bo'sh ro'yxat, xato emas: savol to'g'ri, javobi yo'q.
  const yoq = await admin('GET', `/api/sales/debts?${q}&manager_id=999999`);
  assert.equal(yoq.status, 200);
  assert.equal(yoq.body.rows.length, 0);
  assert.equal(Number(yoq.body.total.closing), 0);
});

//  ★ YOZILGANINI TUZATISH — PUL O'ZGARMAYDI, U QAYERGA YOZILGANI
//  O'ZGARADI (zavod qarori, 2026-10). Sana, modda, foyda-zarar oyi,
//  xodim va izoh — saralash; summa, valyuta, kurs va tomonlar esa
//  haqiqatda bo'lib o'tgan harakat va ular bu yo'ldan o'tmaydi.
//
//  Test OXIRIDA turadi: u harajatni oydan oyga ko'chiradi va
//  o'rtada tursa foyda-zarar hisobotining aniq qatorlarini
//  tekshiradigan testlarga qo'shilib ketardi.
test('kassa operatsiyasi tuzatiladi: modda va oy ko\'chadi, pul qimirlamaydi', async () => {
  const { db } = require('../db');
  const kassir = H.api(base, await H.sessionFor('Sinov kassir'));
  const kassa = (await H.id(`SELECT id FROM cash_accounts WHERE code='MAIN'`)).id;
  await db.query(`INSERT INTO expense_groups (code, name) VALUES ('TUZAT','Tuzatish guruhi')
                  ON CONFLICT DO NOTHING`);
  for (const n of ['Tuzatish A', 'Tuzatish B'])
    await db.query(`INSERT INTO expense_items (group_code, name) VALUES ('TUZAT', $1)
                    ON CONFLICT DO NOTHING`, [n]);
  const A = (await H.id(`SELECT id FROM expense_items WHERE name='Tuzatish A'`)).id;
  const B = (await H.id(`SELECT id FROM expense_items WHERE name='Tuzatish B'`)).id;

  const oldin = Number((await H.id(
    `SELECT total_usd FROM v_cash_balance WHERE code='MAIN'`)).total_usd);
  const r = await kassir('POST', '/api/cash/ops', {
    from_kind: 'account', from_id: kassa, to_kind: 'expense',
    currency: 'USD', amount: 300, op_date: '2026-09-20',
    expense_item_id: A, pl_month: '2026-09', note: 'eski izoh' });
  assert.equal(r.status, 200, r.text);
  const id = r.body.id || (await H.id(
    `SELECT id FROM cash_ops ORDER BY id DESC LIMIT 1`)).id;

  //  Tuzatish: sana, modda, foyda-zarar oyi va izoh
  const f = await kassir('PATCH', `/api/cash/ops/${id}/fix`, {
    op_date: '2026-09-21', expense_item_id: B, pl_month: '2026-07',
    note: 'yangi izoh' });
  assert.equal(f.status, 200, f.text);

  const o = await H.id(
    `SELECT to_char(op_date,'YYYY-MM-DD') AS kun, note, expense_item_id,
            to_char(pl_month,'YYYY-MM') AS oy, amount_usd, status
       FROM cash_ops WHERE id = $1`, [id]);
  assert.equal(o.kun, '2026-09-21');
  assert.equal(o.note, 'yangi izoh');
  assert.equal(o.expense_item_id, B);
  assert.equal(o.oy, '2026-07');
  //  ★ PUL QIMIRLAMAYDI: summa ham, kassa qoldig'i ham o'sha holda.
  assert.equal(Number(o.amount_usd), 300);
  assert.equal(Number((await H.id(
    `SELECT total_usd FROM v_cash_balance WHERE code='MAIN'`)).total_usd),
    oldin - 300, 'qoldiq faqat birinchi yozuvdan o\'zgargan');

  //  Foyda-zararda ham ko'chgan: iyulda bor, sentabrda yo'q
  const pl = (await kassir('GET', '/api/cash/pl?from=2026-01&to=2026-12')).body;
  const iyul = pl.rows.filter((x) => x.kind === 'expense'
    && x.pl_month.slice(0, 7) === '2026-07' && x.item_id === B);
  assert.equal(iyul.length, 1, 'harajat iyul qatorida');
  assert.equal(Number(iyul[0].amount_usd), 300);
  assert.ok(!pl.rows.some((x) => x.kind === 'expense' && x.item_id === A),
    'eski moddada qolmaydi');

  //  ★ HARAJATDA MODDA MAJBURIY QOLAVERADI: uning tomoni moddaning
  //  O'ZI va moddasiz qator qayerga tushishi noma'lum qolardi.
  const bosh = await kassir('PATCH', `/api/cash/ops/${id}/fix`,
    { op_date: '2026-09-21', expense_item_id: null });
  assert.equal(bosh.status, 400);
  assert.match(bosh.body.error, /modda/i);

  //  ★ MODDASI BO'LMAYDIGAN OPERATSIYAGA MODDA YOZIB BO'LMAYDI.
  //  Kassalar aro ko'chirishda pul korxonadan chiqmagan, shunchaki
  //  joyini o'zgartirgan — unga modda qo'shilsa foyda-zararga
  //  bo'lmagan harajat tushardi. Tekshiruv SERVERDA: katakni
  //  yashirish himoya emas.
  const bank = (await H.id(`SELECT id FROM cash_accounts WHERE code <> 'MAIN'
                             ORDER BY id LIMIT 1`));
  if (bank) {
    const k = await kassir('POST', '/api/cash/ops', {
      from_kind: 'account', from_id: kassa, to_kind: 'account', to_id: bank.id,
      currency: 'USD', amount: 10, op_date: '2026-09-22' });
    assert.equal(k.status, 200, k.text);
    const kid = (await H.id(`SELECT id FROM cash_ops ORDER BY id DESC LIMIT 1`)).id;
    assert.equal((await kassir('PATCH', `/api/cash/ops/${kid}/fix`,
      { op_date: '2026-09-23', expense_item_id: A, pl_month: '2026-09' })).status, 200);
    const kk = await H.id(`SELECT expense_item_id, pl_month FROM cash_ops WHERE id = $1`, [kid]);
    assert.equal(kk.expense_item_id, null, 'modda yozilmaydi');
    assert.equal(kk.pl_month, null);
  }

  //  Bekor qilingani tuzatilmaydi: u hisobdan chiqqan va tuzatish
  //  hech narsani o'zgartirmasdi.
  assert.equal((await kassir('PATCH', '/api/cash/ops/' + id)).status, 200);
  const bekor = await kassir('PATCH', `/api/cash/ops/${id}/fix`,
    { op_date: '2026-09-21', expense_item_id: B, pl_month: '2026-07' });
  assert.equal(bekor.status, 400);
  assert.match(bekor.body.error, /[Bb]ekor/);

  //  Menejerda `cash.manage` yo'q — tuzatish ham yo'q.
  const menejer = H.api(base, await H.sessionFor('Sinov menejer'));
  assert.equal((await menejer('PATCH', `/api/cash/ops/${id}/fix`,
    { op_date: '2026-09-21' })).status, 403);
});

//  ★ SUMMANI FAQAT ADMINISTRATOR TUZATADI (`cash.fix`). Kassirning
//  tuzatishi SARALASH xatosi uchun: pul to'g'ri ketgan, lekin
//  foyda-zararda boshqa qatorga tushgan. Summaning o'zi esa haqiqatda
//  bo'lib o'tgan harakat va u mijozning, ta'minotchining qarzi hamda
//  kassa qoldig'i bilan bir vaqtda o'zgaradi — shuning uchun huquqi
//  ALOHIDA va u faqat administratorda (`sales.fix` bilan bir xil
//  idiom va bir xil sabab).
test('kassa summasi: kassir tegolmaydi, administrator tuzatadi', async () => {
  const kassir = H.api(base, await H.sessionFor('Sinov kassir'));
  const admin = H.api(base, tokenAdmin);
  const kassa = (await H.id(`SELECT id FROM cash_accounts WHERE code='MAIN'`)).id;
  const tam = (await H.id(`SELECT id FROM suppliers ORDER BY id LIMIT 1`)).id;

  const oldinKassa = Number((await H.id(
    `SELECT total_usd FROM v_cash_balance WHERE code='MAIN'`)).total_usd);
  const oldinQarz = Number((await H.id(
    `SELECT balance FROM v_supplier_debt WHERE id = $1`, [tam])).balance);

  const r = await kassir('POST', '/api/cash/ops', {
    from_kind: 'account', from_id: kassa, to_kind: 'supplier', to_id: tam,
    currency: 'USD', amount: 500, op_date: '2026-09-20' });
  assert.equal(r.status, 200, r.text);
  const id = (await H.id(`SELECT id FROM cash_ops ORDER BY id DESC LIMIT 1`)).id;

  //  Kassirda `cash.fix` YO'Q: summa yuborilsa ham e'tiborga
  //  olinmaydi, qolgani esa (sana, izoh) eskicha tuzatiladi.
  const k = await kassir('PATCH', `/api/cash/ops/${id}/fix`,
    { op_date: '2026-09-21', amount: 900, currency: 'USD' });
  assert.equal(k.status, 200, k.text);
  assert.equal(Number((await H.id(
    `SELECT amount FROM cash_ops WHERE id = $1`, [id])).amount), 500,
    'kassir summaga tegolmaydi');

  //  Administratorda — ko'chadi, va u bilan BIRGA kassa qoldig'i
  //  hamda ta'minotchining qarzi: `amount_usd` GENERATED, ya'ni
  //  qayta hisoblanadigan narsa yo'q.
  const a = await admin('PATCH', `/api/cash/ops/${id}/fix`,
    { op_date: '2026-09-21', amount: 900, currency: 'USD' });
  assert.equal(a.status, 200, a.text);
  const o = await H.id(`SELECT amount, amount_usd, currency, rate
                          FROM cash_ops WHERE id = $1`, [id]);
  assert.equal(Number(o.amount), 900);
  assert.equal(Number(o.amount_usd), 900);
  assert.equal(Number((await H.id(
    `SELECT total_usd FROM v_cash_balance WHERE code='MAIN'`)).total_usd),
    oldinKassa - 900, 'kassadan 900 chiqdi');
  assert.equal(Number((await H.id(
    `SELECT balance FROM v_supplier_debt WHERE id = $1`, [tam])).balance),
    oldinQarz - 900, 'qarz 900 ga kamaydi');

  //  So'mga o'tkazilganda KURS majburiy: kursi yo'q so'm dollarga
  //  aylanmaydi va qator qiymatsiz qolardi.
  const kursiz = await admin('PATCH', `/api/cash/ops/${id}/fix`,
    { op_date: '2026-09-21', amount: 9000000, currency: 'UZS' });
  assert.equal(kursiz.status, 400);
  assert.match(kursiz.body.error, /[Kk]urs/);

  const soum = await admin('PATCH', `/api/cash/ops/${id}/fix`,
    { op_date: '2026-09-21', amount: 9000000, currency: 'UZS', rate: 11811.0236 });
  assert.equal(soum.status, 200, soum.text);
  const u = await H.id(`SELECT currency, amount_usd FROM cash_ops WHERE id = $1`, [id]);
  assert.equal(u.currency, 'UZS');
  assert.equal(Number(u.amount_usd), 762, 'tiyinli kurs bilan aynan 762 $');

  //  Nol yoki manfiy summa qabul qilinmaydi — yaratishdagi bilan
  //  AYNAN bir xil shart.
  assert.equal((await admin('PATCH', `/api/cash/ops/${id}/fix`,
    { op_date: '2026-09-21', amount: 0, currency: 'USD' })).status, 400);

  //  Tozalab ketamiz: qoldiq va qarz keyingi testlar uchun o'z
  //  holida qolsin.
  assert.equal((await kassir('PATCH', '/api/cash/ops/' + id)).status, 200);
  assert.equal(Number((await H.id(
    `SELECT total_usd FROM v_cash_balance WHERE code='MAIN'`)).total_usd), oldinKassa);
  assert.equal(Number((await H.id(
    `SELECT balance FROM v_supplier_debt WHERE id = $1`, [tam])).balance), oldinQarz);
});

//  ★ TA'MINOTCHIGA TO'LOV HAM HUJJAT BO'LIB OCHILADI (zavod qarori,
//  2026-10). Qarzdorlik lentasida to'lov raqami bosilsa kassa orderi
//  ochiladi — mijozning kirim orderi bilan BIR XIL sahifa, faqat
//  yo'nalishi teskari.
//
//  Ilgari lenta mijozning yo'liga ulangan edi va u
//  `from_kind = 'customer'` bilan qattiq bog'langan: ekranda «Hujjat
//  topilmadi» chiqardi. Test aynan shuni ushlab turadi.
test('ta\'minotchiga to\'lov kassa orderi bo\'lib ochiladi', async () => {
  const kassir = H.api(base, await H.sessionFor('Sinov kassir'));
  const admin = H.api(base, tokenAdmin);
  const kassa = (await H.id(`SELECT id FROM cash_accounts WHERE code='MAIN'`)).id;
  const tam = (await H.id(`SELECT id FROM suppliers ORDER BY id LIMIT 1`)).id;
  const modda = (await H.id(
    `SELECT id FROM expense_items WHERE needs_supplier LIMIT 1`)).id;

  const r = await kassir('POST', '/api/cash/ops', {
    from_kind: 'account', from_id: kassa, to_kind: 'supplier', to_id: tam,
    currency: 'USD', amount: 250, op_date: '2026-09-18',
    expense_item_id: modda, pl_month: '2026-09' });
  assert.equal(r.status, 200, r.text);
  const id = (await H.id(`SELECT id FROM cash_ops ORDER BY id DESC LIMIT 1`)).id;

  //  Hujjat ochiladi va ichida solishtirish uchun kerak bo'lgani turadi.
  const d = await admin('GET', '/api/purchasing/payment/' + id);
  assert.equal(d.status, 200, d.text);
  assert.equal(d.body.op.doc_no, r.body.doc_no);
  assert.equal(Number(d.body.op.amount_usd), 250);
  assert.ok(d.body.op.supplier_name, 'kimga to\'langani yoziladi');
  //  Pul QAYERDAN chiqqani: kassadan yoki podotchyot olgan xodimdan.
  assert.ok(d.body.op.qarshi, 'qaysi kassadan');
  //  Foyda-zararda qaysi qatorda turgani ham hujjatda.
  assert.ok(d.body.op.expense_item);
  assert.equal(d.body.op.pl_month, '2026-09');

  //  ★ MIJOZNING YO'LI buni TOPMAYDI, va aynan shu yerda ekranda
  //  «Hujjat topilmadi» chiqardi: so'rov `from_kind = 'customer'` ga
  //  bog'langan.
  assert.equal((await admin('GET', '/api/sales/payment/' + id)).status, 404);

  //  Lentadagi qator o'sha hujjatga olib boradi: ekrandagi havola
  //  `op_id` dan quriladi va u bo'sh bo'lsa raqam umuman bosilmasdi.
  const lenta = (await admin('GET',
    `/api/purchasing/debts/${tam}?from=2026-09-01&to=2026-09-30`)).body;
  const qator = lenta.rows.find((x) => x.op_id === id);
  assert.ok(qator, 'to\'lov lentada turadi');
  assert.equal(qator.kind, 'payment');
  assert.equal(Number(qator.debit), 250, 'qarzdor tomonda \u2014 qarzimiz kamaydi');

  //  Tozalab ketamiz: keyingi testlar qoldiqni o'z holida topsin.
  assert.equal((await kassir('PATCH', '/api/cash/ops/' + id)).status, 200);
});

//  ★ XOM ASHYO QOLDIG'I HAM AYLANMA (zavod qarori, 2026-10). Mudir
//  javondagi raqamni ko'radi-yu, «shu oyda qancha keldi» degan
//  savolga javob topolmasdi — harakatlar tabiga o'tib, bitta
//  material bo'yicha ko'z bilan qo'shib chiqish kerak edi. Tayyor
//  mahsulot qoldig'idagi bilan AYNAN bir xil qoida, shuning uchun
//  test ham o'sha ikki narsani tekshiradi: kirdi/chiqdi
//  ORALIQNIKI, qoldiq esa HOZIRGI holat.
test('xom ashyo qoldig\'ida oraliq: aylanma oraliqniki, qoldiq hozirgi',
  async () => {
  const xom = await xodim('Sinov aylanma xodim', 'xom_ombor');
  //  Kirim FAQAT zavod omboriga yoziladi (izoh: modules/materials.js),
  //  shuning uchun tsex ombori emas.
  const wh = (await H.id(`SELECT id FROM warehouses WHERE code = 'XOM'`)).id;
  const tam = (await H.id(`SELECT id FROM suppliers ORDER BY id LIMIT 1`)).id;
  const m = (await xom('POST', '/api/materials',
    { name: 'Aylanma sinov yelimi', uom: 'kg', category: 'FURN' })).body;

  //  Sentabrda 100 boshlang'ich qoldiq, oktabrda 40 kirim.
  assert.equal((await xom('POST', '/api/materials/opening', {
    on: '2026-09-05',
    items: [{ warehouse_id: wh, material_id: m.id, qty: 100 }] })).status, 200);
  const k = await xom('POST', '/api/materials/receipts', {
    supplier_id: tam, warehouse_id: wh, doc_on: '2026-10-03',
    items: [{ material_id: m.id, qty: 40, price: 5 }] });
  assert.equal(k.status, 200, k.text);

  const qator = async (q) => (await xom('GET', '/api/materials/stock' + q))
    .body.rows.find((r) => r.material_id === m.id);

  //  ★ ORALIQ BERILMASA aylanma NOL bo'lib keladi: so'ralmagan
  //  savolga javob yozilmaydi va ro'yxat eskicha turaveradi.
  const hammasi = await qator('');
  assert.ok(hammasi, 'javonda turgani ro\'yxatda');
  assert.equal(Number(hammasi.qty), 140, 'javonda 100 + 40');
  assert.equal(Number(hammasi.kirdi), 0, 'oraliqsiz aylanma so\'ralmaydi');
  assert.equal(Number(hammasi.chiqdi), 0);

  //  SENTABR: faqat boshlang'ich qoldiq tushadi.
  const sen = await qator('?from=2026-09-01&to=2026-09-30');
  assert.equal(Number(sen.kirdi), 100, 'sentabrda 100 kirdi');
  assert.equal(Number(sen.chiqdi), 0);
  //  ★ Qoldiq ORALIQQA BOG'LIQ EMAS — u hozirgi holat.
  assert.equal(Number(sen.qty), 140, 'qoldiq oraliqdan qat\'i nazar bir xil');

  //  OKTABR: faqat kirim hujjati.
  const okt = await qator('?from=2026-10-01&to=2026-10-31');
  assert.equal(Number(okt.kirdi), 40, 'oktabrda 40 kirdi');
  assert.equal(Number(okt.qty), 140);

  //  Oraliqdan tashqarida aylanma nol, lekin qator YO'QOLMAYDI:
  //  javonda turgani baribir ko'rinishi kerak.
  const yoq = await qator('?from=2026-11-01&to=2026-11-30');
  assert.ok(yoq, 'javondagi material oraliqsiz oyda ham turadi');
  assert.equal(Number(yoq.kirdi), 0);
  assert.equal(Number(yoq.qty), 140);

  //  Qidiruv KOD bo'yicha ham ishlaydi: mudir ko'pincha kodni
  //  yozadi va ilgari so'rov faqat nomni qidirardi.
  await H.id(`UPDATE materials SET code = 'AYL-77' WHERE id = $1`, [m.id]);
  assert.ok(await qator('?q=AYL-77'), 'kod bo\'yicha topiladi');
  assert.ok(await qator('?q=Aylanma sinov'), 'nomi bo\'yicha ham');
});

test('tsex omborida narx: ko\'chirishda qator bilan ketadi', async () => {
  //  ★ NARX OMBORDAN OMBORGA KO'CHADI (izoh: sql/materials.sql).
  //  Tsex omboriga material talabnoma bilan keladi va o'sha qatorda
  //  narx yozilmasdi — tsex javonining qiymati HAR DOIM bo'sh
  //  chiqardi va «tsexda qancha pul turibdi» degan savolga javob
  //  yo'q edi.
  const { db } = require('../db');
  const xom = await xodim('Sinov tsex narx xodim', 'xom_ombor');
  await xodim('Sinov tsex narx boshliq', 'tsex_usta');
  //  Tsex boshlig'ining DOIRASI bor (talabnoma testi bilan bir xil):
  //  u faqat o'z tsexining omboriga so'raydi.
  await db.query(
    `UPDATE worker_roles SET scope_shop_id = (SELECT id FROM shops WHERE code='KORPUS')
      WHERE role_code = 'tsex_usta'
        AND worker_id = (SELECT id FROM workers WHERE name = 'Sinov tsex narx boshliq')`);
  const bosh = H.api(base, await H.sessionFor('Sinov tsex narx boshliq'));
  const zavod = (await H.id(`SELECT id FROM warehouses WHERE code = 'XOM'`)).id;
  const tsexWh = (await H.id(
    `SELECT id FROM warehouses WHERE code = 'TSEX-KOR-ARRA'`)).id;
  const m = (await xom('POST', '/api/materials',
    { name: 'Narx ko\'chish sinovi', uom: 'list', category: 'LDSP' })).body;

  //  Zavod omborida 100 list, listi 20 $ (so'mda yozilgani kurs bilan).
  assert.equal((await xom('POST', '/api/materials/opening', {
    ccy: 'UZS', rate: 12500,
    items: [{ warehouse_id: zavod, material_id: m.id, qty: 100,
              price: 250000 }] })).status, 200);

  const qator = async (whId) => (await xom(
    'GET', '/api/materials/stock?warehouse_id=' + whId))
    .body.rows.find((r) => r.material_id === m.id);
  assert.equal(Number((await qator(zavod)).price), 20);

  //  Talabnoma bilan tsexga 30 list.
  const t = await bosh('POST', '/api/materials/requests', {
    shop_warehouse_id: tsexWh, factory_warehouse_id: zavod,
    items: [{ material_id: m.id, qty: 30 }] });
  assert.equal(t.status, 200, t.text);
  assert.equal((await xom('POST',
    `/api/materials/requests/${t.body.id}/ready`)).status, 200);
  assert.equal((await xom('POST',
    `/api/materials/requests/${t.body.id}/done`, {})).status, 200);

  //  ★ TSEXDA ENDI NARX BOR va u manba omborning o'rtachasi.
  const tx = await qator(tsexWh);
  assert.equal(Number(tx.qty), 30);
  assert.equal(Number(tx.price), 20, 'narx manba omborning o\'rtachasi');
  assert.equal(Number(tx.amount), 600, '30 \u00d7 20 $');

  //  ★ MANBA OMBORNING NARXI O'ZGARMAYDI: chiqim qatorlari
  //  o'rtachaga umuman qo'shilmaydi (`WHERE f.qty > 0`).
  const zv = await qator(zavod);
  assert.equal(Number(zv.qty), 70);
  assert.equal(Number(zv.price), 20, 'manba omborning narxi qimirlamadi');

  //  ★ NARX QATOR BILAN QOTADI. Zavod omboriga qimmatroq kirim
  //  kelsa uning o'rtachasi ko'tariladi, tsexga KECHA ketgan
  //  material esa qayta baholanmaydi — kursning operatsiya bilan
  //  qotishi bilan bir xil idiom.
  const tam = (await H.id(`SELECT id FROM suppliers ORDER BY id LIMIT 1`)).id;
  assert.equal((await xom('POST', '/api/materials/receipts', {
    supplier_id: tam, warehouse_id: zavod,
    items: [{ material_id: m.id, qty: 70, price: 40 }] })).status, 200);
  //  O'rtacha KIRGAN dona bo'yicha, qoldiq bo'yicha emas: chiqib
  //  ketgani o'rtachaga ham, maxrajga ham qo'shilmaydi.
  //  (100 \u00d7 20 + 70 \u00d7 40) / 170 = 28,2353 $
  assert.equal(Number((await qator(zavod)).price), 28.2353);
  assert.equal(Number((await qator(tsexWh)).price), 20,
    'tsexdagi eski narx qayta baholanmaydi');

  //  Narxi yo'q materialda qator NARXSIZ qoladi: nol yozish «bepul»
  //  degani bo'lardi va tsexning qiymati jimgina pasayib borardi.
  const m2 = (await xom('POST', '/api/materials',
    { name: 'Narxsiz ko\'chish sinovi', uom: 'kg' })).body;
  assert.equal((await xom('POST', '/api/materials/opening', {
    items: [{ warehouse_id: zavod, material_id: m2.id, qty: 50 }] })).status, 200);
  const t2 = await bosh('POST', '/api/materials/requests', {
    shop_warehouse_id: tsexWh, factory_warehouse_id: zavod,
    items: [{ material_id: m2.id, qty: 10 }] });
  assert.equal((await xom('POST',
    `/api/materials/requests/${t2.body.id}/ready`)).status, 200);
  assert.equal((await xom('POST',
    `/api/materials/requests/${t2.body.id}/done`, {})).status, 200);
  const nx = (await xom('GET', '/api/materials/stock?warehouse_id=' + tsexWh))
    .body.rows.find((r) => r.material_id === m2.id);
  assert.equal(Number(nx.qty), 10);
  assert.equal(nx.price, null, 'narxsiz material narxsiz ko\'chadi');
});

test('qoldiqni to\'g\'rilash: minus nolga keladi, hujjat bo\'lib qoladi',
  async () => {
  const xom = await xodim('Sinov tuzatish xodim', 'xom_ombor');
  const wh = (await H.id(`SELECT id FROM warehouses WHERE code = 'XOM'`)).id;
  const m = (await xom('POST', '/api/materials',
    { name: 'Tuzatish sinov smolasi', uom: 'kg', category: 'FURN' })).body;

  const qator = async () => (await xom('GET', '/api/materials/stock'))
    .body.rows.find((r) => r.material_id === m.id);

  //  Minusga tushirish: boshlang'ich qoldiqsiz sarf yoziladi. Bu
  //  ataylab mumkin \u2014 material allaqachon kesilgan va yozuvni
  //  rad etish taxtani qaytarmaydi (izoh: `minus_material`).
  const usta = await xodim('Sinov tuzatish ustasi', 'tsex_usta');
  //  Sarfni tsex boshlig'i yozadi, lekin bu test uchun ombordan
  //  to'g'ridan-to'g'ri chiqim yetarli: qoldiq minusga tushsa bo'ldi.
  await H.id(`INSERT INTO material_moves
                (material_id, qty, from_kind, from_id, to_kind, moved_on)
              VALUES ($1, 30, 'warehouse', $2, 'writeoff', CURRENT_DATE)
              RETURNING id`, [m.id, wh]);
  assert.equal(Number((await qator()).qty), -30, 'qoldiq minusda');

  //  ★ SABAB MAJBURIY: tuzatish ombor qiymatiga tegadi va «nega
  //  nolga tushdi» degan savol keyin beriladi.
  const sz = await xom('POST', '/api/materials/adjust',
    { items: [{ warehouse_id: wh, material_id: m.id, to_qty: 0 }] });
  assert.equal(sz.status, 400, sz.text);
  assert.match(sz.body.error, /[Ss]abab/);

  //  ★ NECHTA BO'LISHI KERAKLIGI yuboriladi, farqni SERVER hisoblaydi.
  const ok = await xom('POST', '/api/materials/adjust', {
    note: 'sanoq \u2014 hujjati topilmadi',
    items: [{ warehouse_id: wh, material_id: m.id, to_qty: 0 }] });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body.saved, 1);
  //  ★ QOLDIQDAN BUTUNLAY CHIQADI: `v_material_stock` nolni tashlab
  //  yuboradi (`HAVING SUM(qty) <> 0`), ya'ni qator ro'yxatda
  //  qolmaydi \u2014 minus ham, nol ham ko'rinmaydi.
  assert.equal(await qator(), undefined, 'nolga kelgan qator qoldiqda yo\'q');

  //  ★ RAQAM JIMGINA O'ZGARMAYDI \u2014 TARIXDA QATOR BO'LIB QOLADI,
  //  sababi, sanasi va kim yozgani bilan.
  const mv = (await xom('GET', '/api/materials/moves')).body.rows
    .find((r) => r.material === 'Tuzatish sinov smolasi'
               && r.from_kind === 'writeoff');
  assert.ok(mv, 'tuzatish tarixda turadi');
  assert.equal(mv.to_kind, 'warehouse', 'minusda ombor QABUL qiluvchi tomon');
  assert.equal(Number(mv.qty), 30);
  assert.match(mv.note, /sanoq/);

  //  ★ FARQI YO'Q QATOR O'TKAZIB YUBORILADI, xato emas: ro'yxat
  //  ochilgandan keyin kirim yozilgan bo'lishi mumkin.
  const yana = await xom('POST', '/api/materials/adjust', {
    note: 'ikkinchi marta',
    items: [{ warehouse_id: wh, material_id: m.id, to_qty: 0 }] });
  assert.equal(yana.status, 400, yana.text);
  assert.match(yana.body.error, /yo'q/);

  //  Teskari yo'nalish ham SHU yo'ldan: javonda ortiqcha chiqsa
  //  ombor BERUVCHI tomon bo'ladi (ikkita mexanizm yozilmadi).
  assert.equal((await xom('POST', '/api/materials/opening', {
    items: [{ warehouse_id: wh, material_id: m.id, qty: 50 }] })).status, 200);
  const kam = await xom('POST', '/api/materials/adjust', {
    note: 'sanoqda 42 chiqdi',
    items: [{ warehouse_id: wh, material_id: m.id, to_qty: 42 }] });
  assert.equal(kam.status, 200, kam.text);
  assert.equal(Number((await qator()).qty), 42, 'sanoqdagi songa keldi');
  const ch = (await xom('GET', '/api/materials/moves')).body.rows
    .find((r) => r.material === 'Tuzatish sinov smolasi'
               && r.to_kind === 'writeoff' && Number(r.qty) === 8);
  assert.ok(ch, 'ortiqchasi hisobdan chiqdi');

  //  ★ BEKOR QILISH BORLIGI \u2014 boshlang'ich qoldiq bilan BITTA
  //  yo'ldan: ikkalasi ham hujjatsiz harakat va ikkinchi yo'l
  //  yozilsa bir kun biri ikkinchisidan ajralib ketardi.
  assert.equal((await xom('POST', `/api/materials/moves/${ch.id}/cancel`))
    .status, 200);
  assert.equal(Number((await qator()).qty), 50, 'bekor qilingach qaytdi');

  //  Huquq: sarfni yozadigan tsex boshlig'ida `materials.manage` yo'q.
  const rad = await usta('POST', '/api/materials/adjust', {
    note: 'sinov', items: [{ warehouse_id: wh, material_id: m.id, to_qty: 0 }] });
  assert.equal(rad.status, 403, rad.text);
});

test('kassa lentasida oraliq: boshiga + kirim \u2212 chiqim = oxiriga',
  async () => {
  //  ★ Tepadagi kartochkalar BUGUNGI qoldiqni ko'rsatadi; oraliq
  //  tanlangach savol boshqa bo'ladi \u2014 «sentabr oxirida qancha
  //  edi» (izoh: modules/cash.js, davrHisobi).
  const { db } = require('../db');
  const kassir = await xodim('Sinov davr kassir', 'buxgalter');
  const acc = (await H.id(
    `SELECT id, code FROM cash_accounts WHERE code = 'MAIN'`));
  const mijoz = (await H.id(
    `INSERT INTO customers (name) VALUES ('Sinov davr mijozi') RETURNING id`)).id;

  //  Boshlang'ich qoldiqni TOZA holatga keltirmaymiz \u2014 boshqa
  //  testlar ham shu kassaga yozadi. Shuning uchun oldin va keyin
  //  o'qib, AYIRMASI tekshiriladi.
  const davr = async (q) => (await kassir('GET', '/api/cash/ops?a=MAIN&' + q))
    .body.davr;

  const oldin = await davr('from=2026-07-01&to=2026-07-31');
  assert.ok(oldin, 'oraliq tanlanganda davr hisobi keladi');

  //  Iyul oyiga ikkita operatsiya: 300 $ kirim va 120 $ chiqim.
  const kir = await kassir('POST', '/api/cash/ops', {
    from_kind: 'customer', from_id: mijoz, to_kind: 'account', to_id: acc.id,
    currency: 'USD', amount: 300, op_date: '2026-07-10' });
  assert.equal(kir.status, 200, kir.text);
  const item = (await H.id(
    `SELECT id FROM expense_items WHERE active ORDER BY id LIMIT 1`)).id;
  const chiq = await kassir('POST', '/api/cash/ops', {
    from_kind: 'account', from_id: acc.id, to_kind: 'expense',
    expense_item_id: item, pl_month: '2026-07-01',
    currency: 'USD', amount: 120, op_date: '2026-07-20' });
  assert.equal(chiq.status, 200, chiq.text);

  const iyul = await davr('from=2026-07-01&to=2026-07-31');
  assert.equal(Number(iyul.kirim.total_usd) - Number(oldin.kirim.total_usd), 300);
  assert.equal(Number(iyul.chiqim.total_usd) - Number(oldin.chiqim.total_usd), 120);
  //  ★ boshiga + kirim \u2212 chiqim = oxiriga
  assert.equal(
    Number((Number(iyul.bosh.total_usd) + Number(iyul.kirim.total_usd)
          - Number(iyul.chiqim.total_usd)).toFixed(2)),
    Number(iyul.oxir.total_usd));

  //  ★ AVGUST: iyulning ikkala operatsiyasi «davr boshiga» ga o'tadi
  //  va aylanmada QOLMAYDI.
  const avg = await davr('from=2026-08-01&to=2026-08-31');
  assert.equal(Number(avg.bosh.total_usd), Number(iyul.oxir.total_usd),
    'oldingi davrning oxiri keyingisining boshi');

  //  ★ ORALIQ OXIRIGA tanlangan kunning qoldig'i chiqadi, bugungisi
  //  emas: iyul oxiriga 20-iyuldagi chiqim ham kirgan.
  const yarim = await davr('from=2026-07-01&to=2026-07-15');
  assert.equal(
    Number(yarim.oxir.total_usd),
    Number((Number(iyul.oxir.total_usd) + 120).toFixed(2)),
    '15-iyulga 20-iyuldagi chiqim hali bo\'lmagan');

  //  ★ QIDIRUV VA TAB raqamlarga TA'SIR QILMAYDI: qoldiq joydagi
  //  pulning javobi, lentadagi qatorlarning emas.
  const q = (await kassir('GET',
    '/api/cash/ops?a=MAIN&from=2026-07-01&to=2026-07-31&dir=in&q=zzz')).body;
  assert.equal(q.rows.length, 0, 'qidiruv lentani bo\'shatdi');
  assert.equal(Number(q.davr.oxir.total_usd), Number(iyul.oxir.total_usd),
    'qoldiq esa o\'sha holda qoladi');

  //  Oraliq berilmasa davr hisobi ham chiqadi va oxiri BUGUNGI
  //  qoldiqqa teng bo'ladi (tepadagi kartochka bilan bir xil raqam).
  const hammasi = (await kassir('GET', '/api/cash/ops?a=MAIN')).body.davr;
  const bal = (await kassir('GET', '/api/cash/balance')).body.accounts
    .find((a) => a.id === acc.id);
  assert.equal(Number(hammasi.oxir.total_usd), Number(bal.total_usd),
    'oraliqsiz oxiri \u2014 bugungi qoldiq');
  await db.query(`DELETE FROM customers WHERE id = $1`, [mijoz])
    .catch(() => {});
});

test('bekor qilingan sarf tiklanadi \u2014 o\'sha qatorning o\'zi',
  async () => {
  //  ★ «×» bexosdan bosiladi va qaytaradigan joy yo'q edi: yagona
  //  chora sarfni QAYTADAN yozish bo'lardi \u2014 tarixda ikkita
  //  qator qolardi, biri bekor qilingan, ikkinchisi boshqa sana va
  //  boshqa odam bilan (izoh: modules/materials.js).
  const xom = await xodim('Sinov tiklash xodim', 'xom_ombor');
  const wh = (await H.id(
    `SELECT id FROM warehouses WHERE code = 'TSEX-KOR-ARRA'`)).id;
  const m = (await xom('POST', '/api/materials',
    { name: 'Tiklash sinov gruntofkasi', uom: 'kg', category: 'FURN' })).body;
  assert.equal((await xom('POST', '/api/materials/opening', {
    items: [{ warehouse_id: wh, material_id: m.id, qty: 40 }] })).status, 200);

  const u = await newUnit();
  await admin('POST', '/api/units/move', { unit_id: u.id, section_code: 'ARRA' });

  const c = await admin('POST', `/api/materials/unit/${u.id}/consume`,
    { warehouse_id: wh, items: [{ material_id: m.id, qty: 6 }] });
  assert.equal(c.status, 200, c.text);

  const sarf = async () => (await admin('GET', '/api/materials/unit/' + u.id))
    .body.rows.find((r) => r.material === 'Tiklash sinov gruntofkasi');
  const qoldiq = async () => Number(((await xom('GET',
    '/api/materials/stock?warehouse_id=' + wh)).body.rows
    .find((r) => r.material_id === m.id) || {}).qty || 0);

  const mv = await sarf();
  assert.equal(Number(mv.qty), 6);
  assert.equal(await qoldiq(), 34, 'sarf qoldiqdan chiqdi');

  //  Bekor qilish: qator TARIXDA qoladi, qoldiq qaytadi.
  assert.equal((await admin('POST', `/api/materials/consume/${mv.id}/cancel`))
    .status, 200);
  assert.equal((await sarf()).status, 'cancelled');
  assert.equal(await qoldiq(), 40, 'bekor qilingach qoldiq qaytdi');

  //  ★ TIKLASH: yangi qator YOZILMAYDI \u2014 o'sha qatorning o'zi
  //  `ok` ga qaytadi, sanasi ham, soni ham o'zgarmaydi.
  const t = await admin('POST', `/api/materials/consume/${mv.id}/restore`);
  assert.equal(t.status, 200, t.text);
  const keyin = await sarf();
  assert.equal(keyin.id, mv.id, 'o\'sha qatorning o\'zi');
  assert.equal(keyin.status, 'ok');
  assert.equal(Number(keyin.qty), 6, 'soni o\'zgarmadi');
  assert.equal(Number(keyin.moved_on === mv.moved_on), 1, 'sanasi o\'zgarmadi');
  assert.equal(await qoldiq(), 34, 'qoldiqdan yana chiqdi');
  assert.equal((await admin('GET', '/api/materials/unit/' + u.id)).body.rows
    .filter((r) => r.material === 'Tiklash sinov gruntofkasi').length, 1,
    'ikkinchi qator yozilmadi');

  //  Ikkinchi marta tiklab bo'lmaydi: u allaqachon `ok`.
  assert.equal((await admin('POST', `/api/materials/consume/${mv.id}/restore`))
    .status, 404);

  //  Boshlang'ich qoldiq qatori ham shu yo'ldan qaytadi.
  const op = (await xom('GET', '/api/materials/moves')).body.rows
    .find((r) => r.material === 'Tiklash sinov gruntofkasi'
               && r.from_kind === 'opening');
  assert.equal((await xom('POST', `/api/materials/moves/${op.id}/cancel`))
    .status, 200);
  assert.equal(await qoldiq(), -6, 'boshlang\'ich qoldiqsiz minusga tushdi');
  assert.equal((await xom('POST', `/api/materials/moves/${op.id}/restore`))
    .status, 200);
  assert.equal(await qoldiq(), 34, 'tiklangach qaytdi');
});

test('minus_cash kaliti YOQIQ tug\'iladi', async () => {
  //  ★ Yozilgan, lekin yoqilmagan qoida — yozilmagan qoida bilan bir
  //  xil (zavod qarori, 2026-10). Kalit o'chiq tug'ilgani uchun u
  //  saytda ham o'chiq turdi va kassa qoldig'i o'tmishda minusga
  //  tushib ketdi; buni faqat oraliq hisoboti ochilganda ko'rindi.
  //  Migratsiyadan KEYINGI holat — sinov uchun o'chirilishidan oldin
  //  o'qib olingani (izoh: test/helper.js).
  assert.equal(H.seedMinusCash, true, 'kassa kaliti yoqiq tug\'iladi');
  assert.ok((await admin('GET', '/api/admin/settings')).body.rows
    .some((x) => x.kod === 'minus_cash'), 'kalit ro\'yxatda turadi');

  //  Bir martalik yoqish bayrog'i: ishlayotgan bazada qator allaqachon
  //  bor va `ON CONFLICT DO NOTHING` unga tegmasdi — ya'ni standart
  //  faqat toza bazaga tushardi va saytdagi kalit o'chiq qolaverardi.
  assert.ok(await H.id(
    `SELECT key FROM migration_flags WHERE key = 'kassa-minus-yoq'`),
    'bir martalik yoqish bayrog\'i qo\'yilgan');

  //  Ombornikida sabab boshqa va u O'CHIQ qolaveradi: deploy kuni
  //  o'ttizta material minusda turardi va to'siq tsexni to'xtatardi.
  assert.equal((await admin('GET', '/api/admin/settings')).body.rows
    .find((x) => x.kod === 'minus_material').on, false,
    'ombor kaliti eskicha o\'chiq');
});

test('oraliq oxiridagi qoldiq: ombor ham, xom ashyo ham', async () => {
  //  ★ Qoldiq USTUNI hozirgi holat va u shunday qoladi; oraliq
  //  tanlangach savol boshqa bo'ladi \u2014 «o'sha kuni javonda
  //  nechta turgan edi» (izoh: modules/warehouse.js, modules/materials.js).
  //
  //      boshiga + kirdi \u2212 chiqdi = oxiriga
  const xom = await xodim('Sinov oraliq xodim', 'xom_ombor');
  const wh = (await H.id(`SELECT id FROM warehouses WHERE code = 'XOM'`)).id;
  const tam = (await H.id(`SELECT id FROM suppliers ORDER BY id LIMIT 1`)).id;
  const m = (await xom('POST', '/api/materials',
    { name: 'Oraliq sinov lagi', uom: 'kg', category: 'FURN' })).body;

  //  Sentabrda 100 boshlang'ich qoldiq, oktabrda 40 kirim.
  assert.equal((await xom('POST', '/api/materials/opening', {
    on: '2026-09-05',
    items: [{ warehouse_id: wh, material_id: m.id, qty: 100 }] })).status, 200);
  assert.equal((await xom('POST', '/api/materials/receipts', {
    supplier_id: tam, warehouse_id: wh, doc_on: '2026-10-03',
    items: [{ material_id: m.id, qty: 40, price: 5 }] })).status, 200);

  const q = async (s) => (await xom('GET', '/api/materials/stock' + s))
    .body.rows.find((r) => r.material_id === m.id);

  //  SENTABR: boshiga 0, kirdi 100, oxiriga 100 \u2014 oktabrdagi
  //  kirim hali bo'lmagan, qoldiq ustuni esa BUGUNGI 140 bo'lib
  //  turaveradi.
  const sen = await q('?from=2026-09-01&to=2026-09-30');
  assert.equal(Number(sen.bosh), 0);
  assert.equal(Number(sen.kirdi), 100);
  assert.equal(Number(sen.oxir), 100, 'sentabr oxiriga 100');
  assert.equal(Number(sen.qty), 140, 'qoldiq ustuni \u2014 hozirgi holat');

  //  OKTABR: sentabrniki «davr boshiga» ga o'tadi va aylanmada
  //  QOLMAYDI \u2014 qarzdorlik hisoboti bilan bir xil qoida.
  const okt = await q('?from=2026-10-01&to=2026-10-31');
  assert.equal(Number(okt.bosh), 100, 'oldingi davrning oxiri \u2014 boshi');
  assert.equal(Number(okt.kirdi), 40);
  assert.equal(Number(okt.oxir), 140);

  //  Oraliqdan OLDINGI kun: hali hech narsa kelmagan.
  const avg = await q('?from=2026-08-01&to=2026-08-31');
  assert.equal(Number(avg.oxir), 0, 'avgust oxiriga javonda yo\'q edi');

  // ── TAYYOR MAHSULOT OMBORI: aynan shu idiom ────────────────────────
  //  Rangi ATAYLAB yagona: qator mahsulot + rang + mato bo'yicha
  //  guruhlanadi va boshqa testlarning konverlari bilan qo'shilib
  //  ketsa raqam o'sha testlarga bog'lanib qolardi.
  const u = await newUnit({ qty: 7, color: 'Oraliq sinov rangi' });
  await H.id(`UPDATE production_units SET status = 'fg', fg_on = '2026-09-10',
                     current_section_id = NULL WHERE id = $1`, [u.id]);
  const fg = async (s) => (await admin('GET', '/api/warehouse/fg/summary' + s)).body;

  const pid = (await H.id(
    `SELECT product_id FROM production_units WHERE id = $1`, [u.id])).product_id;
  const s9 = await fg('?from=2026-09-01&to=2026-09-30');
  const r9 = s9.rows.find((r) => r.product_id === pid
    && r.color === 'Oraliq sinov rangi');
  assert.ok(r9, 'sentabrda kelgani qatorda turadi');
  assert.equal(Number(r9.kirdi), 7, 'sentabrda kirdi');
  assert.equal(Number(r9.oxir), 7, 'sentabr oxiriga javonda turgan');

  //  ★ ORALIQDAN OLDINGI oy: o'sha kuni omborda YO'Q edi.
  const s8 = await fg('?from=2026-08-01&to=2026-08-31');
  const r8 = s8.rows.find((r) => r.product_id === pid
    && r.color === 'Oraliq sinov rangi');
  assert.equal(r8 ? Number(r8.oxir) : 0, 0, 'avgust oxiriga omborda yo\'q');

  //  ★ boshiga + kirdi \u2212 chiqdi = oxiriga \u2014 YIG'INDIDA ham,
  //  va u SERVERDA hisoblanadi: ikki joyda yozilgan shart bir kun
  //  ajralib ketardi.
  (s9.total.by_uom || []).forEach((x) => assert.equal(
    Number(x.bosh) + Number(x.kirdi) - Number(x.chiqdi), Number(x.oxir),
    `${x.uom}: yig'indi ham tenglikni saqlaydi`));
  assert.equal(Number(s9.total.bosh) + Number(s9.total.kirdi)
             - Number(s9.total.chiqdi), Number(s9.total.oxir));
});

test('yakun', async () => {
  server.close();
  await require('../db').db.end();
});
