# Scandi ERP

Zavod uchun modulli boshqaruv tizimi. Yadro bitta: bitta baza, bitta API,
bitta rol/huquq tizimi. Modullar shu yadroga ulanadi.

Bugun **ishlab chiqarish** moduli ishlaydi. Ombor, ta'minot, savdo, kassa va
maosh modullari uchun huquqlar, rollar va ulanish nuqtasi allaqachon tayyor.

## Uchta ko'rinish, bitta backend

Kod bitta, interfeys uch xil — kim qayerda ishlashiga qarab:

| Ko'rinish | Kim uchun | Qanday ishlaydi |
|---|---|---|
| **Sayt** (brauzer) | Direktor, buxgalter, kassir, ta'minotchi, sotuvchi | PIN bilan kirish, kompyuter yoki planshet |
| **Telegram Mini App** | Tsex ustasi, operator, omborchi | Bot ichida ochiladi, parol so'ralmaydi — Telegram imzosi orqali tanib olinadi |
| **Bot xabarlari** | Kim faqat xabar olishi kerak | Interfeys yo'q, `notifications` navbatidan xabar keladi |

Rolning ko'rinishi `roles.surface` da yozilgan, ya'ni yangi lavozim qo'shilganda
qaysi ko'rinishda ishlashi ham shu yerda belgilanadi.

Mini App uchun sahifa oddiy sayt sahifasining o'zi: `telegram-web-app.js` ulangan
va `App.start()` Telegram ichida ochilganini sezsa `initData` imzosini serverga
yuboradi (`POST /api/auth/telegram`), server HMAC bilan tekshirib xodimni
`workers.tg_id` bo'yicha topadi. Mavjud `hr-bot.js` dagi Mini App mexanizmi
bilan bir xil.

## Huquqlar

Huquq **rolga emas, amalga** beriladi. Rol — huquqlar to'plami.

```
permissions        production.entry, cash.manage, payroll.view ...
roles              tsex_usta, kassir, buxgalter, direktor ...
role_permissions   rol → huquqlar
worker_roles       xodim → rol (+ tsex/yo'nalish doirasi)
```

API tomonida bitta qator yetarli:

```js
router.post('/flow', need('production.entry'), handler)
```

Tayyor rollar:

| Rol | Nima qila oladi |
|---|---|
| `admin` | hammasi |
| `direktor` | hamma hisobotni ko'radi |
| `ishlab_boshl` | ishlab chiqarish to'liq: jurnal, marshrut, quvvat |
| **`kirituvchi`** | **jurnal va qoldiqni to'ldiradi; sozlamalarga tegmaydi** |
| `tsex_usta` | o'z tsexida dona qayd etadi |
| `operator` | faqat bo'lim terminali |
| `sotuvchi` | zakaz, mijoz, narx |
| `kassir`, `buxgalter`, `omborchi`, `taminotchi`, `hr` | keyingi modullar uchun tayyor |

Yangi lavozim paydo bo'lsa — yangi rol yaratiladi, **kod tegilmaydi**.
`worker_roles.scope_shop_id` rolni bitta tsex bilan cheklaydi: Korpus ustasi
terminalda faqat o'z tsexini ko'radi.

Kim nima yozgani ham klientdan olinmaydi — sessiyadan olinadi. Terminal boshqa
xodim nomidan yozuv kirita olmaydi.

## Struktura

```
erp/
  server.js            kirish nuqtasi, modullarni ulaydi
  db.js                baza, xatolik ushlagichi, audit
  auth.js              sessiya, PIN, Telegram imzosi, huquq guard'i
  notify.js            bot xabarlari navbati
  modules/
    production.js      ishlab chiqarish API (jamlanma hisob)
    units.js           konveyer jurnali va mijozlar
    admin.js           xodimlar va rollar
    shift.js           smenani mahsulot yo'nalishidan aniqlash
  sql/
    core.sql           xodim, rol, huquq, sessiya, audit, bildirishnoma
    core-seed.sql      huquqlar va rollar
    production.sql     ishlab chiqarish jadvallari va hisobot view'lari
    production-seed.sql tsexlar, bo'limlar, marshrutlar
    catalog-groups.sql  mahsulot guruhlari: penal, kamod, sp, stol, stul
    production-sku.sql  fason va SKU katalogi
    units.sql          konveyer jurnali: birlik, harakat, mijoz, kanal
  public/
    app.js             klient: sessiya, huquq, so'rov
    index.html         modullar menyusi
    modul.html         modul bo'limlari: yozilgani va rejadagisi
    jurnal.html        ishlab chiqarish jurnali
    qoldiq.html        boshlang'ich qoldiq
    mijozlar.html      mijozlar va kanal tahlili
    zavod.html         zavod ko'rinishi
    dashboard.html     ko'rsatkichlar paneli
    smena.html         tsex boshlig'ining kiritish jadvali
    terminal.html      tsex terminali
```

### Yangi modul qo'shish

1. `sql/<modul>.sql` — jadvallar.
2. `modules/<modul>.js` — `express.Router`, har yo'lda `need('<modul>.<amal>')`.
3. `server.js` da bitta qator: `app.use('/api/<modul>', require('./modules/<modul>'))`.
4. Huquqlar `sql/core-seed.sql` da allaqachon bor — rolga biriktirish kifoya.

Pul yoki ombor tegadigan amallarda `audit(req, {...})` chaqiriladi.

## Modullar

Modul nomi va bo'limlar ro'yxati bitta joyda — `public/app.js` dagi `MODULES`
va `PAGES`. Menyu ham, bosh sahifadagi kartochkalar ham shundan chiziladi.
"Ishlayaptimi yoki rejadami" alohida yozilmaydi: moduldan xodimga ochiq
sahifa bo'lsa — ishlayapti. Shuning uchun menyu bilan kartochka hech qachon
qarama-qarshi bo'lmaydi.

**Hali yozilmagan bo'lim ham ro'yxatda turadi** — `href` siz. U menyuda
ko'rsatilmaydi (aks holda modul sahifasidagi ro'yxatni ikkinchi marta
takrorlardi), balki "Bo'limlar" havolasi ortida, `modul.html` da "rejada"
belgisi bilan turadi. Zavod tizim qanday o'sishini oldindan ko'rib turadi,
kelishilgan tarkib esa bir joyda yozilib qoladi. Bo'lim yozilganda o'sha
qatorga `href`, `title`, `lead` va `text` qo'shiladi — boshqa hech narsa
o'zgartirilmaydi.

Ikkita ixtiyoriy maydon bor. `mod` ro'yxat bo'lsa sahifa bir nechta modulda
turadi — Mijozlar shunday: savdo uchun ham kerak, ma'lumotnoma sifatida ham
(qaysi bo'limdan kirilgani manzildagi `?m=` da qoladi, shunda menyu o'sha
bo'limni yoqib turadi). `group` esa modul ichida toifa yasaydi — Hisobotlarda
"Ishlab chiqarish hisobotlari" shunday.

`modul.html` bitta sahifa bo'lib hamma modulga xizmat qiladi: `?m=<kod>` bilan
ochiladi va bo'limlar ro'yxatini `PAGES` dan chizadi. Sahifasi bor modul
menyudan to'g'ridan-to'g'ri o'sha sahifaga kiradi, sahifasi yo'q moduli esa
shu reja sahifasiga.

### Bo'limlar tarkibi

| Modul | Bo'limlar |
|---|---|
| **Savdo** | Mijozlar ✅ (ma'lumotnomalarda ham) · Buyurtmalar · Buyurtma shakllantirish · Buyurtmalar arxivi · O'chirilgan buyurtmalar · Qaytib olish (mijozdan) · Solishtirma dalolatnoma · Qarzdorlik |
| **Ta'minot** | Xaridlar · Kirim shakllantirish · Kirimlar arxivi · O'chirilgan kirimlar · Qaytarib berish (ta'minotchiga) · Solishtirma dalolatnoma · Qarzdorlik |
| **Ombor** | Omborlar · Omborga kirim · Qoldiqlar · Hisobdan chiqarish · Omborlar aro harakatlar |
| **Ishlab chiqarish** | Jurnal ✅ · Boshlang'ich qoldiq ✅ · Smena ✅ · Terminal ✅ |
| **Hisobotlar** | Ishlab chiqarish hisobotlari: Zavod ko'rinishi ✅ · Boshqaruv paneli ✅ — hamda Moliyaviy hisobotlar · Savdo hisobotlari · Ombor va tovarlar |
| **Ma'lumotnomalar** | Mijozlar ✅ (savdoda ham) · Katalog ✅ |
| **Xodimlar va ish haqi** | Xodimlar ✅ |
| **Bank va kassa** | tarkibi hali kelishilmagan |

**Solishtirma dalolatnoma** va **Qarzdorlik** — ikki xil narsa, shuning uchun
nomlari ham ikki xil: birinchisi mijoz yoki ta'minotchi bilan imzolanadigan
hujjat, ikkinchisi kim qancha qarzda degan hisobot.

| Modul | Holat | Nima bo'ladi |
|---|---|---|
| **Ishlab chiqarish** | ✅ ishlayapti | Tsex/bo'lim, marshrut, WIP, komplektlilik, muddat bashorati |
| **Savdo** | ⚙️ qisman | Mijozlar va kanal tahlili bor; zakaz, jo'natma, debitorlik rejada |
| **Hisobotlar** | ✅ ishlayapti | Zavod ko'rinishi, boshqaruv paneli |
| **Ma'lumotnomalar** | ✅ ishlayapti | Katalog |
| **Xodimlar va ish haqi** | ⚙️ qisman | Xodim, rol va PIN bor; davomat, ishbay hisob, to'lov rejada |
| **Ombor** | rejada | Xom ashyo va tayyor mahsulot: kirim, chiqim, qoldiq, inventarizatsiya |
| **Ta'minot** | rejada | Ta'minotchilar, buyurtmalar, kirim hujjatlari, qarzdorlik |
| **Bank va kassa** | rejada | Kirim/chiqim, kun yopish, hisobotlar |
| **Asosiy vositalar** | rejada | `assets.*` huquqlari hali yaratilmagan — modul menyuda ko'rinmaydi |

Ishlab chiqarish moduli maosh uchun poydevorni allaqachon yozib boradi:
`flow_log` da kim, qaysi bo'limda, nechta dona qilgani turadi — ishbay
maosh aynan shundan hisoblanadi.

---

# Ishlab chiqarish moduli

## Ierarxiya

```
TSEX  →  BO'LIM  →  (mahsulot marshruti)
```

| Tsex | Bo'limlar |
|---|---|
| **Korpus** | Arra · Rover · Press · Freza · Zborka · Shkurka · Kromka · Prisadka |
| **Bo'yoqlash** *(umumiy)* | Astar sepish 1 · Astar shkurka · Astar sepish 2 · Aboy · Grunt sepish · Grunt shkurka · Rang sepish · Lak · Palirovka |
| **Qadoqlash** | Oyna qo'yish · Qadoqlash |
| **Stul** | Rover · Zborka · Shkurka · Qoplash · Qadoqlash |

## Ikki asosiy prinsip

### 1 · Marshrutli oqim

Qat'iy konveyer emas. Har SKU o'z marshrutiga ega: ayrim fasonlar Aboy,
Palirovka yoki Oyna qo'yish bo'limlariga kirmaydi. Marshrut kodga emas, bazaga
yozilgan (`route_templates` + `product_route_skip`), shuning uchun yangi fason
qo'shish uchun kod o'zgartirish shart emas.

### 2 · Umumiy tsex

Bo'yoqlash tsexi **ikkala yo'nalishni** xizmat qiladi — korpus mebel ham, stul
ham. U yo'nalishga bog'lanmagan (`shops.line_id = NULL`), navbati esa manba
yo'nalish kesimida hisoblanadi (`v_shared_load`).

Stul oqimi bo'yoqlashdan keyin **Stul tsexiga qaytadi** (Qoplash → Qadoqlash).
Operator smenani tanlamaydi — tizim uni mahsulot yo'nalishidan aniqlaydi.

## Sahifalar

| Sahifa | Kim uchun | Huquq |
|---|---|---|
| `/jurnal.html` | **Ishlab chiqarish boshlig'i**: har mahsulot konveyer raqami bilan | `production.view` |
| `/qoldiq.html` | Boshlang'ich qoldiq — bir martalik kiritish | `production.manage` |
| `/mijozlar.html` | Mijozlar ro'yxati, kanal va menejer tahlili | `production.view` |
| `/zavod.html` | Nima qayerda, qachon keyingi tsexga o'tadi, qachon omborga kiradi | `production.view` |
| `/dashboard.html` | Reja/fakt, bottleneck, komplektlilik, umumiy tsex yuklamasi, Pareto | `production.view` |
| `/smena.html` | **Tsex boshlig'i**: bir tsexning barcha bo'limlari bo'yicha kunlik kiritish | `production.entry` |
| `/terminal.html` | Tsex planshetlari: bo'lim bo'yicha real vaqtda kiritish | `production.entry` |
| `/sozlamalar.html` | Bo'lim quvvati — muddat bashorati shunga tayanadi. **Menyuda yo'q**: manzil bilan ochiladi, kerak bo'lsa `app.js` dagi izohlangan qator qaytariladi | `production.manage` |
| `/xodimlar.html` | Xodim, PIN, rol va tsex biriktirish | `admin.users` |
| `/katalog.html` | **Mahsulot nomi va guruhi** — katalog kodda emas, shu yerda | `production.manage` |

### Ishlab chiqarish jurnali — konveyer raqami

Ikki xil kuzatuv birligi bir bazada yashaydi:

| Model | Birlik | Kim uchun |
|---|---|---|
| **Jamlanma** | dona / bo'lim | Tsex boshlig'i: "Freza bo'limidan 30 dona o'tdi" |
| **Konveyer birligi** | raqamli birlik | Ishlab chiqarish boshlig'i: "K26-0001 qayerda, kimga ketadi" |

Konveyer birligi o'tkazilganda tizim **jamlanma yozuvni ham** yozadi, shuning
uchun zavod ko'rinishi, panel va Pareto hisobotlari ikkala usulda ham to'g'ri
ishlaydi. Boshlang'ich qoldiq ham shunday — kiritilgan birlik darrov WIP ga
tushadi.

Jurnal ustunlari gorizontal, mahsulotlar qatorlarda vertikal:

```
Bosh sana · K№ · Z№ · Maxsulot nomi · Maxsulot guruhi · Rang · Mato ·
Soni · Tseh · Bo'lim · Lak tsehi · Qadoqlash tsehi · T/M ombor ·
Mijoz nomi · Narx · Summa
```

Ustunlar zavodda yuritilgan qog'oz jurnaldan olingan — xodim yangi tartibga
o'rganishi shart emas. Pul birligi — **dollar**.

Filtr, saralash va Excel — uchalasi bitta so'rovdan chiqadi. Sahifada beshta
filtr: zakaz raqami, mahsulot nomi, mahsulot guruhi, tsex va mijoz — zavod
jurnalni aynan shu kesimlarda qidiradi. API holat, sana oralig'i va erkin
qidiruvni ham qabul qiladi, lekin ular sahifada ko'rsatilmaydi: kunda
ishlatilmaydigan katak faqat panelni og'irlashtiradi.

Sarlavhaga bosilsa o'sha ustun bo'yicha saralanadi, ikkinchi bosishda teskari
tartibda. Saralash **serverda** bajariladi — ro'yxat 500 qator bilan
cheklangan, faqat ko'rinib turganini saralash "eng qimmat mahsulot"ni
501-qatorda qoldirib ketardi.

**Excelga yuklash** o'sha filtr va saralash bilan CSV beradi (20 000 qatorgacha,
ya'ni ekrandagidan ko'proq). Fayl Excel'da to'g'ri ochilishi uchun UTF-8 BOM,
`;` ajratgich va `,` kasr bilan yoziladi; sana `YYYY-MM-DD` — Excel uni har
qanday tilda sana deb taniydi. Sana ustunlari yonida `fakt/reja/taxmin`
manbasi alohida ustunda turadi: faylda tahlil qilinadigan bo'lsa, sana bilan
belgi bir katakda bo'lmasligi kerak.

- **Konveyer №** — ishlab chiqarish beradi, takrorlanmas. `K26-0001`
  shaklida avtomatik taklif qilinadi. Har mahsulot o'z raqami bilan yuradi:
  "Zero · Penal — K26-0001", "Zero · Kamod — K26-0002". Faqat to'plam
  (Sp) bitta raqam ostida bir butun bo'lib o'tadi.
  Mahsulot nomi — faqat fason ("Zero"); turi guruh ustunida alohida
  turadi, shuning uchun nomga takrorlab yozilmaydi.
- **Zakaz №** — savdo bo'limi zakaz tushganda qo'yadi. Bir mijoz penal +
  kamod + stol + stul olsa, hammasiga bitta zakaz raqami qo'yiladi va
  jurnalda shu raqam bo'yicha filtrlanadi. Zakaz hali yo'q bo'lsa faqat
  konveyer raqami turadi.
- **Mijoz** — biriktirilmagan bo'lsa `T/M ombor` deb ko'rsatiladi.
- **Rang va Mato** — birlikning o'zida, SKU da emas: bitta fason har xil
  rangda va matoda chiqadi. Ro'yxat oldindan tuzilmaydi — kiritilgani o'zi
  yig'iladi va keyingi safar tanlash uchun taklif qilinadi.
- **Lak tsehi · Qadoqlash tsehi · T/M ombor** — uchalasi bir mantiqda
  ishlaydi:
  `fakt` — birlik o'sha tsexga o'tganda tizim o'zi yozadi;
  `reja` — tsex boshlig'i qo'ygan muddat, topshirish shunga qarab nazorat
  qilinadi; `taxmin` — marshrut va bo'lim quvvatidan hisoblanadi.
  Reja o'tib ketgan bo'lsa qator `kechikdi` deb belgilanadi.
  Qadoqlash sanasi savdo uchun: mahsulot T/M omborida bo'lmasa, mijozga
  aytiladigan muddat aynan shundan chiqadi.
- **Keyingi tsexga** — qo'lda reja kiritilsa `reja`, kiritilmasa marshrut va
  bo'lim quvvatidan `taxmin`, allaqachon kirgan bo'lsa `fakt` belgisi bilan
  chiqadi.

  Yo'lda quvvati kiritilmagan bo'lim tursa **taxmin umuman ko'rsatilmaydi**.
  Yarim ma'lumotdan chiqqan sana bo'sh katakdan yomonroq: unga ishonib mijozga
  va'da beriladi. Bo'sh ustun "quvvat kiritilmagan" degani — u
  `/sozlamalar.html` da kiritiladi (sahifa menyuda yo'q, manzil bilan
  ochiladi).

Birlik "O'tkazish" tugmasi bilan marshrutdagi **keyingi bo'limga** o'tadi —
qaysi bo'lim ekanini tizim marshrutdan o'zi topadi. Chiqish bo'limiga
yetganda birlik avtomatik T/M omboriga tushadi va `fg_stock` yangilanadi.

### Mijozlar

| Maydon | Izoh |
|---|---|
| Mijoz nomi | takrorlanmas; qayta import qilinsa yangi qator yaratmaydi |
| Respublika | O'zbekiston · Qozog'iston · Qirg'iziston · Tojikiston · Ozarbayjon |
| Region | respublikaga qarab taklif qilinadi, lekin erkin matn |
| Tel raqami | |
| Kanali | Instagram · Telegram · Salon · Tavsiya · Sayt · Ko'rgazma · Diler |
| Savdo menejeri | xodimlar ro'yxatidan biriktiriladi |

Ro'yxatni birdan import qilish mumkin (nuqtali vergul bilan):
`Mijoz nomi ; Respublika ; Region ; Tel raqami ; Kanal`

Kesimlar: kanal, respublika, region va savdo menejeri bo'yicha mijoz soni,
dona va summa. Kanal kesimi reklama byudjetini taqsimlashda asosiy ko'rsatkich.

### Ikki xil kiritish usuli

Bir xil ma'lumot, ikki xil ish uslubi — tsex o'zi tanlaydi:

- **`/smena.html`** — tsex boshlig'i smena oxirida bitta jadvalda hammasini kiritadi.
  Odatda faqat navbatda turgan mahsulotlar ko'rsatiladi, "bugun kiritilgan" ustuni
  takror kiritishdan saqlaydi. Boshlash uchun eng qulay usul.
- **`/terminal.html`** — bo'lim planshetida real vaqtda: +1 / +5 / +10 tugmalari,
  brak, to'xtash sekundomeri, bo'yoqlash kamerasi partiyasi.

## Muddat qanday hisoblanadi

Oqim liniyasida partiya bo'limlardan ketma-ket emas, quvur (pipeline) bo'lib
o'tadi:

```
MAX(qty / rate)   -- eng tor bo'lim butun partiyani o'tkazish vaqti
+ SUM(1 / rate)   -- bitta dona quvurdan o'tish vaqti
```

`rate` ikki manbadan: **fakt** (oxirgi 14 kundagi real o'rtacha, ustuvor) yoki
**reja** (`sections.capacity_per_day`, ishga tushish davri uchun). Ikkalasi ham
yo'q bo'lsa muddat ko'rsatilmaydi va panel buni ochiq aytadi.

## Uchta o'lchov

| O'lchov | Nima ko'rsatadi | Qayerda |
|---|---|---|
| **WIP / navbat** | Bottleneck qaysi bo'limda | `v_wip`, `v_shop_wip` |
| **Umumiy tsex yuklamasi** | Bo'yoqlash quvvatini qaysi yo'nalish yeyapti | `v_shared_load` |
| **Komplektlilik** | Omborda nechta **to'liq to'plam** bor | `v_set_completeness`, `v_set_blockers` |

Komplektlilik — eng muhimi. "500 dona ishlab chiqarildi" degani "40 to'plam
sotish mumkin" degani emas: bitta pozitsiya yetishmasa to'plam jo'natilmaydi va
bu oddiy dona hisobida ko'rinmaydi.

## Detalirovka uchun qoldirilgan joy

Bugun kuzatuv **SKU darajasida**. Detalirovka tayyor bo'lgach **detal
darajasiga** tushirish mumkin, schema tayyor:

| Joy | Nima uchun |
|---|---|
| `product_parts` | Detal ro'yxati: raqam, nom, material, o'lcham, dona/mahsulot |
| `product_parts.route_template_id` | Detal butun mahsulotdan boshqa yo'ldan yurishi mumkin |
| `flow_log.part_id` | Qaysi detal o'tgani. Hozir NULL — yozuv SKU ga tegishli |
| `set_items` | To'plam tarkibi — ixtiyoriy. Bo'sh bo'lsa to'plam bir butun hisoblanadi |

`part_id` NULL bo'lsa yozuv SKU darajasida qoladi, ya'ni detalirovka
bosqichma-bosqich kiritilishi mumkin — hammasi birdan emas.

## Ishga tushirish

### Serverga qo'yish (tavsiya etiladi)

Bir necha xodim bir vaqtda ishlashi kerak bo'lsa dastur internetda turishi
kerak. Railway yoki Render'da tartib bir xil:

1. Loyihani GitHub'dan ulang, `main`
   tarmog'ini tanlang.
2. **PostgreSQL** qo'shing — platforma `DATABASE_URL` ni o'zi qo'yadi.
3. O'zgaruvchilarga `ERP_AUTO_MIGRATE=1` qo'shing. Boshqa hech narsa
   majburiy emas.
4. Deploy. Server ko'tarilishidan oldin bazani o'zi yaratadi, logda
   `Migratsiya bajarildi: {...}` ko'rinadi.
5. Platforma bergan manzilni oching, `0000` PIN bilan kiring va birinchi ish
   sifatida `/xodimlar.html` da o'z xodimlaringizni kiriting.

`Procfile` da `web: node erp/server.js` — qo'shimcha sozlash kerak emas.
HTTPS'ni platforma o'zi beradi.

### Lokal ishga tushirish

```bash
cp .env.example .env        # DATABASE_URL ni to'ldiring, PGSSL=off qo'shing
npm install
npm run erp:migrate         # bazani yaratadi; qayta ishga tushirish xavfsiz
npm start                   # -> http://localhost:3000
```

Demo PIN: `0000` admin · `5555` direktor · `1111`–`4444` tsex ustalari ·
`6666` operator. **Birinchi ish — o'z xodimlaringizni kiritib, demo PIN'larni
o'chirish yoki o'zgartirish** (`/xodimlar.html`).

## Birinchi kun tartibi

1. `npm run erp:migrate` — baza tayyor bo'ladi (4 tsex, 24 bo'lim, 42 SKU).
2. `/katalog.html` — o'z mahsulot nomlari va guruhlaringizni kiriting.
   Ishlatmaydigan fason va guruhlarni yashiring.
3. `/xodimlar.html` — xodimlarni kiriting, PIN bering, rol biriktiring.
   Ma'lumot kiritadigan xodimlarga **Ma'lumot kirituvchi** rolini bering:
   ular jurnal va qoldiqni to'ldiradi, lekin marshrut, bo'lim quvvati va
   xodimlarga tegmaydi. Demo xodimlarni o'chiring.
4. `/sozlamalar.html` — har bo'limning taxminiy kunlik quvvatini kiriting.
   Sahifa menyuda yo'q, manzil bilan ochiladi. **Ixtiyoriy:** quvvatsiz ham
   hammasi ishlaydi, faqat muddat `taxmin`i hisoblanmaydi — muddat qo'lda
   `reja` sifatida qo'yiladi.
   Aniq bo'lmasa ham kiriting: muddat bashorati shusiz ishlamaydi, real fakt
   yig'ilgach bu qiymatlar avtomatik ustunlikni yo'qotadi.
5. `/mijozlar.html` — mijozlar ro'yxatini import qiling.
6. `/qoldiq.html` — bugun konveyerda turgan va T/M omborida yotgan
   mahsulotlarni konveyer raqami bilan kiriting. Bu bir martalik ish.
7. Kundalik ish: ishlab chiqarish boshlig'i `/jurnal.html` da birliklarni
   o'tkazadi, tsex boshliqlari `/smena.html` da jamlanma kiritadi.
8. Siz `/zavod.html` va `/dashboard.html` dan kuzatasiz.

## Joriy qilish tartibi

**0-faza — katalog.** `/katalog.html` da o'z mahsulot nomlaringiz va
guruhlaringizni kiriting, ishlatmaydiganlarini yashiring. Seed'dagi 17 fason va
5 guruh (Penal · Kamod · Sp · Stol · Stul) — boshlang'ich taklif,
majburiy emas.

**1-faza — ishga tushirishdan oldin.** Sp to'plami tarkibini kiritish
(`set_items`) — komplektlilik hisoboti shusiz ishlamaydi. Penal, kamod,
stol va stul yakka mahsulot, ularga tarkib kerak emas. Fasonlarning real marshrutlarini
biriktirish. Kamera sig'imi va siklini (`chambers`) to'ldirish. Muddat bashorati
birinchi kundan ishlashi uchun `sections.capacity_per_day` ga taxminiy quvvatni
kiritish. **Normani (`route_steps.norma_min`) bo'sh qoldiring.**

**2-faza — 1-oy.** Faqat ma'lumot yig'iladi, faqat tsex chegaralarida
(`shops.track_sections = false`). 24 ta bo'limni birdan o'lchash — ma'lumot
kiritilmay qolishining eng keng tarqalgan sababi.

**3-faza — 2-3-oy.** Real fakt asosida `norma_min` to'ldiriladi. Bottleneck
aniqlangan tsexda `track_sections = true` qilinadi.

**4-faza.** Ombor va ta'minot modullari, keyin savdo, kassa, maosh.

## Hali qilinmagan

- **Telegram** — xodimlarga `workers.tg_id` kiritilmaguncha Mini App va bot
  xabarlari hech kimga bormaydi. ID ni bot ichida `/myid` bilan olib,
  `/xodimlar.html` da kiritiladi.
- **Bot jarayoni** — `notify.sendPending()` tayyor, uni chaqiruvchi bot
  jarayoni yozilmagan (`hr-bot.js` ga o'xshash).
- **Audit** — xodim boshqaruvida ishlaydi, ishlab chiqarish modulida hali
  chaqirilmagan (pul tegadigan modullarda majburiy bo'ladi).
- **To'plam tarkibi va detalirovka** — jadvallar bo'sh, yuqoriga qarang.
- **HTTPS va rate limit** — ishlab chiqarish serveriga qo'yishdan oldin
  reverse proxy (nginx/Caddy) orqali.
