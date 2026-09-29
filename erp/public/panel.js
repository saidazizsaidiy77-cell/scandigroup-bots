/* ============================================================================
 *  PANEL — grafiklar uchun umumiy yordamchi
 *
 *  Kutubxona ULANMADI (Chart.js, D3 va hokazo): loyihada freymvork yo'q
 *  va uni bitta sahifa uchun olib kelish butun tizimning qoidasini
 *  buzardi. Ustiga tsexdagi telefon sekin internetda turadi — 200 KB
 *  skript har ochilishda yuklanardi. Grafiklar SOF SVG bo'lib chiziladi.
 *
 *  ★ RANG — IDENTIKLIK UCHUN, KO'RK UCHUN EMAS. Bitta qator bo'lgan
 *  grafikda (oylar, reyting) BITTA rang turadi: raqam qaysi ustunda
 *  ekani balandlikdan chiqadi, rangdan emas. Ko'p rang faqat
 *  TURLARNI ajratganda ishlatiladi (buyurtma holatlari).
 *
 *  Palitra rang ko'rmaslikka tekshirilgan (deutan/protan/tritan) va
 *  yuza rangiga nisbatan kontrasti 3:1 dan yuqori. Tartibi QOTIB
 *  turadi: qator kamaysa qolganlarining rangi o'zgarmaydi — aks
 *  holda filtr bosilganda butun ekran qayta bo'yalib ketardi.
 * ========================================================================== */
const Panel = (() => {
  const RANG = ['#8a5a00', '#0075a3', '#b3314a', '#7248c4', '#3f7d3a'];
  const KUL  = '#b9b7af';

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  //  Pul: dollar belgisi bilan, uch xonadan ajratilgan. Mingdan katta
  //  raqam panelda qisqartiriladi — kartochkada o'n bitta raqam
  //  turishi mumkin emas, u o'qilmaydi.
  const pul = (v, aniq) => {
    const n = Number(v) || 0;
    if (aniq || Math.abs(n) < 1000)
      return n.toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + ' $';
    if (Math.abs(n) < 1e6)
      return (n / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + 'k $';
    return (n / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + 'M $';
  };
  const son = (v) => (Number(v) || 0).toLocaleString('ru-RU',
    { maximumFractionDigits: 0 });

  const OY = ['yan', 'fev', 'mar', 'apr', 'may', 'iyn',
              'iyl', 'avg', 'sen', 'okt', 'noy', 'dek'];
  //  «2026-09» → «sen 26». Sanani Date bilan o'girish shart emas va
  //  xavfli ham: soat mintaqasi bilan oy surilib ketardi.
  const oyNom = (mon) => {
    const [y, m] = String(mon).split('-');
    return `${OY[Number(m) - 1] || m} ${String(y).slice(-2)}`;
  };

  /* ---------------------------------------------------------- TOOLTIP
   *  Bitta element butun sahifaga: har grafik uchun alohida qutilar
   *  yasalsa ular bir-birining ustiga chiqib qolardi.
   */
  let tip;
  function tipKor(e, html) {
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'ptip';
      document.body.appendChild(tip);
    }
    tip.innerHTML = html;
    tip.style.display = 'block';
    const r = tip.getBoundingClientRect();
    //  Ekrandan chiqib ketmasin: o'ng chekkada chapga o'giriladi.
    const x = Math.min(e.clientX + 14, window.innerWidth - r.width - 8);
    tip.style.left = Math.max(8, x) + 'px';
    tip.style.top = Math.max(8, e.clientY - r.height - 12) + 'px';
  }
  const tipYop = () => { if (tip) tip.style.display = 'none'; };

  //  Hodisalar BITTA joyda ulanadi: har markka alohida `onmouseenter`
  //  yozilsa qayta chizilgan grafikda eskilari osilib qolardi.
  function ulash(host) {
    host.addEventListener('mousemove', (e) => {
      const el = e.target.closest('[data-tip]');
      if (el) tipKor(e, el.dataset.tip); else tipYop();
    });
    host.addEventListener('mouseleave', tipYop);
  }

  /* ------------------------------------------------------- KARTOCHKA
   *  Raqam — javobning O'ZI, shuning uchun u yirik turadi; nomi
   *  ustida, izohi ostida mayda yozuvda.
   */
  function kpi(el, items) {
    el.innerHTML = items.filter(Boolean).map((k) => `
      <div class="card pkpi${k.tone ? ' ' + k.tone : ''}">
        <div class="plabel">${esc(k.name)}</div>
        <div class="kpi">${esc(k.value)}</div>
        ${k.hint ? `<div class="muted" style="font-size:12px;margin-top:4px"
          >${esc(k.hint)}</div>` : ''}
      </div>`).join('');
  }

  /* ------------------------------------------------- VAQT BO'YICHA
   *  Ustunli grafik: o'zgarish vaqt bo'yicha o'qiladi.
   *
   *  ★ BO'SH OY HAM USTUN BO'LADI (server `generate_series` bilan
   *  beradi): bo'sh ustun javob, yo'q ustun esa savol — ko'z oylarni
   *  sanab chiqishga majbur bo'lardi.
   *
   *  Qiymat HAR ustunda yozilmaydi — faqat eng kattasida va
   *  oxirgisida: har ustunda raqam bo'lsa grafik jadvalga aylanadi va
   *  shakli ko'rinmay qoladi.
   */
  function bars(el, { rows, key = 'amount', label = oyNom, fmt = pul, name }) {
    const max = Math.max(1, ...rows.map((r) => Number(r[key]) || 0));
    const oxirgi = rows.length - 1;
    const eng = rows.reduce((a, r, i) =>
      (Number(r[key]) || 0) > (Number(rows[a][key]) || 0) ? i : a, 0);
    el.innerHTML = `<div class="pbars" style="--n:${rows.length}">
      ${rows.map((r, i) => {
        const v = Number(r[key]) || 0;
        const h = Math.max(v > 0 ? 3 : 0, Math.round(v / max * 100));
        const yoz = i === eng || (i === oxirgi && oxirgi !== eng);
        return `<div class="pbar" data-tip="<b>${esc(label(r.mon ?? r.name))}</b><br>${
          esc(fmt(v, true))}${r.orders != null
            ? '<br>' + son(r.orders) + ' ta buyurtma' : ''}">
          <div class="pbar-v">${yoz ? esc(fmt(v)) : ''}</div>
          <div class="pbar-col"><i style="height:${h}%"></i></div>
          <div class="pbar-x">${esc(label(r.mon ?? r.name))}</div>
        </div>`;
      }).join('')}
    </div>${name ? `<div class="muted" style="font-size:12px;margin-top:8px">${
      esc(name)}</div>` : ''}`;
    ulash(el);
  }

  /* --------------------------------------------- IKKI QATOR, VAQT
   *  Tushum va harajat — bir xil O'LCHOVDA (dollar), shuning uchun
   *  BITTA o'qda turadi va yonma-yon o'qiladi. Ikkinchi o'q
   *  qo'yilsa ikki qatorning kesishishi tasodifiy joyda chiqib,
   *  «harajat tushumdan oshib ketdi» degan yolg'on javob berardi.
   *
   *  ★ IKKI QATORDA LEGENDA HAR DOIM BO'LADI: rang yolg'iz o'zi
   *  identiklikni ayta olmaydi (rang ko'rmaydigan odam uchun ham,
   *  qora-oq bosmada ham).
   */
  function bars2(el, { rows, a, b, label = oyNom, fmt = pul }) {
    const max = Math.max(1, ...rows.map((r) =>
      Math.max(Number(r[a.key]) || 0, Number(r[b.key]) || 0)));
    const rang = [RANG[0], RANG[2]];
    el.innerHTML = `
      <div class="plegend" style="margin-bottom:10px">
        ${[a, b].map((x, i) => `<span><b style="background:${rang[i]}"></b>${
          esc(x.name)}</span>`).join('')}
      </div>
      <div class="pbars" style="--n:${rows.length}">
        ${rows.map((r) => `
          <div class="pbar" data-tip="<b>${esc(label(r.mon ?? r.name))}</b><br>${
            esc(a.name)}: ${esc(fmt(r[a.key], true))}<br>${
            esc(b.name)}: ${esc(fmt(r[b.key], true))}">
            <div class="pbar-v"></div>
            <div class="pbar-col pbar-2">
              ${[a, b].map((x, i) => `<i style="height:${
                Math.max((Number(r[x.key]) || 0) > 0 ? 3 : 0,
                  Math.round((Number(r[x.key]) || 0) / max * 100))
                }%;background:${rang[i]}"></i>`).join('')}
            </div>
            <div class="pbar-x">${esc(label(r.mon ?? r.name))}</div>
          </div>`).join('')}
      </div>`;
    ulash(el);
  }

  /* ------------------------------------------------------- REYTING
   *  Gorizontal ustun: nomi uzun bo'ladi va tik ustunda o'qilmasdi.
   *  Tartib kattadan kichikka — savol «kim ko'p» degan savol.
   */
  //  ★ NOM YONIDA TURI (zavod qarori, 2026-09). Zavodda bitta nom
  //  IKKI guruhda uchraydi — «Barocco» ham sp, ham penal bo'ladi —
  //  va faqat nomi ko'rinsa ro'yxatda ikkita bir xil qator turardi:
  //  qaysi biri qaysi ekani noaniq qolardi. Xuddi shu qoida
  //  vitrinadan qaytarish hujjatida ham bor.
  //
  //  Turi MAYDA yozuvda, nomning yonida: u nomning bir qismi emas,
  //  uni AJRATADIGAN belgi va qalin bo'lsa ko'z ikkalasini teng
  //  o'qishga urinardi.
  //
  //  `birlik` — o'lchov birligi qatorning O'ZIDAN olinadi: stul
  //  DONA, penal KOMPLEKT va bitta so'zni hammasiga yozib qo'yish
  //  yolg'on bo'lardi.
  function rank(el, { rows, key = 'amount', name = 'name', fmt = pul, hint,
                      tur = 'product_type', birlik }) {
    if (!rows.length) {
      el.innerHTML = '<p class="muted" style="font-size:13px">Ma\'lumot yo\'q.</p>';
      return;
    }
    const max = Math.max(1, ...rows.map((r) => Number(r[key]) || 0));
    const qiy = (r, aniq) => fmt(r[key], aniq)
      + (birlik && r[birlik] ? ' ' + r[birlik] : '');
    el.innerHTML = `<div class="prank">${rows.map((r) => {
      const v = Number(r[key]) || 0;
      const t = tur && r[tur] ? r[tur] : '';
      return `<div class="prow" data-tip="<b>${esc(r[name])}</b>${
        t ? ' <span style=\'opacity:.75\'>\u00b7 ' + esc(t) + '</span>' : ''}<br>${
        esc(qiy(r, true))}${hint && r[hint] != null
          ? '<br>' + esc(son(r[hint])) + ' ta' : ''}">
        <div class="pname">${esc(r[name])}${t
          ? ` <span class="muted" style="font-size:12px">\u00b7 ${esc(t)}</span>` : ''}</div>
        <div class="ptrack"><i style="width:${Math.max(2, v / max * 100)}%"></i></div>
        <div class="pval">${esc(qiy(r))}</div>
      </div>`;
    }).join('')}</div>`;
    ulash(el);
  }

  /* --------------------------------------------------- ULUSH (bitta qator)
   *  Bitta gorizontal chiziq, turlarga bo'lingan. Doira (pie) EMAS:
   *  yonma-yon turgan ikki bo'lakning kattaligini burchakdan farqlash
   *  uzunlikdan farqlashdan ancha qiyin.
   *
   *  Bo'laklar orasida 2px bo'shliq qoladi — aks holda ikki rang
   *  tutashib, chegarasi yo'qolardi.
   */
  function share(el, { rows, key = 'amount', name = 'name', fmt = pul }) {
    const jami = rows.reduce((a, r) => a + (Number(r[key]) || 0), 0);
    if (!jami) {
      el.innerHTML = '<p class="muted" style="font-size:13px">Ma\'lumot yo\'q.</p>';
      return;
    }
    el.innerHTML = `
      <div class="pshare">${rows.map((r, i) => `
        <i style="flex:${Number(r[key]) || 0};background:${RANG[i % RANG.length]}"
           data-tip="<b>${esc(r[name])}</b><br>${esc(fmt(r[key], true))} · ${
             Math.round((Number(r[key]) || 0) / jami * 100)}%"></i>`).join('')}
      </div>
      <div class="plegend">${rows.map((r, i) => `
        <span><b style="background:${RANG[i % RANG.length]}"></b>${esc(r[name])}
          <span class="muted">${esc(fmt(r[key]))}</span></span>`).join('')}
      </div>`;
    ulash(el);
  }

  return { RANG, KUL, pul, son, oyNom, kpi, bars, bars2, rank, share, esc };
})();
