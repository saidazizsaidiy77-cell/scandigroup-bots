-- ============================================================================
--  SCANDI ERP — ISHLAB CHIQARISH MODULI
--  sql/core.sql dan KEYIN ishga tushiriladi (workers jadvaliga tayanadi)
--
--  Ierarxiya:  TSEX  →  BO'LIM  →  (mahsulot marshruti)
--    Tsexlar: Korpus · Bo'yoqlash · Qadoqlash · Stul
--    Bo'limlar: Arra, Rover, Press ... Palirovka, Qoplash, Qadoqlash
--
--  Ikki asosiy prinsip:
--
--  1) MARSHRUTLI OQIM — qat'iy konveyer emas. Har SKU o'z marshrutiga ega;
--     ayrim fasonlar ayrim bo'limlarni chetlab o'tadi.
--
--  2) UMUMIY TSEX — bo'yoqlash tsexi ikkala yo'nalishni (korpus mebel va stul)
--     xizmat qiladi. Shuning uchun u yo'nalishga bog'lanmagan
--     (shops.line_id NULL, is_shared = true) va navbati manba yo'nalish
--     kesimida hisoblanadi.
-- ============================================================================

-- ---------------------------------------------------------------- SPRAVOCHNIK

-- Ishlab chiqarish yo'nalishi (mahsulot oqimi), tsexdan farqli tushuncha
CREATE TABLE IF NOT EXISTS lines (
  id     SERIAL PRIMARY KEY,
  code   TEXT UNIQUE NOT NULL,
  name   TEXT NOT NULL,
  sort   INT  NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true
);

-- TSEX. line_id NULL → umumiy tsex (bo'yoqlash), ikkala yo'nalishga xizmat qiladi.
--   kind = 'flow'  → dona/soat bilan o'lchanadi
--   kind = 'batch' → partiya + quritish sikli bilan o'lchanadi
CREATE TABLE IF NOT EXISTS shops (
  id        SERIAL PRIMARY KEY,
  line_id   INT REFERENCES lines(id),
  code      TEXT UNIQUE NOT NULL,
  name      TEXT NOT NULL,
  kind      TEXT NOT NULL DEFAULT 'flow' CHECK (kind IN ('flow','batch')),
  is_shared BOOLEAN NOT NULL DEFAULT false,
  sort      INT  NOT NULL DEFAULT 0,
  -- 1-fazada faqat tsex chegaralari o'lchanadi. Bottleneck aniqlangach,
  -- o'sha tsexda true qilinadi va bo'limlar alohida qayd etiladi.
  track_sections BOOLEAN NOT NULL DEFAULT false,
  CHECK ((is_shared AND line_id IS NULL) OR (NOT is_shared AND line_id IS NOT NULL))
);

-- BO'LIM — tsex ichidagi ish nuqtasi (Arra, Rover, Rang sepish, Qoplash ...)
CREATE TABLE IF NOT EXISTS sections (
  id      SERIAL PRIMARY KEY,
  shop_id INT  NOT NULL REFERENCES shops(id),
  code    TEXT UNIQUE NOT NULL,
  name    TEXT NOT NULL,
  sort    INT  NOT NULL DEFAULT 0,
  is_exit BOOLEAN NOT NULL DEFAULT false,   -- tayyor mahsulot omboriga chiqish nuqtasi
  -- Rejadagi kunlik quvvat (dona/kun). Muddat bashorati uchun ishlatiladi
  -- FAQAT real tarix hali yo'q paytda; tarix paydo bo'lgach fakt ustun turadi.
  capacity_per_day NUMERIC(10,2),
  active  BOOLEAN NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS idx_sections_shop ON sections(shop_id);

-- Bo'yoqlash kameralari — umumiy tsexning haqiqiy quvvat chegarasi
CREATE TABLE IF NOT EXISTS chambers (
  id           SERIAL PRIMARY KEY,
  shop_id      INT  NOT NULL REFERENCES shops(id),
  code         TEXT UNIQUE NOT NULL,
  name         TEXT NOT NULL,
  capacity_qty INT,      -- bir siklda nechta dona sig'adi
  cycle_min    INT,      -- quritish sikli (daqiqa)
  active       BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS product_groups (
  id      SERIAL PRIMARY KEY,
  code    TEXT UNIQUE NOT NULL,
  name    TEXT NOT NULL,
  line_id INT NOT NULL REFERENCES lines(id)
);

CREATE TABLE IF NOT EXISTS fasons (
  id     SERIAL PRIMARY KEY,
  code   TEXT UNIQUE NOT NULL,
  name   TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true
);

-- ------------------------------------------------------------------- MARSHRUT

CREATE TABLE IF NOT EXISTS route_templates (
  id      SERIAL PRIMARY KEY,
  line_id INT  NOT NULL REFERENCES lines(id),
  code    TEXT UNIQUE NOT NULL,
  name    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS route_steps (
  id          SERIAL PRIMARY KEY,
  template_id INT NOT NULL REFERENCES route_templates(id) ON DELETE CASCADE,
  section_id  INT NOT NULL REFERENCES sections(id),
  sort        INT NOT NULL,
  -- Normani ISHGA TUSHGANDA BO'SH QOLDIRING. Birinchi 3-4 hafta real fakt
  -- yig'iladi, keyin baseline asosida to'ldiriladi.
  norma_min   NUMERIC(8,2),
  UNIQUE (template_id, section_id)
);

CREATE TABLE IF NOT EXISTS products (
  id                SERIAL PRIMARY KEY,
  sku               TEXT UNIQUE NOT NULL,
  name              TEXT NOT NULL,
  group_id          INT  NOT NULL REFERENCES product_groups(id),
  fason_id          INT  REFERENCES fasons(id),
  route_template_id INT  REFERENCES route_templates(id),
  is_set            BOOLEAN NOT NULL DEFAULT false,
  active            BOOLEAN NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS idx_products_group ON products(group_id);

-- Guruh spravochnigining qo'shimcha ustunlari. Jadval yuqorida yaratilgan,
-- lekin ustunlar keyin qo'shilgan — mavjud bazalarda ular ALTER bilan
-- paydo bo'ladi. `route_template_id` shu yerda turadi, chunki
-- `route_templates` product_groups dan keyin yaratiladi.
--
--   active  — o'chirilmaydi, faolsizlantiriladi: kiritilgan birlik o'z
--             mahsulotiga bog'liq, o'chirilsa jurnal tarixi buziladi
--   sort    — jadvaldagi ko'rinish tartibi
--   is_set  — to'plammi yoki yakka mahsulot. To'plam bitta konveyer raqami
--             bilan bir butun bo'lib liniyadan o'tadi
--   route_template_id — guruhning odatdagi marshruti: yangi mahsulot shu
--             bilan yaratiladi, keyin alohida o'zgartirilishi mumkin
ALTER TABLE product_groups ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE product_groups ADD COLUMN IF NOT EXISTS sort   INT     NOT NULL DEFAULT 0;
ALTER TABLE product_groups ADD COLUMN IF NOT EXISTS is_set BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE product_groups ADD COLUMN IF NOT EXISTS route_template_id INT
  REFERENCES route_templates(id);

ALTER TABLE fasons ADD COLUMN IF NOT EXISTS sort INT NOT NULL DEFAULT 0;

-- Mahsulot o'lchami. Bitta fason bir nechta o'lchamda chiqadigan guruhlar
-- uchun: stol "Safia" 3,5 m dan 6 m gacha oltita uzunlikda yasaladi va
-- ularning har biri ALOHIDA mahsulot — narxi boshqa, omborda alohida
-- turadi, "3 dona stol bor" degan gap uzunliksiz ma'no bermaydi.
--
-- Rang va matodan farqi shu: ular birlikning belgisi (bitta fason har xil
-- rangda chiqaveradi), o'lcham esa mahsulotning o'zini o'zgartiradi.
--
-- O'lchami yo'q guruhlarda (penal, kamod, sp, stul) NULL bo'lib qoladi.
ALTER TABLE products ADD COLUMN IF NOT EXISTS size_label TEXT;

CREATE TABLE IF NOT EXISTS set_items (
  set_product_id  INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  item_product_id INT NOT NULL REFERENCES products(id),
  qty             INT NOT NULL DEFAULT 1,
  PRIMARY KEY (set_product_id, item_product_id)
);

-- ============================================================================
--  DETALIROVKA UCHUN JOY — hozircha bo'sh, keyingi bosqichda to'ldiriladi.
--
--  Bugun kuzatuv SKU darajasida: "Milano vitrina — 30 dona Freza bo'limida".
--  Detalirovka kiritilgach kuzatuvni DETAL darajasiga tushirish mumkin
--  ("Milano vitrina yon panel — 60 dona"), va buning uchun schema tayyor:
--    · product_parts — detal ro'yxati, har detal o'z marshrutiga ega bo'lishi mumkin
--    · flow_log.part_id — qaysi detal o'tgani (hozir NULL, SKU darajasi ishlaydi)
--  Ikkisi birga ishlaydi: part_id NULL bo'lsa yozuv butun SKU ga tegishli.
-- ============================================================================
CREATE TABLE IF NOT EXISTS product_parts (
  id                SERIAL PRIMARY KEY,
  product_id        INT  NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  part_no           TEXT,                      -- detalirovka raqami / chizma kodi
  name              TEXT NOT NULL,             -- "Yon panel", "Eshik", "Tokcha"
  material          TEXT,                      -- LDSP 16mm, MDF 18mm, massiv ...
  size_mm           TEXT,                      -- "1800x400x16"
  qty_per_product   NUMERIC(10,3) NOT NULL DEFAULT 1,
  -- Detal butun mahsulotdan boshqa yo'ldan yurishi mumkin (masalan faqat
  -- eshik bo'yaladi, korpus bo'yalmaydi) — shuning uchun alohida marshrut.
  route_template_id INT REFERENCES route_templates(id),
  note              TEXT,
  UNIQUE (product_id, part_no)
);
CREATE INDEX IF NOT EXISTS idx_parts_product ON product_parts(product_id);

-- Fason istisnosi: shu SKU shu bo'limga KIRMAYDI
CREATE TABLE IF NOT EXISTS product_route_skip (
  product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  section_id INT NOT NULL REFERENCES sections(id),
  note       TEXT,
  PRIMARY KEY (product_id, section_id)
);

-- Xodimlar (workers) yadroda: sql/core.sql

-- --------------------------------------------------------------------- SABAB

CREATE TABLE IF NOT EXISTS defect_reasons (
  code TEXT PRIMARY KEY, name TEXT NOT NULL, sort INT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS downtime_reasons (
  code TEXT PRIMARY KEY, name TEXT NOT NULL, sort INT NOT NULL DEFAULT 0
);

-- ------------------------------------------------------------------- OPERATIV

-- Smena yo'nalish kesimida yuritiladi. Umumiy bo'yoqlash tsexida ishlangan dona
-- MAHSULOT YO'NALISHIGA yoziladi — chiqish har doim to'g'ri yo'nalishga tegishli.
CREATE TABLE IF NOT EXISTS shifts (
  id        SERIAL PRIMARY KEY,
  work_date DATE NOT NULL,
  shift_no  INT  NOT NULL DEFAULT 1,
  line_id   INT  NOT NULL REFERENCES lines(id),
  opened_by INT  REFERENCES workers(id),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  UNIQUE (work_date, shift_no, line_id)
);

CREATE TABLE IF NOT EXISTS plans (
  id         SERIAL PRIMARY KEY,
  work_date  DATE NOT NULL,
  line_id    INT  NOT NULL REFERENCES lines(id),
  product_id INT  NOT NULL REFERENCES products(id),
  qty        INT  NOT NULL,
  UNIQUE (work_date, line_id, product_id)
);

-- ★ TIZIM YADROSI: har bo'limdan o'tgan dona
CREATE TABLE IF NOT EXISTS flow_log (
  id         BIGSERIAL PRIMARY KEY,
  shift_id   INT  NOT NULL REFERENCES shifts(id),
  section_id INT  NOT NULL REFERENCES sections(id),
  product_id INT  NOT NULL REFERENCES products(id),
  -- Detalirovka kiritilgach to'ldiriladi. NULL → yozuv butun SKU ga tegishli.
  part_id    INT  REFERENCES product_parts(id),
  qty_ok     INT  NOT NULL DEFAULT 0,
  qty_defect INT  NOT NULL DEFAULT 0,
  worker_id  INT  REFERENCES workers(id),
  ts         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note       TEXT,
  CHECK (qty_ok >= 0 AND qty_defect >= 0)
);
-- Boshlang'ich qoldiq ham flow_log ga tushadi (WIP va hisobotlar shunga
-- tayanadi), lekin u O'SHA KUNI ISHLAB CHIQARILGAN emas — konveyerda
-- allaqachon turgan mahsulotning suratga olingani. Quvvat hisobiga qo'shilsa
-- bo'lim quvvati bir necha barobar oshib ketadi va muddat bashorati buziladi:
-- savdo mijozga noto'g'ri sana aytadi. Shuning uchun alohida belgilanadi.
ALTER TABLE flow_log ADD COLUMN IF NOT EXISTS is_opening BOOLEAN NOT NULL DEFAULT false;

-- Belgi qo'shilishidan oldin kiritilgan qoldiqlar: izohidan topiladi.
-- Bir marta ishlaydi, keyin mos qator qolmaydi.
UPDATE flow_log SET is_opening = true
 WHERE NOT is_opening AND note LIKE '%boshlang''ich qoldiq%';

CREATE INDEX IF NOT EXISTS idx_flow_shift   ON flow_log(shift_id);
CREATE INDEX IF NOT EXISTS idx_flow_section ON flow_log(section_id, product_id);
CREATE INDEX IF NOT EXISTS idx_flow_ts      ON flow_log(ts);

CREATE TABLE IF NOT EXISTS defects (
  id          BIGSERIAL PRIMARY KEY,
  flow_log_id BIGINT REFERENCES flow_log(id) ON DELETE CASCADE,
  work_date   DATE NOT NULL DEFAULT CURRENT_DATE,
  section_id  INT  NOT NULL REFERENCES sections(id),
  product_id  INT  NOT NULL REFERENCES products(id),
  reason_code TEXT NOT NULL REFERENCES defect_reasons(code),
  qty         INT  NOT NULL,
  -- brak topilgan joy emas, KELIB CHIQQAN joy
  -- (bo'yoqlashda topilgan korpus xatosi korpusga yoziladi)
  origin_section_id INT REFERENCES sections(id),
  ts          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note        TEXT
);
CREATE INDEX IF NOT EXISTS idx_defects_date ON defects(work_date);

-- To'xtash smenaga emas, BO'LIM + VAQTga bog'langan: umumiy bo'yoqlash tsexi
-- to'xtaganda u bitta yo'nalishga tegishli bo'lmaydi.
CREATE TABLE IF NOT EXISTS downtime (
  id          BIGSERIAL PRIMARY KEY,
  work_date   DATE NOT NULL DEFAULT CURRENT_DATE,
  shift_no    INT  NOT NULL DEFAULT 1,
  section_id  INT  NOT NULL REFERENCES sections(id),
  reason_code TEXT REFERENCES downtime_reasons(code),
  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at    TIMESTAMPTZ,
  worker_id   INT REFERENCES workers(id),
  note        TEXT
);
CREATE INDEX IF NOT EXISTS idx_downtime_date ON downtime(work_date);

CREATE TABLE IF NOT EXISTS paint_batches (
  id          BIGSERIAL PRIMARY KEY,
  work_date   DATE NOT NULL DEFAULT CURRENT_DATE,
  shift_no    INT  NOT NULL DEFAULT 1,
  section_id  INT  NOT NULL REFERENCES sections(id),
  chamber_id  INT  REFERENCES chambers(id),
  product_id  INT  NOT NULL REFERENCES products(id),
  qty         INT  NOT NULL,
  repaint_qty INT  NOT NULL DEFAULT 0,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at    TIMESTAMPTZ,
  worker_id   INT REFERENCES workers(id)
);
CREATE INDEX IF NOT EXISTS idx_paint_date ON paint_batches(work_date);

CREATE TABLE IF NOT EXISTS fg_stock (
  product_id INT PRIMARY KEY REFERENCES products(id),
  qty        INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ========================================================== HISOBOT VIEW'LARI

-- Mahsulot → yo'nalish. Hisobotlarda yo'nalish AYNAN SHU YERDAN olinadi,
-- tsexdan emas: umumiy bo'yoqlash tsexida ishlangan dona o'z yo'nalishiga tegishli.
CREATE OR REPLACE VIEW v_product_line AS
SELECT p.id AS product_id, l.id AS line_id, l.name AS line_name
FROM products p
JOIN product_groups g ON g.id = p.group_id
JOIN lines l          ON l.id = g.line_id;

-- Mahsulotning haqiqiy marshruti (shablon − istisnolar)
CREATE OR REPLACE VIEW v_product_route AS
SELECT p.id                                                  AS product_id,
       rs.section_id,
       ROW_NUMBER() OVER (PARTITION BY p.id ORDER BY rs.sort) AS step_no,
       rs.norma_min
FROM products p
JOIN route_steps rs ON rs.template_id = p.route_template_id
JOIN sections sc    ON sc.id = rs.section_id AND sc.active
LEFT JOIN product_route_skip sk
       ON sk.product_id = p.id AND sk.section_id = rs.section_id
WHERE p.active AND sk.product_id IS NULL;

CREATE OR REPLACE VIEW v_product_route_lag AS
SELECT product_id, section_id, step_no, norma_min,
       LAG(section_id) OVER (PARTITION BY product_id ORDER BY step_no) AS prev_section_id
FROM v_product_route;

CREATE OR REPLACE VIEW v_section_totals AS
SELECT product_id, section_id, SUM(qty_ok) AS qty_ok, SUM(qty_defect) AS qty_defect
FROM flow_log GROUP BY product_id, section_id;

-- ★ WIP / navbat: bo'lim oldida nechta yarim tayyor turibdi
CREATE OR REPLACE VIEW v_wip AS
SELECT rl.product_id, rl.section_id, rl.step_no,
       COALESCE(pv.qty_ok,0) - COALESCE(cu.qty_ok,0) - COALESCE(cu.qty_defect,0) AS queue_qty
FROM v_product_route_lag rl
LEFT JOIN v_section_totals pv
       ON pv.product_id = rl.product_id AND pv.section_id = rl.prev_section_id
LEFT JOIN v_section_totals cu
       ON cu.product_id = rl.product_id AND cu.section_id = rl.section_id
WHERE rl.prev_section_id IS NOT NULL;

-- Tsexlar kesimida navbat. Umumiy tsex uchun yo'nalish bo'yicha ham ajratiladi.
CREATE OR REPLACE VIEW v_shop_wip AS
SELECT sh.id AS shop_id, sh.name AS shop, sh.is_shared, sh.sort,
       pl.line_name,
       SUM(GREATEST(w.queue_qty, 0)) AS queue_qty
FROM v_wip w
JOIN sections sc       ON sc.id = w.section_id
JOIN shops sh          ON sh.id = sc.shop_id
JOIN v_product_line pl ON pl.product_id = w.product_id
GROUP BY sh.id, sh.name, sh.is_shared, sh.sort, pl.line_name;

-- ★ UMUMIY TSEX YUKLAMASI: bo'yoqlash quvvatini qaysi yo'nalish qancha yeyapti.
--   Umumiy resursda bu asosiy boshqaruv savoli.
CREATE OR REPLACE VIEW v_shared_load AS
WITH q AS (
  SELECT sh.id AS shop_id, sh.name AS shop, pl.line_name,
         SUM(GREATEST(w.queue_qty, 0)) AS queue_qty
  FROM v_wip w
  JOIN sections sc       ON sc.id = w.section_id
  JOIN shops sh          ON sh.id = sc.shop_id AND sh.is_shared
  JOIN v_product_line pl ON pl.product_id = w.product_id
  GROUP BY sh.id, sh.name, pl.line_name
)
SELECT shop_id, shop, line_name, queue_qty,
       ROUND(100.0 * queue_qty / NULLIF(SUM(queue_qty) OVER (PARTITION BY shop_id), 0), 1)
         AS share_pct
FROM q;

CREATE OR REPLACE VIEW v_section_daily AS
SELECT s.work_date, sc.id AS section_id, sc.name AS section,
       sh.name AS shop, sh.is_shared, pl.line_name AS line,
       SUM(f.qty_ok)     AS qty_ok,
       SUM(f.qty_defect) AS qty_defect,
       ROUND(100.0 * SUM(f.qty_defect)
             / NULLIF(SUM(f.qty_ok) + SUM(f.qty_defect), 0), 2) AS defect_pct
FROM flow_log f
JOIN shifts s          ON s.id = f.shift_id
JOIN sections sc       ON sc.id = f.section_id
JOIN shops sh          ON sh.id = sc.shop_id
JOIN v_product_line pl ON pl.product_id = f.product_id
GROUP BY s.work_date, sc.id, sc.name, sh.name, sh.is_shared, pl.line_name;

CREATE OR REPLACE VIEW v_plan_fact AS
SELECT pl.work_date, pl.line_id, pl.product_id, p.name AS product,
       pl.qty AS plan_qty,
       COALESCE(SUM(f.qty_ok), 0) AS fact_qty,
       ROUND(100.0 * COALESCE(SUM(f.qty_ok), 0) / NULLIF(pl.qty, 0), 1) AS pct,
       -- Yangi ustun oxirida: CREATE OR REPLACE VIEW mavjud bazada
       -- ustunni faqat oxiriga qo'sha oladi, o'rtaga qo'yolmaydi.
       p.sku
FROM plans pl
JOIN products p ON p.id = pl.product_id
LEFT JOIN shifts sh ON sh.work_date = pl.work_date AND sh.line_id = pl.line_id
LEFT JOIN flow_log f
       ON f.shift_id = sh.id
      AND f.product_id = pl.product_id
      AND f.section_id IN (SELECT id FROM sections WHERE is_exit)
GROUP BY pl.work_date, pl.line_id, pl.product_id, p.name, p.sku, pl.qty;

-- ★ KOMPLEKTLILIK: omborda nechta TO'LIQ to'plam yig'ish mumkin.
-- KOMPLEKTLILIK — units.sql da
--
--   v_set_completeness shu yerda EMAS, units.sql da yaratiladi. Sabab
--   v_unit_register bilan bir xil: migratsiya har deploy'da qayta ishlaydi
--   va fayllar tartib bilan yuradi. Bitta view ikki faylda tursa, oldingi
--   fayl uni eski ustunlar bilan qayta yozmoqchi bo'ladi va "cannot drop
--   columns from view" xatosi chiqadi — ERP_AUTO_MIGRATE=1 da bu serverning
--   umuman ko'tarilmasligi demakdir.
--
--   Bugun xato chiqmayotgani tasodif: ikkala ta'rifda ustun nomi va turi
--   bir xil bo'lgani uchun CREATE OR REPLACE o'tib ketyapti. Bittasiga
--   ustun qo'shilishi bilan keyingi deploy yiqilardi.
--
--   units.sql dagi versiya to'liqroq: set_items bo'sh bo'lsa to'plam
--   nomidagi fg_stock qoldig'ini sotishga tayyor deb hisoblaydi.


CREATE OR REPLACE VIEW v_set_blockers AS
SELECT sp.id AS set_product_id, sp.name AS set_name,
       ip.name AS blocking_item, si.qty AS need_per_set,
       COALESCE(stk.qty,0) AS in_stock,
       FLOOR(COALESCE(stk.qty,0)::numeric / si.qty)::int AS sets_possible
FROM products sp
JOIN set_items si      ON si.set_product_id = sp.id
JOIN products ip       ON ip.id = si.item_product_id
LEFT JOIN fg_stock stk ON stk.product_id = si.item_product_id
WHERE sp.is_set AND sp.active
ORDER BY sp.name, sets_possible;

-- Kamera bandligi va o'rtacha sikl — bo'yoqlash quvvatining haqiqiy chegarasi
CREATE OR REPLACE VIEW v_chamber_load AS
SELECT c.id AS chamber_id, c.name AS chamber, b.work_date,
       COUNT(*)           AS batches,
       SUM(b.qty)         AS qty,
       SUM(b.repaint_qty) AS repaint_qty,
       ROUND(AVG(EXTRACT(EPOCH FROM (b.ended_at - b.started_at)) / 60)) AS avg_cycle_min
FROM paint_batches b
JOIN chambers c ON c.id = b.chamber_id
WHERE b.ended_at IS NOT NULL
GROUP BY c.id, c.name, b.work_date;

-- ============================================================================
--  ZAVOD KO'RINISHI — "hozir nima qayerda va qachon o'tadi"
-- ============================================================================

-- ★ JOYLASHUV: har SKU ning nechta donasi qaysi tsex/bo'lim oldida turibdi.
--   "Milano vitrina · Korpus tsexi · Freza oldida 22 dona"
CREATE OR REPLACE VIEW v_position AS
SELECT w.product_id, p.sku, p.name AS product, g.name AS group_name,
       pl.line_name, sh.id AS shop_id, sh.name AS shop, sh.sort AS shop_sort,
       sc.id AS section_id, sc.name AS section, sc.sort AS section_sort,
       w.step_no, w.queue_qty AS qty
FROM v_wip w
JOIN products p        ON p.id = w.product_id
JOIN product_groups g  ON g.id = p.group_id
JOIN v_product_line pl ON pl.product_id = w.product_id
JOIN sections sc       ON sc.id = w.section_id
JOIN shops sh          ON sh.id = sc.shop_id
WHERE w.queue_qty > 0;

-- Bo'limning kunlik o'tkazish quvvati (dona/kun).
--   'fakt' — oxirgi 14 kundagi real o'rtacha (ishlangan kunlar bo'yicha)
--   'reja' — tarix yo'q, sections.capacity_per_day ishlatildi
--   'yo''q' — ikkalasi ham yo'q, muddat bashorat qilinmaydi
CREATE OR REPLACE VIEW v_section_rate AS
WITH obs AS (
  SELECT f.section_id,
         SUM(f.qty_ok)::numeric / NULLIF(COUNT(DISTINCT s.work_date), 0) AS rate
  FROM flow_log f
  JOIN shifts s ON s.id = f.shift_id
  WHERE s.work_date >= CURRENT_DATE - INTERVAL '14 days' AND f.qty_ok > 0
    -- Boshlang'ich qoldiq real ishlab chiqarish emas — quvvatga qo'shilmaydi
    AND NOT f.is_opening
  GROUP BY f.section_id
)
SELECT sc.id AS section_id, sc.name AS section,
       COALESCE(o.rate, sc.capacity_per_day) AS rate_per_day,
       CASE WHEN o.rate IS NOT NULL           THEN 'fakt'
            WHEN sc.capacity_per_day IS NOT NULL THEN 'reja'
            ELSE 'yo''q' END AS rate_source
FROM sections sc
LEFT JOIN obs o ON o.section_id = sc.id;

-- Joylashuvdan oldinga qolgan marshrut (muddat hisobi uchun yordamchi)
CREATE OR REPLACE VIEW v_position_rem AS
SELECT ps.product_id, ps.section_id AS at_section_id, ps.qty, ps.shop_id AS at_shop_id,
       r.step_no AS rem_step, sc.shop_id AS rem_shop_id, rt.rate_per_day
FROM v_position ps
JOIN v_product_route r ON r.product_id = ps.product_id AND r.step_no >= ps.step_no
JOIN sections sc       ON sc.id = r.section_id
JOIN v_section_rate rt ON rt.section_id = r.section_id;

-- ★ MUDDAT BASHORATI.
--
--   Oqim liniyasida partiya bo'limlardan ketma-ket emas, quvur (pipeline)
--   bo'lib o'tadi: birinchi dona oxirgi bo'limga yetguncha keyingilari
--   orqadan kelaveradi. Shuning uchun taxmin ikki qismdan iborat:
--
--     MAX(qty / rate)  — eng tor bo'lim butun partiyani o'tkazish vaqti
--   + SUM(1 / rate)    — bitta dona quvurdan o'tish vaqti (to'ldirish)
--
--   Bu klassik flow-shop makespan yaqinlashuvi. Kalendar kun beradi,
--   ish kuni emas — dam olish kunlari hisobga olinmagan.
CREATE OR REPLACE VIEW v_position_eta AS
WITH brk AS (   -- tsex almashadigan birinchi qadam
  SELECT product_id, at_section_id, MIN(rem_step) AS change_step
  FROM v_position_rem
  WHERE rem_shop_id <> at_shop_id
  GROUP BY product_id, at_section_id
),
nxt AS (
  SELECT b.product_id, b.at_section_id, b.change_step, sh.name AS next_shop
  FROM brk b
  JOIN v_position_rem r ON r.product_id = b.product_id
                       AND r.at_section_id = b.at_section_id
                       AND r.rem_step = b.change_step
  JOIN shops sh ON sh.id = r.rem_shop_id
  GROUP BY b.product_id, b.at_section_id, b.change_step, sh.name
)
SELECT r.product_id, r.at_section_id, MIN(r.qty) AS qty,
       n.next_shop,
       ROUND(MAX(r.qty / NULLIF(r.rate_per_day, 0))
             + SUM(1.0 / NULLIF(r.rate_per_day, 0)), 1) AS eta_fg_days,
       ROUND(MAX(r.qty / NULLIF(r.rate_per_day, 0))
               FILTER (WHERE n.change_step IS NULL OR r.rem_step < n.change_step)
             + SUM(1.0 / NULLIF(r.rate_per_day, 0))
               FILTER (WHERE n.change_step IS NULL OR r.rem_step < n.change_step), 1)
         AS eta_next_shop_days,
       BOOL_OR(r.rate_per_day IS NULL) AS rate_missing
FROM v_position_rem r
LEFT JOIN nxt n ON n.product_id = r.product_id AND n.at_section_id = r.at_section_id
GROUP BY r.product_id, r.at_section_id, n.next_shop, n.change_step;

-- Tsexlar kesimida jami: nechta dona qaysi tsexda turibdi
CREATE OR REPLACE VIEW v_shop_load AS
SELECT sh.id AS shop_id, sh.name AS shop, sh.is_shared, sh.sort,
       COALESCE(SUM(ps.qty), 0) AS qty,
       COUNT(DISTINCT ps.product_id) AS sku_count
FROM shops sh
LEFT JOIN sections sc ON sc.shop_id = sh.id
LEFT JOIN v_position ps ON ps.section_id = sc.id
GROUP BY sh.id, sh.name, sh.is_shared, sh.sort;

-- Oxirgi harakatlar: "qachon o'tdi" tarixi
CREATE OR REPLACE VIEW v_movements AS
SELECT f.id, f.ts, p.sku, p.name AS product, pl.line_name,
       sh.name AS shop, sc.name AS section,
       f.qty_ok, f.qty_defect, w.name AS worker, sc.is_exit
FROM flow_log f
JOIN products p        ON p.id = f.product_id
JOIN v_product_line pl ON pl.product_id = f.product_id
JOIN sections sc       ON sc.id = f.section_id
JOIN shops sh          ON sh.id = sc.shop_id
LEFT JOIN workers w    ON w.id = f.worker_id;

-- Bitta SKU ning marshruti bo'ylab holati: qayerdan o'tdi, qachon, nechta
CREATE OR REPLACE VIEW v_product_progress AS
SELECT r.product_id, r.step_no, sc.id AS section_id, sc.name AS section,
       sh.name AS shop, sh.is_shared, sc.is_exit,
       COALESCE(t.qty_ok, 0)     AS passed_qty,
       COALESCE(t.qty_defect, 0) AS defect_qty,
       COALESCE(GREATEST(w.queue_qty, 0), 0) AS queue_qty,
       (SELECT MAX(f.ts) FROM flow_log f
         WHERE f.product_id = r.product_id AND f.section_id = r.section_id) AS last_ts
FROM v_product_route r
JOIN sections sc ON sc.id = r.section_id
JOIN shops sh    ON sh.id = sc.shop_id
LEFT JOIN v_section_totals t ON t.product_id = r.product_id AND t.section_id = r.section_id
LEFT JOIN v_wip w            ON w.product_id = r.product_id AND w.section_id = r.section_id;
