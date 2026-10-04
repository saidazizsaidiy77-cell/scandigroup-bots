-- ═══════════════════════════════════════════════════════ SAVDO KPI
--
--  ★ NOMLAR `sales_kpi_*`, va bu ATAYLAB. Loyihada ALLAQACHON
--  `kpi_targets` bor (`sql/cash.sql`, `modules/kpi.js`) va u BOSHQA
--  narsa: zavodning BO'LIM rejasi — «ishlab chiqarish bu oyda qancha
--  qildi». Bu yerdagisi esa savdo XODIMINING shaxsiy KPI si:
--  og'irlik, turkum va bonus shkalasi bilan.
--
--  Ikkalasi bitta nomda bo'lsa migratsiya yiqilardi va 1-qoida
--  bo'yicha SAYT UMUMAN KO'TARILMASDI. Shuning uchun prefiks:
--  «savdo KPI si» ekani nomning o'zidan ko'rinib tursin.
--
--  ★ KPI UCHTA NARSADAN YIG'ILADI (zavod qarori, 2026-10). Savdo
--  xodimining oylik natijasi bitta raqam emas: u bir nechta
--  ko'rsatkichdan, har biri o'z OG'IRLIGI bilan qo'shiladi.
--
--    Bajarilish    = Fakt / Reja
--    KPIga ta'siri = Bajarilish × Og'irlik
--    UMUMIY KPI    = ta'sirlarning yig'indisi
--
--  Og'irliklar yig'indisi 1,00 bo'lishi kerak — aks holda UMUMIY KPI
--  o'z ma'nosini yo'qotadi (0,9 bo'lsa hech kim 100% ga yetolmaydi,
--  1,1 bo'lsa hammasini bajargan odam 110% oladi). Tekshiruv
--  serverda: reja saqlanayotganda aytiladi.
--
--  ★ KO'RSATKICHLAR RO'YXATI BAZADA, kodda emas (4-qoida). Zavod
--  hozir uchtasini ishlatadi, ertaga to'rtinchisini qo'shadi —
--  «Qarzdorlik» va «Yangi mijoz» qatorlari shu sababdan hoziroq
--  yoziladi, lekin O'CHIQ (`active = false`): ro'yxatda turgani
--  bilan hisobga tushmaydi.

CREATE TABLE IF NOT EXISTS sales_kpi_indicators (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  --  O'lchov birligi: pul (`usd`) yoki dona (`ta`). Ekran raqamni
  --  shunga qarab yozadi — AKB ni dollar qilib ko'rsatish yolg'on
  --  bo'lardi.
  unit TEXT NOT NULL DEFAULT 'usd' CHECK (unit IN ('usd', 'ta')),
  --  ★ SEGMENT KO'RSATKICHI ICHIDA TURKUMLAR BOR va ular ALOHIDA
  --  ko'rsatkich EMAS: og'irlikni ota qator ko'taradi, to'rttasi esa
  --  uning tafsiloti. Teskarisi qilinsa og'irliklar yig'indisi
  --  buzilardi va bitta savdo ikki marta sanalardi.
  by_category BOOLEAN NOT NULL DEFAULT false,
  --  Standart og'irlik — yangi oyga reja qo'yilganda shu tushadi.
  --  Haqiqiy og'irlik REJADA turadi: bir xodimga tushum muhimroq,
  --  boshqasiga mijozlar bazasi.
  default_weight NUMERIC(5,4) NOT NULL DEFAULT 0,
  sort   INT     NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true
);

INSERT INTO sales_kpi_indicators (code, name, unit, by_category, default_weight, sort, active)
VALUES
  ('TUSHUM',  'Tushum',                 'usd', false, 0.70, 1, true),
  ('AKB',     'AKB',                    'ta',  false, 0.15, 2, true),
  ('SEGMENT', 'Segment bo''yicha savdo','usd', true,  0.15, 3, true),
  --  Hali ishlatilmaydi — zavod qo'shganda `active` yoqiladi.
  ('QARZ',    'Muddati o''tgan qarz',   'usd', false, 0.00, 4, false),
  ('YANGI',   'Yangi mijoz',            'ta',  false, 0.00, 5, false)
ON CONFLICT (code) DO NOTHING;

--  ★ REJA XODIM VA OY BO'YICHA. Kim kimga qo'yishi huquqdan chiqadi
--  (`sales.kpi`), kodda ism yozilmaydi (4-qoida): direktor va
--  administrator savdo bo'lim boshlig'iga, boshliq esa o'z
--  menejerlariga.
CREATE TABLE IF NOT EXISTS sales_kpi_targets (
  id        SERIAL PRIMARY KEY,
  worker_id INT  NOT NULL REFERENCES workers(id),
  --  Oyning BIRINCHI kuni: reja oylik va uni kun bilan saqlash
  --  «qaysi kunniki» degan savolni ochiq qoldirardi.
  mon       DATE NOT NULL,
  indicator TEXT NOT NULL REFERENCES sales_kpi_indicators(code),
  --  Turkum FAQAT `by_category` ko'rsatkichida to'ladi; ota qatorda
  --  bo'sh qoladi va og'irlik aynan o'sha qatorda turadi.
  category  TEXT REFERENCES sales_categories(code),
  plan      NUMERIC(16,2) NOT NULL CHECK (plan >= 0),
  weight    NUMERIC(5,4)  CHECK (weight IS NULL OR (weight >= 0 AND weight <= 1)),
  set_by    INT REFERENCES workers(id),
  set_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

--  `category` NULL bo'lgani ham TAKRORLANMASIN: Postgres'da NULL lar
--  bir-biriga teng emas, ya'ni oddiy UNIQUE ikkita ota qatorni o'tkazib
--  yuborardi va og'irlik ikki marta sanalardi.
--  COALESCE indeks IFODASI bo'lgani uchun QO'SHIMCHA qavs talab
--  qiladi: oddiy funksiya chaqiruvi emas va qavssiz Postgres uni
--  ustun nomi deb o'qiydi («column category does not exist»).
CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_kpi_targets_uniq
  ON sales_kpi_targets (worker_id, mon, indicator, (COALESCE(category, '')));
CREATE INDEX IF NOT EXISTS idx_sales_kpi_targets_mon ON sales_kpi_targets (mon);

--  ★ BONUS SHKALASI BAZADA (zavod qarori, 2026-10):
--
--    KPI < 50%       faqat fiksa oylik
--    50 – 79,99%     tushgan pulning 0,75%
--    80% va yuqori   tushgan pulning 1%
--
--  Bosqich qo'shish yoki stavkani o'zgartirish — bitta qator, kodga
--  tegilmaydi. Qator KPI ning QUYI chegarasi bilan yoziladi: hisob
--  «shu foizdan katta yoki teng bo'lgan eng yuqori bosqich» ni
--  oladi, ya'ni oraliqlar orasida teshik qolmaydi.
CREATE TABLE IF NOT EXISTS sales_kpi_bands (
  from_pct NUMERIC(6,2) PRIMARY KEY CHECK (from_pct >= 0),
  rate_pct NUMERIC(6,4) NOT NULL CHECK (rate_pct >= 0)
);

INSERT INTO sales_kpi_bands (from_pct, rate_pct) VALUES
  (0,  0),
  (50, 0.75),
  (80, 1)
ON CONFLICT (from_pct) DO NOTHING;

-- ───────────────────────────────────────────────────────── FAKT
--
--  ★ UCHALA RAQAM HAM MIJOZNING MENEJERIGA yoziladi
--  (`customers.manager_id`), pulni qo'lida kim olib kelganiga
--  qaramay. Zavodda inkassator bor va u HAMMA mijozdan yig'adi —
--  to'lovni olgan odamga yozsak butun bo'limning tushumi bitta
--  odamga tushib ketardi.
--
--  ★ TUSHUM — PUL, SEGMENT esa YUK XATI, va ular TENG EMAS. Mahsulot
--  chiqdi-yu puli kelmadi, yoki teskarisi: oldindan to'lov. Ikkala
--  raqam ham to'g'ri, faqat boshqa savolga javob beradi. Shuning
--  uchun ular alohida ko'rsatkich va alohida og'irlik bilan turadi.
--
--  Turkum GURUHDAN o'qiladi (`sales_category`): penal va kamod
--  ikkita guruh, bitta turkum (izoh: sql/catalog-groups.sql).
-- ────────────────────────────────────────── KIM KIMNING QO'L OSTIDA
--
--  ★ BOSHLIQNING KPI SI — QO'L OSTIDAGILARNING YIG'INDISI (zavod
--  qarori, 2026-10). Savdo bo'lim boshlig'i o'z qo'li bilan mijoz
--  yuritmaydi: direktor UNGA reja qo'yadi, u esa o'z menejerlariga
--  qo'yadi va ularning natijasi orqali o'z rejasini bajaradi.
--
--  Ilgari fakt QAT'IY `customers.manager_id` dan yurardi, ya'ni
--  boshliqning varag'ida hamma raqam NOL bo'lib turardi — unga reja
--  qo'yish mumkin edi-yu, bajarilishi hech qachon ko'rinmasdi.
--
--  Bog'lanish BAZADA, rolda emas (4-qoida): zavodda ertaga ikkinchi
--  bo'lim boshlig'i paydo bo'lsa yoki menejer boshqasiga o'tsa bitta
--  katakcha ko'chadi. Rol buni ajrata olmaydi — `savdo_boshliq`
--  rolining O'ZI kimning qo'l ostida kim turganini aytmaydi.
ALTER TABLE workers ADD COLUMN IF NOT EXISTS sales_head_id INT
  REFERENCES workers(id);

--  O'ZINI O'ZIGA biriktirib bo'lmaydi: halqa hosil bo'lardi va
--  boshliqning savdosi o'ziga ikki marta qo'shilardi.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'workers_sales_head_not_self') THEN
    ALTER TABLE workers ADD CONSTRAINT workers_sales_head_not_self
      CHECK (sales_head_id IS NULL OR sales_head_id <> id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_workers_sales_head
  ON workers(sales_head_id) WHERE sales_head_id IS NOT NULL;

DROP VIEW IF EXISTS v_sales_kpi_fact CASCADE;
CREATE VIEW v_sales_kpi_fact AS
--  ★ BITTA MIJOZ IKKI ODAMGA SANALADI: o'z menejeriga va uning
--  bo'lim boshlig'iga. Yig'indi SHU YERDA, har ko'rsatkichda emas —
--  AKB `COUNT(DISTINCT)` bilan hisoblanadi va menejerlarning
--  raqamini qo'shib bo'lmaydi: bitta mijoz ikkalasidan ham olgan
--  bo'lsa boshliqda ikki marta sanalardi. Mijozni oldindan
--  ko'paytirib, keyin guruhlash bu savolni o'zi hal qiladi.
--
--  Bir qavat yetarli: zavodda zanjir «direktor → bo'lim boshlig'i →
--  menejer» va direktorning o'zi dasturda o'lchanmaydi. Rekursiya
--  yozilsa bugun hech narsa bermay, ertaga halqani tekshirish
--  kerak bo'lardi.
WITH kim AS (
  SELECT c.id AS customer_id, c.manager_id AS worker_id
    FROM customers c
   WHERE c.manager_id IS NOT NULL
  UNION
  SELECT c.id, w.sales_head_id
    FROM customers c
    JOIN workers w ON w.id = c.manager_id
   WHERE w.sales_head_id IS NOT NULL
)
--  1. TUSHUM — mijozdan kelgan pul. Bekor qilingani va hali qabul
--  qilinmagani (`pending`) sanalmaydi: pul hali kassada emas.
SELECT k.worker_id                                   AS worker_id,
       date_trunc('month', o.op_date)::date          AS mon,
       'TUSHUM'::text                                AS indicator,
       NULL::text                                    AS category,
       SUM(o.amount_usd)::numeric(16,2)              AS fakt
  FROM cash_ops o
  JOIN kim k ON k.customer_id = o.from_id
 WHERE o.from_kind = 'customer' AND o.status = 'ok'
 GROUP BY 1, 2
UNION ALL
--  2. AKB — oraliqda mahsulot OLGAN mijozlar soni (zavod qarori):
--  buyurtma yozgani emas, to'lagani ham emas — mahsulotni olgani.
SELECT k.worker_id, date_trunc('month', u.ship_on)::date, 'AKB', NULL,
       COUNT(DISTINCT u.customer_id)::numeric(16,2)
  FROM production_units u
  JOIN kim k ON k.customer_id = u.customer_id
 WHERE u.status = 'shipped' AND u.ship_on IS NOT NULL
 GROUP BY 1, 2
UNION ALL
--  3. SEGMENT — chiqib ketgan mahsulot summasi, TURKUM bo'yicha.
--  Turkumi yo'q guruh ham qatorda qoladi (`category` bo'sh): uning
--  savdosi yig'indiga qo'shiladi, lekin qaysi turkumga tegishli
--  ekani ko'rinmaydi — bo'sh katak savol, yo'q qator esa yolg'on.
SELECT k.worker_id, date_trunc('month', u.ship_on)::date, 'SEGMENT',
       g.sales_category,
       SUM(u.total_amount)::numeric(16,2)
  FROM production_units u
  JOIN kim k            ON k.customer_id = u.customer_id
  JOIN products p       ON p.id = u.product_id
  JOIN product_groups g ON g.id = p.group_id
 WHERE u.status = 'shipped' AND u.ship_on IS NOT NULL
   AND u.total_amount IS NOT NULL
 GROUP BY 1, 2, 4;
