/* ZELTA ERP — umumiy klient qatlami: sessiya, huquq, so'rov.
   Har sahifa shuni ulaydi va App.start() bilan boshlaydi. */
const App = (() => {
  const KEY = 'erp.token';
  let me = null;

  const token    = () => localStorage.getItem(KEY);
  const setToken = (t) => t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY);

  async function api(path, opts = {}) {
    const r = await fetch(path, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...(token() ? { Authorization: 'Bearer ' + token() } : {}),
        ...(opts.headers || {}),
      },
    });
    if (r.status === 401) { setToken(null); gate(); throw new Error('Sessiya tugadi'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Xato');
    return j;
  }

  // Fayl yuklab olish. Sessiya tokeni sarlavhada yuboriladi, shuning uchun
  // oddiy havola ishlamaydi — so'rov shu yerdan ketadi va javob brauzerga
  // fayl bo'lib beriladi.
  async function download(path, filename) {
    const r = await fetch(path, {
      headers: token() ? { Authorization: 'Bearer ' + token() } : {},
    });
    if (r.status === 401) { setToken(null); gate(); throw new Error('Sessiya tugadi'); }
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Xato');
    const url = URL.createObjectURL(await r.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // Fayl yuborish. Xom bayt bilan ketadi — JSON ichida base64 qilish
  // hajmni uchdan bir baravar oshiradi va hech qanday foyda bermaydi.
  async function upload(path, file) {
    const r = await fetch(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        ...(token() ? { Authorization: 'Bearer ' + token() } : {}),
      },
      body: file,
    });
    if (r.status === 401) { setToken(null); gate(); throw new Error('Sessiya tugadi'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Xato');
    return j;
  }

  const can = (...p) => !!me && p.some((x) => me.permissions.includes(x));

  async function logout() {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
    setToken(null);
    location.reload();
  }

  // Kirish ekrani. Telegram Mini App ichida ochilsa PIN so'ralmaydi —
  // xodim initData imzosi orqali aniqlanadi.
  function gate(message) {
    document.body.insertAdjacentHTML('beforeend', `
      <div class="overlay" id="erpGate">
        <div class="modal" style="max-width:360px">
          <h2>ZELTA ERP</h2>
          <p class="muted" style="margin:8px 0 18px">Kirish uchun PIN kodingizni kiriting</p>
          ${message ? `<p class="tag bad" style="display:block;margin-bottom:12px">${message}</p>` : ''}
          <input id="erpPin" type="tel" inputmode="numeric" maxlength="6" placeholder="••••"
                 style="font-size:28px;text-align:center;letter-spacing:.4em">
          <button class="primary" style="width:100%;margin-top:14px" id="erpGo">Kirish</button>
        </div>
      </div>`);
    const go = async () => {
      try {
        const r = await api('/api/auth/pin',
          { method: 'POST', body: JSON.stringify({ pin: document.getElementById('erpPin').value }) });
        setToken(r.token);
        location.reload();
      } catch (e) {
        const g = document.getElementById('erpGate');
        if (g) g.remove();
        gate(e.message);
      }
    };
    document.getElementById('erpGo').onclick = go;
    document.getElementById('erpPin').onkeydown = (e) => { if (e.key === 'Enter') go(); };
    document.getElementById('erpPin').focus();
  }

  // Telegram Mini App ichida bo'lsa avtomatik kirish
  async function tryTelegram() {
    const tg = window.Telegram?.WebApp;
    if (!tg?.initData) return false;
    try {
      const r = await api('/api/auth/telegram',
        { method: 'POST', body: JSON.stringify({ initData: tg.initData }) });
      setToken(r.token);
      me = r.user;
      return true;
    } catch { return false; }
  }



  // ASOSIY BO'LIMLAR — saytning yuqori qatori.
  //
  // Tartib zavod ishiga qarab: pul, sotuv, ombor, ishlab chiqarish, mulk.
  // Modul "tayyor" deb hisoblanadi, agar unga tegishli sahifa bo'lsa —
  // alohida bayroq yuritilmaydi, chunki u ro'yxatdan ajralib ketardi.
  //
  // Hali yozilmagan modul ham ko'rinadi: rahbar tizim qayerga o'sishini
  // ko'rib tursin. Bosilmaydi va "rejada" deb belgilanadi — ochilmaydigan
  // havola ochilmaydigan havoladan yomonroq.
  // Modul ro'yxati BITTA joyda: menyu ham, bosh sahifadagi kartochkalar ham
  // shundan chiziladi. Ilgari nomlar bu yerda ham, server.js da ham yozilgan
  // edi — natijada bitta modul bitta ekranda ikki xil atalardi
  // ("Sotib olish" / "Ta'minot"). Endi nom faqat shu ro'yxatda.
  //
  //   perm  — bo'sh bo'lsa hammaga ochiq; aks holda sanalganidan bittasi yetarli.
  //
  // "Ishlayaptimi yoki rejadami" bu yerda yozilmaydi — u sahifalar
  // ro'yxatidan chiqadi: moduldan xodimga ochiq sahifa bo'lsa, modul
  // ishlayapti. Shu sabab menyu bilan bosh sahifadagi kartochka hech qachon
  // qarama-qarshi bo'lmaydi: kulrang modul kartochkada ham "rejada" turadi.
  const MODULES = [
    { code: 'main',       name: 'Bosh sahifa',          perm: [] },
    { code: 'cash',       name: 'Bank va kassa',        perm: ['cash.view', 'cash.entry', 'cash.manage'] },
    { code: 'sales',      name: 'Savdo',                perm: ['sales.view', 'sales.manage'] },
    { code: 'purchasing', name: "Ta'minot",             perm: ['purchasing.view', 'purchasing.manage'] },
    { code: 'warehouse',  name: 'Ombor',                perm: ['warehouse.view', 'warehouse.move', 'warehouse.manage'] },
    { code: 'production', name: 'Ishlab chiqarish',     perm: ['production.view', 'production.entry', 'production.units', 'production.manage'] },
    { code: 'assets',     name: 'Asosiy vositalar',     perm: ['assets.view', 'assets.manage'] },
    { code: 'payroll',    name: 'Xodimlar va ish haqi', perm: ['payroll.view', 'payroll.manage', 'admin.users'] },
    { code: 'reports',    name: 'Hisobotlar',           perm: ['production.view'] },
    { code: 'refs',       name: "Ma'lumotnomalar",      perm: ['production.manage'] },
  ];


  // Sahifalar ro'yxati BITTA joyda: har sahifadagi navigatsiya ham, bosh
  // sahifadagi kartochkalar ham shundan chiziladi. Yangi sahifa qo'shilganda
  // shu ro'yxatga bitta qator qo'shiladi, qolgani o'zi ishlaydi.
  //
  // perm bo'sh bo'lsa sahifa hammaga ochiq; aks holda sanab o'tilgan
  // huquqlardan bittasi yetarli.
  const PAGES = [
    { href: '/', mod: 'main', nav: 'Bosh sahifa', perm: [] },
    { href: '/harakat.html', mod: 'production', nav: "Bo'limlar aro harakat",
      title: "Bo'limlar aro harakat", lead: 'Tsex boshlig\'ining ekrani',
      text: "Konverlar bo'limlar bo'yicha \u00b7 bitta bosishda keyingi bo'limga \u00b7 keyingi tsexga topshirishga qancha qolgani \u00b7 bugungi harakatlar lentasi",
      perm: ['production.view', 'production.entry'] },
    { href: '/jurnal.html', mod: 'production', nav: 'Jurnal',
      title: 'Ishlab chiqarish jurnali', lead: 'Konveyer raqami bo\'yicha',
      text: "Har mahsulot: bosh sana, K\u2116, Z\u2116, rang, mato, tsex, bo'lim, mijoz, narx, muddatlar",
      perm: ['production.view'] },
    { href: '/qoldiq.html', mod: 'production', nav: "Boshlang'ich qoldiq",
      title: "Boshlang'ich qoldiq", lead: 'Bir martalik kiritish',
      text: "Tizim ishga tushgan kundagi konveyerdagi va T/M omboridagi mahsulotlar",
      perm: ['production.units', 'production.manage'] },
    { href: '/zavod.html', mod: 'reports', nav: 'Zavod',
      group: 'Ishlab chiqarish hisobotlari',
      title: "Zavod ko'rinishi", lead: 'Nima qayerda',
      text: "Har mahsulot qaysi tsex va bo'limda \u00b7 qachon keyingi tsexga o'tadi \u00b7 qachon omborga kiradi",
      perm: ['production.view'] },
    { href: '/dashboard.html', mod: 'reports', nav: 'Panel',
      group: 'Ishlab chiqarish hisobotlari',
      title: 'Boshqaruv paneli', lead: "Ko'rsatkichlar",
      text: "Reja/fakt \u00b7 bottleneck \u00b7 komplektlilik \u00b7 umumiy tsex yuklamasi \u00b7 Pareto",
      perm: ['production.view'] },
    // Smena va Terminal menyudan olib tashlangan. Sahifalar va API joyida —
    // manzil bilan ochiladi, qaytarish uchun shu qatorlarni izohdan
    // chiqarish kifoya:
    //
    //   { href: '/smena.html', mod: 'production', nav: 'Smena',
    //     title: 'Smena kiritish', lead: 'Tsex boshliqlari uchun',
    //     text: "Bir tsexning barcha bo'limlari bo'yicha kunlik ma'lumotni bitta jadvalda kiritish",
    //     perm: ['production.entry'] },
    //   { href: '/terminal.html', mod: 'production', nav: 'Terminal',
    //     title: "Bo'lim terminali", lead: 'Tsex planshetlari',
    //     text: "Dona qayd etish · brak · to'xtash · kamera partiyasi",
    //     perm: ['production.entry'] },
    //
    // Jamlanma kiritish shu ikki sahifadan bo'lardi. Ularsiz ishlab
    // chiqarish jurnal orqali yuritiladi: birlik "O'tkazish" bilan
    // marshrutdagi keyingi bo'limga o'tadi va jamlanma yozuv ham
    // o'sha yerda yoziladi.
    { href: '/mijozlar.html', mod: ['sales', 'refs'], nav: 'Mijozlar',
      title: 'Mijozlar', lead: "Ro'yxat va kanal tahlili",
      text: "Mijoz nomi, region, telefon, kanal \u00b7 qaysi kanal qancha sotuv keltirdi",
      perm: ['production.view', 'sales.view'] },
    { href: '/taminotchilar.html', mod: ['purchasing', 'refs'], nav: "Ta'minotchilar",
      title: "Ta'minotchilar", lead: "Kimdan sotib olinadi",
      text: "Nomi, yo'nalishi, region, telefon, STIR, mas'ul xodim \u00b7 kirim hujjati va qarzdorlik shunga tayanadi",
      perm: ['purchasing.view', 'purchasing.manage'] },
    { href: '/katalog.html', mod: 'refs', nav: 'Katalog',
      title: 'Katalog', lead: 'Mahsulot nomi va guruhi',
      text: "Fason, guruh va marshrut \u2014 yangi mahsulot qo'shish uchun kod tegilmaydi",
      perm: ['production.manage'] },
    // Bo'lim quvvati menyudan olib tashlangan. Sahifaning o'zi
    // (`sozlamalar.html`) va API joyida — kerak bo'lganda shu qatorni
    // izohdan chiqarish kifoya:
    //
    //   { href: '/sozlamalar.html', mod: 'refs', nav: "Bo'lim quvvati",
    //     title: "Bo'lim quvvati", lead: 'Muddat bashorati',
    //     text: "Har bo'limning kunlik quvvati — muddat hisobi shunga tayanadi",
    //     perm: ['production.manage'] },
    //
    // Quvvatsiz muddat `taxmin` ustunlari bo'sh qoladi; `reja` (tsex
    // boshlig'i qo'lda qo'ygan) va `fakt` (tizim yozgan) sanalar
    // o'zgarishsiz ishlayveradi.
    { href: '/xodimlar.html', mod: 'payroll', nav: 'Xodimlar',
      title: 'Xodimlar', lead: 'Rollar va kirish',
      text: "Xodim qo'shish, PIN berish, rol va tsex biriktirish",
      perm: ['admin.users'] },

    // ─────────────────────────────────────────── HALI YOZILMAGAN BO'LIMLAR
    //
    //  Sahifasi yo'q bo'lim ham ro'yxatda turadi: `href` bo'lmasa menyuda
    //  kulrang, bosilmaydigan bo'lib chiqadi. Tizim qanday o'sishi
    //  ko'rinib tursin — xodim ham, ishlab chiquvchi ham qayerda nima
    //  turishini oldindan biladi.
    //
    //  Bo'lim yozilganda shu qatorga `href`, `title`, `lead` va `text`
    //  qo'shiladi, boshqa hech narsa o'zgartirilmaydi.

    // Savdo
    { mod: 'sales', nav: 'Buyurtmalar',                 perm: ['sales.view'] },
    { mod: 'sales', nav: 'Buyurtma shakllantirish',     perm: ['sales.manage'] },
    { mod: 'sales', nav: 'Buyurtmalar arxivi',          perm: ['sales.view'] },
    { mod: 'sales', nav: "O'chirilgan buyurtmalar",     perm: ['sales.manage'] },
    { mod: 'sales', nav: 'Qaytib olish (mijozdan)',     perm: ['sales.manage'] },
    // Ikkalasi bir xil narsani anglatib qolmasin: dalolatnoma — mijoz bilan
    // imzolanadigan hujjat, qarzdorlik — kim qancha qarzda degan hisobot.
    { mod: 'sales', nav: 'Solishtirma dalolatnoma',     perm: ['sales.view'] },
    { mod: 'sales', nav: 'Qarzdorlik',                  perm: ['sales.view'] },

    // Ta'minot
    { mod: 'purchasing', nav: 'Xaridlar',                          perm: ['purchasing.view'] },
    { mod: 'purchasing', nav: 'Kirim shakllantirish',              perm: ['purchasing.manage'] },
    { mod: 'purchasing', nav: 'Kirimlar arxivi',                   perm: ['purchasing.view'] },
    { mod: 'purchasing', nav: "O'chirilgan kirimlar",              perm: ['purchasing.manage'] },
    { mod: 'purchasing', nav: "Qaytarib berish (ta'minotchiga)",   perm: ['purchasing.manage'] },
    { mod: 'purchasing', nav: 'Solishtirma dalolatnoma',           perm: ['purchasing.view'] },
    { mod: 'purchasing', nav: 'Qarzdorlik',                        perm: ['purchasing.view'] },

    // Ombor
    { mod: 'warehouse', nav: 'Omborlar',                perm: ['warehouse.view'] },
    { mod: 'warehouse', nav: 'Omborga kirim',           perm: ['warehouse.move'] },
    { mod: 'warehouse', nav: 'Qoldiqlar',               perm: ['warehouse.view'] },
    { mod: 'warehouse', nav: 'Hisobdan chiqarish',      perm: ['warehouse.manage'] },
    { mod: 'warehouse', nav: 'Omborlar aro harakatlar', perm: ['warehouse.move'] },

    // Hisobotlar
    { mod: 'reports', nav: 'Moliyaviy hisobotlar', perm: ['cash.view', 'production.manage'] },
    { mod: 'reports', nav: 'Savdo hisobotlari',    perm: ['sales.view', 'production.view'] },
    { mod: 'reports', nav: 'Ombor va tovarlar',    perm: ['warehouse.view', 'production.view'] },
  ];

  // Sahifa bir nechta modulda turishi mumkin: `mod` ro'yxat bo'lsa, u har
  // birida ko'rinadi. Mijozlar shunday — savdo uchun ham kerak,
  // ma'lumotnoma sifatida ham.
  const inMod = (p, code) => Array.isArray(p.mod) ? p.mod.includes(code) : p.mod === code;

  // Bir nechta modulda turgan sahifaga qaysi bo'limdan kirilgani manzilga
  // yoziladi — shunda menyu o'sha bo'limni yoqib turadi.
  const hrefFor = (p, code) => Array.isArray(p.mod) ? `${p.href}?m=${code}` : p.href;

  // Xodimga ochiq sahifalar
  const pages = () => PAGES.filter((p) => !p.perm.length || can(...p.perm));

  // Har sahifada bir xil navigatsiya: yuqorida asosiy bo'limlar, ostida
  // shu bo'limning sahifalari. Ilgari sahifalar bir-biriga bog'lanmagan edi
  // va har biriga alohida manzil bilan kirilardi — xodim uchun bu ishlamaydi.
  function drawNav() {
    const top = document.querySelector('.top');
    if (!top || document.querySelector('.nav')) return;

    const here = location.pathname === '/index.html' ? '/' : location.pathname;
    const open = pages();
    // Qaysi bo'limdamiz. Manzildagi `?m=` ustuvor: modul rejasi sahifasi ham,
    // bir nechta modulda turgan sahifa ham qaysi bo'limdan kirilganini
    // shu bilan aytadi.
    const q = new URLSearchParams(location.search).get('m');
    const cur = PAGES.find((p) => p.href === here);
    const active = (q && MODULES.some((m) => m.code === q)) ? q
      : cur ? (Array.isArray(cur.mod) ? cur.mod[0] : cur.mod) : null;

    // Xodim faqat o'ziga biriktirilgan bo'limlarni ko'radi. Huquqi yo'q
    // bo'lim umuman chizilmaydi — "rejada" deb ko'rsatish ham ortiqcha:
    // kassirga ishlab chiqarish bo'limi hech qachon kerak bo'lmaydi.
    const mods = MODULES
      .filter((m) => !m.perm.length || can(...m.perm))
      .map((m) => {
        const on = m.code === active ? ' class="on"' : '';
        const first = open.find((p) => inMod(p, m.code) && p.href);
        if (first) return `<a href="${hrefFor(first, m.code)}"${on}>${m.name}</a>`;
        // Sahifasi yo'q, lekin bo'limlari rejalashtirilgan modul: reja
        // sahifasiga olib boradi — nima kutilayotgani ko'rinib tursin.
        if (open.some((p) => inMod(p, m.code)))
          return `<a href="/modul.html?m=${m.code}"${on}>${m.name}</a>`;
        return `<span class="soon" title="Bu bo'lim hali yozilmagan">${m.name}</span>`;
      }).join('');

    // Faol bo'limning sahifalari. Bo'limda bitta sahifa bo'lsa ikkinchi
    // qator ortiqcha — ko'rsatilmaydi.
    // Ostki qatorda faqat yozilgan sahifalar. Rejadagilar bu yerda ham
    // ko'rsatilsa, modul sahifasidagi ro'yxatni ikkinchi marta takrorlab
    // qo'yardi — ular "Bo'limlar" havolasi ortida, bir joyda turadi.
    const sub = active ? open.filter((p) => inMod(p, active) && p.href) : [];
    const plan = active && open.some((p) => inMod(p, active) && !p.href)
      ? `<a href="/modul.html?m=${active}"${here === '/modul.html' ? ' class="on"' : ''}>Bo'limlar</a>`
      : '';
    const links = sub.map((p) =>
      `<a href="${hrefFor(p, active)}"${p.href === here ? ' class="on"' : ''}>${p.nav}</a>`).join('');
    const subRow = (sub.length + (plan ? 1 : 0)) > 1
      ? `<nav class="nav sub">${links}${plan}</nav>` : '';

    top.insertAdjacentHTML('afterend', `<nav class="nav mods">${mods}</nav>${subRow}`);

    // Sarlavha bosh sahifaga olib borsin — odam avval shuni bosadi
    const brand = top.querySelector('.brand');
    if (brand && here !== '/') {
      brand.style.cursor = 'pointer';
      brand.onclick = () => { location.href = '/'; };
    }
  }

  // Sahifa shu bilan boshlanadi:
  //   App.start(me => { ... }, 'production.view')
  async function start(onReady, ...required) {
    if (!me && token()) { try { me = await api('/api/auth/me'); } catch { me = null; } }
    if (!me) await tryTelegram();
    if (!me) return gate();

    if (required.length && !can(...required)) {
      document.body.innerHTML =
        `<div class="card" style="max-width:420px;margin:80px auto;text-align:center">
           <h2>Ruxsat yo'q</h2>
           <p class="muted" style="margin:10px 0 18px">Bu bo'lim sizning rolingizga ochiq emas.</p>
           <button onclick="App.logout()">Boshqa hisob bilan kirish</button></div>`;
      return;
    }
    // Sarlavhadagi foydalanuvchi paneli
    const slot = document.getElementById('erpUser');
    if (slot) slot.innerHTML =
      `<span class="muted">${me.name}${me.roles[0] ? ' · ' + me.roles[0].name : ''}</span>
       <button onclick="App.logout()">Chiqish</button>`;
    drawNav();
    onReady(me);
  }

  return { api, download, upload, can, start, logout, me: () => me, pages, inMod, hrefFor,
           modules: () => MODULES
             .filter((m) => !m.perm.length || can(...m.perm))
             .map((m) => ({ ...m,
               ready: pages().some((p) => inMod(p, m.code) && p.href) })) };
})();

// Telefonga o'rnatish. Xizmat ishchisi ro'yxatdan o'tgach brauzer ZELTA ni
// alohida ilova sifatida bosh ekranga qo'sha oladi: xodim manzil yozmaydi,
// brauzer paneli ko'rinmaydi. Ro'yxatdan o'tmasa ham sayt ishlayveradi —
// shuning uchun xatosi jim yutiladi.
if ('serviceWorker' in navigator && location.protocol === 'https:')
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
