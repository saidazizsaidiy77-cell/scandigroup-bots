-- ============================================================================
--  SAVDO: BUYURTMA
--
--  Buyurtma — mijoz nima so'raganining yozuvi. Zavod uni IKKI manbadan
--  bajaradi (zavod qarori):
--
--    · T/M ombordan — tayyor turgan konver mijozga biriktiriladi;
--    · zahiradan    — rang sepishda buyurtma kutayotgan konverga rang
--                     beriladi va u tugatiladi.
--
--  Buyurtma uchun YANGI konver ochilmaydi: ishlab chiqarish o'z rejasi
--  bilan yuradi, savdo esa tayyor va yarim tayyordan sotadi.
--
--  Buyurtmada bir nechta mahsulot bo'ladi ("2 ta Milano penal + 6 ta
--  Laura stul"), shuning uchun sarlavha va qatorlar alohida.
-- ============================================================================

CREATE TABLE IF NOT EXISTS orders (
  id          SERIAL PRIMARY KEY,
  -- Z26-0001. Tizim beradi: xodim o'ylab topmaydi va takrorlanmaydi.
  order_no    TEXT NOT NULL UNIQUE,
  customer_id INT  NOT NULL REFERENCES customers(id),
  manager_id  INT  REFERENCES workers(id),
  ordered_on  DATE NOT NULL DEFAULT CURRENT_DATE,
  -- Mijozga va'da qilingan kun. Muddat o'tsa ro'yxatda qizarib turadi.
  due_on      DATE,
  note        TEXT,
  --   new       — yozildi, hali bron qo'yilmagan
  --   reserved  — bron qo'yildi, hali omborga yuborilmagan
  --   to_ship   — savdo omborga yubordi, mudir chiqarishni nazorat qiladi
  --   shipped   — mijozga chiqdi (ombor mudiri tasdiqladi)
  --   cancelled — bekor qilindi
  status      TEXT NOT NULL DEFAULT 'new'
              CHECK (status IN ('new', 'reserved', 'to_ship', 'shipped', 'cancelled')),
  created_by  INT REFERENCES workers(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);

-- ─────────────────────────────────────────────────────── MAHSULOT QAYERGA
--
--  Zavod to'rt xil yo'l bilan beradi va har birida boshqa narsa kerak:
--  mashina zavodga kirsa manzil so'ralmaydi, mijoz uyiga bo'lsa
--  so'raladi. Shuning uchun ro'yxat KODDA emas, bazada — yangi yo'l
--  qo'shilsa shu faylga bitta qator yoziladi, sahifaga tegilmaydi.
CREATE TABLE IF NOT EXISTS order_destinations (
  code         TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  -- Manzil maydonini majburiy qiladi: uyiga va do'konga yetkazilsa
  -- manzilsiz mashina qayerga borishini hech kim bilmaydi.
  needs_address BOOLEAN NOT NULL DEFAULT FALSE,
  sort         INT NOT NULL DEFAULT 100
);
INSERT INTO order_destinations (code, name, needs_address, sort) VALUES
  ('ZAVOD',    'Avtomobil zavodga kiradi', FALSE, 1),
  ('TERMINAL', 'Yuk terminaliga',          TRUE,  2),
  ('UY',       'Mijoz uyiga',              TRUE,  3),
  ('DOKON',    'Do''konga',                TRUE,  4)
ON CONFLICT (code) DO NOTHING;

-- ───────────────────────────────────────────── JO'NATISH TAFSILOTLARI
--
--  Buyurtma yozilayotganda so'raladi, jo'natma moduli yozilganda o'sha
--  yerda ishlatiladi. Hozir ular faqat YOZIB QO'YILADI: menejer mijoz
--  bilan gaplashib turib kelishadi va keyin qidirib yurmasin.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS ship_to TEXT
  REFERENCES order_destinations(code);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS address TEXT;
-- Mahsulotni kutib oluvchining raqami. Mijozning o'z raqami emas:
-- ko'pincha kutib oluvchi boshqa odam — qarindosh, do'kon sotuvchisi,
-- terminal xodimi bo'ladi.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS receiver_phone TEXT;

-- ══════════════════════════════════════════ CHIQARISHNI OMBOR NAZORAT QILADI
--
--  Savdo buyurtmani yozadi va bron qo'yadi, lekin mahsulotni zavoddan
--  CHIQARIB YUBORMAYDI. Buyurtma tayyor bo'lgach ombor mudiriga
--  yuboriladi: u ko'zi bilan ko'rib, mashinaga ortilganini tasdiqlaydi.
--
--  Sabab qabul qilish bilan bir xil: bitta tugma bitta sana beradi,
--  ikkita tugma esa ikkita — va omborda turgan mahsulot kimningdir
--  qo'l ko'tarishisiz chiqib ketmaydi.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sent_to_wh_on DATE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sent_by       INT REFERENCES workers(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipped_on    DATE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipped_by    INT REFERENCES workers(id);

--  Pul kirim sanasi — nakladnoy yozilayotganda, mahsulot chiqib
--  ketayotgan payt qo'yiladi: pul qachon keladi yoki qachon olindi.
--
--  Bu SANA, summa emas: kassa moduli yozilganda to'lovning o'zi o'sha
--  yerda yoziladi. Shuning uchun bu maydon mijoz balansiga TEGMAYDI —
--  sanani yozib qo'yish pul kelganini anglatmaydi.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_on DATE;

-- Holatlar ro'yxati kengaydi: eski bazadagi cheklov almashtiriladi.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('new', 'reserved', 'to_ship', 'shipped', 'cancelled'));
CREATE INDEX IF NOT EXISTS idx_orders_status   ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_due      ON orders(due_on);

-- Buyurtma qatori: qaysi mahsulotdan nechta, qaysi rang va matoda.
-- Rang va mato shu yerda so'raladi, chunki mijoz aynan shuni tanlaydi —
-- keyin ombordan mos konver izlanadi.
CREATE TABLE IF NOT EXISTS order_items (
  id         SERIAL PRIMARY KEY,
  order_id   INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INT NOT NULL REFERENCES products(id),
  qty        INT NOT NULL DEFAULT 1 CHECK (qty > 0),
  color      TEXT,
  fabric     TEXT,
  unit_price NUMERIC(12,2),
  note       TEXT,
  sort       INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_order_items_order   ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items(product_id);

-- ══════════════════════════════════════════════════════════════════ BRON
--
--  Konver buyurtmaning aniq QATORIGA bron qilinadi, buyurtmaga emas:
--  bitta buyurtmada bir xil mahsulot ikki xil rangda bo'lishi mumkin va
--  qaysi konver qaysi qatorni yopayotgani bilinishi kerak.
--
--  ★ KONVER BO'LINMAYDI, USTIGA BRON QO'YILADI
--
--  Ilgari bir qismi olinsa konver bo'linardi (`clonePart`). Ishlab
--  chiqarishdagi konver uchun bu noto'g'ri: 10 ta stul bitta partiya
--  bo'lib yuradi, bo'limdan bo'limga birga o'tadi. Uni savdo ikkiga
--  bo'lib qo'ysa jurnalda bitta raqam ikki qator bo'lib ko'rinadi va
--  tsex boshlig'i «qaysi biri meniki» deb o'ylab qoladi.
--
--  Shuning uchun bron ALOHIDA jadval: konver bir butun qoladi, ustida
--  «6 tasi Alisherga, 2 tasi Zaripovga» degan yozuv turadi. Bitta
--  konverda bir nechta mijozning broni bo'lishi mumkin.
--
--  Qoida ombordagi mahsulotga ham bir xil: manba bitta bo'lsin, aks
--  holda «nechtasi band» degan savolga ikki xil javob chiqardi.
CREATE TABLE IF NOT EXISTS unit_reservations (
  id            SERIAL PRIMARY KEY,
  unit_id       INT NOT NULL REFERENCES production_units(id) ON DELETE CASCADE,
  order_item_id INT NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  qty           INT NOT NULL CHECK (qty > 0),
  created_by    INT REFERENCES workers(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Bitta qatorga bitta konverdan bitta bron: yana olinsa soni oshadi,
  -- ikkinchi qator ochilmaydi.
  UNIQUE (unit_id, order_item_id)
);
CREATE INDEX IF NOT EXISTS idx_bron_unit ON unit_reservations(unit_id);
CREATE INDEX IF NOT EXISTS idx_bron_item ON unit_reservations(order_item_id);

--  Bronning soni oshirilsa ham bu YANGI xabar: mijozga va'da qilingan
--  dona o'zgardi. `created_at` bunda qimirlamaydi — u konver birinchi
--  marta olingan kun — shuning uchun alohida ustun.
ALTER TABLE unit_reservations
  ADD COLUMN IF NOT EXISTS changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

--  ── YANGI BUYURTMA BELGISI ───────────────────────────────────────────
--
--  Savdo konverni buyurtmaga olsa tsex boshlig'i buni BILISHI kerak:
--  partiya endi mijozniki va navbat shunga qarab tuziladi. Ekrandagi
--  «N buyurtmada» yozuvi buni aytadi, lekin u doim turadi — ko'z
--  o'rganib qoladi va yangisi eskisidan ajralmaydi.
--
--  Shuning uchun har xodim uchun «shu konverni qachon ochib ko'rdim»
--  yozib boriladi: undan keyin tushgan bron YANGI bo'lib turadi, qator
--  ochilganda belgi o'chadi. Xodimga bog'langani muhim — bir tsexda ikki
--  boshliq bo'lsa, birining ko'rgani ikkinchisiniki hisoblanmaydi.
CREATE TABLE IF NOT EXISTS unit_bron_seen (
  worker_id INT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  unit_id   INT NOT NULL REFERENCES production_units(id) ON DELETE CASCADE,
  seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (worker_id, unit_id)
);

--  Belgi ishga tushgan kun. Shu kunga qadar qo'yilgan bronlar YANGI
--  emas: ular allaqachon ekranda turgan va ko'rilgan. Bo'lmasa birinchi
--  deploy'dan keyin har tsexda o'nlab oltin belgi chiqib, boshliq
--  ularni birma-bir ochib tozalashga majbur bo'lardi — va o'sha kuni
--  haqiqiy yangi buyurtma shu to'da orasida ko'rinmay ketardi.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM migration_flags WHERE key = 'bron-korildi') THEN
    -- Eski bronning `changed_at` i ustun qo'shilgan kun emas, olingan kun
    UPDATE unit_reservations SET changed_at = created_at;
    INSERT INTO unit_bron_seen (worker_id, unit_id)
    SELECT w.id, r.unit_id
      FROM workers w
      JOIN v_worker_permissions vp ON vp.worker_id = w.id
                                  AND vp.permission_code = 'production.entry'
      JOIN (SELECT DISTINCT unit_id FROM unit_reservations) r ON true
     WHERE w.active
    ON CONFLICT DO NOTHING;
    INSERT INTO migration_flags (key) VALUES ('bron-korildi');
  END IF;
END $$;

--  Eski biriktirishlar bron jadvaliga ko'chiriladi — bir marta, bayroq
--  bilan. Keyin ustunning o'zi olib tashlanadi: ikki joyda turgan
--  «band» belgisi bir kun bir-biriga zid javob berardi.
--
--  `v_fg_units` shu ustunni o'qiydi, shuning uchun avval o'chiriladi —
--  uni `warehouse.sql` qaytadan quradi (migrate.js dagi tartib: sales
--  ombordan OLDIN).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM migration_flags WHERE key = 'bron-jadvali') THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name = 'production_units' AND column_name = 'order_item_id') THEN
      INSERT INTO unit_reservations (unit_id, order_item_id, qty)
      SELECT id, order_item_id, qty FROM production_units
       WHERE order_item_id IS NOT NULL AND status <> 'cancelled'
      ON CONFLICT (unit_id, order_item_id) DO NOTHING;
    END IF;
    INSERT INTO migration_flags (key) VALUES ('bron-jadvali');
  END IF;
END $$;

--  Konverdagi bronlar: jurnalda qatorni ochganda shu ro'yxat chiqadi
--  («10 ta ishlanmoqda, 6 tasi bronda — kimga?»).
CREATE OR REPLACE VIEW v_unit_bron AS
SELECT r.id, r.unit_id, r.qty, r.created_at,
       i.id AS order_item_id, i.color, i.fabric,
       o.id AS order_id, o.order_no, o.due_on, o.status AS order_status,
       c.id AS customer_id, c.name AS customer_name, c.region,
       w.name AS manager_name
FROM unit_reservations r
JOIN order_items i  ON i.id = r.order_item_id
JOIN orders o       ON o.id = i.order_id
JOIN customers c    ON c.id = o.customer_id
LEFT JOIN workers w ON w.id = o.manager_id
WHERE o.status <> 'cancelled';

-- ─────────────────────────────────────────────────────────── BUYURTMA HOLATI
--
--  Nechtasi biriktirilgani saqlanmaydi, HISOBLANADI: saqlansa u bir kun
--  haqiqatdan ajralib qoladi (konver qaytarildi, bekor qilindi, bo'lindi).
--
--  Nomi `v_sales_orders`, `v_orders` emas: `v_orders` allaqachon bor va u
--  BOSHQA narsa — konverlardagi zakaz raqami bo'yicha kesim (units.sql).
--  Bir xil nom ikki faylda bo'lsa ikkinchi deployda migratsiya yiqiladi
--  va sayt ko'tarilmaydi (CLAUDE.md, 2-qoida).
CREATE OR REPLACE VIEW v_sales_orders AS
SELECT o.id, o.order_no, o.ordered_on, o.due_on, o.status, o.note,
       o.customer_id, c.name AS customer_name, c.region, c.phone,
       o.manager_id, w.name AS manager_name,
       (o.due_on - CURRENT_DATE)::int AS days_left,
       i.lines, i.qty, i.amount,
       COALESCE(a.qty, 0) AS assigned_qty,
       -- Qatorlar to'liq yopilganmi. Bo'sh buyurtma yopilgan hisoblanmaydi.
       (i.qty > 0 AND COALESCE(a.qty, 0) >= i.qty) AS is_ready,
       -- Savdo yo'nalishi: menejerga chegara shu ustundan qo'yiladi
       -- (`worker_roles.scope_channel`). Ustun OXIRIGA qo'shilgan —
       -- CREATE OR REPLACE VIEW faqat oxiriga qo'sha oladi (CLAUDE.md, 2-qoida).
       c.channel,
       -- Jo'natish tafsilotlari ham OXIRIDA, xuddi shu sababdan.
       o.ship_to, d.name AS ship_to_name, o.address, o.receiver_phone,
       o.sent_to_wh_on, sw.name AS sent_by_name,
       o.shipped_on, shw.name AS shipped_by_name,
       -- Bronlarning hammasi omborga yetib kelganmi: yetmagani bo'lsa
       -- ombor mudiri chiqarib bo'lmaydi va nimasi yo'qligini ko'radi.
       COALESCE(a.in_wh, 0) AS in_warehouse_qty,
       -- Pul kirim sanasi ham OXIRIDA: CREATE OR REPLACE VIEW ustunni
       -- faqat oxiriga qo'sha oladi (CLAUDE.md, 2-qoida).
       o.payment_on,
       -- Yuk xatida «yetkazib beruvchi» tomonida menejerning telefoni
       -- turadi: mijoz mashina yo'lda bo'lganda kimga qo'ng'iroq
       -- qilishini bilsin. Ustun OXIRIDA — yuqoridagi sabab bilan.
       w.phone AS manager_phone,
       -- Mahsulotni zavoddan chiqarib bergan ombor mudirining telefoni:
       -- yuk xatida imzo joyida ismi bilan birga turadi. Ism ham,
       -- raqam ham BAZADAN keladi — kodga yozilmaydi (CLAUDE.md, 4-qoida).
       shw.phone AS shipped_by_phone
  FROM orders o
  JOIN customers c      ON c.id = o.customer_id
  LEFT JOIN workers w   ON w.id = o.manager_id
  LEFT JOIN order_destinations d ON d.code = o.ship_to
  LEFT JOIN workers sw  ON sw.id = o.sent_by
  LEFT JOIN workers shw ON shw.id = o.shipped_by
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS lines,
           COALESCE(SUM(oi.qty), 0)::int AS qty,
           COALESCE(SUM(oi.qty * COALESCE(oi.unit_price, 0)), 0) AS amount
      FROM order_items oi WHERE oi.order_id = o.id) i ON true
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(r.qty), 0)::int AS qty,
           COALESCE(SUM(r.qty) FILTER (WHERE u.status IN ('fg', 'shipped')), 0)::int
             AS in_wh
      FROM unit_reservations r
      JOIN order_items oi     ON oi.id = r.order_item_id
      JOIN production_units u ON u.id = r.unit_id
     WHERE oi.order_id = o.id AND u.status <> 'cancelled') a ON true;

-- ─────────────────────────────────── ESKI «BAND» USTUNI OLIB TASHLANADI
--
--  Ma'lumot yuqorida `unit_reservations` ga ko'chirildi. Ustunning o'zi
--  esa fayl OXIRIDA o'chiriladi — undan oldin EMAS: `v_sales_orders`
--  ning eski versiyasi shu ustunga tayanadi va u yuqorida qaytadan
--  qurilishi kerak. Aks holda «cannot drop column ... other objects
--  depend on it» bilan yiqilardi.
--
--  `v_fg_units` ham shu ustunni o'qiydi. U `warehouse.sql` da va
--  bu yerdan keyin quriladi (migrate.js: sales → warehouse), shuning
--  uchun bemalol o'chiriladi.
DROP VIEW IF EXISTS v_fg_units CASCADE;
ALTER TABLE production_units DROP COLUMN IF EXISTS order_item_id;

-- Qarzdorlik lentasi (`v_customer_ledger`) KASSA faylida: unga to'lovlar
-- ham tushadi, to'lovlar esa `cash_ops` da — u migratsiyada shu fayldan
-- KEYIN yaratiladi (sql/cash.sql).

-- ═════════════════════════ CHIQIB KETGAN KONVERGA SOTILGAN NARX
--
--  Mijoz YUK XATIDAGI summani to'laydi, konver kartochkasidagini emas:
--  kartochkadagi narx ishlab chiqarish uchun qo'yilgan, buyurtma
--  qatoridagi esa menejer mijoz bilan kelishgani. Ikkalasi har xil
--  bo'lsa balans hujjatdan farq qilib qolardi — mijoz 2 100 imzolab,
--  qarzdorlikda 2 160 turardi.
--
--  Bundan keyin narx chiqarishda ko'chadi (`modules/sales.js`), lekin
--  ALLAQACHON chiqib ketganlarda eski narx qolgan. Bir martalik
--  ko'chirish shuni to'g'rilaydi.
--
--  Faqat ANIQ holatda: buyurtmada shu mahsulotdan BITTA qator bo'lsa va
--  narxi yozilgan bo'lsa. Ikkita qator bo'lsa (bir xil mahsulot ikki
--  rangda, ikki narxda) qaysi biri ekanini bu yerdan bilib bo'lmaydi —
--  taxmin qilib qo'yilgan narx yolg'on qarz yozardi.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM migration_flags WHERE key = 'sotilgan-narx') THEN
    UPDATE production_units u SET unit_price = t.narx
      FROM (SELECT o.order_no, i.product_id,
                   MIN(i.unit_price) AS narx
              FROM orders o
              JOIN order_items i ON i.order_id = o.id
             WHERE i.unit_price IS NOT NULL
             GROUP BY o.order_no, i.product_id
            HAVING COUNT(*) = 1) t
     WHERE u.status = 'shipped'
       AND u.order_no = t.order_no
       AND u.product_id = t.product_id
       AND COALESCE(u.unit_price, -1) <> t.narx;
    INSERT INTO migration_flags (key) VALUES ('sotilgan-narx');
  END IF;
END $$;

-- ══════════════════════════════════════ HUJJAT RAQAMI QAYERDAN BOSHLANADI
--
--  ★ ZAVOD O'Z DAFTARIDA RAQAM YURITADI (zavod qarori, 2026-09).
--
--  Tizimda buyurtma raqami hozirgacha bo'lgan eng katta raqamdan davom
--  etardi, zavodning qog'oz daftarida esa hisob boshqa joyda turibdi:
--  2026 yilda 757-buyurtma yozilgan. Ikki raqam bir-biridan ajralib
--  ketsa nakladnoydagi raqam daftardagisiga to'g'ri kelmasdi va bitta
--  buyurtmani ikki joyda izlash kerak bo'lardi.
--
--  Shuning uchun har prefiks uchun BOSHLANISH raqami bazada turadi va
--  hisob shundan past tushmaydi: `GREATEST(eng katta + 1, first_no)`.
--  Yil almashganda prefiks ham almashadi (`Z27-`) va qator yo'q bo'lsa
--  hisob eskicha 1 dan boshlanadi — 2027 uchun alohida qator yozish
--  shart emas.
--
--  Raqam KODDA emas, BAZADA: zavod 757 ni 800 ga o'zgartirsa bitta
--  katakcha tahrirlanadi (omborning `perm` i va tsexning `plan_*_days`
--  i bilan bir xil idiom). `ON CONFLICT DO NOTHING` — saytdan yoki
--  qo'lda tuzatilgani keyingi migratsiyada eskisiga qaytib qolmasin.
CREATE TABLE IF NOT EXISTS doc_no_start (
  prefix   TEXT PRIMARY KEY,
  first_no INT  NOT NULL CHECK (first_no > 0)
);

INSERT INTO doc_no_start (prefix, first_no) VALUES ('Z26-', 757)
  ON CONFLICT (prefix) DO NOTHING;

-- ═══════════════════════════════ SAVDO ISHLAB CHIQARISHGA SO'ROV YOZADI
--
--  ★ ZAVOD QARORI (2026-09): buyurtma uchun konver OCHILMAYDI degan
--  qoida STOL va STUL uchun yumshatildi.
--
--  Menejer mijozdan «12 ta Zero stul» so'rovini oladi; T/M omborda ham,
--  ishlab chiqarishda ham u yo'q. Ilgari javob bitta edi — rad etish:
--  savdo ishlab chiqarishga ish qo'sha olmasdi va buyurtma yo'qolardi.
--  Endi menejer SO'ROV yozadi, u odatdagi navbatga tushadi va direktor
--  (yoki ishlab chiqarish boshlig'i, administrator) tasdiqlaydi.
--
--  Konver «boshlanmagan» bo'lib ochiladi — tsex boshlig'i uni o'z
--  ekranidan bir bosishda yo'lga chiqaradi, ya'ni ishlab chiqarish o'z
--  tartibini yo'qotmaydi.
--
--  SP, PENAL va KAMOD ga bu tegishli EMAS (zavod qarori): ularning
--  yo'li uzun va rejasi oldindan tuziladi, savdo esa o'rtasiga qator
--  qo'shib yuborardi. Ro'yxat BAZADA: ertaga zavod «endi kamod ham»
--  desa bitta katakcha belgilanadi, kodga tegilmaydi (4-qoida).
ALTER TABLE product_groups
  ADD COLUMN IF NOT EXISTS sales_can_request BOOLEAN NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM migration_flags WHERE key = 'savdo-sorov') THEN
    UPDATE product_groups SET sales_can_request = true WHERE code IN ('STL', 'STU');
    INSERT INTO migration_flags (key) VALUES ('savdo-sorov');
  END IF;
END $$;

--  So'rov qaysi buyurtma qatori uchun yozilgani. Tasdiqlangach konver
--  o'sha qatorga O'ZI biriktiriladi: aks holda menejer har kuni
--  so'rovlar ro'yxatini ochib, tasdiqlanganini kutib o'tirardi va
--  tasdiqlangan konverni qo'lda qidirib topardi.
--
--  `ON DELETE SET NULL`: qator o'chirilsa so'rov qolaveradi — u
--  allaqachon ishlab chiqarishga tushgan bo'lishi mumkin va uni
--  jimgina yo'qotib bo'lmaydi.
ALTER TABLE unit_requests ADD COLUMN IF NOT EXISTS order_item_id INT
  REFERENCES order_items(id) ON DELETE SET NULL;
