/* Scandi ERP — umumiy klient qatlami: sessiya, huquq, so'rov.
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
          <h2>Scandi ERP</h2>
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
    { href: '/jurnal.html', mod: 'production', nav: 'Jurnal',
      title: 'Ishlab chiqarish jurnali', lead: 'Konveyer raqami bo\'yicha',
      text: "Har mahsulot: bosh sana, K\u2116, Z\u2116, rang, mato, tsex, bo'lim, mijoz, narx, muddatlar",
      perm: ['production.view'] },
    { href: '/qoldiq.html', mod: 'production', nav: "Boshlang'ich qoldiq",
      title: "Boshlang'ich qoldiq", lead: 'Bir martalik kiritish',
      text: "Tizim ishga tushgan kundagi konveyerdagi va T/M omboridagi mahsulotlar",
      perm: ['production.units', 'production.manage'] },
    { href: '/zavod.html', mod: 'reports', nav: 'Zavod',
      title: "Zavod ko'rinishi", lead: 'Nima qayerda',
      text: "Har mahsulot qaysi tsex va bo'limda \u00b7 qachon keyingi tsexga o'tadi \u00b7 qachon omborga kiradi",
      perm: ['production.view'] },
    { href: '/dashboard.html', mod: 'reports', nav: 'Panel',
      title: 'Boshqaruv paneli', lead: "Ko'rsatkichlar",
      text: "Reja/fakt \u00b7 bottleneck \u00b7 komplektlilik \u00b7 umumiy tsex yuklamasi \u00b7 Pareto",
      perm: ['production.view'] },
    { href: '/smena.html', mod: 'production', nav: 'Smena',
      title: 'Smena kiritish', lead: 'Tsex boshliqlari uchun',
      text: "Bir tsexning barcha bo'limlari bo'yicha kunlik ma'lumotni bitta jadvalda kiritish",
      perm: ['production.entry'] },
    { href: '/terminal.html', mod: 'production', nav: 'Terminal',
      title: "Bo'lim terminali", lead: 'Tsex planshetlari',
      text: "Dona qayd etish \u00b7 brak \u00b7 to'xtash \u00b7 kamera partiyasi",
      perm: ['production.entry'] },
    { href: '/mijozlar.html', mod: 'sales', nav: 'Mijozlar',
      title: 'Mijozlar', lead: "Ro'yxat va kanal tahlili",
      text: "Mijoz nomi, region, telefon, kanal \u00b7 qaysi kanal qancha sotuv keltirdi",
      perm: ['production.view', 'sales.view'] },
    { href: '/katalog.html', mod: 'refs', nav: 'Katalog',
      title: 'Katalog', lead: 'Mahsulot nomi va guruhi',
      text: "Fason, guruh va marshrut \u2014 yangi mahsulot qo'shish uchun kod tegilmaydi",
      perm: ['production.manage'] },
    { href: '/sozlamalar.html', mod: 'refs', nav: "Bo'lim quvvati",
      title: "Bo'lim quvvati", lead: 'Muddat bashorati',
      text: "Har bo'limning kunlik quvvati \u2014 muddat hisobi shunga tayanadi",
      perm: ['production.manage'] },
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
    // Qaysi bo'limdamiz: shu sahifaning moduli. Modul rejasi sahifasida esa
    // modul manzildan olinadi — u bitta sahifa bo'lib hammasiga xizmat qiladi.
    const active = here === '/modul.html'
      ? new URLSearchParams(location.search).get('m')
      : (PAGES.find((p) => p.href === here) || {}).mod || null;

    // Xodim faqat o'ziga biriktirilgan bo'limlarni ko'radi. Huquqi yo'q
    // bo'lim umuman chizilmaydi — "rejada" deb ko'rsatish ham ortiqcha:
    // kassirga ishlab chiqarish bo'limi hech qachon kerak bo'lmaydi.
    const mods = MODULES
      .filter((m) => !m.perm.length || can(...m.perm))
      .map((m) => {
        const on = m.code === active ? ' class="on"' : '';
        const first = open.find((p) => p.mod === m.code && p.href);
        if (first) return `<a href="${first.href}"${on}>${m.name}</a>`;
        // Sahifasi yo'q, lekin bo'limlari rejalashtirilgan modul: reja
        // sahifasiga olib boradi — nima kutilayotgani ko'rinib tursin.
        if (open.some((p) => p.mod === m.code))
          return `<a href="/modul.html?m=${m.code}"${on}>${m.name}</a>`;
        return `<span class="soon" title="Bu bo'lim hali yozilmagan">${m.name}</span>`;
      }).join('');

    // Faol bo'limning sahifalari. Bo'limda bitta sahifa bo'lsa ikkinchi
    // qator ortiqcha — ko'rsatilmaydi.
    const sub = active ? open.filter((p) => p.mod === active) : [];
    const subRow = sub.length > 1
      ? `<nav class="nav sub">${sub.map((p) => p.href
          ? `<a href="${p.href}"${p.href === here ? ' class="on"' : ''}>${p.nav}</a>`
          : `<span class="soon" title="Bu bo'lim hali yozilmagan">${p.nav}</span>`).join('')}</nav>`
      : '';

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

  return { api, download, can, start, logout, me: () => me, pages,
           modules: () => MODULES
             .filter((m) => !m.perm.length || can(...m.perm))
             .map((m) => ({ ...m,
               ready: pages().some((p) => p.mod === m.code && p.href) })) };
})();
