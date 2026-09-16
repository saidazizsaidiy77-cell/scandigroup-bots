// ============================================================================
//  OPERATSIYA SHAKLI
//
//  Oltita tugma — bitta shakl. Farqi faqat qaysi tomon qayerda turishida:
//  «Mijozdan pul olindi» da chap tomonda mijoz, o'ngda xodim; «Harajat»
//  da chapda kassa, o'ngda harajat moddasi. Shuning uchun tomon tanlash
//  ham bitta funksiyadan chiqadi (`sidePicker`) va yangi operatsiya turi
//  qo'shilsa `FORMS` ga bitta qator yoziladi, shakl o'zgarmaydi.
//
//  Tomon qiymati «tur:id» bo'lib yuriladi (`account:3`) — ikkita maydon
//  o'rniga bitta, va ro'yxatda kassa ham, xodim ham birga tursa
//  guruhlanib chiqadi.
let form = null;

const SIDE_LABEL = { account: 'Kassa', worker: 'Xodim',
                     customer: 'Mijoz', supplier: "Ta'minotchi" };

//  Qaysi turdagi tomonlar tanlanishi mumkin — shakl turiga qarab.
//  Menejerda «qayerga» umuman so'ralmaydi: pul faqat uning qo'liga
//  tushadi va serverda ham shunday (modules/cash.js).
const SIDE_LIST = (kind) => ({
  account:  (refs.accounts  || []).map(a => [`account:${a.id}`, a.name]),
  worker:   (refs.workers   || []).map(w => [`worker:${w.id}`, w.name]),
  customer: (refs.customers || []).map(c =>
              [`customer:${c.id}`, c.name + (c.region ? ` · ${c.region}` : '')]),
  supplier: (refs.suppliers || []).map(s => [`supplier:${s.id}`, s.name]),
}[kind] || []);

function sidePicker(id, kinds, val) {
  const groups = kinds.map(k => [SIDE_LABEL[k], SIDE_LIST(k)])
                      .filter(([, list]) => list.length);
  if (!groups.length)
    return `<select id="${id}" disabled><option>— ro'yxat bo'sh —</option></select>`;
  const opts = groups.length === 1
    ? groups[0][1].map(([v, t]) =>
        `<option value="${esc(v)}"${v === val ? ' selected' : ''}>${esc(t)}</option>`).join('')
    : groups.map(([lab, list]) => `<optgroup label="${esc(lab)}">${list.map(([v, t]) =>
        `<option value="${esc(v)}"${v === val ? ' selected' : ''}>${esc(t)}</option>`)
        .join('')}</optgroup>`).join('');
  return `<select id="${id}" onchange="calc()">
    <option value="">— tanlang —</option>${opts}</select>`;
}

function openForm(kind, sideId) {
  const F = FORMS[kind];
  if (!F) return;
  form = kind;
  const bugun = isoDay(new Date());
  const oy = bugun.slice(0, 7);
  //  «Qayerdan» ba'zi shakllarda bitta bo'ladi (kassa), ba'zisida
  //  ikkita tur aralashadi: harajatni kassa ham, xodim ham qo'lidagi
  //  puldan to'lashi mumkin.
  const fromKinds = kind === 'expense' ? ['account', 'worker'] : [F.from];
  const toKinds   = kind === 'in' ? ['worker', 'account'] : [F.to];

  $('modalRoot').innerHTML = `
    <div class="overlay" onclick="if(event.target===this)closeForm()">
      <div class="modal" style="max-width:640px">
        <div class="row" style="justify-content:space-between;margin-bottom:18px">
          <h1 style="margin:0">${esc(F.t)}</h1>
          <button onclick="closeForm()">Yopish</button></div>

        <div class="fields">
          <div><label>Sana</label>
            <input id="fDate" type="date" value="${bugun}"><div class="hint"></div></div>

          <div><label>Qayerdan</label>
            ${sidePicker('fFrom', fromKinds, sideId && kind === 'accept'
              ? `worker:${sideId}` : '')}<div class="hint"></div></div>

          ${kind === 'expense' ? '' : `
          <div><label>Qayerga</label>
            ${boss ? sidePicker('fTo', toKinds, '')
                   : `<input value="${esc(refs.me.name)} — mening qo'limga" disabled>
                      <input type="hidden" id="fTo" value="worker:${refs.me.id}">`}
            <div class="hint"></div></div>`}

          <div><label>Valyuta</label>
            <select id="fCur" onchange="calc()">
              <option value="UZS">So'm</option><option value="USD">Dollar</option>
            </select><div class="hint"></div></div>

          <div><label>Summa</label>
            <input id="fAmt" type="number" min="0" step="0.01" inputmode="decimal"
              oninput="calc()"><div class="hint"></div></div>

          <!--  Kurs HAR OPERATSIYADA: pulni kiritayotgan odam o'sha
                to'lovning kursini yozadi va u operatsiya bilan birga
                qotib qoladi — ertaga kurs o'zgarsa kechagi to'lov
                qayta hisoblanmaydi. -->
          <div id="fRateBox"><label>Kurs, 1$ = so'm</label>
            <input id="fRate" type="number" min="0" step="0.01" inputmode="decimal"
              oninput="calc()"><div class="hint" id="fCalc"></div></div>

          ${kind === 'expense' ? `
          <div class="wide"><label>Harajat moddasi</label>
            ${refs.items.length ? `<select id="fItem">
              <option value="">— tanlang —</option>
              ${refs.groups.map(g => {
                const list = refs.items.filter(i => i.group_code === g.code);
                return list.length ? `<optgroup label="${esc(g.name)}">${list.map(i =>
                  `<option value="${i.id}">${esc(i.name)}</option>`).join('')}</optgroup>` : '';
              }).join('')}</select>`
              : `<select id="fItem" disabled><option>— moddalar kiritilmagan —</option></select>`}
            <div class="hint">guruh → kichik guruh</div></div>

          <!--  ★ QAYSI OYNING FOYDA-ZARARIGA. To'lov bugun ketadi,
                harajat esa boshqa oyniki bo'lishi mumkin: sentabrda
                to'langan avgust ijarasi AVGUST foydasini kamaytiradi. -->
          <div><label>Foyda-zarar oyi</label>
            <input id="fMonth" type="month" value="${oy}">
            <div class="hint">qaysi oyning hisobotiga tushsin</div></div>` : ''}

          <div class="wide"><label>Izoh</label>
            <input id="fNote" placeholder="ixtiyoriy"></div>
        </div>

        <div class="row" style="gap:10px;margin-top:22px">
          <button class="primary" onclick="saveOp()">Saqlash</button>
          <button onclick="closeForm()">Bekor qilish</button>
          <span class="muted" id="fSum" style="font-size:13px"></span>
        </div>
      </div>
    </div>`;
  calc();
}

const closeForm = () => { $('modalRoot').innerHTML = ''; form = null; };

//  Kurs katagi faqat SO'M da kerak: dollarda to'langan pul dollarda
//  qoladi. Yonida darrov dollardagi summa chiqib turadi — kassir
//  raqamni ko'zi bilan tekshiradi.
function calc() {
  if (!$('fCur')) return;
  const so = $('fCur').value === 'UZS';
  $('fRateBox').hidden = !so;
  const a = Number($('fAmt').value) || 0;
  const r = Number($('fRate').value) || 0;
  const d = so ? (r > 0 ? a / r : 0) : a;
  $('fSum').innerHTML = d
    ? `= <b>${usd(d)} $</b>${so && r ? ` (kurs ${uzs(r)})` : ''}` : '';
}

async function saveOp() {
  const side = (v) => {
    const [kind, id] = String(v || '').split(':');
    return { kind, id: Number(id) || null };
  };
  const F = FORMS[form];
  const from = side($('fFrom').value);
  const to = form === 'expense' ? { kind: 'expense', id: null }
                                : side($('fTo').value);
  const body = {
    op_date: $('fDate').value || null,
    from_kind: from.kind, from_id: from.id,
    to_kind: to.kind,     to_id: to.id,
    currency: $('fCur').value,
    amount: $('fAmt').value,
    rate: $('fRate') ? $('fRate').value : null,
    note: $('fNote').value,
    ...(form === 'expense'
      ? { expense_item_id: $('fItem').value, pl_month: $('fMonth').value } : {}),
  };
  try {
    const r = await App.api('/api/cash/ops',
      { method: 'POST', body: JSON.stringify(body) });
    toast(`${r.doc_no} · ${usd(r.amount_usd)} $`);
    closeForm();
    tab === 'ops' ? loadOps() : loadBalance();
  } catch (e) { toast(e.message, true); }
}

App.start(async () => {
  refs = await App.api('/api/cash/refs');
  boss = refs.boss;
  drawButtons();
  drawTabs();
  await loadBalance();
}, 'cash.view', 'cash.entry', 'cash.manage');

// ────────────────────────────────────────────── BOSHLANG'ICH QOLDIQ
//
//  Tizim ishga tushgan kundagi pul. Operatsiya EMAS: uning «qayerdan» i
//  yo'q — pul tizimdan oldin ham bor edi. Shuning uchun kassaning o'z
//  maydoni, mijozning `opening_debt` i bilan bir xil mantiq.
function openOpening(id) {
  const a = bal.accounts.find(x => x.id === id);
  if (!a) return;
  $('modalRoot').innerHTML = `
    <div class="overlay" onclick="if(event.target===this)closeForm()">
      <div class="modal" style="max-width:520px">
        <div class="row" style="justify-content:space-between;margin-bottom:6px">
          <h1 style="margin:0">${esc(a.name)}</h1>
          <button onclick="closeForm()">Yopish</button></div>
        <p class="muted" style="margin-bottom:18px">Boshlang'ich qoldiq —
          tizim ishga tushgan kundagi pul.</p>
        <div class="fields">
          <div><label>Sana</label>
            <input id="oDate" type="date" value="${(a.opening_on || '').slice(0, 10)}">
            <div class="hint"></div></div>
          <div><label>So'm</label>
            <input id="oUzs" type="number" step="0.01" inputmode="decimal"
              value="${Number(a.opening_uzs) || ''}"><div class="hint"></div></div>
          <div><label>Kurs, 1$ = so'm</label>
            <input id="oRate" type="number" step="0.01" inputmode="decimal"
              value="${Number(a.opening_rate) || ''}">
            <div class="hint">so'm qoldig'i uchun</div></div>
          <div><label>Dollar</label>
            <input id="oUsd" type="number" step="0.01" inputmode="decimal"
              value="${Number(a.opening_usd) || ''}"><div class="hint"></div></div>
        </div>
        <div class="row" style="gap:10px;margin-top:22px">
          <button class="primary" onclick="saveOpening(${id})">Saqlash</button>
          <button onclick="closeForm()">Bekor qilish</button></div>
      </div></div>`;
}

async function saveOpening(id) {
  try {
    await App.api('/api/cash/accounts/' + id, { method: 'PATCH', body: JSON.stringify({
      opening_on: $('oDate').value || null,
      opening_uzs: $('oUzs').value || 0,
      opening_usd: $('oUsd').value || 0,
      opening_rate: $('oRate').value || null,
    }) });
    toast('Saqlandi'); closeForm(); loadBalance();
  } catch (e) { toast(e.message, true); }
}
