-- ============================================================================
--  KASSA — pul harakati
--
--  Zavodda ikkita pul joyi bor: ASOSIY KASSA (naqd) va BANK hisob raqami.
--  Ikkalasida ham so'm va dollar yuriydi. Hisob-kitob esa DOLLARDA: so'mda
--  kelgan pul o'sha operatsiyaning kursi bilan dollarga aylanadi va
--  mijozning (yoki ta'minotchining) qarzidan SHU dollar ayiriladi. Kurs
--  operatsiya bilan birga saqlanadi — ertaga kurs o'zgarsa kechagi to'lov
--  qayta hisoblanmaydi.
--
--  ★ HAR OPERATSIYA — QAYERDAN → QAYERGA
--
--  Pul o'zidan-o'zi paydo bo'lmaydi va yo'qolmaydi: u bir joydan ikkinchi
--  joyga ko'chadi. Shuning uchun bitta jadval va har qatorda ikki tomon.
--  Tomon beshta turdan biri:
--
--    account   — kassa yoki bank hisobi
--    worker    — XODIMNING QO'LIDAGI PUL: menejer mijozdan olgan,
--                lekin kassirga topshirmagan pul ham shu yerda
--    customer  — mijoz
--    supplier  — ta'minotchi
--    expense   — harajat (pul tizimdan chiqib ketdi)
--
--  Zavoddagi hamma harakat shu ikkilik bilan yoziladi:
--
--    menejer mijozdan pul oldi      mijoz    → menejer
--    kassir menejerdan qabul qildi  menejer  → asosiy kassa
--    mijoz to'g'ridan kassaga to'ladi mijoz  → asosiy kassa
--    xodim qo'liga pul berildi      kassa    → xodim
--    xodim qoldiqni qaytardi        xodim    → kassa
--    ta'minotchiga to'lov           kassa    → ta'minotchi
--    harajat                        kassa    → harajat moddasi
--    kassalar aro / valyuta almashish  kassa → kassa
--
--  ★ MENEJER OLGAN PUL DARROV KASSAGA TUSHMAYDI
--
--  Menejer mijozdan pulni oldi — mijozning qarzi O'SHA ZAHOTI kamayadi
--  (mijoz to'ladi, uning oldida savol qolmadi). Lekin pul hali kassada
--  emas, MENEJERNING qo'lida: u kassirga topshirguncha korxonaga qarzdor
--  bo'lib turadi. Kassir sanab olgach ikkinchi operatsiya yoziladi va pul
--  asosiy kassaga qo'shiladi.
--
--  Ikki bosqich tsexdagi topshirish bilan bir xil sababdan: hech kimning
--  qo'l ko'tarishisiz pul kassaga kirib qolmasin.
-- ============================================================================

-- ─────────────────────────────────────────────────────────── KASSALAR
--
--  Ro'yxat BAZADA, kodda emas — yangi hisob raqami ochilsa shu faylga
--  bitta qator qo'shiladi, sahifaga tegilmaydi (omborlar bilan bir xil).
CREATE TABLE IF NOT EXISTS cash_accounts (
  id        SERIAL PRIMARY KEY,
  code      TEXT UNIQUE NOT NULL,
  name      TEXT NOT NULL,
  --  cash — naqd pul sanaladigan kassa; bank — hisob raqami
  kind      TEXT NOT NULL DEFAULT 'cash' CHECK (kind IN ('cash', 'bank')),
  sort      INT  NOT NULL DEFAULT 100,
  is_active BOOLEAN NOT NULL DEFAULT true,
  note      TEXT
);

--  ★ BOSHLANG'ICH QOLDIQ — tizim ishga tushgan kundagi pul. Bir
--  martalik raqam, hisoblanmaydi: undan keyingi hamma narsa
--  operatsiyalardan chiqadi. Mijozning `opening_debt` i bilan bir xil
--  mantiq — shusiz kassa birinchi kundanoq minusda turardi.
ALTER TABLE cash_accounts ADD COLUMN IF NOT EXISTS opening_uzs  NUMERIC(18,2) NOT NULL DEFAULT 0;
ALTER TABLE cash_accounts ADD COLUMN IF NOT EXISTS opening_usd  NUMERIC(16,2) NOT NULL DEFAULT 0;
--  So'mdagi boshlang'ich qoldiqni dollarga aylantiradigan kurs: o'sha
--  kundagi kurs, keyin o'zgarmaydi.
ALTER TABLE cash_accounts ADD COLUMN IF NOT EXISTS opening_rate NUMERIC(14,4);
ALTER TABLE cash_accounts ADD COLUMN IF NOT EXISTS opening_on   DATE;

INSERT INTO cash_accounts (code, name, kind, sort) VALUES
  ('MAIN', 'Asosiy kassa',       'cash', 1),
  ('BANK', 'Bank hisob raqami',  'bank', 2)
ON CONFLICT (code) DO NOTHING;

-- ────────────────────────────────────────────────── HARAJAT MODDALARI
--
--  Guruh → kichik guruh. Ro'yxat zavoddan keladi; bo'sh bo'lsa harajat
--  yozib bo'lmaydi va bu TO'G'RI: moddasiz harajat keyin hech qanday
--  hisobotga tushmaydi.
CREATE TABLE IF NOT EXISTS expense_groups (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort INT  NOT NULL DEFAULT 100
);

CREATE TABLE IF NOT EXISTS expense_items (
  id         SERIAL PRIMARY KEY,
  group_code TEXT NOT NULL REFERENCES expense_groups(code) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  sort       INT  NOT NULL DEFAULT 100,
  active     BOOLEAN NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_expense_items_name
  ON expense_items(group_code, lower(name));

--  Zavod ro'yxati. Kiritilgan modda O'CHIRILMAYDI — u operatsiyalarda
--  ishlatilgan bo'lishi mumkin; keraksizi `active = false` qilinadi va
--  eski hisobotda joyida qoladi. Qayta deploy'da nomi tiklanmaydi:
--  saytdan tuzatilgan nom keyingi migratsiyada eskisiga qaytib qolmasin
--  (ON CONFLICT DO NOTHING).
INSERT INTO expense_groups (code, name, sort) VALUES
  ('TAMIN', 'Ta''minot', 10),
  ('ASOSIY', 'Asosiy vositalar', 20),
  ('KOMUNAL', 'Kommunal to''lovlar', 30),
  ('MAOSH', 'Xodimlar maoshi', 40),
  ('XOJALIK', 'Xo''jalik xarajatlari', 50),
  ('MARKET', 'Marketing va savdo xarajatlari', 60),
  ('MOLIYA', 'Moliyaviy xarajatlar', 70),
  ('XIZMAT', 'Xizmat ko''rsatish', 80),
  ('BOSHQA', 'Boshqa xarajatlar', 90)
ON CONFLICT (code) DO NOTHING;

INSERT INTO expense_items (group_code, name, sort) VALUES
  ('TAMIN', 'Ta''minotchilarga to''lov', 10),
  ('TAMIN', 'Yetkazib berish xarajati', 20),
  ('ASOSIY', 'Asosiy vositalar uchun', 10),
  ('ASOSIY', 'Asbob-anjom', 20),
  ('ASOSIY', 'Tig'' charxlash', 30),
  ('ASOSIY', 'Ta''mirlash xarajati', 40),
  ('ASOSIY', 'Zavod qurilishi', 50),
  ('KOMUNAL', 'Elektr energiya', 10),
  ('KOMUNAL', 'Suv', 20),
  ('KOMUNAL', 'Gaz', 30),
  ('KOMUNAL', 'Internet', 40),
  ('MAOSH', 'Oylik AUP', 10),
  ('MAOSH', 'Oylik korpus', 20),
  ('MAOSH', 'Oylik lak', 30),
  ('MAOSH', 'Oylik qadoqlash', 40),
  ('MAOSH', 'Oylik stul', 50),
  ('MAOSH', 'Oylik savdo', 60),
  ('MAOSH', 'Xodimlarga sarmoya', 70),
  ('MAOSH', 'Tibbiy yordam', 80),
  ('XOJALIK', 'Oziq-ovqat', 10),
  ('XOJALIK', 'Tozalik mahsulotlari', 20),
  ('XOJALIK', 'Bog'' xarajati', 30),
  ('MARKET', 'Marketing', 10),
  ('MARKET', 'Target', 20),
  ('MARKET', 'Savdo', 30),
  ('MARKET', 'Vistavka', 40),
  ('MARKET', 'Yetkazib berish (savdo)', 50),
  ('MOLIYA', 'Soliqlar', 10),
  ('MOLIYA', 'Divident', 20),
  ('XIZMAT', 'IT sarmoya', 10),
  ('BOSHQA', 'Bank xizmati', 10),
  ('BOSHQA', 'Bojxona xizmati', 20),
  ('BOSHQA', 'Benzin', 30)
ON CONFLICT (group_code, lower(name)) DO NOTHING;

-- ──────────────────────────────────────────────────────── OPERATSIYA
CREATE TABLE IF NOT EXISTS cash_ops (
  id        SERIAL PRIMARY KEY,
  doc_no    TEXT UNIQUE NOT NULL,
  op_date   DATE NOT NULL DEFAULT CURRENT_DATE,

  --  Ikki tomon. `*_id` tomon turiga qarab o'qiladi: account → kassa,
  --  worker → xodim, customer → mijoz, supplier → ta'minotchi,
  --  expense → harajat moddasi (`expense_item_id` da).
  from_kind TEXT NOT NULL CHECK (from_kind IN
              ('account', 'worker', 'customer', 'supplier')),
  from_id   INT  NOT NULL,
  to_kind   TEXT NOT NULL CHECK (to_kind IN
              ('account', 'worker', 'customer', 'supplier', 'expense')),
  to_id     INT,

  --  Summa O'SHA valyutada, kurs esa 1$ necha so'mligi. Dollarda
  --  to'langanda kurs kerak emas.
  currency  TEXT NOT NULL CHECK (currency IN ('UZS', 'USD')),
  amount    NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  rate      NUMERIC(14,4) CHECK (rate IS NULL OR rate > 0),
  --  Hisob-kitob dollarda: qarz ham, hisobot ham shu ustundan. Kurs
  --  operatsiya bilan birga qotib qoladi.
  amount_usd NUMERIC(16,2) GENERATED ALWAYS AS (
    CASE WHEN currency = 'USD' THEN amount
         ELSE ROUND(amount / NULLIF(rate, 0), 2) END) STORED,
  CONSTRAINT cash_ops_rate_required
    CHECK (currency = 'USD' OR rate IS NOT NULL),

  --  ★ HARAJAT QAYSI OYNING FOYDA-ZARARIDA
  --
  --  To'lov bugun ketadi, harajatning o'zi esa boshqa oyniki bo'lishi
  --  mumkin: sentabrda to'langan avgust ijarasi avgust foydasini
  --  kamaytiradi. Shuning uchun to'lov sanasi (`op_date`) va hisobot
  --  oyi (`pl_month`) ALOHIDA. Oyning birinchi kuni saqlanadi.
  pl_month  DATE,
  expense_item_id INT REFERENCES expense_items(id),

  --  Qaysi buyurtma uchun to'lov: majburiy emas, mijoz to'lovi umumiy
  --  qarzga ham tushaveradi.
  order_id  INT REFERENCES orders(id) ON DELETE SET NULL,

  note      TEXT,
  --  Bekor qilingan operatsiya o'chmaydi, tarixda qoladi va hech qaysi
  --  qoldiqqa qo'shilmaydi.
  status    TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'cancelled')),
  created_by INT REFERENCES workers(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cash_ops_date ON cash_ops(op_date DESC);
CREATE INDEX IF NOT EXISTS idx_cash_ops_from ON cash_ops(from_kind, from_id);
CREATE INDEX IF NOT EXISTS idx_cash_ops_to   ON cash_ops(to_kind, to_id);
CREATE INDEX IF NOT EXISTS idx_cash_ops_pl   ON cash_ops(pl_month);

--  Harajatda modda ham, oy ham bo'lishi shart: ikkalasisiz harajat
--  hisobotda «boshqa» bo'lib yo'qolib ketardi.
ALTER TABLE cash_ops DROP CONSTRAINT IF EXISTS cash_ops_expense_needs;
ALTER TABLE cash_ops ADD  CONSTRAINT cash_ops_expense_needs CHECK (
  to_kind <> 'expense' OR (expense_item_id IS NOT NULL AND pl_month IS NOT NULL));

-- ═══════════════════════════════════════════════════════ PUL HARAKATI
--
--  Har operatsiya IKKI QATOR bo'lib ochiladi: beruvchi tomonda minus,
--  oluvchi tomonda plyus. Shundan keyin har qanday qoldiq bitta yig'indi
--  bo'lib qoladi — kassaniki ham, xodim qo'lidagi puliki ham, mijozning
--  to'lovi ham. Ikkita alohida hisob yozilmaydi va ular bir-biridan
--  ajralib ketmaydi.
--
--  Harajat tomoni ham shu yerda: uning «qoldig'i» — o'sha moddaga
--  jami qancha sarflangani, ya'ni foyda-zarardagi raqam.
DROP VIEW IF EXISTS v_cash_flow CASCADE;
CREATE VIEW v_cash_flow AS
SELECT o.id AS op_id, o.doc_no, o.op_date, o.pl_month,
       o.from_kind AS side_kind, o.from_id AS side_id,
       o.currency, (-o.amount)::numeric(18,2) AS amount,
       (-o.amount_usd)::numeric(16,2) AS amount_usd,
       o.rate, o.note, o.order_id, o.expense_item_id,
       o.to_kind AS other_kind, o.to_id AS other_id
  FROM cash_ops o WHERE o.status = 'ok'
UNION ALL
SELECT o.id, o.doc_no, o.op_date, o.pl_month,
       o.to_kind, o.to_id,
       o.currency, o.amount, o.amount_usd,
       o.rate, o.note, o.order_id, o.expense_item_id,
       o.from_kind, o.from_id
  FROM cash_ops o WHERE o.status = 'ok';

-- ─────────────────────────────────────────────── OPERATSIYALAR LENTASI
--
--  Ikkala tomonning NOMI bilan: ekranda «Kanalsiz mijoz → Asosiy kassa»
--  bo'lib o'qiladi. Tomon turi beshta bo'lgani uchun nom ham beshta
--  jadvaldan kelishi mumkin — COALESCE bittasini tanlaydi.
DROP VIEW IF EXISTS v_cash_ops CASCADE;
CREATE VIEW v_cash_ops AS
SELECT o.id, o.doc_no, o.op_date, o.from_kind, o.from_id, o.to_kind, o.to_id,
       o.currency, o.amount, o.rate, o.amount_usd, o.pl_month,
       o.expense_item_id, o.order_id, o.note, o.status, o.created_at,
       COALESCE(fa.name, fw.name, fc.name, fs.name) AS from_name,
       COALESCE(ta.name, tw.name, tc.name, ts.name, ei.name) AS to_name,
       eg.name  AS expense_group,
       ei.name  AS expense_item,
       ord.order_no,
       w.name   AS created_by_name
  FROM cash_ops o
  LEFT JOIN cash_accounts fa ON o.from_kind = 'account'  AND fa.id = o.from_id
  LEFT JOIN workers       fw ON o.from_kind = 'worker'   AND fw.id = o.from_id
  LEFT JOIN customers     fc ON o.from_kind = 'customer' AND fc.id = o.from_id
  LEFT JOIN suppliers     fs ON o.from_kind = 'supplier' AND fs.id = o.from_id
  LEFT JOIN cash_accounts ta ON o.to_kind   = 'account'  AND ta.id = o.to_id
  LEFT JOIN workers       tw ON o.to_kind   = 'worker'   AND tw.id = o.to_id
  LEFT JOIN customers     tc ON o.to_kind   = 'customer' AND tc.id = o.to_id
  LEFT JOIN suppliers     ts ON o.to_kind   = 'supplier' AND ts.id = o.to_id
  LEFT JOIN expense_items ei ON ei.id = o.expense_item_id
  LEFT JOIN expense_groups eg ON eg.code = ei.group_code
  LEFT JOIN orders        ord ON ord.id = o.order_id
  LEFT JOIN workers       w  ON w.id = o.created_by;

-- ──────────────────────────────────────────────────── KASSA QOLDIG'I
--
--  So'm va dollar ALOHIDA: kassada ikkalasi ham jismonan turadi va mudir
--  ikkalasini alohida sanaydi. Uchinchi raqam — dollardagi jami: so'm
--  KELGAN KUNIDAGI kursi bilan hisoblangan, bugungi kurs bilan emas.
--  Shuning uchun u «hozir sotsam qancha bo'ladi» degani emas, «qancha
--  kirgan» degani.
DROP VIEW IF EXISTS v_cash_balance CASCADE;
CREATE VIEW v_cash_balance AS
SELECT a.id, a.code, a.name, a.kind, a.sort, a.is_active,
       a.opening_uzs, a.opening_usd, a.opening_rate, a.opening_on,
       (a.opening_uzs + COALESCE(SUM(f.amount)
          FILTER (WHERE f.currency = 'UZS'), 0))::numeric(18,2) AS uzs,
       (a.opening_usd + COALESCE(SUM(f.amount)
          FILTER (WHERE f.currency = 'USD'), 0))::numeric(16,2) AS usd,
       (a.opening_usd
          + CASE WHEN a.opening_rate > 0
                 THEN ROUND(a.opening_uzs / a.opening_rate, 2) ELSE 0 END
          + COALESCE(SUM(f.amount_usd), 0))::numeric(16,2) AS total_usd,
       MAX(f.op_date) AS last_on
  FROM cash_accounts a
  LEFT JOIN v_cash_flow f ON f.side_kind = 'account' AND f.side_id = a.id
 GROUP BY a.id, a.code, a.name, a.kind, a.sort, a.is_active,
          a.opening_uzs, a.opening_usd, a.opening_rate, a.opening_on;

-- ──────────────────────────────────────── KIMGA PUL BERISH MUMKIN
--
--  Zavodda pul hamma xodimga berilmaydi — beshta odam oladi (ta'minot,
--  xo'jalik ishlari). Shuning uchun belgi XODIMDA turadi, kassa
--  sahifasida emas: kassir ro'yxatdan tanlaydi, kimni tanlash mumkinligini
--  esa administrator Xodimlar sahifasida hal qiladi. Ro'yxat kodga
--  yozilmaydi (4-qoida) — ertaga oltinchi odam qo'shilsa katakcha
--  belgilanadi, kod tegilmaydi.
--
--  Bu FAQAT berishni cheklaydi. Mijozdan pul olgan menejerning qo'lida
--  pul baribir paydo bo'ladi va uni topshiradi — unga belgi kerak emas.
ALTER TABLE workers ADD COLUMN IF NOT EXISTS can_hold_cash BOOLEAN NOT NULL DEFAULT false;

-- ─────────────────────────────────────────────── XODIM QO'LIDAGI PUL
--
--  Ikki yo'ldan to'ladi: xodimga kassadan berilgan pul va
--  menejer mijozdan olib, hali kassirga topshirmagani. Ikkalasi ham
--  bitta narsa — xodimning qo'lidagi, korxonaga qarz pul.
DROP VIEW IF EXISTS v_worker_cash CASCADE;
CREATE VIEW v_worker_cash AS
SELECT w.id, w.name, w.phone,
       COALESCE(SUM(f.amount)     FILTER (WHERE f.currency = 'UZS'), 0)::numeric(18,2) AS uzs,
       COALESCE(SUM(f.amount)     FILTER (WHERE f.currency = 'USD'), 0)::numeric(16,2) AS usd,
       COALESCE(SUM(f.amount_usd), 0)::numeric(16,2) AS total_usd,
       MAX(f.op_date) AS last_on
  FROM workers w
  JOIN v_cash_flow f ON f.side_kind = 'worker' AND f.side_id = w.id
 GROUP BY w.id, w.name, w.phone;

-- ───────────────────────────────────── HARAJAT: FOYDA-ZARAR KESIMIDA
--
--  To'lov sanasi bo'yicha emas, HISOBOT OYI bo'yicha (`pl_month`):
--  sentabrda to'langan avgust ijarasi avgust foydasini kamaytiradi.
DROP VIEW IF EXISTS v_expenses CASCADE;
CREATE VIEW v_expenses AS
SELECT o.pl_month, eg.code AS group_code, eg.name AS group_name, eg.sort AS group_sort,
       ei.id AS item_id, ei.name AS item_name,
       SUM(o.amount_usd)::numeric(16,2) AS amount_usd,
       COUNT(*)::int AS ops
  FROM cash_ops o
  JOIN expense_items  ei ON ei.id = o.expense_item_id
  JOIN expense_groups eg ON eg.code = ei.group_code
 WHERE o.status = 'ok' AND o.to_kind = 'expense'
 GROUP BY o.pl_month, eg.code, eg.name, eg.sort, ei.id, ei.name;

-- ════════════════════════════════════════════════ FOYDA-ZARAR (P&L)
--
--  Oy bo'yicha: TUSHUM minus HARAJAT. Ikki manba bitta jadvalda —
--  sotuv konverlardan, harajat esa kassadan.
--
--  Tushum CHIQIB KETGAN mahsulotdan hisoblanadi (`ship_on`), buyurtma
--  yozilgan kundan emas: buyurtma hali pul emas, mahsulot mijozda
--  bo'lgandagina sotuv bo'ladi. Mijoz balansi ham shu qoida bilan
--  yuritiladi, ya'ni hisobot va qarzdorlik bir-biriga mos tushadi.
--
--  Harajat esa TO'LOV sanasi bo'yicha emas, HISOBOT OYI bo'yicha
--  (`pl_month`): sentabrda to'langan avgust ijarasi avgust foydasini
--  kamaytiradi.
--
--  Tannarx yo'q: xom ashyo hisobi hali yozilmagan. Shuning uchun bu
--  «yalpi foyda» emas — tushumdan zavodning pul harajatlari ayirilgani.
DROP VIEW IF EXISTS v_pl_month CASCADE;
CREATE VIEW v_pl_month AS
SELECT date_trunc('month', u.ship_on)::date AS pl_month,
       'income'::text AS kind,
       'SOTUV'::text  AS group_code,
       'Mahsulot sotuvi'::text AS group_name,
       0 AS group_sort,
       NULL::int AS item_id,
       'Sotuv'::text AS item_name,
       SUM(u.total_amount)::numeric(16,2) AS amount_usd,
       COUNT(*)::int AS ops
  FROM production_units u
 WHERE u.status = 'shipped' AND u.ship_on IS NOT NULL
   AND u.total_amount IS NOT NULL
 GROUP BY 1
UNION ALL
SELECT e.pl_month, 'expense', e.group_code, e.group_name, e.group_sort,
       e.item_id, e.item_name, e.amount_usd, e.ops
  FROM v_expenses e;

-- ══════════════════════════════════════════════════════════ PUL OQIMI
--
--  Korxonaning puli IKKI joyda turadi: kassalarda va xodimlarning
--  qo'lida. Shuning uchun oqim shu ikkoviga KIRGAN va undan CHIQQAN
--  pul: menejerdan kassaga o'tkazish ichki harakat va hisobotga
--  tushmaydi — aks holda bitta to'lov ikki marta kirim bo'lib
--  ko'rinardi. Kassalar aro ko'chirish va valyuta almashish ham shunday.
--
--  Sana — TO'LOV kuni (`op_date`), harajatning foyda-zarar oyi emas:
--  pul oqimi pul QACHON qimirlaganini sanaydi. Foyda-zarar boshqa
--  savolga javob beradi va shuning uchun boshqa hisobot.
DROP VIEW IF EXISTS v_cash_month CASCADE;
CREATE VIEW v_cash_month AS
SELECT date_trunc('month', o.op_date)::date AS mon,
       CASE WHEN o.from_kind IN ('account', 'worker') THEN 'out' ELSE 'in' END AS dir,
       --  Tashqi tomon: pul kimdan keldi yoki kimga ketdi
       CASE WHEN o.from_kind IN ('account', 'worker') THEN o.to_kind
            ELSE o.from_kind END AS side,
       ei.group_code, eg.name AS group_name, eg.sort AS group_sort,
       ei.id AS item_id, ei.name AS item_name,
       SUM(o.amount_usd)::numeric(16,2) AS amount_usd,
       COUNT(*)::int AS ops
  FROM cash_ops o
  LEFT JOIN expense_items  ei ON ei.id = o.expense_item_id
  LEFT JOIN expense_groups eg ON eg.code = ei.group_code
 WHERE o.status = 'ok'
   AND NOT (o.from_kind IN ('account', 'worker')
        AND o.to_kind   IN ('account', 'worker'))
 GROUP BY 1, 2, 3, 4, 5, 6, 7, 8;

-- ═══════════════════════════════════ MIJOZ BALANSI — TO'LOVLAR BILAN
--
--  Ikki view SHU YERGA ko'chirildi (ilgari `units.sql` va `sales.sql`
--  da edi): ular endi `cash_ops` ni o'qiydi, u esa migratsiyada shu
--  fayldagina yaratiladi. Toza bazada oldingi joyida qolsa, view
--  bo'lmagan jadvalni izlab yiqilardi — ya'ni sayt ko'tarilmasdi.
--
--  Formula to'ldi:
--      boshlang'ich qarz + chiqib ketgan mahsulot − TO'LOVLAR
--
--  To'lov mijozdan chiqqan zahoti hisobga oladi — menejer olganda ham,
--  kassaga to'g'ridan to'langanda ham. Mijoz uchun farqi yo'q: u to'ladi
--  va qarzi kamaydi. Pulning kassaga yetib borishi KORXONANING ichki
--  ishi (pul menejerning qo'lida) va mijozning qarziga aloqasi yo'q.
DROP VIEW IF EXISTS v_customer_sales CASCADE;
CREATE VIEW v_customer_sales AS
SELECT c.id, c.name, c.country, c.region, c.phone,
       ch.name AS channel_name, c.channel,
       c.manager_id, m.name AS manager_name,
       c.opening_debt, c.opening_debt_on,
       COUNT(u.id)                            AS units,
       COALESCE(SUM(u.qty), 0)                AS qty,
       COALESCE(SUM(u.total_amount), 0)       AS amount,
       COUNT(DISTINCT u.order_no)             AS orders,
       MAX(u.started_on)                      AS last_order_on,
       --  Qarzga faqat CHIQIB KETGAN mahsulot qo'shiladi: buyurtma
       --  yozilgani yoki konver biriktirilgani hali qarz emas —
       --  mahsulot mijozda emas.
       COALESCE(SUM(u.total_amount) FILTER (WHERE u.status = 'shipped'), 0)
         AS shipped_amount,
       pay.paid AS paid_amount,
       (COALESCE(c.opening_debt, 0)
         + COALESCE(SUM(u.total_amount) FILTER (WHERE u.status = 'shipped'), 0)
         - pay.paid)::numeric(16,2) AS balance
FROM customers c
LEFT JOIN customer_channels ch ON ch.code = c.channel
LEFT JOIN workers m            ON m.id = c.manager_id
LEFT JOIN production_units u   ON u.customer_id = c.id AND u.status <> 'cancelled'
--  To'lovlar alohida LATERAL bilan: konverlar bilan bitta JOIN ga
--  qo'shilsa har to'lov har konverga ko'payib, summa bir necha barobar
--  bo'lib ketardi.
LEFT JOIN LATERAL (
  SELECT COALESCE(SUM(-f.amount_usd), 0)::numeric(16,2) AS paid
    FROM v_cash_flow f
   WHERE f.side_kind = 'customer' AND f.side_id = c.id) pay ON true
WHERE c.active
GROUP BY c.id, c.name, c.country, c.region, c.phone, ch.name, c.channel,
         c.manager_id, m.name, c.opening_debt, c.opening_debt_on, pay.paid;

-- ═══════════════════════════════════════════════════ QARZDORLIK LENTASI
--
--  `v_customer_sales.balance` — mijozning BUGUNGI qarzi, bitta raqam.
--  Zavodga esa oraliq kerak: «1-sentabr holatiga qancha edi, oy ichida
--  qancha qo'shildi, 30-sentabrda qancha bo'ldi». Buning uchun balansni
--  emas, uni hosil qiladigan HARAKATLARNI sanasi bilan berish kerak —
--  shu view o'sha lenta.
--
--  Har qator bitta harakat:
--    `debit`  — QARZDOR: mijozning qarzi oshdi (mahsulot unga chiqdi)
--    `credit` — HAQDOR:  qarzi kamaydi (to'lov)
--
--  Sanasi yo'q harakat 1900-01-01 bo'ladi: u har qanday oraliqdan OLDIN
--  bo'lgan hisoblanadi, ya'ni «boshiga» ustuniga tushadi va yig'indidan
--  yo'qolib qolmaydi.
DROP VIEW IF EXISTS v_customer_ledger CASCADE;
CREATE VIEW v_customer_ledger AS
SELECT c.id                                           AS customer_id,
       COALESCE(c.opening_debt_on, DATE '1900-01-01') AS on_date,
       'opening'::text                                AS kind,
       'Boshlang''ich qarz'::text                     AS note,
       NULL::text                                     AS conveyor_no,
       NULL::text                                     AS order_no,
       --  Tomonga shu yerda ajratiladi: manfiy boshlang'ich qarz —
       --  QARZDOR ustunidagi minus emas, HAQDOR (korxona mijozga
       --  qarzdor, ya'ni oldindan to'lov).
       GREATEST(c.opening_debt, 0)::numeric(16,2)     AS debit,
       GREATEST(-c.opening_debt, 0)::numeric(16,2)    AS credit
  FROM customers c
 WHERE COALESCE(c.opening_debt, 0) <> 0
UNION ALL
SELECT u.customer_id,
       COALESCE(u.ship_on, DATE '1900-01-01'),
       'ship'::text,
       (COALESCE(p.name, 'Mahsulot') || ' — ' || u.qty || ' ta')::text,
       u.conveyor_no::text,
       u.order_no::text,
       GREATEST(COALESCE(u.total_amount, 0), 0)::numeric(16,2),
       GREATEST(-COALESCE(u.total_amount, 0), 0)::numeric(16,2)
  FROM production_units u
  LEFT JOIN products p ON p.id = u.product_id
 WHERE u.status = 'shipped' AND u.customer_id IS NOT NULL
   AND COALESCE(u.total_amount, 0) <> 0
UNION ALL
--  ★ TO'LOVLAR. Mijoz tomonidagi pul harakati: undan chiqqani (to'lov)
--  HAQDOR, unga qaytarilgani QARZDOR. Ishora `v_cash_flow` da
--  allaqachon qo'yilgan, bu yerda faqat tomonga ajratiladi.
SELECT f.side_id,
       f.op_date,
       'payment'::text,
       ('To''lov — ' || f.doc_no
         || CASE WHEN f.currency = 'UZS'
                 THEN ' · ' || TRIM(TO_CHAR(f.amount, '999999999999D99')) || ' so''m'
                 ELSE '' END)::text,
       NULL::text,
       ord.order_no::text,
       GREATEST(f.amount_usd, 0)::numeric(16,2),
       GREATEST(-f.amount_usd, 0)::numeric(16,2)
  FROM v_cash_flow f
  LEFT JOIN orders ord ON ord.id = f.order_id
 WHERE f.side_kind = 'customer';
