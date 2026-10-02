-- ============================================================================
--  SCANDI ERP — YADRO
--
--  Modullar ustidan umumiy qatlam: xodimlar, rollar, huquqlar, sessiyalar,
--  audit va bildirishnomalar. Har modul (ishlab chiqarish, ombor, ta'minot,
--  savdo, kassa, maosh) shu yadroga suyanadi.
--
--  Muhim: huquq ROLga emas, AMALGA beriladi (permission). Rol — huquqlar
--  to'plami. Yangi lavozim paydo bo'lsa yangi rol yaratiladi, kod tegilmaydi.
-- ============================================================================

-- ------------------------------------------------------------------ XODIMLAR
-- Xodim yozuvi — maosh moduli uchun ham asos. Tizimga kirmaydigan xodim ham
-- shu yerda turadi (pin va tg_id NULL bo'lishi mumkin).
CREATE TABLE IF NOT EXISTS workers (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  phone      TEXT,
  pin        TEXT UNIQUE,          -- ESKI ustun: izoh pastda
  tg_id      BIGINT UNIQUE,        -- Telegram Mini App / bot
  hired_at   DATE,
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

--  ★ PIN BAZADA OCHIQ MATNDA TURMAYDI. `pin_hash` — PIN'ning izi
--  (izoh: `erp/pin.js`): izdan PIN'ni qaytarib bo'lmaydi, shuning uchun
--  bazani ko'rgan odam ham, zaxira faylini ochgan odam ham tsexga kira
--  olmaydi. Eski `pin` ustuni joyida qoladi va MAXFIY KALIT qo'yilgach
--  bir martalik ko'chirishda bo'shatiladi (`erp/migrate.js`,
--  `migration_flags`: `pin-hash`) — kalitsiz server eskicha ishlayversin.
ALTER TABLE workers ADD COLUMN IF NOT EXISTS pin_hash TEXT;
--  Iz kalit bilan hisoblanadi, ya'ni bir xil PIN har doim bir xil iz
--  beradi — shuning uchun takrorlanmaslik shu yerda tekshiriladi.
--  Iz yo'q qatorlar ko'p bo'lishi mumkin (PIN'siz xodim), NULL to'qnashmaydi.
CREATE UNIQUE INDEX IF NOT EXISTS workers_pin_hash_uq ON workers (pin_hash);

-- --------------------------------------------------------- ROL VA HUQUQLAR
CREATE TABLE IF NOT EXISTS permissions (
  code   TEXT PRIMARY KEY,        -- 'production.entry', 'cash.manage'
  module TEXT NOT NULL,           -- 'production', 'warehouse', 'cash' ...
  name   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS roles (
  code    TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  -- Bu rol qaysi ko'rinishda ishlaydi: sayt, Telegram ilova, yoki faqat bot
  surface TEXT NOT NULL DEFAULT 'web' CHECK (surface IN ('web','miniapp','bot')),
  sort    INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_code       TEXT NOT NULL REFERENCES roles(code) ON DELETE CASCADE,
  permission_code TEXT NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_code, permission_code)
);

-- Bir xodim bir nechta rolda bo'lishi mumkin (usta + ombor mas'uli).
-- scope_* — rolni tsex yoki yo'nalish bilan cheklaydi (NULL = cheklovsiz).
CREATE TABLE IF NOT EXISTS worker_roles (
  worker_id     INT  NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  role_code     TEXT NOT NULL REFERENCES roles(code) ON DELETE CASCADE,
  scope_shop_id INT,
  scope_line_id INT,
  PRIMARY KEY (worker_id, role_code)
);

-- Xodimning barcha huquqlari (rollari orqali)
CREATE OR REPLACE VIEW v_worker_permissions AS
SELECT DISTINCT wr.worker_id, rp.permission_code, p.module
FROM worker_roles wr
JOIN role_permissions rp ON rp.role_code = wr.role_code
JOIN permissions p       ON p.code = rp.permission_code;

-- -------------------------------------------------------------- SESSIYALAR
-- Token Authorization: Bearer <token> sarlavhasida yuboriladi.
-- surface — kirish qayerdan: sayt, Telegram Mini App, yoki bot.
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  worker_id  INT  NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  surface    TEXT NOT NULL DEFAULT 'web' CHECK (surface IN ('web','miniapp','bot')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sessions_worker ON sessions(worker_id);

-- ------------------------------------------------------------------- AUDIT
-- Kassa, maosh va ombor harakatlarida kim nima qilgani yozib boriladi.
-- Pul tegadigan modullarda bu majburiy.
CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGSERIAL PRIMARY KEY,
  ts         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  worker_id  INT REFERENCES workers(id),
  module     TEXT NOT NULL,
  action     TEXT NOT NULL,        -- 'create', 'update', 'delete', 'approve'
  entity     TEXT,                 -- 'cash_entry', 'stock_move' ...
  entity_id  TEXT,
  payload    JSONB,
  ip         TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts     ON audit_log(ts);
CREATE INDEX IF NOT EXISTS idx_audit_module ON audit_log(module, action);

-- -------------------------------------------------------- BILDIRISHNOMALAR
-- Bot orqali yuboriladigan xabarlar navbati. Yuborish alohida jarayonda
-- bo'lgani uchun API javobi bot ishlashini kutmaydi.
CREATE TABLE IF NOT EXISTS notifications (
  id              BIGSERIAL PRIMARY KEY,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Kimga: aniq xodim, yoki huquqqa ega barcha xodimlar
  worker_id       INT REFERENCES workers(id),
  permission_code TEXT REFERENCES permissions(code),
  module          TEXT NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT,
  sent_at         TIMESTAMPTZ,
  error           TEXT,
  CHECK (worker_id IS NOT NULL OR permission_code IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_notif_pending ON notifications(sent_at) WHERE sent_at IS NULL;

-- ═══════════════════════ ★ KIMGA QAYSI XABAR BORADI — XODIMDA
--
--  ZAVOD QARORI (2026-09). Xabar HUQUQ bo'yicha boradi va bu
--  ko'pchilik uchun to'g'ri: talabnomani xom ashyo xodimi oladi,
--  konver qabulini tsex boshlig'i. Lekin ADMINISTRATORDA barcha
--  huquq bor — ya'ni unga zavodning HAMMA xabari kelardi: talabnoma
--  ham, xarid zayavkasi ham, T/M omborga qabul ham. Direktor
--  telefonini ochib, o'ziga tegishli bitta xabarni o'ntasi orasidan
--  qidirib o'tirardi va oxiri hammasini o'qimay qo'yardi.
--
--  Huquq bilan tuzatib bo'lmaydi: huquqlar KODDA turadi
--  (`sql/core-seed.sql`) va administratordan `materials.manage` ni
--  olib tashlash uning ishini to'xtatardi. Shuning uchun belgi
--  XODIMDA — `supply_reports` va `daily_digest` bilan bir xil idiom
--  va bir xil sabab: kodga na ism, na lavozim yoziladi (4-qoida).
--
--  ★ BU «O'CHIRILGANLAR» RO'YXATI, «YOQILGANLAR» EMAS, va bu
--  ataylab. Qator yo'q = HAMMASI keladi, ya'ni:
--
--    · deploy kuni hech kimning xabari jimgina yo'qolmaydi;
--    · ertaga yangi xabar turi qo'shilsa u O'ZI keladi — har
--      xodimga qo'lda yoqib chiqish kerak emas va unutilgan
--      xodim xabarsiz qolmaydi.
--
--  Teskarisi («faqat belgilangani keladi») ikkala joyda ham jim
--  ishlamasdi: birinchi deployda hamma xabar to'xtardi, keyin esa
--  har yangi tur uchun oltmish oltita kartochka ochish kerak
--  bo'lardi.
--
--  Turlar ro'yxati KODDA (`erp/notify.js`, TURLAR) — u jadval, zavod
--  ma'lumoti emas: yangi xabar yozilganda o'sha ro'yxatga bitta qator
--  qo'shiladi va kartochkada o'zi paydo bo'ladi (menyudagi `PAGES`
--  bilan bir xil idiom).
CREATE TABLE IF NOT EXISTS worker_notify_off (
  worker_id INT  NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  kind      TEXT NOT NULL,
  PRIMARY KEY (worker_id, kind)
);

--  Xabarning TURI yozib qo'yiladi: huquq bo'yicha ketadigan xabar
--  kimga borishi YUBORISH paytida hal qilinadi (`sendPending`), ya'ni
--  filtr o'sha yerda ham kerak bo'ladi.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS kind TEXT;

-- -------------------------------------------------- BIR MARTALIK KO'CHIRISH
-- Migratsiya har deploy'da qaytadan ishlaydi, shuning uchun ma'lumotni
-- ko'chiradigan UPDATE'lar xavfli: saytdan qilingan o'zgarish ikkinchi
-- deploy'da bekor bo'lib qolishi mumkin. Bajarilgan ko'chirish shu yerga
-- belgilanadi va boshqa takrorlanmaydi.
CREATE TABLE IF NOT EXISTS migration_flags (
  key        TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ═══════════════════════════════════ ★ ZAVOD KALITLARI (SOZLAMALAR)
--
--  `migration_flags` bilan ADASHTIRMASLIK kerak, garchi ikkalasi ham
--  kalit-qiymat bo'lsa ham: bayroq O'TMISHDAGI ma'lumot tuzatilganini
--  yozib qo'yadi va bir marta o'qiladi, bu esa BUGUNGI qoida —
--  zavod uni istagan payt yoqadi va o'chiradi, kod tegilmaydi
--  (4-qoida: kodga qaror yozilmaydi).
--
--  ★ QIYMAT MATN. Hozir ikkalasi ham «1» yoki bo'sh, lekin ertaga
--  soni yoki sanasi bo'lgan kalit qo'shilsa jadval o'zgarmaydi:
--  ustun turi bir marta tanlanadi va keyin uni almashtirish butun
--  jadvalni ko'chirishni talab qilardi.
--
--  Kim va qachon o'zgartirgani yoziladi: «buni kim o'chirib qo'ydi»
--  degan savol pulga va ombor qoldig'iga tegadigan kalitda
--  albatta paydo bo'ladi.
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  val        TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by INT REFERENCES workers(id)
);

--  ★ QOLDIQDAN KO'P CHIQARIB BO'LMAYDI (zavod qarori, 2026-09).
--
--  Ilgari to'siq YO'Q edi va bu ataylab edi: material allaqachon
--  kesilgan, sarfni rad etish taxtani qaytarmaydi — faqat yozuvni
--  yo'qotadi. Ustiga talabnoma moduli yozilmagan edi va tsex
--  omborlari bo'sh turardi, ya'ni to'siq birinchi kundanoq hamma
--  ishni to'xtatardi.
--
--  Ikkala sabab ham o'tdi: talabnoma yozildi, kirim hujjati yozildi
--  va omborlar to'la boshladi. Endi minus qoldiq — xato.
--
--  ★ STANDARTI O'CHIQ, va bu ham ataylab. Deploy kuni o'ttizga yaqin
--  material allaqachon minusda turibdi (kirim hujjati yozilmagani
--  uchun): to'siq darrov yoqilsa ertaga o'sha materiallardan sarf
--  yozib bo'lmasdi va tsex to'xtardi. Zavod avval o'sha qatorlarni
--  kirim yoki boshlang'ich qoldiq bilan tuzatadi, keyin kalitni
--  yoqadi.
--
--  ★ IKKI KALIT, BITTA EMAS: kassa qoldig'i toza, ombor esa hali
--  emas. Bitta kalit bo'lsa kassani yoqish uchun ombor tuzatilishini
--  kutish kerak bo'lardi.
--
--  Qator YO'Q = o'chiq (`COALESCE`), ya'ni jadval bo'sh bo'lsa ham
--  hech narsa buzilmaydi.
--  ★ KASSA KALITI YOQIQ TUG'ILADI (zavod qarori, 2026-10). Yuqoridagi
--  «standarti o'chiq» OMBORNIKIGA tegishli bo'lib qoldi: u yerda
--  deploy kuni o'ttizta qator minusda turardi va to'siq ishni
--  to'xtatardi. Kassada bunday sabab YO'Q — zavod qarori bitta va
--  qat'iy: «programmaning hech bir yerida minusga ishlamasin».
--
--  Kalit o'chiq tug'ilgani uchun u saytda ham o'chiq turdi va hech
--  kim yoqmadi: natijada kassa qoldig'i o'tmishda minusga tushib
--  ketdi va buni faqat oraliq hisoboti ochilganda ko'rindi. Yozilgan,
--  lekin yoqilmagan qoida — yozilmagan qoida bilan bir xil.
INSERT INTO app_settings (key, val) VALUES
  ('minus_cash',     '1'),
  ('minus_material', '')
ON CONFLICT (key) DO NOTHING;

--  Ishlayotgan bazada qator ALLAQACHON bor va `DO NOTHING` unga
--  tegmaydi — ya'ni yuqoridagi standart faqat toza bazaga tushadi.
--  Shuning uchun bir martalik: kalit bir marta yoqiladi va keyin
--  saytdan o'chirilgani QAYTARIB yoqilmaydi (zavod bir kunga
--  o'chirishi mumkin — masalan xodimning qo'lidagi qoldiq minusda
--  turgan bo'lsa, boshlang'ich qoldiq kiritilgunga qadar).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM migration_flags WHERE key = 'kassa-minus-yoq') THEN
    INSERT INTO app_settings (key, val, updated_at) VALUES ('minus_cash', '1', NOW())
    ON CONFLICT (key) DO UPDATE SET val = '1', updated_at = NOW();
    INSERT INTO migration_flags (key) VALUES ('kassa-minus-yoq');
  END IF;
END $$;
