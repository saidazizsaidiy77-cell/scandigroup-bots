/* ============================================================================
 *  ★ TAHLILCHI AI (zavod qarori, 2026-11; `sql/ai.sql`)
 *
 *  Telegram'da savolga javob beradi («bu oy stul rejasi qanday?»,
 *  «kim qancha qarzdor?») va har kuni ertalab tahliliy xulosa yozadi.
 *  Faqat raqam emas — TAHLIL: rejadan qayerda orqada, nega va nima
 *  qilish kerak.
 *
 *  ★ MA'LUMOT SAYT BILAN BIR XIL API DAN, SO'RAGAN XODIMNING HUQUQI
 *  BILAN. Agent bazaga to'g'ridan-to'g'ri kirmaydi: har savol uchun
 *  o'sha xodimning sessiyasi ochiladi va ichki HTTP so'rov yuboriladi.
 *  Shuning uchun doira (`ownOf`, `scopeOf`, `channelsOf`) va huquqlar
 *  IKKINCHI marta yozilmadi — menejer botdan ham faqat o'z mijozini
 *  ko'radi, saytdagi bilan aynan bir xil. Faqat O'QIYDI: ro'yxatda
 *  birorta yozadigan yo'l yo'q.
 *
 *  Kimga ochiq — XODIMDA (`workers.ai_access`, 4-qoida), standarti
 *  `false`: har javob pul turadi.
 * ========================================================================== */
const express = require('express');
const { db, wrap } = require('../db');
const { createSession } = require('../auth');

const MODEL = process.env.AI_MODEL || 'claude-opus-5-5';
const MAX_JAVOB = 30000;        // bitta vosita javobi (belgi) — kontekst to'lmasin
const TARIX_DAQIQA = 30;        // shuncha jim turilsa suhbat yangidan boshlanadi
const TARIX_SAVOL = 8;          // bitta suhbatda shuncha savoldan keyin ham

//  ★ AGENT O'QIY OLADIGAN HISOBOTLAR — BITTA RO'YXAT. Har biri saytdagi
//  sahifaning O'Z API si: raqam ekrandagi bilan bir xil chiqadi.
const ENDPOINTLAR = {
  konver:            ['/api/units/track', 'Bitta konver (raqami bo\'yicha) qayerda: tsexda, omborda, mijozda. params: no (masalan S26-474)'],
  jurnal:            ['/api/units/', 'Ishlab chiqarish jurnali — konverlar ro\'yxati, bo\'limi, muddati, kechikishi. params: q (qidiruv), section_id ("yoq" — boshlanmagan), sort, dir'],
  ishlab_panel:      ['/api/units/dashboard', 'Ishlab chiqarish paneli: tsexlardan chiqqan, T/M omborga topshirilgan (turi va oy bo\'yicha). params: from, to (YYYY-MM-DD)'],
  sekin_qoldiq:      ['/api/units/slow-stock', 'Omborda uzoq turib qolgan mahsulot'],
  talab_reja:        ['/api/units/demand-plan', 'Buyurtma talabi va ishlab chiqarish rejasi'],
  savdo_panel:       ['/api/sales/dashboard', 'Savdo paneli: shu oy turkum bo\'yicha REJA, CHIQDI, ZAVODDA, pul tushumi; mahsulot va mijoz kesimi. params: from, to'],
  kpi_umumiy:        ['/api/sales/kpi/umumiy', 'KPI: turkum rejasi bajarilishi, tanlangan oy. params: mon (YYYY-MM)'],
  kpi_varaq:         ['/api/sales/kpi', 'Har menejerning KPI varag\'i (reja, fakt, indeks, oy oxiriga taxmin). params: mon (YYYY-MM), worker_id'],
  buyurtmalar:       ['/api/sales/orders', 'Buyurtmalar ro\'yxati va har tab bo\'yicha jami summa. params: status, q, customer_id, manager_id, shipped_from, shipped_to, discount ("pending")'],
  kunlik_jonatma:    ['/api/sales/day', 'Bugungi jo\'natma rejasi: olindi, chiqdi, qoldi'],
  mijoz_qarzlari:    ['/api/sales/debts', 'Mijozlar qarzdorligi (boshiga, qarzdor, haqdor, oxiriga). params: from, to, q, manager_id'],
  mijoz_lentasi:     ['/api/sales/debts/:id', 'Bitta mijozning harakatlari (chiqim, to\'lov, qaytarish). params: id (mijoz id), from, to'],
  nomuvofiq:         ['/api/sales/mismatch', 'Nomuvofiq buyurtmalar: bron va qator farqi, kam chiqqan'],
  kassalar:          ['/api/cash/list', 'Kassalar va bank qoldig\'i, xodimlar qo\'lidagi pul'],
  foyda_zarar:       ['/api/cash/pl', 'Foyda-zarar: savdo, tannarx, harajat, foyda, divident, oylar bo\'yicha. params: from, to'],
  pul_oqimi:         ['/api/cash/flow', 'Pul oqimi: kirim (mijozdan), chiqim, oylar bo\'yicha. params: from, to'],
  harajatlar:        ['/api/cash/expenses', 'Harajatlar moddalar bo\'yicha. params: from, to'],
  moliya_panel:      ['/api/cash/dashboard', 'Moliya paneli: oylik savdo, harajat, foyda, tushum. params: from, to'],
  aylanma_kapital:   ['/api/cash/working-capital', 'Sof aylanma kapital: ombor, ishlab chiqarishda, xom ashyo, kassa, qarzlar. params: from, to'],
  tm_ombor:          ['/api/warehouse/fg/summary', 'Tayyor mahsulot ombori qoldig\'i, bronda, kirdi/chiqdi. params: w (ombor kodi, standart TM), q, from, to'],
  omborlar:          ['/api/warehouse/list', 'Omborlar ro\'yxati va qoldig\'i'],
  xom_ashyo:         ['/api/materials/stock', 'Xom ashyo qoldig\'i va qiymati. params: w (ombor kodi), from, to'],
  xom_ashyo_minus:   ['/api/materials/minus', 'Minusga tushgan materiallar'],
  taminot_qarzlari:  ['/api/purchasing/debts', 'Ta\'minotchilar oldidagi qarz. params: q, from, to'],
  tannarx:           ['/api/cost', 'Konver tannarxi: material, ish haqi, oldingisiga farq. params: from, to'],
  ish_haqi:          ['/api/payroll', 'Ish haqi: hisoblandi, to\'landi, qarz. params: month (YYYY-MM) yoki from, to'],
  zavod_yuklama:     ['/api/factory', 'Zavod ko\'rinishi: bo\'limlar oldidagi navbat va yuklama'],
  tizim_tekshiruvi:  ['/api/integrity', 'Tizim tekshiruvi: hujjat, qoldiq va qarz bir-biriga mos kelmagan joylar'],
};

const SYSTEM = `Sen ZELTA ERP ning tahlilchisisan — Scandi Group mebel fabrikasi (penal, kamod, sp, stol, stul, matras, maxsus buyurtma).
Rahbariyat va xodimlarga Telegram'da javob berasan.

QOIDALAR
- Har raqamni erp_oqish vositasi bilan O'QI. Xotiradan yoki taxmin bilan raqam AYTMA. Ma'lumot topilmasa — shuni ayt.
- Ma'lumot SO'RAGAN XODIMNING huquqi bilan o'qiladi. «Huquq yo'q» kelsa: «bu ma'lumot sizga ochiq emas» deb ayt, aylanib o'tishga urinma.
- Faqat raqam emas, TAHLIL ber: reja bilan solishtir, o'tgan davr bilan solishtir, nima yaxshi, nima xavf, nega bo'lishi mumkin va 1–3 ta aniq tavsiya. Sabab taxmin bo'lsa — «ehtimol» deb ayt.
- Javob QISQA va tuzilmali: sarlavha, 3–8 qator, oxirida «Tavsiya». Telegram oddiy matn: jadval chizma, «•» bilan ro'yxat qil, ko'pi bilan bitta *qalin* so'z.
- Har raqamning manbasini bir so'z bilan ayt: (Savdo paneli), (Qarzdorlik), (Foyda-zarar)...
- Dollar ($) va so'm alohida pul — qo'shma. Dona (stul) va komplekt (penal, kamod, sp, stol) qo'shilmaydi.
- Sana: DD.MM.YYYY. Pul: 12 500 $ ko'rinishida.
- Xodim qaysi tilda yozsa — o'sha tilda (o'zbek lotin yoki rus) javob ber.
- Sen faqat o'qiysan: hech narsani o'zgartira olmaysan. Biror ish qilish kerak bo'lsa — kim va qayerda qilishini ayt.

ATAMALAR
konver — ishlab chiqarish birligi, raqami bilan (K26-0041 korpus, S26-104 stul, C26-227 stol, Z26-0001 maxsus);
turkum — savdo kesimi: mehmonxona (penal, kamod), yotoqxona (sp, matras), stol, stul;
T/M ombor — tayyor mahsulot ombori; bron — konver buyurtmaga biriktirilgan; zahira — buyurtmasiz ishlangan;
savdo — mijozga CHIQIB KETGAN mahsulot summasi; tushum — kassaga KELGAN pul (ular har xil).`;

//  ── Xodim sessiyasi: sayt bilan bir xil huquq va doira ─────────────────
const tokenlar = new Map();
async function tokenOl(workerId, yangi = false) {
  if (!yangi && tokenlar.has(workerId)) return tokenlar.get(workerId);
  const t = await createSession(workerId, 'bot');
  tokenlar.set(workerId, t);
  return t;
}

//  Bitta hisobotni o'qish. Javob agentga MATN bo'lib qaytadi.
async function oqi({ workerId, asos }, endpoint, params = {}) {
  const e = ENDPOINTLAR[endpoint];
  if (!e) return `Noma'lum hisobot: ${endpoint}`;
  const p = { ...(params || {}) };
  let yol = e[0];
  if (yol.includes(':id')) {
    const id = Number(p.id);
    if (!id) return 'params.id kerak';
    yol = yol.replace(':id', String(id));
    delete p.id;
  }
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(p))
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  const url = asos + yol + (qs.toString() ? '?' + qs : '');
  let r;
  for (let urinish = 0; urinish < 2; urinish++) {
    r = await fetch(url, { headers: { authorization: 'Bearer ' + await tokenOl(workerId, urinish > 0) } });
    if (r.status !== 401) break;
  }
  if (r.status === 403) return 'Huquq yo\'q: bu ma\'lumot shu xodimga ochiq emas.';
  const matn = await r.text();
  if (!r.ok) return `Xato ${r.status}: ${matn.slice(0, 500)}`;
  return matn.length > MAX_JAVOB
    ? matn.slice(0, MAX_JAVOB) + `\n…[qisqartirildi: jami ${matn.length} belgi — filtr bilan aniqroq so'rang]`
    : matn;
}

let mijoz = null;
function claude() {
  if (!mijoz) {
    const Anthropic = require('@anthropic-ai/sdk').default;
    mijoz = new Anthropic();     // ANTHROPIC_API_KEY (va ANTHROPIC_BASE_URL) muhitdan
  }
  return mijoz;
}
const yoqilganmi = () => String(process.env.ANTHROPIC_API_KEY || '').trim() !== '';

//  ★ SAVOLGA JAVOB — BITTA JOY. Telegram ham, sayt ham, kunlik
//  xulosa ham shundan o'tadi.
async function javob({ workerId, savol, tarix = [], asos, kind = 'chat' }) {
  const { betaTool } = require('@anthropic-ai/sdk/helpers/beta/json-schema');
  const ishlatilgan = [];
  const vosita = betaTool({
    name: 'erp_oqish',
    description: 'ZELTA ERP hisobotini o\'qiydi (faqat o\'qish). Hisobotlar:\n'
      + Object.entries(ENDPOINTLAR).map(([k, v]) => `- ${k}: ${v[1]}`).join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        endpoint: { type: 'string', enum: Object.keys(ENDPOINTLAR) },
        params: { type: 'object', description: 'So\'rov parametrlari (matn qiymatlar)',
                  additionalProperties: { type: ['string', 'number'] } },
      },
      required: ['endpoint'],
    },
    run: async ({ endpoint, params }) => {
      ishlatilgan.push(endpoint);
      try { return await oqi({ workerId, asos }, endpoint, params); }
      catch (e) { return 'Xato: ' + e.message; }
    },
  });

  const w = (await db.query(
    `SELECT w.name, COALESCE(string_agg(r.name, ', '), '') AS rollar
       FROM workers w
       LEFT JOIN worker_roles wr ON wr.worker_id = w.id
       LEFT JOIN roles r ON r.code = wr.role_code
      WHERE w.id = $1 GROUP BY w.name`, [workerId])).rows[0] || {};
  const bugun = new Date().toISOString().slice(0, 10);
  const messages = [...tarix, { role: 'user',
    content: `[Bugun ${bugun}. So'rayapti: ${w.name || '—'} (${w.rollar || 'rolsiz'})]\n${savol}` }];

  let oxirgi = null, kirdi = 0, chiqdi = 0, xato = null, matn = '';
  const runner = claude().beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    max_iterations: 12,
    thread: false,
    system: SYSTEM,
    output_config: { effort: 'medium' },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    tools: [vosita],
    messages,
  });
  try {
    for await (const m of runner) {
      oxirgi = m;
      kirdi += Number(m.usage?.input_tokens || 0);
      chiqdi += Number(m.usage?.output_tokens || 0);
    }
    if (oxirgi?.stop_reason === 'refusal')
      matn = 'Bu savolga javob bera olmayman.';
    else
      matn = (oxirgi?.content || []).filter((b) => b.type === 'text')
        .map((b) => b.text).join('\n').trim() || 'Javob bo\'sh chiqdi — savolni boshqacha yozib ko\'ring.';
  } catch (e) {
    xato = e.message;
    matn = 'Tahlilchi hozir javob bera olmadi. Birozdan keyin qayta yozing.';
  }
  await db.query(
    `INSERT INTO ai_log (worker_id, kind, question, answer, tools, input_tokens,
                         output_tokens, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [workerId, kind, savol, matn, ishlatilgan, kirdi, chiqdi, xato]);
  const keyingi = xato || !oxirgi ? tarix
    : [...runner.params.messages, { role: 'assistant', content: oxirgi.content }];
  return { matn, tarix: keyingi, tools: ishlatilgan, xato };
}

//  ── Sayt yo'li: POST /api/ai/savol ────────────────────────────────────
const router = express.Router();
let ASOS = null;
const asosOl = (req) => ASOS || `${req.protocol}://127.0.0.1:${req.socket.localPort}`;

async function ruxsatmi(workerId) {
  const { rows } = await db.query(
    `SELECT 1 FROM workers WHERE id = $1 AND active AND ai_access`, [workerId]);
  return rows.length > 0;
}

router.post('/savol', wrap(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Kirish kerak' });
  if (!await ruxsatmi(req.user.id))
    return res.status(403).json({ error: 'Tahlilchi sizga ochilmagan — Xodimlar sahifasida «Tahlilchi AI» belgisi' });
  if (!yoqilganmi()) return res.status(503).json({ error: 'ANTHROPIC_API_KEY qo\'yilmagan' });
  const savol = String(req.body?.savol || '').trim().slice(0, 2000);
  if (!savol) return res.status(400).json({ error: 'Savol bo\'sh' });
  const r = await javob({ workerId: req.user.id, savol, asos: asosOl(req) });
  res.json({ javob: r.matn, tools: r.tools });
}));

//  ── Telegram: botga yozilgan savol ────────────────────────────────────
const suhbat = new Map();       // chatId → { tarix, vaqt, n }

function bolib(matn, n = 3900) {
  const out = [];
  let s = matn;
  while (s.length > n) {
    let i = s.lastIndexOf('\n', n);
    if (i < n / 2) i = n;
    out.push(s.slice(0, i));
    s = s.slice(i);
  }
  if (s.trim()) out.push(s);
  return out;
}

async function tg(token, metod, body) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${metod}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) {
    const e = new Error(`Telegram ${r.status}: ${j.description || ''}`);
    e.status = r.status;
    throw e;
  }
  return j.result;
}

async function xabarniQayta(token, msg) {
  const chatId = msg.chat.id;
  const savol = String(msg.text || '').trim();
  const yoz = (text) => tg(token, 'sendMessage', { chat_id: chatId, text });
  const w = (await db.query(
    `SELECT id FROM workers WHERE tg_id = $1 AND active AND ai_access`,
    [msg.from?.id])).rows[0];
  if (!w) {
    if (savol === '/start' || savol.startsWith('/'))
      return yoz('Assalomu alaykum! Tahlilchi sizga hali ochilmagan — administratorga ayting '
        + '(Xodimlar sahifasida «Tahlilchi AI» belgisi va Telegram ID).');
    return;     // begona odamga jim: bot boshqa xabarlar uchun ham ishlaydi
  }
  if (savol === '/start' || savol === '/yangi') {
    suhbat.delete(chatId);
    return yoz('Tahlilchi tayyor. Savol yozing, masalan:\n'
      + '• Bu oy stul rejasi qanday ketyapti?\n'
      + '• Kim qancha qarzdor, kimga qo\'ng\'iroq qilish kerak?\n'
      + '• S26-474 qayerda?\n'
      + '• Oktabr foyda-zararini tahlil qil\n'
      + '/yangi — yangi suhbat');
  }
  if (!savol) return;
  let s = suhbat.get(chatId);
  if (!s || Date.now() - s.vaqt > TARIX_DAQIQA * 60000 || s.n >= TARIX_SAVOL)
    s = { tarix: [], n: 0 };
  const yozmoqda = setInterval(() => tg(token, 'sendChatAction',
    { chat_id: chatId, action: 'typing' }).catch(() => {}), 4500);
  tg(token, 'sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  try {
    const r = await javob({ workerId: w.id, savol: savol.slice(0, 2000), tarix: s.tarix, asos: ASOS });
    suhbat.set(chatId, { tarix: r.tarix, vaqt: Date.now(), n: s.n + 1 });
    for (const b of bolib(r.matn)) await yoz(b);
  } finally { clearInterval(yozmoqda); }
}

//  Server ko'tarilgach chaqiriladi. `ERP_TG_TOKEN` va `ANTHROPIC_API_KEY`
//  ikkalasi bo'lmasa JIM turadi — xabar navbati bilan bir xil idiom.
function boshla(asos) {
  ASOS = asos;
  const token = String(process.env.ERP_TG_TOKEN || '').trim();
  if (!token || !yoqilganmi()) {
    console.warn('Tahlilchi AI: O\'CHIQ — ERP_TG_TOKEN va ANTHROPIC_API_KEY kerak');
    return;
  }
  console.log(`Tahlilchi AI: yoqilgan (${MODEL})`);
  let offset = 0;
  const navbat = new Map();       // chatId → oldingi javob tugashini kutish
  const aylana = async () => {
    for (;;) {
      try {
        const yangilar = await tg(token, 'getUpdates',
          { offset, timeout: 50, allowed_updates: ['message'] });
        for (const u of yangilar) {
          offset = u.update_id + 1;
          const msg = u.message;
          if (!msg || msg.chat?.type !== 'private' || !msg.text) continue;
          const oldin = navbat.get(msg.chat.id) || Promise.resolve();
          const keyin = oldin.then(() => xabarniQayta(token, msg))
            .catch((e) => console.error('[tahlilchi] XATO:', e.message));
          navbat.set(msg.chat.id, keyin);
        }
      } catch (e) {
        //  409 — botga webhook qo'yilgan yoki ikkinchi nusxa ishlayapti:
        //  ikkalasi ham bir vaqtda xabar ololmaydi, shuning uchun to'xtaymiz.
        if (e.status === 409) {
          console.error('[tahlilchi] getUpdates 409 — botda webhook yoki ikkinchi nusxa bor. To\'xtadi.');
          return;
        }
        console.error('[tahlilchi] getUpdates:', e.message);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  };
  aylana();
}

//  ── Kunlik tahlil (KUNLIK jadvali, `AI_AT`) ───────────────────────────
//  «Kunlik xulosa» belgisi bor VA tahlilchi ochiq xodimga — har biriga
//  O'Z huquqi bilan: menejerga o'z mijozlari, direktorga butun zavod.
const KUNLIK_SAVOL = `Ertalabki tahliliy xulosa tayyorla (kechagi kun va shu oy):
1) Savdo: shu oy turkum rejalari bajarilishi, oy oxiriga taxmin, kim ortda.
2) Ishlab chiqarish: kechikayotgan konverlar, omborga topshirilgani.
3) Pul: kassa, tushum, eng katta qarzdorlar va bugun kimga qo'ng'iroq qilish kerak.
4) Tizim tekshiruvida xato bo'lsa — qisqa.
Oxirida «Bugun 3 ta ish» — eng muhim uchta aniq ish. Ochiq bo'lmagan bo'limni o'tkazib yubor.
Hammasi 3000 belgidan oshmasin.`;

async function kunlikYubor() {
  if (!yoqilganmi() || !ASOS) return 0;
  const notify = require('../notify');
  const { rows } = await db.query(
    `SELECT id FROM workers
      WHERE active AND ai_access AND daily_digest AND tg_id IS NOT NULL`);
  let n = 0;
  for (const w of rows) {
    const r = await javob({ workerId: w.id, savol: KUNLIK_SAVOL, asos: ASOS, kind: 'daily' });
    if (r.xato) continue;
    if (await notify.queue({ worker_id: w.id, module: 'ai', kind: 'ai_daily',
                             title: 'Tahlilchi — ertalabki xulosa', body: r.matn })) n++;
  }
  return n;
}

module.exports = { router, javob, boshla, kunlikYubor, ENDPOINTLAR, oqi };
