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

-- ─────────────────────────────────────────── KONVERNI BUYURTMAGA BIRIKTIRISH
--
--  Konver buyurtmaning aniq QATORIGA biriktiriladi, buyurtmaga emas:
--  bitta buyurtmada bir xil mahsulot ikki xil rangda bo'lishi mumkin va
--  qaysi konver qaysi qatorni yopayotgani bilinishi kerak.
--
--  `order_no` va `customer_id` ustunlari konverda ilgari ham bor edi —
--  qo'lda yozilardi. Ular saqlanadi va biriktirishda tizim o'zi to'ldiradi:
--  jurnal, ombor va hisobotlar o'sha ustunlarga tayanadi.
ALTER TABLE production_units ADD COLUMN IF NOT EXISTS order_item_id INT
  REFERENCES order_items(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_units_order_item ON production_units(order_item_id);

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
       c.channel
  FROM orders o
  JOIN customers c      ON c.id = o.customer_id
  LEFT JOIN workers w   ON w.id = o.manager_id
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS lines,
           COALESCE(SUM(oi.qty), 0)::int AS qty,
           COALESCE(SUM(oi.qty * COALESCE(oi.unit_price, 0)), 0) AS amount
      FROM order_items oi WHERE oi.order_id = o.id) i ON true
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(u.qty), 0)::int AS qty
      FROM production_units u
      JOIN order_items oi ON oi.id = u.order_item_id
     WHERE oi.order_id = o.id AND u.status <> 'cancelled') a ON true;
