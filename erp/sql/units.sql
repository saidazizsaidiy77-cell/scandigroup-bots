-- ============================================================================
--  ISHLAB CHIQARISH JURNALI — KONVEYER BIRLIGI
--
--  Oldingi model dona sanardi ("Freza bo'limida 30 dona"). Bu model har bir
--  mahsulotni RAQAMI BILAN kuzatadi: konveyer raqami — asosiy konver, u
--  marshrut bo'ylab yuradi, zakaz raqami va mijoz unga biriktiriladi.
--
--  production.sql dan KEYIN ishga tushiriladi.
-- ============================================================================

-- ★ KOMPLEKTLILIK — to'plam bir butun bo'lib ishlab chiqarilgani uchun
--   qayta yoziladi. Ikki holatni ham qamrab oladi:
--     · tarkibi kiritilmagan to'plam → omborga tushgan donaning o'zi
--     · tarkibi kiritilgan to'plam   → eng kam imkon beruvchi pozitsiya
CREATE OR REPLACE VIEW v_set_completeness AS
SELECT sp.id AS set_product_id, sp.name AS set_name,
       CASE
         WHEN COUNT(si.item_product_id) = 0
           THEN COALESCE(MAX(own.qty), 0)
         ELSE MIN(FLOOR(COALESCE(stk.qty,0)::numeric / si.qty))::int
       END AS complete_sets,
       CASE
         WHEN COUNT(si.item_product_id) = 0
           THEN COALESCE(MAX(own.qty), 0)
         ELSE SUM(COALESCE(stk.qty,0))
       END AS items_in_stock
FROM products sp
LEFT JOIN set_items si  ON si.set_product_id = sp.id
LEFT JOIN fg_stock stk  ON stk.product_id = si.item_product_id
LEFT JOIN fg_stock own  ON own.product_id = sp.id
WHERE sp.is_set AND sp.active
GROUP BY sp.id, sp.name;

-- Mijoz keladigan kanal. Alohida spravochnik — keyinchalik "qaysi kanal
-- qancha sotuv keltirdi" tahlili shu ustunga tayanadi.
CREATE TABLE IF NOT EXISTS customer_channels (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort INT NOT NULL DEFAULT 0
);

INSERT INTO customer_channels (code, name, sort) VALUES
  ('INSTAGRAM', 'Instagram',            1),
  ('TELEGRAM',  'Telegram',             2),
  ('SALON',     'Salon / do''kon',      3),
  ('TAVSIYA',   'Tavsiya (tanish)',     4),
  ('SAYT',      'Sayt',                 5),
  ('KORGAZMA',  'Ko''rgazma / bozor',   6),
  ('DILER',     'Diler / hamkor',       7),
  ('BOSHQA',    'Boshqa',              99),
  -- Mijoz turi: u bilan qanday ishlanadi. Yuqoridagilar mijoz qayerdan
  -- kelganini yozadi, bular esa qanday sotilishini.
  ('B2B',       'B2B — diler / do''kon', 10),
  ('B2C',       'B2C — chakana',         11),
  ('EXPORT',    'Eksport',               12)
ON CONFLICT (code) DO NOTHING;

-- Mijoz. To'liq savdo moduli keyin quriladi — hozir jurnalga yetarli minimum.
CREATE TABLE IF NOT EXISTS customers (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  phone      TEXT,
  note       TEXT,
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS country TEXT
  DEFAULT 'O''zbekiston';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS region  TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS channel TEXT REFERENCES customer_channels(code);
-- Mijozga biriktirilgan savdo menejeri
ALTER TABLE customers ADD COLUMN IF NOT EXISTS manager_id INT REFERENCES workers(id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_name ON customers(lower(name));

-- ──────────────────────────────────────────── BOSHLANG'ICH QARZDORLIK
--
--  Tizim ishga tushgan kunda mijozning zavodga qarzi. U kassa moduligacha
--  kerak: mijoz bilan gaplashayotgan sotuvchi qarzni bilishi shart.
--
--  Bu — BIR MARTALIK raqam, hisoblanmaydi. Kassa yozilganda qarz
--  shundan boshlab yuritiladi:
--
--      qarz = boshlang'ich qarz + sotuvlar − to'lovlar
--
--  Valyuta $: mahsulot narxi ham shunda. So'mdagi qarz bo'lsa, kassa
--  moduli bilan birga valyuta ustuni qo'shiladi — hozir taxmin qilib
--  ikkita ustun ochish keyin ikkalasini ham tuzatish demakdir.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS opening_debt NUMERIC(14,2);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS opening_debt_on DATE;

-- ─────────────────────────────────────── SAVDO MENEJERINING YO'NALISHI
--
--  Zavodda savdo yo'nalishlarga bo'lingan: biri B2B bilan, boshqasi
--  eksport bilan ishlaydi. Xodimga yo'nalish biriktirilsa, u faqat
--  o'sha kanaldagi mijozlarni ko'radi — tsex ustasining o'z tsexini
--  ko'rgani kabi.
--
--  Bo'sh qoldirilsa — hamma kanal. Rahbariyat va administrator uchun
--  shunday: ular butun savdoni ko'radi.
--
--  Bu FILTR emas, CHEGARA: so'rovga serverda qo'shiladi (scopeChannels).
ALTER TABLE worker_roles ADD COLUMN IF NOT EXISTS scope_channel TEXT
  REFERENCES customer_channels(code);
CREATE INDEX IF NOT EXISTS idx_customers_country ON customers(country);
CREATE INDEX IF NOT EXISTS idx_customers_region  ON customers(region);
CREATE INDEX IF NOT EXISTS idx_customers_channel ON customers(channel);
CREATE INDEX IF NOT EXISTS idx_customers_manager ON customers(manager_id);

-- ★ KONVEYER BIRLIGI
--   conveyor_no — ishlab chiqarish beradi, majburiy va takrorlanmas
--   order_no    — savdo bo'limi keyin qo'yadi; zakaz hali yo'q bo'lsa NULL
--   customer_id — NULL bo'lsa mahsulot tayyor mahsulot omboriga ketadi
CREATE TABLE IF NOT EXISTS production_units (
  id           SERIAL PRIMARY KEY,
  conveyor_no  TEXT NOT NULL UNIQUE,
  order_no     TEXT,
  product_id   INT  NOT NULL REFERENCES products(id),
  qty          INT  NOT NULL DEFAULT 1 CHECK (qty > 0),

  started_on   DATE NOT NULL DEFAULT CURRENT_DATE,  -- ishlab chiqarishga kirgan sana

  -- Hozirgi joylashuv. NULL → hali birinchi bo'limga qo'yilmagan.
  current_section_id INT REFERENCES sections(id),
  entered_section_on DATE,

  -- Keyingi tsexga o'tkazish sanasi. Qo'lda rejalashtirilsa shu yerda turadi,
  -- bo'sh bo'lsa tizim marshrut va bo'lim quvvatidan taxmin qiladi.
  next_shop_planned_on DATE,

  fg_on        DATE,        -- T/M omboriga kirgan sana (fakt)
  ship_on      DATE,        -- mijozga chiqadigan sana

  customer_id  INT REFERENCES customers(id),
  unit_price   NUMERIC(14,2),
  total_amount NUMERIC(16,2) GENERATED ALWAYS AS (qty * COALESCE(unit_price, 0)) STORED,

  status       TEXT NOT NULL DEFAULT 'production'
               CHECK (status IN ('production','fg','shipped','cancelled')),
  -- Tizim ishga tushirilgandagi boshlang'ich qoldiq (o'sha kungi holat)
  is_opening   BOOLEAN NOT NULL DEFAULT false,
  note         TEXT,
  created_by   INT REFERENCES workers(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_units_section  ON production_units(current_section_id);
CREATE INDEX IF NOT EXISTS idx_units_order    ON production_units(order_no);
CREATE INDEX IF NOT EXISTS idx_units_customer ON production_units(customer_id);
CREATE INDEX IF NOT EXISTS idx_units_status   ON production_units(status);

-- Konverning harakat tarixi: qaysi bo'limga, qachon, kim o'tkazdi
CREATE TABLE IF NOT EXISTS unit_moves (
  id          BIGSERIAL PRIMARY KEY,
  unit_id     INT  NOT NULL REFERENCES production_units(id) ON DELETE CASCADE,
  section_id  INT  NOT NULL REFERENCES sections(id),
  moved_on    DATE NOT NULL DEFAULT CURRENT_DATE,
  moved_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  qty_defect  INT  NOT NULL DEFAULT 0,
  defect_reason TEXT REFERENCES defect_reasons(code),
  worker_id   INT  REFERENCES workers(id),
  note        TEXT
);

-- ============================================================================
--  KONVER BO'LINADI
--
--  Zavod konverni butunligicha ko'chirmaydi: 10 ta stulning 3 tasi
--  keyingi bo'limga o'tadi, 7 tasi joyida qoladi. Ya'ni konver bir vaqtda
--  bir nechta bo'limda turadi.
--
--  Buning uchun alohida "joylashuvlar" jadvali ochilmadi — konverning
--  har bo'lagi O'ZI qator bo'lib turadi: bir xil konveyer raqami, har
--  biri o'z bo'limida, o'z sonida. Shunda bo'lim ekrani, jurnal, muddat
--  hisobi va ombor qabuli — hammasi eskicha ishlaydi, chunki har qator
--  baribir bitta joyda turgan bitta konver.
--
--  Bo'laklar uchrashganda qo'shilib ketadi: 3 tasi Zborkaga o'tgan, keyin
--  qolgan 7 tasi ham o'tsa, Zborkada bitta 10 lik qator qoladi. Shuning
--  uchun qatorlar soni o'smaydi — konver nechta bo'limda tursa, shuncha.
--
--  `part` — bo'lak raqami. Raqamning o'zi takrorlanmasligi kerak edi,
--  endi (raqam + bo'lak) juftligi takrorlanmaydi: yangi konver har doim
--  1-bo'lak bo'lib kiradi, demak bir xil raqamli ikkinchi konver
--  ochilmaydi — himoya o'z joyida qoladi.
ALTER TABLE production_units ADD COLUMN IF NOT EXISTS part INT NOT NULL DEFAULT 1;
ALTER TABLE production_units DROP CONSTRAINT IF EXISTS production_units_conveyor_no_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_units_no_part
  ON production_units (conveyor_no, part);
CREATE INDEX IF NOT EXISTS idx_units_no ON production_units (conveyor_no);

-- Harakatda nechta dona ko'chgani va QAYERDAN kelgani. Qayerdan —
-- qaytarish uchun: bo'lak orqaga qaytganda donalar aynan o'sha bo'limdagi
-- qatorga qo'shilishi kerak, aks holda ular yo'qolib qoladi.
ALTER TABLE unit_moves ADD COLUMN IF NOT EXISTS qty INT NOT NULL DEFAULT 1;
ALTER TABLE unit_moves ADD COLUMN IF NOT EXISTS from_section_id INT REFERENCES sections(id);

-- Eski harakatlarda bu ustunlar yo'q edi. Bir marta to'ldiriladi:
-- soni — konverning hozirgi soni (u paytda bo'linish bo'lmagan),
-- qayerdan — o'sha konverning bir oldingi harakati.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM migration_flags WHERE key = 'moves-qty-from') THEN
    UPDATE unit_moves m SET qty = u.qty
      FROM production_units u WHERE u.id = m.unit_id;
    UPDATE unit_moves m SET from_section_id = p.section_id
      FROM (SELECT id, LAG(section_id) OVER (PARTITION BY unit_id ORDER BY id) AS section_id
              FROM unit_moves) p
     WHERE p.id = m.id;
    INSERT INTO migration_flags (key) VALUES ('moves-qty-from');
  END IF;
END $$;

-- ZAHIRA. Zavod mijozga yetkazishni qisqartirish uchun mahsulotni oldindan,
-- rangsiz holda tayyorlab qo'yadi va rang sepish bo'limida ushlab turadi.
-- Buyurtma tushgach rang beriladi, lak sepiladi, qadoqlanadi.
--
-- Bu mijozdan mustaqil belgi: zahira mahsulotning qanday ishlanayotganini
-- aytadi, kimga ketishini emas. Mijozi bor konver ham zahiradan olinishi,
-- mijozsiz konver esa oddiy tartibda to'liq yasalishi mumkin — shuning
-- uchun uni mijozning bor-yo'qligidan chiqarib bo'lmaydi, alohida
-- belgilanadi.
--
-- Ta'siri: zahiraga qadoqlash va T/M ombor muddati hisoblanmaydi —
-- u buyurtma kutadi, quvvat kutmaydi.
ALTER TABLE production_units ADD COLUMN IF NOT EXISTS is_stock BOOLEAN NOT NULL DEFAULT false;

-- ★ TOPSHIRISH — tsexdan tsexga o'tish ikki bosqichda
--
--  Korpus ishni tugatdi va «Lak tsexiga jo'natdim» deydi; lak tsexi esa
--  «Qabul qildim» deb o'ziga oladi. Ikki bosqich ikki xil savolga javob
--  beradi: mahsulot QACHON tayyor bo'ldi va QACHON qabul qilindi.
--  Oradagi farq — tsexlar orasida yotib qolgan vaqt; zavodda vaqt aynan
--  shu yerda yo'qoladi, bo'lim ichida emas.
--
--  Belgi konverning o'zida turadi, harakat yozuvi sifatida emas: jo'natish
--  — bo'lim almashuvi emas, mahsulot joyidan qimirlamaydi. Uni unit_moves
--  ga yozsak, joylashuv tarixi yolg'on bo'lib qolardi.
--
--  handover_shop_id — QAYSI tsex jo'natgani. Busiz konver keyingi tsexga
--  o'tgach eski belgi qolib ketardi va u yerda ham «jo'natilgan» bo'lib
--  ko'rinardi.
ALTER TABLE production_units ADD COLUMN IF NOT EXISTS handover_on      DATE;
ALTER TABLE production_units ADD COLUMN IF NOT EXISTS handover_at      TIMESTAMPTZ;
ALTER TABLE production_units ADD COLUMN IF NOT EXISTS handover_by      INT REFERENCES workers(id);
ALTER TABLE production_units ADD COLUMN IF NOT EXISTS handover_shop_id INT REFERENCES shops(id);
CREATE INDEX IF NOT EXISTS idx_units_handover ON production_units(handover_shop_id, handover_on)
  WHERE handover_on IS NOT NULL;

-- Har o'tkazish jamlanma `flow_log` ga ham yoziladi. O'tkazish qaytarilganda
-- o'sha jamlanma yozuvni ham olib tashlash kerak, aks holda WIP va panel
-- bo'lmagan ishni ko'rsatib qoladi. Qaysi yozuv ekanini topish uchun
-- bog'lanish shu yerda saqlanadi.
--
-- Bu ustun qo'shilishidan oldin kiritilgan harakatlarda NULL — ular uchun
-- jamlanma yozuv bo'lim, mahsulot, sana va konveyer raqami bo'yicha
-- topiladi (izoh: modules/units.js).
ALTER TABLE unit_moves ADD COLUMN IF NOT EXISTS flow_log_id BIGINT
  REFERENCES flow_log(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_moves_unit ON unit_moves(unit_id, moved_at);

-- ========================================================== HISOBOT VIEW'LARI

-- Konverning marshrutdagi qadami va tsexi
CREATE OR REPLACE VIEW v_unit_place AS
SELECT u.id AS unit_id, u.current_section_id AS section_id,
       sc.name AS section, sh.id AS shop_id, sh.name AS shop, sh.sort AS shop_sort,
       sc.sort AS section_sort, sc.is_exit,
       r.step_no
FROM production_units u
LEFT JOIN sections sc      ON sc.id = u.current_section_id
LEFT JOIN shops sh         ON sh.id = sc.shop_id
LEFT JOIN v_product_route r ON r.product_id = u.product_id
                           AND r.section_id = u.current_section_id;

-- Konverdan oldinga qolgan marshrut (muddat hisobi uchun)
CREATE OR REPLACE VIEW v_unit_rem AS
SELECT u.id AS unit_id, u.qty, pp.shop_id AS at_shop_id,
       r.step_no AS rem_step, sc.shop_id AS rem_shop_id, rt.rate_per_day
FROM production_units u
JOIN v_unit_place pp   ON pp.unit_id = u.id
JOIN v_product_route r ON r.product_id = u.product_id AND r.step_no >= pp.step_no
JOIN sections sc       ON sc.id = r.section_id
JOIN v_section_rate rt ON rt.section_id = r.section_id
WHERE u.status = 'production' AND pp.step_no IS NOT NULL;

-- Muddat taxmini: MAX(qty/quvvat) + SUM(1/quvvat) — quvurli oqim yaqinlashuvi
CREATE OR REPLACE VIEW v_unit_eta AS
WITH brk AS (
  SELECT unit_id, MIN(rem_step) AS change_step
  FROM v_unit_rem WHERE rem_shop_id <> at_shop_id GROUP BY unit_id
),
nxt AS (
  SELECT b.unit_id, b.change_step, sh.name AS next_shop
  FROM brk b
  JOIN v_unit_rem r ON r.unit_id = b.unit_id AND r.rem_step = b.change_step
  JOIN shops sh     ON sh.id = r.rem_shop_id
  GROUP BY b.unit_id, b.change_step, sh.name
)
-- Quvvati noma'lum bo'lim oldinda tursa muddat CHIQARILMAYDI. Aks holda
-- o'sha bo'lim yig'indidan jimgina tushib qoladi va sana haqiqiydan qisqa
-- ko'rinadi — savdo mijozga bajarib bo'lmaydigan muddat aytadi. Bo'sh
-- javob "quvvatni kiriting" degani, noto'g'ri sanadan ko'ra foydaliroq.
SELECT r.unit_id, n.next_shop,
       CASE WHEN COUNT(*) FILTER (WHERE r.rate_per_day IS NULL
              AND (n.change_step IS NULL OR r.rem_step < n.change_step)) > 0 THEN NULL
            ELSE CEIL(MAX(r.qty / NULLIF(r.rate_per_day, 0))
              FILTER (WHERE n.change_step IS NULL OR r.rem_step < n.change_step)
            + SUM(1.0 / NULLIF(r.rate_per_day, 0))
              FILTER (WHERE n.change_step IS NULL OR r.rem_step < n.change_step))
       END AS next_shop_days,
       CASE WHEN COUNT(*) FILTER (WHERE r.rate_per_day IS NULL) > 0 THEN NULL
            ELSE CEIL(MAX(r.qty / NULLIF(r.rate_per_day, 0))
                    + SUM(1.0 / NULLIF(r.rate_per_day, 0)))
       END AS fg_days
FROM v_unit_rem r
LEFT JOIN nxt n ON n.unit_id = r.unit_id
GROUP BY r.unit_id, n.next_shop, n.change_step;

-- ★ ISHLAB CHIQARISH BOSHLIG'INING JADVALI — register.sql da
--
--   v_unit_register shu yerda EMAS, register.sql da yaratiladi. Sabab:
--   migratsiya har deploy'da qayta ishlaydi va fayllar tartib bilan yuradi.
--   View ikki faylda tursa, oldingi fayl uni eski ustunlar bilan qayta
--   yozmoqchi bo'ladi va "cannot drop columns from view" xatosi chiqadi —
--   ERP_AUTO_MIGRATE=1 da bu serverning umuman ko'tarilmasligi demakdir.
--   Bitta view — bitta fayl.

-- Zakaz kesimi: bir mijozning bitta zakazdagi hamma mahsuloti
CREATE OR REPLACE VIEW v_orders AS
SELECT u.order_no,
       COALESCE(c.name, 'T/M ombor') AS customer_name,
       COUNT(*)            AS units,
       SUM(u.qty)          AS qty,
       SUM(u.total_amount) AS amount,
       MIN(u.started_on)   AS started_on,
       MAX(u.ship_on)      AS ship_on,
       COUNT(*) FILTER (WHERE u.status = 'production') AS in_production,
       COUNT(*) FILTER (WHERE u.status = 'fg')         AS in_stock,
       COUNT(*) FILTER (WHERE u.status = 'shipped')    AS shipped
FROM production_units u
LEFT JOIN customers c ON c.id = u.customer_id
WHERE u.order_no IS NOT NULL AND u.status <> 'cancelled'
GROUP BY u.order_no, COALESCE(c.name, 'T/M ombor');

-- Mijoz kesimi: nechta zakaz, qancha summa
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
       --  BALANS. Zavod qoidasi: qarzga faqat CHIQIB KETGAN mahsulot
       --  qo'shiladi. Buyurtma yozilgani yoki konver biriktirilgani hali
       --  qarz emas — mahsulot mijozda emas.
       --
       --  To'lovlar ayirilmaydi: kassa moduli hali yo'q. U yozilganda
       --  shu yerga bitta ayirma qo'shiladi va balans o'zi to'g'rilanadi.
       COALESCE(SUM(u.total_amount) FILTER (WHERE u.status = 'shipped'), 0)
         AS shipped_amount,
       COALESCE(c.opening_debt, 0)
         + COALESCE(SUM(u.total_amount) FILTER (WHERE u.status = 'shipped'), 0)
         AS balance
FROM customers c
LEFT JOIN customer_channels ch ON ch.code = c.channel
LEFT JOIN workers m            ON m.id = c.manager_id
LEFT JOIN production_units u   ON u.customer_id = c.id AND u.status <> 'cancelled'
WHERE c.active
GROUP BY c.id, c.name, c.country, c.region, c.phone, ch.name, c.channel,
         c.manager_id, m.name, c.opening_debt, c.opening_debt_on;

-- ★ Kanal kesimi: qaysi kanal qancha sotuv keltirdi.
--   Reklama byudjetini taqsimlashda asosiy ko'rsatkich.
CREATE OR REPLACE VIEW v_channel_sales AS
SELECT COALESCE(ch.name, 'Kiritilmagan') AS channel_name, c.channel,
       COUNT(DISTINCT c.id)              AS customers,
       COUNT(u.id)                       AS units,
       COALESCE(SUM(u.qty), 0)           AS qty,
       COALESCE(SUM(u.total_amount), 0)  AS amount
FROM customers c
LEFT JOIN customer_channels ch ON ch.code = c.channel
LEFT JOIN production_units u   ON u.customer_id = c.id AND u.status <> 'cancelled'
WHERE c.active
GROUP BY ch.name, c.channel;

-- Respublika kesimi — eksport yo'nalishlarini ko'rish uchun
CREATE OR REPLACE VIEW v_country_sales AS
SELECT COALESCE(c.country, 'Kiritilmagan') AS country,
       COUNT(DISTINCT c.id)                AS customers,
       COALESCE(SUM(u.qty), 0)             AS qty,
       COALESCE(SUM(u.total_amount), 0)    AS amount
FROM customers c
LEFT JOIN production_units u ON u.customer_id = c.id AND u.status <> 'cancelled'
WHERE c.active
GROUP BY c.country;

-- Region kesimi (respublika bilan birga)
--  Region kesimi REGION bo'yicha, davlat bilan emas. Ilgari ikkalasi
--  birga guruhlanardi va «Toshkent» uch marta chiqardi — O'zbekiston,
--  Qozog'iston va Tojikiston mijozlari ostida. Savdoni region bo'yicha
--  ko'rayotgan odam esa bitta Toshkentni ko'rishi kerak; davlat kesimi
--  esa o'z jadvalida turibdi (v_country_sales).
--
--  Guruhlash kichik harf bo'yicha: «Toshkent» va «toshkent» bitta region.
--  Imlo xatosi (Xorazm / Xorazim) bu bilan tuzalmaydi — uni mijoz
--  kartochkasidan to'g'rilash kerak, tizim o'zi taxmin qilmaydi.
DROP VIEW IF EXISTS v_region_sales;
CREATE VIEW v_region_sales AS
SELECT MIN(TRIM(COALESCE(NULLIF(TRIM(c.region), ''), 'Kiritilmagan'))) AS region,
       -- Qaysi davlatlardan: ma'lumot yo'qolmasin
       STRING_AGG(DISTINCT COALESCE(NULLIF(TRIM(c.country), ''), 'Kiritilmagan'),
                  ', ' ORDER BY COALESCE(NULLIF(TRIM(c.country), ''), 'Kiritilmagan'))
         AS countries,
       COUNT(DISTINCT c.id)             AS customers,
       COALESCE(SUM(u.qty), 0)          AS qty,
       COALESCE(SUM(u.total_amount), 0) AS amount
FROM customers c
LEFT JOIN production_units u ON u.customer_id = c.id AND u.status <> 'cancelled'
WHERE c.active
GROUP BY LOWER(TRIM(COALESCE(NULLIF(TRIM(c.region), ''), 'Kiritilmagan')));

-- ★ Savdo menejeri kesimi — sotuv jamoasining natijasi
CREATE OR REPLACE VIEW v_manager_sales AS
SELECT COALESCE(m.name, 'Biriktirilmagan') AS manager_name, c.manager_id,
       COUNT(DISTINCT c.id)                AS customers,
       COUNT(DISTINCT u.order_no)          AS orders,
       COALESCE(SUM(u.qty), 0)             AS qty,
       COALESCE(SUM(u.total_amount), 0)    AS amount
FROM customers c
LEFT JOIN workers m          ON m.id = c.manager_id
LEFT JOIN production_units u ON u.customer_id = c.id AND u.status <> 'cancelled'
WHERE c.active
GROUP BY m.name, c.manager_id;
