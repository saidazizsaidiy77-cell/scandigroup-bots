--  ★ TAHLILCHI AI (zavod qarori, 2026-11; `modules/tahlilchi.js`).
--  Telegram'da savolga javob beradi va har kuni ertalab tahliliy xulosa
--  yozadi. Ma'lumotni SAYT bilan bir xil API dan, SO'RAGAN XODIMNING
--  huquqi va doirasi bilan o'qiydi — ikkinchi qoida yozilmaydi.
--
--  Kimga ochiq — XODIMDA (4-qoida), standarti `false`: har javob pul
--  turadi (Claude API) va kimga berilishini zavod hal qiladi.
ALTER TABLE workers ADD COLUMN IF NOT EXISTS ai_access BOOLEAN NOT NULL DEFAULT false;

--  Har savol va javob — narx va «nima so'radi» degan savolga javob.
CREATE TABLE IF NOT EXISTS ai_log (
  id          BIGSERIAL PRIMARY KEY,
  worker_id   INT REFERENCES workers(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL DEFAULT 'chat',      -- chat | daily
  question    TEXT,
  answer      TEXT,
  tools       TEXT[],
  input_tokens  INT,
  output_tokens INT,
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ai_log_worker ON ai_log (worker_id, created_at DESC);
