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
  --   new       — yozildi, hali mahsulot biriktirilmagan
  --   reserved  — mahsulot biriktirildi, jo'natilmagan
  --   shipped   — mijozga chiqdi (jo'natma moduli yozadi)
  --   cancelled — bekor qilindi
  status      TEXT NOT NULL DEFAULT 'new'
              CHECK (status IN ('new', 'reserved', 'shipped', 'cancelled')),
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
       o.ship_to, d.name AS ship_to_name, o.address, o.receiver_phone
  FROM orders o
  JOIN customers c      ON c.id = o.customer_id
  LEFT JOIN workers w   ON w.id = o.manager_id
  LEFT JOIN order_destinations d ON d.code = o.ship_to
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS lines,
           COALESCE(SUM(oi.qty), 0)::int AS qty,
           COALESCE(SUM(oi.qty * COALESCE(oi.unit_price, 0)), 0) AS amount
      FROM order_items oi WHERE oi.order_id = o.id) i ON true
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(r.qty), 0)::int AS qty
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
