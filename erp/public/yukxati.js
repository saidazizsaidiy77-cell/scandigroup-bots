// ============================================================================
//  YUK XATI — hujjatning YAGONA manbai
//
//  Uni ikki joy chizadi: savdo menejeri buyurtmani ochganda
//  (`buyurtmalar.html`) va ombor mudiri chop etganda (`yukxati.html`).
//  Ikkalasida bir xil bo'lishi kerak — shuning uchun matni ham,
//  tartibi ham shu faylda, ikki nusxada emas.
//
//  Qog'ozda:
//      tepada    korxona nomi va «Yuk xati № … · sana»
//      chapda    YETKAZIB BERUVCHI: korxona, menejer, telefoni
//      o'ngda    MIJOZ: nomi, regioni, qayerga, kutib oluvchi raqami
//      qatorlar  mahsulot · rangi · matosi · soni · narxi · summasi
//      pastda    ikki imzo: chiqarib yuboruvchi (ombor mudiri) va
//                qabul qilib oluvchi
//
//  Korxona nomi shu yerda: u mijoz ma'lumoti emas, zavodning o'z nomi
//  (CLAUDE.md 4-qoidasi mijoz ismi va telefoni haqida). O'zgarsa shu
//  bitta qator tahrirlanadi.
window.Waybill = (() => {
  const FIRMA = 'ZELTA PREMIUM';

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const money = (v) => {
    const x = Number(v) || 0;
    const [i, f] = (Math.abs(x) < 1e15 ? x.toFixed(2) : String(x)).split('.');
    const g = i.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return f && f !== '00' ? `${g}.${f}` : g;
  };
  const d8 = (v) => !v ? '—'
    : ((s) => `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(2, 4)}`)(String(v).slice(0, 10));

  //  Chiqarib yuboruvchi: tasdiqlagan bo'lsa AYNAN o'sha odam, hali
  //  tasdiqlamagan bo'lsa ombor mudiri — hujjat mahsulot berilayotganda
  //  chop etiladi, tasdiq esa keyin bosiladi.
  const dispatcher = (o, keeper) => o.shipped_by_name
    ? { name: o.shipped_by_name, phone: o.shipped_by_phone }
    : (keeper || null);

  //  `balance` — faqat EKRANDA: yuk xati mijozning qo'liga beriladi va
  //  u yerda korxonaning ichki hisobi yozilib turishi shart emas.
  function html({ order: o, items = [], keeper = null, balance = null }) {
    const kim = dispatcher(o, keeper);
    const jami = items.reduce((a, it) =>
      a + (Number(it.qty) || 0) * (Number(it.unit_price) || 0), 0);

    return `
      <div class="card">
        <div class="doc-top">
          <div class="doc-firm">${esc(FIRMA)}</div>
          <div class="doc-no">Yuk xati &#8470; <b>${esc(o.order_no)}</b>
            <span class="muted"> · ${d8(o.ordered_on)}</span></div>
          ${o.due_on ? `<div class="muted" style="font-size:13px;margin-top:2px"
            >chiqib ketish sanasi: ${d8(o.due_on)}</div>` : ''}
        </div>
        <!--  Chapda YETKAZIB BERUVCHI, o'ngda MIJOZ — zavod yuk xatini
              shunday yozadi. -->
        <div class="doc-parties">
          <div>
            <h3>Yetkazib beruvchi</h3>
            <div class="who">${esc(FIRMA)}</div>
            ${o.manager_name ? `<p>${esc(o.manager_name)}</p>` : ''}
            ${o.manager_phone ? `<p class="muted">${esc(o.manager_phone)}</p>` : ''}
          </div>
          <div class="r">
            <h3>Mijoz</h3>
            <div class="who">${esc(o.customer_name || '')}</div>
            ${o.region ? `<p class="muted">${esc(o.region)}</p>` : ''}
            ${o.ship_to_name ? `<p>${esc(o.ship_to_name)}${
              o.address ? ` · ${esc(o.address)}` : ''}</p>` : ''}
            ${o.receiver_phone ? `<p>Kutib oluvchi: ${esc(o.receiver_phone)}</p>` : ''}
            ${Number(balance) > 0 ? `<p class="muted no-print" style="font-size:12px"
              >balans: ${money(balance)} $ qarz</p>` : ''}
          </div>
        </div>
        ${o.note ? `<p class="muted" style="margin-top:18px;font-size:13px"
          >Izoh: ${esc(o.note)}</p>` : ''}
      </div>

      <div class="card">
        <h2>Qatorlar</h2>
        <div style="overflow-x:auto"><table style="table-layout:fixed;min-width:720px">
          <colgroup>
            <col style="width:34%"><col style="width:16%"><col style="width:16%">
            <col style="width:8%"><col style="width:13%"><col style="width:13%">
          </colgroup>
          <thead><tr><th>Mahsulot</th><th>Rangi</th><th>Matosi</th>
            <th class="num">Soni</th><th class="num">Narx, $</th>
            <th class="num">Summa, $</th></tr></thead>
          <tbody>${items.length ? items.map((it) => {
            const summa = (Number(it.qty) || 0) * (Number(it.unit_price) || 0);
            return `<tr>
              <td><b>${esc(it.product || '—')}</b>${it.product_type
                ? ` <span class="muted">· ${esc(it.product_type)}</span>` : ''}</td>
              <td>${it.color ? esc(it.color) : '<span class="muted">—</span>'}</td>
              <td>${it.fabric ? esc(it.fabric) : '<span class="muted">—</span>'}</td>
              <td class="num"><b>${it.qty}</b> <span class="muted"
                style="font-size:11px">${esc(it.uom || '')}</span></td>
              <td class="num">${Number(it.unit_price)
                ? money(it.unit_price) : '<span class="muted">—</span>'}</td>
              <td class="num">${summa ? `<b>${money(summa)}</b>`
                : '<span class="muted">—</span>'}</td>
            </tr>`;
          }).join('') : `<tr><td class="muted" colspan="6">Qator yo'q</td></tr>`}</tbody>
          ${jami ? `<tfoot><tr><td colspan="5"><b>Jami</b></td>
            <td class="num"><b>${money(jami)}</b></td></tr></tfoot>` : ''}
        </table></div>

        <div class="doc-sign">
          <div>
            <div class="line">${kim && kim.name
              ? `<span>${esc(kim.name)}${kim.phone
                  ? ` <span class="muted">${esc(kim.phone)}</span>` : ''}</span>` : ''}</div>
            <small>Chiqarib yuboruvchi — ombor mudiri, imzo</small></div>
          <div><div class="line"></div>
            <small>Qabul qilib oluvchi — F.I.O., imzo</small></div>
        </div>
      </div>`;
  }

  return { html, FIRMA };
})();
