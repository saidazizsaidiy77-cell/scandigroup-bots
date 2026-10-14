// ══════════════════════════════════════════════════════════ VAZIFALAR
//
//  ★ ZAVOD QARORI (2026-10). Ish Telegram chatida yo'qolardi: mavzu
//  ustiga mavzu tushadi va kerakli savol yuqorida qolib ketadi. Endi
//  har ish — MAVZU: kim bajaradi, qachongacha, va ostida izohlar.
//  Doska Trello kabi: Yangi · Jarayonda · Tekshiruvda · Bajarildi.
//
//  ★ HAMMA KO'RADI, HAMMA OCHADI, HAMMA IZOH YOZADI (zavod qarori):
//  huquq qo'yilmadi, faqat tizimga kirgan bo'lishi kerak.
//
//  O'ZGARTIRISH esa chegaralangan va chegara SERVERDA:
//    sarlavha, tafsilot, ijrochi, muddat   ochgan odam yoki administrator
//    holat (doskada surish)                ochgan odam, ijrochi, administrator
//  Ijrochi o'z ishini «Jarayonda» va «Tekshiruvda» ga suradi; muddatni
//  esa o'zi suza olmaydi — aks holda eslatma ham, nazorat ham ma'nosiz
//  bo'lardi. «Administrator» — `admin.users` huquqi (xodimlarni
//  boshqaradigan odam); kodga ism yozilmaydi (4-qoida).
//
//  ★ ESLATMA IKKI XIL (`tasksYubor`, kunlik jadvalda — `erp/server.js`):
//    muddatga 3 kun (yoki kam) qolganda   →  IJROCHIGA
//    muddat kuni (yoki o'tib ketgan)       →  OCHGAN odamga va
//                                             «Vazifa nazorati» belgili
//                                             rahbarlarga: «bugun shu
//                                             xodim bajarishi kerak edi,
//                                             so'rang»
//  Har biri BIR MARTA, va QAYSI muddat uchun yuborilgani saqlanadi
//  (`remind_for`, `due_sent_for`): muddat surilsa eslatma yangi kun
//  uchun qaytadan ketadi, bir xil kunga ikkinchi marta ketmaydi.
const express = require('express');
const { db, wrap, audit, today } = require('../db');
const notify = require('../notify');

const router = express.Router();

const HOLATLAR = ['new', 'doing', 'review', 'done', 'cancelled'];
const OCHIQ = ['new', 'doing', 'review'];
const admin = (req) => req.user.permissions.includes('admin.users');
const kirgan = (req, res, next) => req.user ? next()
  : res.status(401).json({ error: 'Kirish talab qilinadi' });
router.use(kirgan);

const xato = (msg, status = 400) => Object.assign(new Error(msg), { status });
const sana = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
//  Bazadan kelgan DATE — `Date` obyekti; uni mahalliy kun qilib yozish.
const isoKun = (d) => {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const kunYoz = (d) => {
  const s = isoKun(d);
  if (!s) return '';
  const [y, m, k] = s.split('-');
  return `${k}.${m}.${y.slice(-2)}`;
};

//  Raqam: T26-0001. Tranzaksiya qulfi bilan — ikki odam bir vaqtda
//  ochsa ham takrorlanmaydi (`cust_returns` bilan bir xil idiom).
async function nextNo(c) {
  await c.query(`SELECT pg_advisory_xact_lock(hashtext('tasks_no'))`);
  const prefix = `T${String(new Date().getFullYear()).slice(-2)}-`;
  const { rows } = await c.query(
    `SELECT COALESCE(MAX(SUBSTRING(task_no FROM '\\d+$')::int), 0) + 1 AS n
       FROM tasks WHERE task_no LIKE $1`, [`${prefix}%`]);
  return prefix + String(rows[0].n).padStart(4, '0');
}

async function ishchi(c, id) {
  if (id == null || id === '') return null;
  const w = (await c.query(`SELECT id, name FROM workers WHERE id = $1 AND active`,
    [Number(id)])).rows[0];
  if (!w) throw xato('Ijrochi topilmadi yoki faol emas');
  return w;
}

const QATOR = `
  SELECT t.*, a.name AS assignee_name, cr.name AS creator_name,
         db.name AS done_by_name,
         (SELECT COUNT(*)::int FROM task_comments c WHERE c.task_id = t.id) AS comments,
         (SELECT MAX(c.created_at) FROM task_comments c WHERE c.task_id = t.id) AS last_comment_at,
         (t.status IN ('new', 'doing', 'review') AND t.due_on < CURRENT_DATE) AS late,
         (t.due_on - CURRENT_DATE) AS days_left
    FROM tasks t
    LEFT JOIN workers a  ON a.id  = t.assignee_id
    LEFT JOIN workers cr ON cr.id = t.created_by
    LEFT JOIN workers db ON db.id = t.done_by`;

//  ★ MENGA — `assignee_id = men`, ochiq holatda. Menyudagi navbat
//  belgisi AYNAN shu shartni sanaydi (`modules/nav.js`) va test raqamni
//  shu ro'yxatning uzunligi bilan solishtiradi.
router.get('/', wrap(async (req, res) => {
  const p = [];
  const shart = [];
  //  Bajarilgani va bekor qilingani 30 kun turadi: doska yillar o'tib
  //  minglab kartochka bilan to'lib ketmasin. Butun tarix `?all=1` da.
  if (!req.query.all)
    shart.push(`(t.status IN ('new', 'doing', 'review')
                 OR COALESCE(t.done_at, t.updated_at) > NOW() - INTERVAL '30 days')`);
  if (req.query.mine === '1') { p.push(req.user.id); shart.push(`t.assignee_id = $${p.length}`); }
  if (req.query.mine === 'open') {
    p.push(req.user.id);
    shart.push(`t.assignee_id = $${p.length} AND t.status IN ('new', 'doing')`);
  }
  if (req.query.created === '1') { p.push(req.user.id); shart.push(`t.created_by = $${p.length}`); }
  const q = String(req.query.q || '').trim();
  if (q) {
    p.push(`%${q}%`);
    shart.push(`(t.title ILIKE $${p.length} OR t.task_no ILIKE $${p.length}
                 OR t.body ILIKE $${p.length} OR a.name ILIKE $${p.length})`);
  }
  const { rows } = await db.query(
    `${QATOR} ${shart.length ? 'WHERE ' + shart.join(' AND ') : ''}
     ORDER BY t.due_on NULLS LAST, t.id DESC LIMIT 1000`, p);
  //  Ijrochi ro'yxati — FAOL xodimlar. Telegram ID si borlari ajralib
  //  turadi: ID siz odamga eslatma bormaydi va buni oynaning o'zi
  //  aytishi kerak.
  const workers = (await db.query(
    `SELECT id, name, position, (tg_id IS NOT NULL) AS has_tg
       FROM workers WHERE active ORDER BY name`)).rows;
  res.json({ tasks: rows, workers, me: req.user.id, admin: admin(req) });
}));

router.get('/:id', wrap(async (req, res) => {
  const t = (await db.query(`${QATOR} WHERE t.id = $1`, [Number(req.params.id)])).rows[0];
  if (!t) throw xato('Mavzu topilmadi', 404);
  const comments = (await db.query(
    `SELECT c.id, c.body, c.created_at, c.worker_id, w.name AS worker_name
       FROM task_comments c LEFT JOIN workers w ON w.id = c.worker_id
      WHERE c.task_id = $1 ORDER BY c.created_at, c.id`, [t.id])).rows;
  res.json({ ...t, comment_list: comments,
             can_edit: admin(req) || t.created_by === req.user.id,
             can_move: admin(req) || t.created_by === req.user.id
                       || t.assignee_id === req.user.id });
}));

//  Ijrochiga «sizga yangi ish» xabari. O'zi o'ziga yozganida yuborilmaydi.
async function ijrochigaAyt(c, req, t, sarlavha) {
  if (!t.assignee_id || t.assignee_id === req.user.id) return;
  await notify.queue({
    worker_id: t.assignee_id, module: 'tasks', kind: 'task_assigned',
    title: `${sarlavha} — ${t.task_no}`,
    body: `${t.title}${t.due_on ? `\nMuddat: ${kunYoz(t.due_on)}` : ''}`
        + `\nOchgan: ${req.user.name || ''}` }, c);
}

router.post('/', wrap(async (req, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) throw xato('Mavzu nomini yozing');
  const body = String(req.body.body || '').trim() || null;
  const due = req.body.due_on ? sana(req.body.due_on) : null;
  if (req.body.due_on && !due) throw xato('Muddat noto\'g\'ri');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const a = await ishchi(client, req.body.assignee_id);
    const no = await nextNo(client);
    const t = (await client.query(
      `INSERT INTO tasks (task_no, title, body, assignee_id, due_on, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [no, title, body, a?.id || null, due, req.user.id])).rows[0];
    await ijrochigaAyt(client, req, t, 'Sizga yangi vazifa');
    await audit(req, { module: 'tasks', action: 'create', entity: 'tasks',
                       entity_id: t.id, payload: { task_no: no } }, client);
    await client.query('COMMIT');
    res.json(t);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}));

router.patch('/:id', wrap(async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const t = (await client.query(`SELECT * FROM tasks WHERE id = $1 FOR UPDATE`,
      [Number(req.params.id)])).rows[0];
    if (!t) throw xato('Mavzu topilmadi', 404);
    const egasi = admin(req) || t.created_by === req.user.id;
    const suradi = egasi || t.assignee_id === req.user.id;
    const b = req.body;
    const yangi = { ...t };

    const tahrir = ['title', 'body', 'assignee_id', 'due_on'].filter((k) => k in b);
    if (tahrir.length && !egasi)
      throw xato('Sarlavha, ijrochi va muddatni mavzuni ochgan odam o\'zgartiradi', 403);
    if ('title' in b) {
      yangi.title = String(b.title || '').trim();
      if (!yangi.title) throw xato('Mavzu nomini yozing');
    }
    if ('body' in b) yangi.body = String(b.body || '').trim() || null;
    if ('assignee_id' in b) yangi.assignee_id = (await ishchi(client, b.assignee_id))?.id || null;
    //  Bo'sh yuborilgani «tegma» emas, «yo'q» degani — muddat olib
    //  tashlanadi (reja sanasi bilan bir xil idiom).
    if ('due_on' in b) {
      yangi.due_on = b.due_on ? sana(b.due_on) : null;
      if (b.due_on && !yangi.due_on) throw xato('Muddat noto\'g\'ri');
    }
    if ('status' in b) {
      if (!HOLATLAR.includes(b.status)) throw xato('Holat noto\'g\'ri');
      if (!suradi) throw xato('Holatni ochgan odam yoki ijrochi o\'zgartiradi', 403);
      //  Bekor qilish — ochgan odamning qarori: ijrochi o'ziga berilgan
      //  ishni o'zi yo'q qilib qo'ymasin.
      if (b.status === 'cancelled' && !egasi)
        throw xato('Mavzuni ochgan odam bekor qiladi', 403);
      yangi.status = b.status;
    }
    const tugadi = yangi.status === 'done' && t.status !== 'done';
    const u = (await client.query(
      `UPDATE tasks SET title = $2, body = $3, assignee_id = $4, due_on = $5,
              status = $6, updated_at = NOW(),
              done_at = CASE WHEN $6 = 'done' THEN COALESCE(done_at, NOW()) END,
              done_by = CASE WHEN $6 = 'done' THEN COALESCE(done_by, $7) END
        WHERE id = $1 RETURNING *`,
      [t.id, yangi.title, yangi.body, yangi.assignee_id, isoKun(yangi.due_on),
       yangi.status, req.user.id])).rows[0];
    if (u.assignee_id && u.assignee_id !== t.assignee_id)
      await ijrochigaAyt(client, req, u, 'Sizga vazifa berildi');
    //  Bajarildi — ochgan odamga aytiladi: u ishni bergan va natijani
    //  kutadi. O'zi bosgan bo'lsa yuborilmaydi.
    if (tugadi && t.created_by && t.created_by !== req.user.id)
      await notify.queue({
        worker_id: t.created_by, module: 'tasks', kind: 'task_comment',
        title: `Bajarildi — ${t.task_no}`,
        body: `${t.title}\n${req.user.name || ''} bajarildi deb belgiladi` }, client);
    await audit(req, { module: 'tasks', action: 'update', entity: 'tasks', entity_id: t.id,
                       payload: { status: u.status, fields: tahrir } }, client);
    await client.query('COMMIT');
    res.json(u);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}));

//  ★ IZOH — HAMMA YOZADI. Telegramdagi gap shu yerga ko'chadi va
//  mavzuning o'zida qoladi. Ijrochi va ochgan odamga xabar ketadi
//  (yozgan odamning o'ziga emas): izoh ko'pincha savol va javob kutadi.
router.post('/:id/comments', wrap(async (req, res) => {
  const body = String(req.body.body || '').trim();
  if (!body) throw xato('Izoh bo\'sh');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const t = (await client.query(`SELECT * FROM tasks WHERE id = $1`,
      [Number(req.params.id)])).rows[0];
    if (!t) throw xato('Mavzu topilmadi', 404);
    const c = (await client.query(
      `INSERT INTO task_comments (task_id, worker_id, body) VALUES ($1,$2,$3) RETURNING *`,
      [t.id, req.user.id, body])).rows[0];
    await client.query(`UPDATE tasks SET updated_at = NOW() WHERE id = $1`, [t.id]);
    const kimga = [...new Set([t.assignee_id, t.created_by])]
      .filter((x) => x && x !== req.user.id);
    for (const w of kimga)
      await notify.queue({
        worker_id: w, module: 'tasks', kind: 'task_comment',
        title: `Yangi izoh — ${t.task_no}`,
        body: `${t.title}\n${req.user.name || ''}: ${body.slice(0, 500)}` }, client);
    await client.query('COMMIT');
    res.json(c);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}));

//  ═══════════════════════════════════════════════ KUNLIK ESLATMA
//
//  Kunlik jadvaldan chaqiriladi (`KUNLIK`, `erp/server.js`) — xabar
//  NAVBATGA qo'yiladi, yuborish alohida (tokensiz ham hech narsa
//  buzilmaydi). Qaytaradigan raqam — navbatga qo'yilgan xabarlar soni.
async function tasksYubor() {
  let n = 0;
  //  1. Muddatga 3 kun yoki kam qoldi — IJROCHIGA, bir muddatga bir marta.
  const yaqin = (await db.query(
    `SELECT t.*, (t.due_on - CURRENT_DATE) AS qoldi FROM tasks t
      WHERE t.status IN ('new', 'doing', 'review') AND t.assignee_id IS NOT NULL
        AND t.due_on BETWEEN CURRENT_DATE + 1 AND CURRENT_DATE + 3
        AND t.remind_for IS DISTINCT FROM t.due_on`)).rows;
  for (const t of yaqin) {
    if (await notify.queue({
      worker_id: t.assignee_id, module: 'tasks', kind: 'task_due3',
      title: `Muddatga ${t.qoldi} kun qoldi — ${t.task_no}`,
      body: `${t.title}\nMuddat: ${kunYoz(t.due_on)}` })) n++;
    await db.query(`UPDATE tasks SET remind_for = due_on WHERE id = $1`, [t.id]);
  }

  //  2. Muddat keldi (yoki o'tib ketgan, lekin hali aytilmagan) —
  //  OCHGAN odamga va «Vazifa nazorati» belgili rahbarlarga.
  const kelgan = (await db.query(
    `SELECT t.*, a.name AS assignee_name FROM tasks t
       LEFT JOIN workers a ON a.id = t.assignee_id
      WHERE t.status IN ('new', 'doing', 'review') AND t.due_on <= CURRENT_DATE
        AND t.due_sent_for IS DISTINCT FROM t.due_on`)).rows;
  if (kelgan.length) {
    const nazorat = (await db.query(
      `SELECT id FROM workers WHERE active AND task_watch`)).rows.map((r) => r.id);
    for (const t of kelgan) {
      const kim = t.assignee_name || 'ijrochi belgilanmagan';
      const kimga = [...new Set([t.created_by, ...nazorat])].filter(Boolean);
      for (const w of kimga)
        if (await notify.queue({
          worker_id: w, module: 'tasks', kind: 'task_due',
          title: `Muddat keldi — ${t.task_no}`,
          body: `Bugun ${kim} «${t.title}» ishini bajarishi kerak edi`
              + `${isoKun(t.due_on) < today() ? ` (muddat ${kunYoz(t.due_on)})` : ''}`
              + `. So'rang.` })) n++;
      await db.query(`UPDATE tasks SET due_sent_for = due_on WHERE id = $1`, [t.id]);
    }
  }
  return n;
}

module.exports = router;
module.exports.tasksYubor = tasksYubor;
