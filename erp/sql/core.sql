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
  pin        TEXT UNIQUE,          -- tsex terminaliga kirish
  tg_id      BIGINT UNIQUE,        -- Telegram Mini App / bot
  hired_at   DATE,
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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

-- -------------------------------------------------- BIR MARTALIK KO'CHIRISH
-- Migratsiya har deploy'da qaytadan ishlaydi, shuning uchun ma'lumotni
-- ko'chiradigan UPDATE'lar xavfli: saytdan qilingan o'zgarish ikkinchi
-- deploy'da bekor bo'lib qolishi mumkin. Bajarilgan ko'chirish shu yerga
-- belgilanadi va boshqa takrorlanmaydi.
CREATE TABLE IF NOT EXISTS migration_flags (
  key        TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
