//  Shaxsiy pul boti — harajat va daromadni Telegramdan yozib boradi.
//
//  ERP dan ALOHIDA: o'z tokeni, o'z jadvallari (`pf_*`). Zavodning
//  kassasi bilan aralashmaydi — bu egasining SHAXSIY hisobi.
//
//  Kim foydalanadi — `PUL_BOT_USERS` (Telegram ID lar, vergul bilan).
//  Kodga ID ham, ism ham yozilmaydi.
//
//  Ishga tushirish:  npm run pul
require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { Pool } = require('pg');
const { TURKUM, tahlil, turkumTop, turkumBelgi, pul } = require('./parse');

const TOKEN = process.env.PUL_BOT_TOKEN;
if (!TOKEN) {
  console.error('PUL_BOT_TOKEN qo\'yilmagan — @BotFather dan yangi bot oching.');
  process.exit(1);
}
const USERS = String(process.env.PUL_BOT_USERS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const TZ = process.env.PUL_TZ || 'Asia/Tashkent';
// Kechki xulosa vaqti (mahalliy). Bo'sh — yuborilmaydi.
const KECHKI = process.env.PUL_DAILY_AT === undefined ? '21:00' : process.env.PUL_DAILY_AT;

// Baza ham shu mintaqada yuradi: aks holda yarim tundan keyingi yozuv
// kechagi sana bilan tushardi (ERP dagi `db.js` bilan bir xil sabab).
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false },
  max: 5,
  options: `-c timezone=${TZ}`,
});
require('pg').types.setTypeParser(1082, (v) => v);

// Idempotent — har ishga tushishda o'tadi.
const SXEMA = `
CREATE TABLE IF NOT EXISTS pf_entries (
  id          SERIAL PRIMARY KEY,
  tg_id       BIGINT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('in','out')),
  amount      NUMERIC(16,2) NOT NULL CHECK (amount > 0),
  ccy         TEXT NOT NULL DEFAULT 'UZS' CHECK (ccy IN ('UZS','USD')),
  category    TEXT NOT NULL,
  note        TEXT,
  on_date     DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS pf_entries_user_date ON pf_entries (tg_id, on_date) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS pf_budgets (
  tg_id     BIGINT NOT NULL,
  category  TEXT NOT NULL,
  ccy       TEXT NOT NULL DEFAULT 'UZS',
  amount    NUMERIC(16,2) NOT NULL CHECK (amount > 0),
  PRIMARY KEY (tg_id, category, ccy)
);
CREATE TABLE IF NOT EXISTS pf_settings (
  tg_id       BIGINT PRIMARY KEY,
  daily       BOOLEAN NOT NULL DEFAULT TRUE,
  last_daily  DATE
);
`;

const bot = new Telegraf(TOKEN);
const HTML = { parse_mode: 'HTML' };
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const OYLAR = ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun', 'Iyul', 'Avgust', 'Sentabr', 'Oktabr', 'Noyabr', 'Dekabr'];

function bugun() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}
function hozirSoat() {
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
}
const qisqaSana = (d) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;

// ── Ruxsat ─────────────────────────────────────────────────────────────────
bot.use(async (ctx, next) => {
  const id = String(ctx.from?.id || '');
  if (USERS.includes(id)) return next();
  if (ctx.message) {
    await ctx.reply(
      `Bu shaxsiy bot.\nSizning ID: <code>${esc(id)}</code>\n` +
      `Kirish uchun uni serverdagi <code>PUL_BOT_USERS</code> ga qo'shing.`, HTML
    );
  }
});

// ── Yordam ─────────────────────────────────────────────────────────────────
const YORDAM =
  `<b>Qanday yoziladi</b> — oddiy xabar:\n` +
  `<code>50000 taksi</code>  ·  <code>50k ovqat</code>  ·  <code>1.2m ijara</code>\n` +
  `<code>$20 netflix</code> — dollarda\n` +
  `<code>+8 000 000 oylik</code> — daromad («oylik», «bonus» so'zi bo'lsa + shart emas)\n` +
  `<code>kecha 30000 kafe</code>  ·  <code>05.10 30000 kafe</code> — sana bilan\n\n` +
  `<b>Hisobot</b>\n` +
  `/bugun — bugungi\n/hafta — oxirgi 7 kun\n/oy — shu oy (turkumlar, tejash %, prognoz)\n` +
  `/oy 2026-09 — boshqa oy\n/oxirgi — oxirgi 10 yozuv (o'chirish)\n\n` +
  `<b>Boshqaruv</b>\n` +
  `/byudjet — oylik limitlar · <code>/byudjet Kafe 1500000</code>\n` +
  `/excel — hammasini CSV faylga\n/kechki — kechki xulosani yoqish/o'chirish`;

bot.start((ctx) => ctx.reply(`👋 Shaxsiy pul hisobi.\n\n${YORDAM}`, HTML));
bot.help((ctx) => ctx.reply(YORDAM, HTML));

// ── Yozish ─────────────────────────────────────────────────────────────────
async function byudjetHolati(tg, category, ccy) {
  const { rows } = await db.query(
    `SELECT b.amount AS limit_,
            COALESCE((SELECT SUM(e.amount) FROM pf_entries e
                       WHERE e.tg_id = b.tg_id AND e.category = b.category AND e.ccy = b.ccy
                         AND e.kind = 'out' AND e.deleted_at IS NULL
                         AND e.on_date >= date_trunc('month', CURRENT_DATE)), 0) AS spent
       FROM pf_budgets b WHERE b.tg_id = $1 AND b.category = $2 AND b.ccy = $3`,
    [tg, category, ccy]
  );
  if (!rows[0]) return '';
  const lim = Number(rows[0].limit_), sp = Number(rows[0].spent);
  const p = Math.round((sp / lim) * 100);
  const belgi = p >= 100 ? '🔴' : p >= 80 ? '🟡' : '🟢';
  return `\n${belgi} Byudjet: ${pul(sp, ccy)} / ${pul(lim, ccy)} (${p}%)` +
    (p >= 100 ? `\n⚠️ Limitdan ${pul(sp - lim, ccy)} oshdi` : '');
}

function yozuvMatni(e) {
  const yon = e.kind === 'in' ? '➕ Daromad' : '➖ Harajat';
  return `${yon}: <b>${pul(e.amount, e.ccy)}</b>\n` +
    `${turkumBelgi(e.kind, e.category)} ${esc(e.category)}` +
    (e.note ? ` · ${esc(e.note)}` : '') +
    (e.on_date !== bugun() ? `\n📅 ${qisqaSana(e.on_date)}` : '');
}

const yozuvTugma = (id) => Markup.inlineKeyboard([
  [Markup.button.callback('🏷 Turkum', `cat:${id}`), Markup.button.callback('⇄ Daromad/Harajat', `flip:${id}`), Markup.button.callback('↩ O\'chirish', `del:${id}`)],
]);

async function javob(ctx, e, tahrir) {
  const matn = yozuvMatni(e) + (e.kind === 'out' ? await byudjetHolati(ctx.from.id, e.category, e.ccy) : '');
  const opt = { ...HTML, ...yozuvTugma(e.id) };
  return tahrir ? ctx.editMessageText(matn, opt) : ctx.reply(matn, opt);
}

// Buyruqlar pastda ro'yxatdan o'tadi, shuning uchun bu yerdan o'tkazib yuboriladi.
bot.on('text', async (ctx, next) => {
  if (ctx.message.text.startsWith('/')) return next();
  const r = tahlil(ctx.message.text, bugun());
  if (!r) return ctx.reply('Tushunmadim. Masalan: <code>50000 taksi</code>\n/help — to\'liq yo\'riqnoma', HTML);
  if (r.xato) return ctx.reply(`❌ ${r.xato}`);
  const { rows } = await db.query(
    `INSERT INTO pf_entries (tg_id, kind, amount, ccy, category, note, on_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [ctx.from.id, r.kind, r.amount, r.ccy, r.category, r.note, r.on_date]
  );
  return javob(ctx, rows[0]);
});

async function yozuvOl(ctx, id) {
  const { rows } = await db.query(
    'SELECT * FROM pf_entries WHERE id = $1 AND tg_id = $2', [id, ctx.from.id]
  );
  return rows[0];
}

bot.action(/^cat:(\d+)$/, async (ctx) => {
  const e = await yozuvOl(ctx, ctx.match[1]);
  if (!e || e.deleted_at) return ctx.answerCbQuery('Yozuv topilmadi');
  const tugma = TURKUM[e.kind].map((t, i) => Markup.button.callback(`${t.b} ${t.nom}`, `set:${e.id}:${i}`));
  const qator = [];
  for (let i = 0; i < tugma.length; i += 2) qator.push(tugma.slice(i, i + 2));
  await ctx.answerCbQuery();
  return ctx.editMessageReplyMarkup(Markup.inlineKeyboard(qator).reply_markup);
});

bot.action(/^set:(\d+):(\d+)$/, async (ctx) => {
  const e = await yozuvOl(ctx, ctx.match[1]);
  const t = e && TURKUM[e.kind][Number(ctx.match[2])];
  if (!e || e.deleted_at || !t) return ctx.answerCbQuery('Yozuv topilmadi');
  const { rows } = await db.query(
    'UPDATE pf_entries SET category = $1 WHERE id = $2 RETURNING *', [t.nom, e.id]
  );
  await ctx.answerCbQuery(`${t.b} ${t.nom}`);
  return javob(ctx, rows[0], true);
});

// Yo'nalish almashsa turkum ham o'sha tomondan qayta tanlanadi:
// «Kafe» daromad turkumi emas.
bot.action(/^flip:(\d+)$/, async (ctx) => {
  const e = await yozuvOl(ctx, ctx.match[1]);
  if (!e || e.deleted_at) return ctx.answerCbQuery('Yozuv topilmadi');
  const kind = e.kind === 'in' ? 'out' : 'in';
  const { rows } = await db.query(
    'UPDATE pf_entries SET kind = $1, category = $2 WHERE id = $3 RETURNING *',
    [kind, turkumTop(kind, e.note), e.id]
  );
  await ctx.answerCbQuery(kind === 'in' ? 'Daromad' : 'Harajat');
  return javob(ctx, rows[0], true);
});

// O'chirish — iz qoladi (`deleted_at`), tiklash bir bosishda.
bot.action(/^del:(\d+)$/, async (ctx) => {
  const e = await yozuvOl(ctx, ctx.match[1]);
  if (!e) return ctx.answerCbQuery('Yozuv topilmadi');
  await db.query('UPDATE pf_entries SET deleted_at = now() WHERE id = $1', [e.id]);
  await ctx.answerCbQuery('O\'chirildi');
  return ctx.editMessageText(
    `<s>${yozuvMatni(e).replace(/\n/g, ' · ')}</s>\n🗑 O'chirildi`,
    { ...HTML, ...Markup.inlineKeyboard([[Markup.button.callback('↺ Tiklash', `undel:${e.id}`)]]) }
  );
});

bot.action(/^undel:(\d+)$/, async (ctx) => {
  const e = await yozuvOl(ctx, ctx.match[1]);
  if (!e) return ctx.answerCbQuery('Yozuv topilmadi');
  const { rows } = await db.query('UPDATE pf_entries SET deleted_at = NULL WHERE id = $1 RETURNING *', [e.id]);
  await ctx.answerCbQuery('Tiklandi');
  return javob(ctx, rows[0], true);
});

// ── Hisobotlar ─────────────────────────────────────────────────────────────
// Valyuta har doim ALOHIDA: so'm va dollarni o'ylab topilgan kurs bilan
// qo'shish yolg'on yig'indi berardi.
async function jamla(tg, dan, gacha) {
  const { rows } = await db.query(
    `SELECT ccy, kind, category, SUM(amount)::float AS s, COUNT(*)::int AS n
       FROM pf_entries
      WHERE tg_id = $1 AND deleted_at IS NULL AND on_date BETWEEN $2 AND $3
      GROUP BY ccy, kind, category`,
    [tg, dan, gacha]
  );
  const v = {};
  for (const r of rows) {
    const x = (v[r.ccy] ||= { in: 0, out: 0, cat: { in: [], out: [] } });
    x[r.kind] += r.s;
    x.cat[r.kind].push(r);
  }
  for (const x of Object.values(v)) for (const k of ['in', 'out']) x.cat[k].sort((a, b) => b.s - a.s);
  return v;
}

const chiziq = (p) => '▰'.repeat(Math.max(1, Math.round(p / 10))) + '▱'.repeat(10 - Math.max(1, Math.round(p / 10)));

function blok(ccy, x, opt = {}) {
  const qoldi = x.in - x.out;
  let s = '';
  if (x.in) s += `💰 Daromad: <b>${pul(x.in, ccy)}</b>\n`;
  s += `💸 Harajat: <b>${pul(x.out, ccy)}</b>\n`;
  if (x.in) {
    s += `${qoldi >= 0 ? '🟢' : '🔴'} Qoldi: <b>${pul(qoldi, ccy)}</b>` +
      ` · tejash ${Math.round((qoldi / x.in) * 100)}%\n`;
  }
  if (x.cat.out.length) {
    s += '\n';
    for (const c of x.cat.out) {
      const p = x.out ? (c.s / x.out) * 100 : 0;
      s += `${turkumBelgi('out', c.category)} ${esc(c.category)} — ${pul(c.s, ccy)} · ${Math.round(p)}%\n` +
        (opt.chiziq ? `<code>${chiziq(p)}</code>\n` : '');
    }
  }
  if (x.cat.in.length > 1) {
    s += '\nDaromad manbalari:\n' + x.cat.in.map((c) => `${turkumBelgi('in', c.category)} ${esc(c.category)} — ${pul(c.s, ccy)}`).join('\n') + '\n';
  }
  return s;
}

const sarlavhaVal = (ccy, ko) => (ko > 1 ? `\n<b>${ccy === 'USD' ? '💵 Dollar' : '🇺🇿 So\'m'}</b>\n` : '');

async function davr(ctx, nom, dan, gacha) {
  const v = await jamla(ctx.from.id, dan, gacha);
  const vals = Object.keys(v).sort().reverse();
  if (!vals.length) return ctx.reply(`${nom}: yozuv yo'q.`);
  let s = `📊 <b>${nom}</b>\n`;
  for (const c of vals) s += sarlavhaVal(c, vals.length) + blok(c, v[c]);
  return ctx.reply(s, HTML);
}

bot.command('bugun', (ctx) => davr(ctx, `Bugun, ${qisqaSana(bugun())}`, bugun(), bugun()));
bot.command('hafta', (ctx) => {
  const d = new Date(`${bugun()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 6);
  return davr(ctx, 'Oxirgi 7 kun', d.toISOString().slice(0, 10), bugun());
});

function oyChegara(ym) {
  const [y, m] = ym.split('-').map(Number);
  const oxiri = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { dan: `${ym}-01`, gacha: `${ym}-${String(oxiri).padStart(2, '0')}`, kunlar: oxiri, y, m };
}
function oldingiOy(ym) {
  const [y, m] = ym.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

bot.command('oy', async (ctx) => {
  const arg = (ctx.message.text.split(/\s+/)[1] || '').trim();
  const ym = /^\d{4}-\d{2}$/.test(arg) ? arg : bugun().slice(0, 7);
  const o = oyChegara(ym);
  const joriy = ym === bugun().slice(0, 7);
  const v = await jamla(ctx.from.id, o.dan, o.gacha);
  const p = oyChegara(oldingiOy(ym));
  // O'tgan oy bilan TENG oraliq solishtiriladi: 9-oktabrda butun
  // sentabr bilan solishtirish har doim «kam sarfladim» der edi.
  const kunGacha = joriy ? Number(bugun().slice(8, 10)) : o.kunlar;
  const pGacha = `${p.dan.slice(0, 8)}${String(Math.min(kunGacha, p.kunlar)).padStart(2, '0')}`;
  const pv = await jamla(ctx.from.id, p.dan, pGacha);
  const vals = Object.keys(v).sort().reverse();
  if (!vals.length) return ctx.reply(`${OYLAR[o.m - 1]} ${o.y}: yozuv yo'q.`);

  let s = `📊 <b>${OYLAR[o.m - 1]} ${o.y}</b>${joriy ? ` · ${kunGacha}/${o.kunlar} kun` : ''}\n`;
  for (const c of vals) {
    const x = v[c];
    s += sarlavhaVal(c, vals.length) + blok(c, x, { chiziq: true });
    const kunlik = x.out / kunGacha;
    s += `\n📆 Kunlik o'rtacha: ${pul(kunlik, c)}`;
    if (joriy && kunGacha < o.kunlar) s += `\n🔮 Oy oxirigacha prognoz: ${pul(kunlik * o.kunlar, c)}`;
    const old = pv[c]?.out || 0;
    if (old) {
      const d = Math.round(((x.out - old) / old) * 100);
      s += `\n${d > 0 ? '📈' : '📉'} ${OYLAR[p.m - 1].toLowerCase()}ning shu davriga nisbatan: ${d > 0 ? '+' : ''}${d}%`;
    }
    s += '\n';
  }
  return ctx.reply(s, HTML);
});

bot.command('oxirgi', async (ctx) => {
  const { rows } = await db.query(
    `SELECT * FROM pf_entries WHERE tg_id = $1 AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 10`, [ctx.from.id]
  );
  if (!rows.length) return ctx.reply('Hali yozuv yo\'q.');
  const s = rows.map((e, i) =>
    `${i + 1}. ${qisqaSana(e.on_date)} ${e.kind === 'in' ? '➕' : '➖'} ${pul(e.amount, e.ccy)} · ${esc(e.category)}${e.note ? ` · ${esc(e.note)}` : ''}`
  ).join('\n');
  const tugma = rows.map((e, i) => Markup.button.callback(`🗑 ${i + 1}`, `del:${e.id}`));
  const qator = [];
  for (let i = 0; i < tugma.length; i += 5) qator.push(tugma.slice(i, i + 5));
  return ctx.reply(`🧾 <b>Oxirgi yozuvlar</b>\n${s}`, { ...HTML, ...Markup.inlineKeyboard(qator) });
});

// ── Byudjet ────────────────────────────────────────────────────────────────
bot.command('byudjet', async (ctx) => {
  const qism = ctx.message.text.split(/\s+/).slice(1);
  if (qism.length >= 2) {
    const sumMatn = qism.pop();
    const nomMatn = qism.join(' ').toLowerCase();
    const t = TURKUM.out.find((x) => x.nom.toLowerCase() === nomMatn || x.nom.toLowerCase().startsWith(nomMatn));
    if (!t) return ctx.reply(`Turkum topilmadi. Bor turkumlar:\n${TURKUM.out.map((x) => x.nom).join(', ')}`);
    const r = tahlil(`${sumMatn} x`, bugun());
    if (!r || r.xato) {
      if (sumMatn === '0') {
        await db.query('DELETE FROM pf_budgets WHERE tg_id = $1 AND category = $2', [ctx.from.id, t.nom]);
        return ctx.reply(`${t.b} ${t.nom}: limit olib tashlandi.`);
      }
      return ctx.reply('Summa noto\'g\'ri. Masalan: <code>/byudjet Kafe 1500000</code>', HTML);
    }
    await db.query(
      `INSERT INTO pf_budgets (tg_id, category, ccy, amount) VALUES ($1,$2,$3,$4)
       ON CONFLICT (tg_id, category, ccy) DO UPDATE SET amount = EXCLUDED.amount`,
      [ctx.from.id, t.nom, r.ccy, r.amount]
    );
    return ctx.reply(`✅ ${t.b} ${t.nom}: oyiga ${pul(r.amount, r.ccy)}` + await byudjetHolati(ctx.from.id, t.nom, r.ccy));
  }
  const { rows } = await db.query(
    `SELECT b.category, b.ccy, b.amount::float AS lim,
            COALESCE(SUM(e.amount) FILTER (WHERE e.id IS NOT NULL), 0)::float AS sp
       FROM pf_budgets b
       LEFT JOIN pf_entries e ON e.tg_id = b.tg_id AND e.category = b.category AND e.ccy = b.ccy
            AND e.kind = 'out' AND e.deleted_at IS NULL
            AND e.on_date >= date_trunc('month', CURRENT_DATE)
      WHERE b.tg_id = $1 GROUP BY b.category, b.ccy, b.amount ORDER BY b.category`,
    [ctx.from.id]
  );
  if (!rows.length) {
    return ctx.reply('Limit qo\'yilmagan.\n<code>/byudjet Kafe 1500000</code> — qo\'yish\n<code>/byudjet Kafe 0</code> — olib tashlash', HTML);
  }
  const s = rows.map((r) => {
    const p = Math.round((r.sp / r.lim) * 100);
    return `${p >= 100 ? '🔴' : p >= 80 ? '🟡' : '🟢'} ${turkumBelgi('out', r.category)} ${esc(r.category)}\n` +
      `   ${pul(r.sp, r.ccy)} / ${pul(r.lim, r.ccy)} · ${p}% · qoldi ${pul(Math.max(0, r.lim - r.sp), r.ccy)}`;
  }).join('\n');
  return ctx.reply(`🎯 <b>Shu oy limitlari</b>\n${s}`, HTML);
});

// ── Eksport ────────────────────────────────────────────────────────────────
bot.command('excel', async (ctx) => {
  const { rows } = await db.query(
    `SELECT on_date, kind, amount, ccy, category, note FROM pf_entries
      WHERE tg_id = $1 AND deleted_at IS NULL ORDER BY on_date, id`, [ctx.from.id]
  );
  if (!rows.length) return ctx.reply('Hali yozuv yo\'q.');
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const satr = ['Sana;Turi;Summa;Valyuta;Turkum;Izoh'].concat(rows.map((r) =>
    [r.on_date, r.kind === 'in' ? 'Daromad' : 'Harajat', String(r.amount).replace('.', ','), r.ccy, q(r.category), q(r.note)].join(';')
  ));
  // BOM — Excel kirillcha va o'zbekcha harflarni to'g'ri ochsin.
  return ctx.replyWithDocument({ source: Buffer.from('﻿' + satr.join('\r\n'), 'utf8'), filename: `pul-${bugun()}.csv` });
});

// ── Kechki xulosa ──────────────────────────────────────────────────────────
bot.command('kechki', async (ctx) => {
  const { rows } = await db.query(
    `INSERT INTO pf_settings (tg_id, daily) VALUES ($1, FALSE)
     ON CONFLICT (tg_id) DO UPDATE SET daily = NOT pf_settings.daily RETURNING daily`, [ctx.from.id]
  );
  return ctx.reply(rows[0].daily
    ? `🔔 Kechki xulosa yoqildi (${KECHKI || 'vaqt qo\'yilmagan'}).`
    : '🔕 Kechki xulosa o\'chirildi.');
});

// Konteyner qayta ishga tushsa ham ikki marta ketmaydi: «bugun
// yuborildimi» xotirada emas, bazada (`last_daily`).
async function kechkiTick() {
  if (!KECHKI || hozirSoat() < KECHKI) return;
  const kun = bugun();
  for (const id of USERS) {
    const { rows } = await db.query(
      `INSERT INTO pf_settings (tg_id, last_daily) VALUES ($1, $2)
       ON CONFLICT (tg_id) DO UPDATE SET last_daily = $2
        WHERE pf_settings.daily AND (pf_settings.last_daily IS NULL OR pf_settings.last_daily < $2)
       RETURNING tg_id`, [id, kun]
    );
    if (!rows.length) continue;
    const v = await jamla(id, kun, kun);
    const vals = Object.keys(v).sort().reverse();
    const matn = vals.length
      ? `🌙 <b>Bugungi xulosa</b>\n` + vals.map((c) => sarlavhaVal(c, vals.length) + blok(c, v[c])).join('')
      : '🌙 Bugun hech narsa yozilmadi. Harajat bo\'lgan bo\'lsa — hozir yozib qo\'ying.';
    await bot.telegram.sendMessage(id, matn, HTML).catch((e) => console.error('kechki:', id, e.message));
  }
}

// ── Ishga tushish ──────────────────────────────────────────────────────────
bot.catch((e, ctx) => {
  console.error('pul-bot:', e);
  ctx.reply('⚠️ Xatolik yuz berdi, qaytadan urinib ko\'ring.').catch(() => {});
});

(async () => {
  await db.query(SXEMA);
  await bot.telegram.setMyCommands([
    { command: 'oy', description: 'Shu oy hisoboti' },
    { command: 'bugun', description: 'Bugungi harajat' },
    { command: 'hafta', description: 'Oxirgi 7 kun' },
    { command: 'oxirgi', description: 'Oxirgi yozuvlar' },
    { command: 'byudjet', description: 'Oylik limitlar' },
    { command: 'excel', description: 'CSV eksport' },
    { command: 'help', description: 'Yo\'riqnoma' },
  ]);
  if (!USERS.length) console.warn('PUL_BOT_USERS bo\'sh — bot hech kimga javob bermaydi. /start dan ID ni oling.');
  setInterval(() => kechkiTick().catch((e) => console.error('kechki:', e.message)), 60 * 1000);
  bot.launch({ dropPendingUpdates: true });
  console.log('✅ Pul boti ishga tushdi');
})().catch((e) => { console.error(e); process.exit(1); });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
module.exports = { bot };
