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
--  ★ IJROCHI BITTA EMAS (`task_assignees`, zavod qarori 2026-10). Ish
--  ko'pincha ikki-uch odamga tushadi: biri katalogni tayyorlaydi,
--  ikkinchisi mijozga yuboradi. Bitta katakka faqat bittasi sig'ardi
--  va ikkinchisi na doskada, na Telegram eslatmasida ko'rinardi.
--
--  Ro'yxat — SHU jadval. `tasks.assignee_id` o'chirilmadi: u ro'yxatning
--  BIRINCHISI bo'lib qoladi (`pos = 0`) va modul uni har saqlashda
--  sinxron qiladi. Pastdagi to'ldirish DOIMIY qoida, bayroq emas:
--  `assignee_id` har doim ro'yxatda turadi, ya'ni u hech narsani
--  qaytarib qo'ymaydi — faqat ustun qo'shilgunga qadar ochilgan
--  mavzularni ro'yxatga tushiradi.
CREATE TABLE IF NOT EXISTS task_assignees (
  task_id   INT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  worker_id INT NOT NULL REFERENCES workers(id),
  pos       INT NOT NULL DEFAULT 0,
  PRIMARY KEY (task_id, worker_id)
);
CREATE INDEX IF NOT EXISTS idx_task_assignees_worker ON task_assignees(worker_id);

INSERT INTO task_assignees (task_id, worker_id, pos)
SELECT id, assignee_id, 0 FROM tasks WHERE assignee_id IS NOT NULL
ON CONFLICT DO NOTHING;

--  ★ RASM — MAVZUDA HAM, IZOHDA HAM (`task_files`, zavod qarori 2026-10).
--  Telegramdagi gapning yarmi rasm: buzilgan detal, chizma, mijozning
--  surati. Rasmsiz mavzu so'z bilan tushuntirishni talab qilardi va ish
--  yana chatga qaytib ketardi.
--
--  BAZADA saqlanadi (`BYTEA`), diskda emas: Railway konteynerining
--  diski har deployda tozalanadi va rasm jimgina yo'qolardi; zaxira ham
--  (`erp/backup.js`) bazani oladi, ya'ni rasm u bilan birga ketadi.
--  Hajmni sahifa kichraytiradi (eng uzun tomoni 1600 px, JPEG) — telefon
--  surati 4–8 MB, kichraytirilgani 200–400 KB.
--
--  `comment_id` bo'sh — rasm mavzuning O'ZIGA tegishli (ochilganda
--  qo'yilgan), to'ldirilgan — o'sha izohga.
CREATE TABLE IF NOT EXISTS task_files (
  id         SERIAL PRIMARY KEY,
  task_id    INT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  comment_id INT REFERENCES task_comments(id) ON DELETE CASCADE,
  mime       TEXT NOT NULL,
  size       INT  NOT NULL,
  data       BYTEA NOT NULL,
  created_by INT REFERENCES workers(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_task_files_task ON task_files(task_id);

--  Izoh faqat rasmdan iborat bo'lishi mumkin («mana, ko'ring») — matn
--  sharti olib tashlandi; bo'sh izohni (na matn, na rasm) modul tutadi.
ALTER TABLE task_comments DROP CONSTRAINT IF EXISTS task_comments_body_check;
