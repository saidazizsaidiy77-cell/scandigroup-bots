// ============================================================================
//  ORDER — BANKDAGI TO'LOV TOPSHIRIQNOMASIGA O'XSHASH OYNA
//
//  Kassir qog'ozdagi hujjatni to'ldirgandek to'ldiradi: tepada hujjat
//  nomi va qaysi kassa, ostida sana, kimdan/kimga, summa va kurs, eng
//  pastda dollardagi raqam. Shuning uchun uchta shakl bor, oltita emas:
//
//    KIRIM       kimdan keldi → SHU kassaga
//    CHIQIM      SHU kassadan → kimga ketdi (yoki harajatga)
//    KO'CHIRISH  SHU kassadan → boshqa kassaga (valyuta almashish ham)
//
//  Ikkinchi tomon ro'yxatida XODIM YO'Q (zavod qarori): korxonaga pul
//  mijozdan keladi va ta'minotchiga hamda harajatga ketadi. Xodim
//  qo'lidagi pul — bu korxonaning O'Z puli, uning kassaga qaytishi
//  «kirim» emas, topshirish; shuning uchun umumiy ro'yxatda turmaydi.
let form = null;

const SIDE_LABEL = { account: 'Kassa', worker: 'Xodim', payable: 'Xodim',
                     customer: 'Mijoz', supplier: "Ta'minotchi" };

const SIDE_LIST = (kind) => ({
  account:  (refs.accounts  || []).filter(a => isMe() || a.code !== A)
              .map(a => [`account:${a.id}`, a.name]),
  //  Xodim faqat TOPSHIRISH oynasida, va yonida qo'lidagi pul turadi:
  //  kassir sanab olgan pulini shu raqam bilan solishtiradi.
  worker:   (refs.workers   || []).map(w => [`worker:${w.id}`,
              w.name + (Number(w.total_usd) ? ` · ${usd(w.total_usd)} $` : '')]),
  customer: (refs.customers || []).map(c =>
              [`customer:${c.id}`, c.name + (c.region ? ` · ${c.region}` : '')]),
  supplier: (refs.suppliers || []).map(s => [`supplier:${s.id}`, s.name]),
  //  Qo'liga pul BERILADIGAN xodimlar: belgisi Xodimlar sahifasida
  //  qo'yiladi. Qiymati baribir `worker:` — bazada bitta tur, farq
  //  faqat kimni tanlash mumkinligida.
  payable:  (refs.payable   || []).map(w => [`worker:${w.id}`, w.name]),
}[kind] || []);

function sidePicker(id, kinds, extra) {
  const groups = kinds.map(k => [SIDE_LABEL[k], SIDE_LIST(k)])
                      .filter(([, list]) => list.length);
  if (!groups.length && !extra)
    return `<select id="${id}" disabled><option>— ro'yxat bo'sh —</option></select>`;
  const grp = ([lab, list]) => `<optgroup label="${esc(lab)}">${list.map(([v, t]) =>
    `<option value="${esc(v)}">${esc(t)}</option>`).join('')}</optgroup>`;
  return `<select id="${id}" onchange="calc()">
    <option value="">— tanlang —</option>
    ${extra || ''}${groups.map(grp).join('')}</select>`;
}

//  Shakl turiga qarab ikkinchi tomon kim bo'lishi mumkin.
const FORMS = {
  in:   { t: 'Kirim orderi',  who: 'Kimdan', into: true,
          kinds: () => isMe() ? ['customer'] : ['customer', 'supplier'] },
  out:  { t: 'Chiqim orderi', who: 'Kimga',
          kinds: () => ['supplier'] },
  //  TOPSHIRISH — kirim emas. Menejer mijozdan olgan pul korxonaniki,
  //  u shunchaki menejerning qo'lida turibdi; kassaga kelishi yangi
  //  pul emas, o'sha pulning joyi o'zgarishi. Shuning uchun alohida
  //  oyna va alohida nom: «Kirim» ro'yxatida xodim turmaydi.
  take: { t: 'Xodimdan qabul qilish', who: 'Kim topshirdi', into: true,
          kinds: () => ['worker'] },
  //  BERISH — chiqimning bir turi, lekin ro'yxati boshqa: pul hamma
  //  xodimga emas, belgisi qo'yilgan bir nechta odamga beriladi.
  //  Shu sababdan «Chiqim» ro'yxatiga qo'shilmadi: u yerda ta'minotchi
  //  va harajat turadi, ular esa boshqa savolning javobi.
  give: { t: 'Xodimga pul berish', who: 'Kimga', kinds: () => ['payable'] },
  move: { t: "Ko'chirish", who: 'Qaysi kassaga', kinds: () => ['account'] },
};

function openForm(kind) {
  const F = FORMS[kind];
  if (!F) return;
  form = kind;
  const bugun = isoDay(new Date());
  //  Harajat — chiqimning bir turi, alohida tugma emas: kassir «kimga»
  //  o'rniga harajat moddasini tanlaydi va shu zahoti foyda-zarar oyi
  //  so'raladi.
  const harajat = kind === 'out'
    ? `<optgroup label="Harajat">${refs.groups.map(g => {
         const list = refs.items.filter(i => i.group_code === g.code);
         return list.map(i =>
           `<option value="expense:${i.id}">${esc(g.name)} · ${esc(i.name)}</option>`).join('');
       }).join('')}</optgroup>` : '';

  $('modalRoot').innerHTML = `
    <div class="overlay" onclick="if(event.target===this)closeForm()">
      <div class="modal" style="max-width:600px">
        <div class="row" style="justify-content:flex-end;margin-bottom:4px">
          <button onclick="closeForm()">Yopish</button></div>

        <!--  Hujjat boshi: bu qanaqa order va qaysi kassaga. Raqamni
              tizim saqlashda beradi (P26-0004) — oldindan band qilib
              qo'yilsa, bekor qilingan oynadan bo'sh raqam qolardi. -->
        <div class="ord-head">
          <div class="t">${esc(F.t)}</div>
          <div class="n">${esc(here.title || here.name)}</div>
        </div>

        <div class="fields">
          <div><label>Sana</label>
            <input id="fDate" type="date" value="${bugun}"><div class="hint"></div></div>

          <div class="wide"><label>${esc(F.who)}</label>
            ${sidePicker('fSide', F.kinds(), harajat)}
            <div class="hint" id="fSideHint"></div></div>

          <div><label>Summa</label>
            <input id="fAmt" type="number" min="0" step="0.01" inputmode="decimal"
              oninput="calc()"><div class="hint"></div></div>

          <div><label>Valyuta</label>
            <select id="fCur" onchange="calc()">
              <option value="UZS">So'm</option><option value="USD">Dollar</option>
            </select><div class="hint"></div></div>

          <!--  Kurs HAR OPERATSIYADA: pulni kiritayotgan odam o'sha
                to'lovning kursini yozadi va u operatsiya bilan birga
                qotib qoladi. -->
          <div id="fRateBox"><label>Kurs, 1$ = so'm</label>
            <input id="fRate" type="number" min="0" step="0.01" inputmode="decimal"
              oninput="calc()"><div class="hint"></div></div>

          <!--  ★ QAYSI OYNING FOYDA-ZARARIGA: to'lov bugun ketadi,
                harajat esa boshqa oyniki bo'lishi mumkin. -->
          <div id="fMonthBox" hidden><label>Foyda-zarar oyi</label>
            <input id="fMonth" type="month" value="${bugun.slice(0, 7)}">
            <div class="hint">qaysi oy hisobotiga tushsin</div></div>

          <div class="wide"><label>Izoh</label>
            <input id="fNote" placeholder="ixtiyoriy"></div>
        </div>

        <div class="ord-sum">
          <div><span class="muted" style="font-size:13px">Dollarda</span>
            <div class="big" id="fSum">—</div></div>
          <div class="row" style="gap:10px">
            <button class="primary" onclick="saveOp()">Saqlash</button>
            <button onclick="closeForm()">Bekor qilish</button></div>
        </div>
      </div>
    </div>`;
  calc();
}

const closeForm = () => { $('modalRoot').innerHTML = ''; form = null; };

//  Kurs katagi faqat SO'M da kerak; harajat oyi esa faqat harajatda.
//  Ikkalasi ham tanlangan zahoti ochiladi — kassir bo'sh katakni
//  qidirib o'tirmasin.
function calc() {
  if (!$('fCur')) return;
  const so = $('fCur').value === 'UZS';
  $('fRateBox').hidden = !so;
  const side = String($('fSide') ? $('fSide').value : '');
  $('fMonthBox').hidden = !side.startsWith('expense:');
  const a = Number($('fAmt').value) || 0;
  const r = Number($('fRate').value) || 0;
  const d = so ? (r > 0 ? a / r : 0) : a;
  $('fSum').innerHTML = d ? `${usd(d)} <span class="muted">$</span>`
    : '<span class="muted">—</span>';
}

async function saveOp() {
  const raw = String($('fSide').value || '');
  const [kind, id] = raw.split(':');
  if (!kind) return toast('Tomon tanlanmagan', true);
  //  SHU kassa doim bir tomonda: kirimda oluvchi, chiqimda beruvchi.
  //  Menejerda esa u o'zi (`me`) — serverda ham shunday qo'yiladi.
  const meSide = { kind: 'worker', id: refs.me.id };
  const acc = isMe() ? meSide
    : { kind: 'account', id: (refs.accounts.find(a => a.code === A) || {}).id };
  const other = kind === 'expense' ? { kind: 'expense', id: null }
                                   : { kind, id: Number(id) };
  const body = {
    op_date: $('fDate').value || null,
    currency: $('fCur').value,
    amount: $('fAmt').value,
    rate: $('fRate').value || null,
    note: $('fNote').value,
    ...(FORMS[form].into ? { from_kind: other.kind, from_id: other.id,
                             to_kind: acc.kind, to_id: acc.id }
                         : { from_kind: acc.kind, from_id: acc.id,
                             to_kind: other.kind, to_id: other.id }),
    ...(kind === 'expense'
      ? { expense_item_id: Number(id), pl_month: $('fMonth').value } : {}),
  };
  try {
    const r = await App.api('/api/cash/ops',
      { method: 'POST', body: JSON.stringify(body) });
    toast(`${r.doc_no} · ${usd(r.amount_usd)} $`);
    closeForm();
    reload();
  } catch (e) { toast(e.message, true); }
}

// ────────────────────────────────────────────── BOSHLANG'ICH QOLDIQ
//
//  Tizim ishga tushgan kundagi pul. Operatsiya EMAS: uning «qayerdan» i
//  yo'q — pul tizimdan oldin ham bor edi. Shuning uchun kassaning o'z
//  maydoni, mijozning `opening_debt` i bilan bir xil mantiq. Shusiz
//  kassa birinchi kundanoq minusda turardi.
function openOpening() {
  const a = here;
  $('modalRoot').innerHTML = `
    <div class="overlay" onclick="if(event.target===this)closeForm()">
      <div class="modal" style="max-width:560px">
        <div class="row" style="justify-content:flex-end;margin-bottom:4px">
          <button onclick="closeForm()">Yopish</button></div>
        <div class="ord-head">
          <div class="t">Boshlang'ich qoldiq</div>
          <div class="n">${esc(a.name)}</div>
        </div>
        <p class="muted" style="margin:-8px 0 16px">Tizim ishga tushgan kundagi pul.
          Bir martalik raqam: undan keyingi hammasi operatsiyalardan chiqadi.</p>
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
          <button class="primary" onclick="saveOpening()">Saqlash</button>
          <button onclick="closeForm()">Bekor qilish</button></div>
      </div></div>`;
}

async function saveOpening() {
  try {
    await App.api('/api/cash/accounts/' + here.id, { method: 'PATCH', body: JSON.stringify({
      opening_on: $('oDate').value || null,
      opening_uzs: $('oUzs').value || 0,
      opening_usd: $('oUsd').value || 0,
      opening_rate: $('oRate').value || null,
    }) });
    toast('Saqlandi'); closeForm(); reload();
  } catch (e) { toast(e.message, true); }
}

App.start(async () => {
  refs = await App.api('/api/cash/refs');
  await reload();
}, 'cash.view', 'cash.entry', 'cash.manage');
