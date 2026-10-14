-- ═══════════════════════════════════════════════════════════ VAZIFALAR
--
--  ★ ISH TELEGRAM CHATIDA YO'QOLMASIN (zavod qarori, 2026-10). Korxonada
--  ish ko'p va hammasi Telegram guruhlarida gaplashiladi: mavzu ustiga
--  mavzu tushadi va kerakli savol yuqorida qolib ketadi — kim bajarishi,
--  qachongacha va bajarildimi, hech qayerda yozilmaydi.
--
--  Endi har ish — MAVZU (`tasks`): sarlavha, tafsilot, ijrochi, muddat
--  va holat. Ostida izohlar (`task_comments`) — Telegramdagi gap shu
--  yerda yoziladi va mavzuning o'zida qoladi.
--
--  Ko'rinishi doska (Trello kabi): Yangi · Jarayonda · Tekshiruvda ·
--  Bajarildi. Holat SAQLANADI — u odamning qarori («tugatdim»), boshqa
--  narsadan hisoblanmaydi.
--
--  ★ HAMMA KO'RADI, HAMMA OCHADI, HAMMA YOZADI (zavod qarori). Huquq
--  qo'yilmadi: vazifalar zavodning umumiy stoli va savol aynan shu —
--  «hamma ko'rsin». Faqat O'ZGARTIRISH chegaralangan (modules/tasks.js):
--  sarlavha, ijrochi va muddatni mavzuni ochgan odam yoki administrator
--  tuzatadi; holatni esa ijrochi ham suradi.
--
--  Raqami `T26-0001` (konver `K`, zakaz `Z`, pul `P`): izohda yoki
--  Telegram xabarida «T26-0014 ni ko'rdingizmi» deb yozish mumkin bo'lsin.

CREATE TABLE IF NOT EXISTS tasks (
  id          SERIAL PRIMARY KEY,
  task_no     TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL CHECK (btrim(title) <> ''),
  body        TEXT,
  status      TEXT NOT NULL DEFAULT 'new'
              CHECK (status IN ('new', 'doing', 'review', 'done', 'cancelled')),
  assignee_id INT REFERENCES workers(id),
  due_on      DATE,
  created_by  INT REFERENCES workers(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  done_at     TIMESTAMPTZ,
  done_by     INT REFERENCES workers(id),
  --  ★ ESLATMA QAYSI MUDDATGA YUBORILGANI (pastda). Kun emas, MUDDAT
  --  saqlanadi: muddat surilsa eslatma YANGI muddat uchun qaytadan
  --  ketishi kerak — kun saqlansa surilgan vazifa jim qolardi.
  remind_for  DATE,
  due_sent_for DATE
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_due    ON tasks(due_on) WHERE status IN ('new', 'doing', 'review');

CREATE TABLE IF NOT EXISTS task_comments (
  id         SERIAL PRIMARY KEY,
  task_id    INT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  worker_id  INT REFERENCES workers(id),
  body       TEXT NOT NULL CHECK (btrim(body) <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id);

--  ★ MUDDAT KUNI KIMGA AYTILADI — XODIMDA (`workers.task_watch`, zavod
--  qarori 2026-10). Muddat kelgan kuni «bugun shu xodim shu ishni
--  bajarishi kerak edi, so'rang» degan xabar MAVZUNI OCHGAN odamga va
--  shu belgisi bor rahbarlarga ketadi. Rol buni ajrata olmaydi —
--  `daily_digest` va `supply_reports` bilan bir xil idiom; kodga na
--  ism, na lavozim yoziladi (4-qoida). Standarti `false`: belgi
--  qo'yilmaguncha faqat ochgan odam oladi.
ALTER TABLE workers ADD COLUMN IF NOT EXISTS
  task_watch BOOLEAN NOT NULL DEFAULT false;

--  Hujjat raqami prefiksi (zakaz raqami bilan bir xil yordamchi bo'lmasa
--  ham, shakl bir xil: harf + yil + to'rt xonali raqam).
--  Raqamni modul beradi (`modules/tasks.js`, advisory lock bilan).
