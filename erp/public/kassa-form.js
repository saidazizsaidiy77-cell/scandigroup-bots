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

//  Chiqimning BIRINCHI bosqichi: pul qayerga ketishi mumkin.
//  Ta'minotchi va xodim ham shu yerda — kassir uchun ular ham
//  «qayerga» degan savolning javobi, harajat guruhlaridan farqi yo'q.
function outGroups() {
  //  ★ TA'MINOTCHIGA TO'LOV — TA'MINOT GURUHINING ICHIDA, yuqorida
  //  EMAS (zavod qarori). U harajat guruhi bilan bir qatorda turardi
  //  va bitta ishga ikkita yo'l ochilib qolgandi: yuqoridagi yorliq
  //  ham, «Ta'minot → Ta'minotchilarga to'lov» ham. Ikkinchisi to'g'ri
  //  yo'l — u harajat MODDASINI ham yozadi, ya'ni to'lov foyda-zararda
  //  o'z qatorida qoladi; birinchisi esa moddasiz o'tib ketardi.
  //
  //  Uchinchi bosqich (qaysi ta'minotchi) o'zgarmadi: u moddaning
  //  belgisidan chiqadi (`needs_supplier`, izoh: sql/cash.sql).
  //
  //  ★ «HARAJAT YOZISH» OYNASIDA XODIM YO'Q — KIM YOZAYOTGANIDAN
  //  QAT'I NAZAR. Bu oyna qo'ldagi pulni HARAJATGA aylantiradi, uning
  //  ikkinchi tomoni har doim harajat moddasi. Xodimga pul berish esa
  //  harajat emas: korxonaning puli bir qo'ldan ikkinchisiga ko'chadi
  //  va uning moddasi yo'q.
  //
  //  Ro'yxatda turgani mantiqsiz edi — xodimning qo'lidagi puldan
  //  boshqa xodimga, ustiga O'ZIGA ham «podotchyot berish» taklif
  //  qilinardi. Pul kassa orqali yuradi: berish ham, qabul qilish ham
  //  KASSANING oynasida, chunki u yerda ikkinchi tomoni baribir kassa.
  const sarf = form === 'spend';
  //  Cheklov esa faqat XODIMNING O'ZI yozganida: kassir boshqa
  //  xodimning sahifasida chekni qo'lida ushlab turibdi va uni yozib
  //  qo'yishi kerak.
  const ozi = sarf && isMe();
  const ruxsat = (refs.my && refs.my.groups) || [];
  //  Ro'yxati bo'sh bo'lsa ham turadi: ilgari qator umuman chiqmasdi
  //  va kassir «xodimga pul berish yo'q ekan» deb o'ylardi.
  const g = sarf ? [] : [['worker', "Xodim qo'liga pul (podotchyot)"]];
  (refs.groups || []).forEach(x => {
    if (ozi && ruxsat.length && !ruxsat.includes(x.code)) return;
    if ((refs.items || []).some(i => i.group_code === x.code))
      g.push(['g:' + x.code, x.name]);
  });
  return g;
}

//  Ikkinchi bosqich: tanlangan guruhning ichi. Qiymat baribir
//  «tur:id» bo'lib qoladi — saqlash yo'li bitta (saveOp).
function outItems(g) {
  if (g === 'worker') return (refs.payable || []).map(x => [`worker:${x.id}`, x.name]);
  if (g && g.startsWith('g:')) {
    const code = g.slice(2);
    return (refs.items || []).filter(i => i.group_code === code)
      .map(i => [`expense:${i.id}`, i.name]);
  }
  return [];
}

//  Oylar ro'yxati: qo'lda yozilmaydi, tanlanadi. «2026-09» ni terish
//  klaviaturani ochib, formatni eslab turishni talab qilardi —
//  ro'yxatda esa oy nomi bilan turadi va xato yozib bo'lmaydi.
const OYLAR = ['Yanvar','Fevral','Mart','Aprel','May','Iyun',
               'Iyul','Avgust','Sentabr','Oktabr','Noyabr','Dekabr'];
function oyOptions(tanlangan) {
  const now = new Date();
  const out = [];
  //  O'n ikki oy orqaga va bitta oldinga: harajat o'tgan oyniki
  //  bo'lishi odatiy hol, kelasi oyniki esa kamdan-kam.
  //  Kelasi oydan boshlab O'N IKKI oy orqaga: ro'yxat tepasida yaqin
  //  oylar tursin, uzoq o'tmish esa pastda.
  for (let k = 1; k >= -12; k--) {
    const d = new Date(now.getFullYear(), now.getMonth() + k, 1);
    const v = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    out.push(`<option value="${v}"${v === tanlangan ? ' selected' : ''}>${
      OYLAR[d.getMonth()]} ${d.getFullYear()}</option>`);
  }
  return out.join('');
}

//  Uchinchi bosqich — TA'MINOTCHI. Faqat moddasi shuni talab qilsa
//  chiqadi (`needs_supplier`, izoh: sql/cash.sql): pul ma'lum bir
//  ta'minotchiga ketadi va uning qarzidan ayriladi, modda esa
//  foyda-zararda qoladi.
//
//  Qirqta ta'minotchi ro'yxatdan ko'z bilan qidiriladigan narsa emas,
//  shuning uchun ustida qidiruv katagi turadi.
//  Ikkinchi bosqich ro'yxatini qidiruv bo'yicha qayta chizadi.
//  Tanlangani saqlanadi: qidiruv yozilganda tanlov yo'qolmasin.
function itemFilter() {
  const g = $('fSide') ? $('fSide').value : '';
  const q = ($('fItemQ').value || '').trim().toLowerCase();
  const bor = $('fItem').value;
  const list = outItems(g).filter(([, t]) => !q || t.toLowerCase().includes(q));
  $('fItem').innerHTML = `<option value="">— tanlang —</option>` +
    list.map(([v, t]) => `<option value="${esc(v)}"${
      v === bor ? ' selected' : ''}>${esc(t)}</option>`).join('');
  $('fItemHint').textContent = q ? `${list.length} ta topildi` : '';
  outThird();
}

function outThird() {
  const box = $('fSupBox');
  if (!box) return;
  const val = $('fItem') ? $('fItem').value : '';
  const id  = val.startsWith('expense:') ? Number(val.slice(8)) : 0;
  const it  = (refs.items || []).find(x => x.id === id);
  box.hidden = !(it && it.needs_supplier);
  if (box.hidden) { $('fSup').value = ''; $('fSupQ').value = ''; return calc(); }
  supFilter();
}

//  Topilganlar SHU YERDA, ro'yxat bo'lib turadi — bosib ochiladigan
//  ochilma emas. Kassir nomni yozadi va javobni o'sha zahoti ko'radi;
//  ilgari yozgandan keyin yana ochilmani ochishi kerak edi, ya'ni
//  bitta tanlov uchun ikkita harakat.
//
//  Bittasi qolsa O'ZI tanlanadi: ro'yxatda bitta qator turganda uni
//  bosish odamdan javobni ikkinchi marta so'rash bo'lardi.
function supFilter() {
  const q = ($('fSupQ') ? $('fSupQ').value : '').trim().toLowerCase();
  const list = (refs.suppliers || [])
    .filter(x => !q || x.name.toLowerCase().includes(q));
  if (q && list.length === 1) $('fSup').value = `supplier:${list[0].id}`;
  const bor = $('fSup').value;
  $('fSupList').innerHTML = list.length
    ? list.map(x => `<button type="button"${
        `supplier:${x.id}` === bor ? ' class="on"' : ''
      } onclick="supPick(${x.id})">${esc(x.name)}</button>`).join('')
    //  Bo'sh ro'yxat sababini AYTADI: kassir «tizim ishlamayapti» deb
    //  o'ylab, to'lovni yozmay qo'yardi. Ro'yxat Ta'minot bo'limidan
    //  to'ladi — bir marta import qilinadi.
    : `<div class="none">${(refs.suppliers || []).length
        ? "Bunday ta'minotchi topilmadi"
        : "Ro'yxat bo'sh — Ta'minot → Ta'minotchilar sahifasidan kiriting"}</div>`;
  const bori = (refs.suppliers || []).length;
  $('fSupHint').textContent = q ? `${list.length} ta topildi`
    : bori ? `${bori} ta ta'minotchi` : '';
  calc();
}

//  Tanlangach qidiruv katagiga nomi yoziladi: ro'yxat bitta qatorga
//  qisqaradi va kim tanlanganini oyna yopilguncha ko'rsatib turadi.
function supPick(id) {
  const s = (refs.suppliers || []).find(x => x.id === id);
  if (!s) return;
  $('fSup').value = `supplier:${id}`;
  $('fSupQ').value = s.name;
  supFilter();
}

function outSecond() {
  const g = $('fSide') ? $('fSide').value : '';
  const list = outItems(g);
  const box = $('fItemBox');
  if (!box) return;
  box.hidden = !g;
  $('fItemLab').textContent = g === 'worker' ? 'Xodim' : 'Harajat moddasi';
  //  Ro'yxat bo'sh bo'lsa sababi yoziladi: bo'sh ro'yxat «tizim
  //  ishlamayapti» degan taassurot qoldirardi.
  $('fItem').innerHTML = list.length
    ? `<option value="">— tanlang —</option>` +
      list.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('')
    : `<option value="">${g === 'worker'
        ? "— qo'liga pul beriladigan xodim belgilanmagan —"
        : '— modda yo\'q —'}</option>`;
  //  Qidiruv katagi UZUN ro'yxatda kerak: qirqta ta'minotchini ko'z
  //  bilan qidirib bo'lmaydi, oltita moddani esa qidirish shart emas.
  $('fItemQ').hidden = list.length < 10;
  if ($('fItemQ').hidden) $('fItemQ').value = '';
  $('fItemHint').textContent = g === 'worker' && !list.length
    ? "Xodimlar sahifasida «Qo'liga pul beriladi» katagini belgilang" : '';
  outThird();
}

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
  //  ★ CHIQIM IKKI BOSQICH: avval GURUH, keyin uning ichidagi.
  //
  //  Bitta ro'yxatda o'ttizta «Guruh · Modda» qatori turardi va kassir
  //  kerakligini topguncha butun ro'yxatni o'qib chiqardi. Endi avval
  //  to'qqizta guruh ko'rinadi (ustiga ta'minotchi va xodim), tanlangach
  //  esa faqat o'shaning ichidagilar.
  out:  { t: 'Chiqim orderi', who: 'Kimga', two: true },
  //  TOPSHIRISH — kirim emas. Menejer mijozdan olgan pul korxonaniki,
  //  u shunchaki menejerning qo'lida turibdi; kassaga kelishi yangi
  //  pul emas, o'sha pulning joyi o'zgarishi. Shuning uchun alohida
  //  oyna va alohida nom: «Kirim» ro'yxatida xodim turmaydi.
  take: { t: 'Xodimdan qabul qilish', who: 'Kim topshirdi', into: true,
          kinds: () => ['worker'] },
  //  ★ PODOTCHYOT BERISH — o'z oynasi. Chiqimning ichida ham turadi
  //  («Xodim qo'liga pul» guruhi), lekin kassir buni kuniga bir necha
  //  marta qiladi va har safar guruh tanlab o'tirishi kerak bo'lardi.
  //  Topshirish allaqachon alohida tugma — berish ham shunday bo'lishi
  //  kerak: ikkalasi bitta ishning ikki tomoni.
  //  Ro'yxatda faqat BELGISI bor xodimlar (`payable`).
  give: { t: 'Xodimga podotchyot', who: 'Kimga beriladi',
          kinds: () => ['payable'] },
  move: { t: "Ko'chirish", who: 'Qaysi kassaga', kinds: () => ['account'] },
  //  ★ HISOBOT: xodim qo'lidagi puldan nimaga sarflaganini O'ZI yozadi.
  //  Pul qo'lidan chiqadi va harajatga aylanadi — podotchyot shu bilan
  //  yopiladi. Ro'yxatda faqat unga ochilgan guruhlar turadi.
  spend: { t: 'Harajat yozish', who: 'Nimaga', two: true },
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
            ${F.two
              ? `<select id="fSide" onchange="outSecond()">
                   <option value="">— tanlang —</option>
                   ${outGroups().map(([v, t]) =>
                     `<option value="${esc(v)}">${esc(t)}</option>`).join('')}
                 </select>`
              : sidePicker('fSide', F.kinds(), harajat)}
            <div class="hint" id="fSideHint"></div></div>

          <!--  Ikkinchi bosqich: guruh tanlangach uning ichidagilar.
                Boshida yashirin turadi — bo'sh ro'yxat savol berdiradi. -->
          ${F.two ? `<div class="wide" id="fItemBox" hidden>
            <label id="fItemLab">Modda</label>
            <input id="fItemQ" placeholder="nomi bo'yicha qidirish" hidden
                   oninput="itemFilter()" style="margin-bottom:8px">
            <select id="fItem" onchange="outThird()"></select>
            <div class="hint" id="fItemHint"></div></div>

          <!--  Uchinchi bosqich: qaysi ta'minotchiga. Qirqta nomni ko'z
                bilan qidirib bo'lmaydi — ustida qidiruv katagi turadi. -->
          <div class="wide" id="fSupBox" hidden>
            <label>Ta'minotchi</label>
            <input id="fSupQ" placeholder="nomi bo'yicha qidirish"
                   oninput="supFilter()" style="margin-bottom:8px">
            <input type="hidden" id="fSup">
            <div id="fSupList" class="pick"></div>
            <div class="hint" id="fSupHint"></div></div>` : ''}

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
              value="${refs.rate || ''}" oninput="calc()">
            <div class="hint">${refs.rate ? 'oxirgi kurs' : ''}</div></div>

          <!--  ★ QAYSI OYNING FOYDA-ZARARIGA: to'lov bugun ketadi,
                harajat esa boshqa oyniki bo'lishi mumkin. -->
          <div id="fMonthBox" hidden><label>Foyda-zarar oyi</label>
            <select id="fMonth">${oyOptions(bugun.slice(0, 7))}</select>
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
  //  Bo'sh ro'yxat sababini AYTADI: «— ro'yxat bo'sh —» degan yozuv
  //  kassirni nima qilish kerakligi haqida savol bilan qoldirardi.
  if (kind === 'give' && !(refs.payable || []).length)
    $('fSideHint').textContent =
      "Xodimlar sahifasida «Qo'liga pul beriladi» katagini belgilang";
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
  //  Foyda-zarar oyi faqat HARAJATda so'raladi: ta'minotchiga to'lov
  //  ham, xodimga berilgan pul ham harajat emas — ular qarzning
  //  o'rin almashishi.
  const side = String($('fItem') ? $('fItem').value
                                 : ($('fSide') ? $('fSide').value : ''));
  //  Ta'minotchiga to'lovda ham oy so'raladi: modda saqlanadi va
  //  foyda-zararga o'sha oy bilan tushadi.
  $('fMonthBox').hidden = !side.startsWith('expense:');
  const a = Number($('fAmt').value) || 0;
  const r = Number($('fRate').value) || 0;
  const d = so ? (r > 0 ? a / r : 0) : a;
  $('fSum').innerHTML = d ? `${usd(d)} <span class="muted">$</span>`
    : '<span class="muted">—</span>';
}

async function saveOp() {
  //  Ikki bosqichli shaklda javob IKKINCHI katakda: birinchisi faqat
  //  guruh, uning o'zi bilan operatsiya yozib bo'lmaydi.
  //  Ta'minotchi so'ralgan bo'lsa TOMON o'shaniki: pul uning qarzidan
  //  ayriladi. Harajat moddasi yo'qolmaydi — u yonida saqlanadi va
  //  foyda-zararda o'z qatorida turadi (izoh: modules/cash.js).
  const supOchiq = $('fSupBox') && !$('fSupBox').hidden;
  const modda = $('fItem') && $('fItemBox') && !$('fItemBox').hidden
    ? String($('fItem').value || '') : '';
  const raw = String((supOchiq ? $('fSup').value : (modda || $('fSide').value)) || '');
  const [kind, id] = raw.split(':');
  if (!kind) return toast(supOchiq ? "Ta'minotchi tanlanmagan"
                                   : 'Tomon tanlanmagan', true);
  //  SHU kassa doim bir tomonda: kirimda oluvchi, chiqimda beruvchi.
  //  Menejerda esa u o'zi (`me`) — serverda ham shunday qo'yiladi.
  const meSide = { kind: 'worker', id: refs.me.id };
  //  ★ XODIMNING SAHIFASIDA TOMON O'SHA XODIM, kassa emas: qo'lidagi
  //  puldan yozilgan harajat uning qo'lidan chiqishi kerak. Ilgari bu
  //  yerda kassa turardi va sahifa kassaning id sini topa olmay
  //  «Qayerdan tanlanmagan» deb yiqilardi.
  const acc = isMe() ? meSide
    : W ? { kind: 'worker', id: here.id }
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
      ? { expense_item_id: Number(id), pl_month: $('fMonth').value }
      : supOchiq && modda.startsWith('expense:')
      ? { expense_item_id: Number(modda.slice(8)), pl_month: $('fMonth').value } : {}),
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
        <p class="muted" style="margin:-8px 0 16px">Tizim ishga tushgan kundagi pul${
          W ? " — shu xodimning qo'lida turgani" : ''}.
          Bir martalik raqam: undan keyingi hammasi operatsiyalardan chiqadi.</p>
        <div class="fields">
          <div><label>Sana</label>
            <input id="oDate" type="date" value="${(a.opening_on || '').slice(0, 10)}">
            <div class="hint"></div></div>
          <div><label>So'm</label>
            <input id="oUzs" type="number" step="0.01" inputmode="decimal"
              value="${Number(a.opening_uzs) || ''}" oninput="oCalc()">
            <div class="hint"></div></div>
          <!--  Kurs oldindan to'ldiriladi (oxirgi ishlatilgani). Uni
                so'm va dollar qoldig'idan HISOBLAB bo'lmaydi: ular
                ikkita alohida pul, biri ikkinchisining aylantirilgani
                emas — uzs/usd bo'lsa o'ylab topilgan kurs chiqardi. -->
          <div><label>Kurs, 1$ = so'm</label>
            <input id="oRate" type="number" step="0.01" inputmode="decimal"
              value="${Number(a.opening_rate) || refs.rate || ''}" oninput="oCalc()">
            <div class="hint" id="oHint">so'm qoldig'i uchun</div></div>
          <div><label>Dollar</label>
            <input id="oUsd" type="number" step="0.01" inputmode="decimal"
              value="${Number(a.opening_usd) || ''}" oninput="oCalc()">
            <div class="hint"></div></div>
        </div>
        <!--  Jami dollarda: so'm qoldig'i kurs bilan aylantirilib,
              dollardagiga qo'shiladi. Kassir raqamni SAQLASHDAN OLDIN
              ko'radi — bir nol ortiqcha yozilgani shu yerda bilinadi. -->
        <div class="ord-sum" style="margin-top:4px">
          <div><span class="muted" style="font-size:13px">Jami dollarda</span>
            <div class="big" id="oSum">—</div></div>
        </div>
        <div class="row" style="gap:10px;margin-top:22px">
          <button class="primary" onclick="saveOpening()">Saqlash</button>
          <button onclick="closeForm()">Bekor qilish</button></div>
      </div></div>`;
  oCalc();
}

//  Jami: so'm kurs bilan dollarga aylantirilib, dollardagiga qo'shiladi.
//  Kurs yo'q bo'lsa so'm qismi hisoblanmaydi va buni ekran aytib turadi —
//  yarim hisoblangan raqam noto'g'ri raqamdan battar.
//
//  Kursning O'ZI esa hisoblanmaydi: so'm va dollar qoldig'i ikkita
//  ALOHIDA pul, biri ikkinchisining aylantirilgani emas. uzs/usd bo'lsa
//  o'ylab topilgan kurs chiqardi va butun hisob shunga qurilardi.
function oCalc() {
  if (!$('oSum')) return;
  //  O'zgaruvchi nomi `usd` EMAS: shu nomda global formatlovchi funksiya
  //  bor va u soya ostida qolib ketardi.
  const som = Number($('oUzs').value) || 0;
  const dol = Number($('oUsd').value) || 0;
  const r   = Number($('oRate').value) || 0;
  const jami = dol + (r > 0 ? som / r : 0);
  $('oSum').innerHTML = jami
    ? `${usd(jami)} <span class="muted">$</span>` : '<span class="muted">—</span>';
  $('oHint').textContent = som && !r ? "so'm uchun kurs kerak" : "so'm qoldig'i uchun";
}

async function saveOpening() {
  try {
    //  Yo'l joyga qarab: kassaniki `cash_accounts` ga, xodimniki
    //  `workers` ga. Ikkalasi ham bir xil maydonlar, bir xil qoida —
    //  bir martalik raqam, operatsiya emas.
    await App.api(W ? '/api/cash/workers/' + here.id + '/opening'
                    : '/api/cash/accounts/' + here.id,
      { method: 'PATCH', body: JSON.stringify({
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
