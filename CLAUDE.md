# ZELTA ERP — Scandi Group

Mebel fabrikasi uchun ishlab chiqarish tizimi. Node 18+ · Express · PostgreSQL.
Frontend freymvork yo'q: har sahifa oddiy HTML + `public/app.js`.

```
npm start            # server
npm test             # testlar (lokal PostgreSQL kerak)
npm run erp:migrate  # migratsiya
npm run erp:backup   # bazani faylga tushirish
```

Railway `main` ni avtomatik deploy qiladi.

---

## ⚠️ Buzilmasligi kerak bo'lgan to'rtta qoida

**1. Barcha SQL idempotent.** `IF NOT EXISTS`, `ON CONFLICT`, `CREATE OR REPLACE`.
`ERP_AUTO_MIGRATE=1` — server `listen()` dan oldin `migrate()` chaqiradi.
Migratsiya yiqilsa **sayt umuman ko'tarilmaydi**. Har o'zgarishdan keyin toza
bazada VA eski baza ustida uch martadan sinang.

**2. Bitta view — bitta fayl.** `CREATE OR REPLACE VIEW` ustunni faqat oxiriga
qo'sha oladi. Ustun o'rtaga qo'yilsa yoki nomi o'zgarsa `DROP VIEW` + `CREATE`
kerak. View ikki faylda bo'lsa ikkinchi deployда *"cannot drop columns from
view"* bilan yiqiladi. `v_unit_register`, `v_catalog`, `v_suppliers` shu
sababdan DROP+CREATE.

**3. Tranzaksiya ichida hovuzdan yangi ulanish so'ralmaydi.** `audit()` ga
o'sha tranzaksiyaning `client` ini uzating (izoh: `erp/db.js`).

**4. Kodga mijoz ismi, telefoni yoki PIN yozilmaydi.** Ular bazada va
saytdan boshqariladi.

---

## Asosiy tushunchalar

**Konver** (`production_units`) — kuzatuvning asosiy birligi: bitta
mahsulot, o'z raqami bilan (`K26-0041`). Zavod uni shunday ataydi.

**★ RAQAMNING KO'RINISHI TSEXDA** (`shops.no_prefix`, `shops.no_width`,
zavod qarori 2026-09):

    S26-104    S — stul, 26 — 2026 yil, 104 — ketma-ketligi
    K26-0041   korpusniki: harfi ham, raqam uzunligi ham boshqa

Zavod raqamni o'z daftarida yuritadi va mahsulotning O'ZIGA yozib
qo'yadi, shuning uchun tizim taklif qiladigan raqam qog'ozdagisiga
o'xshashi shart. Harf ham, uzunlik ham bazada — yangi tsex qo'shilganda
kodga tegilmaydi.
Boshlang'ich qoldiqda raqami noma'lum mahsulot bo'ladi — raqam katagi
bo'sh qoldiriladi va tizim `Q26-0007` beradi: **Q** bosh harfi raqamni
zavod emas, tizim qo'yganini aytadi.
Sifat shikoyati, ishbay oylik va xom ashyo sarfi — hammasi shu raqamga
bog'lanadi, shuning uchun ombor qoldig'i ham dona emas, konver hisobida.

**Marshrut** — mahsulot qaysi bo'limlardan, qaysi tartibda o'tadi.
`route_templates` + `route_steps`, mahsulotga `route_template_id` orqali
biriktiriladi. Haqiqiy manba: **`sql/routes.sql`** — tartib faqat shu yerda.

**★ MUDDAT MARSHRUTDAN HISOBLANADI: har bo'limda BIR KUN** (zavod qarori,
2026-09). Sana konverning boshlangan kunidan va qadam raqamidan chiqadi
(`v_unit_step_plan`, `v_unit_plan`, `sql/register.sql`):

    N-qadamga kirish   =  started_on + (N − 1)
    T/M omborga kirish =  started_on + qadamlar soni

Ya'ni birinchi bo'limda konver boshlangan KUNNING O'ZIDA turadi,
oxirgi bo'limdan keyingi kuni esa omborga tushadi. Lak va qadoqlash
sanalari ham shundan — o'sha tsexning marshrutdagi birinchi qadami.

Eski hisob (`v_unit_eta`, `MAX(qty/quvvat) + SUM(1/quvvat)`) olib
tashlandi. U ikki narsani talab qilardi: har bo'limning quvvati
kiritilgan bo'lishi va u haqiqatga yaqin bo'lishi. Quvvati yo'q bo'lim
yo'lda uchrasa muddat UMUMAN chiqmasdi — savdo mijozga sana ayta
olmasdi. Ustiga u `CURRENT_DATE` dan hisoblardi, ya'ni javob har kuni
surilib borardi: kecha «25-sentabr» degan konver bugun «26-sentabr»
bo'lardi va kechikish hech qachon ko'rinmasdi. Yangi formulada sana
QOTIB turadi — konver kechiksa reja o'tmishda qoladi va `fg_late`,
`lak_late`, `pack_late` ustunlari aynan shuni ko'rsatadi.

Manba belgisi uchta: **fakt** (bo'lib bo'lgan) → **reja** (tsex
boshlig'i qo'lda qo'ygan, formuladan USTUN) → **marshrut** (formula).
Zahiraga marshrut sanasi chiqarilmaydi: u buyurtma kutadi, marshrut
kutmaydi.

**★ FORMULA HAMMA TSEXDA ISHLAMAYDI** (`shops.plan_auto`, zavod qarori
2026-09). **Stulda** sana marshrutdan o'zi chiqadi: yo'li qisqa
(6–8 bo'lim) va bir tekis yuradi. **Korpusda** esa katak BO'SH
tug'iladi va **tsex boshlig'i o'zi qo'yadi**: marshruti o'n to'qqiz
bo'lim, quritish va kamera navbati bor, va o'sha kunni boshliqdan
boshqa hech kim to'g'ri ayta olmaydi. Bo'sh katak bu yerda «unutilgan»
emas, «boshliq qo'yadi» degani.

Belgi TSEXDA, kodda emas — omborning `perm` i va xodimning
`can_hold_cash` i bilan bir xil idiom: ertaga korpus ham avtomatga
o'tsa bitta katakcha belgilanadi. Qaysi tsexniki ekani marshrutni
BOSHLAYDIGAN qadamdan chiqadi, turgan joyidan emas: stul lak bo'limiga
o'tganda ham stul tsexiniki bo'lib qoladi.

**Boshliq muddatni o'z ekranidan qo'yadi** (`production.plan`,
`POST /api/units/:id/plan`, bo'limlar ekranidagi sana katagi). Unga
jurnal ochilmaydi va ochilishi ham kerak emas — u yerda narx, mijoz va
butun zavodning konverlari turadi; bu huquq esa FAQAT reja sanalarini
yozadi va faqat o'z tsexining konveriga (tsex doirasi — chegara).
Ekranda bitta sana so'raladi («qachon topshiriladi»), **qaysi ustunga
yozilishini SERVER hal qiladi**: oldinda lak tursa `lak_planned_on`,
qadoqlash bo'lsa `pack_planned_on`, tsex qolmagan bo'lsa
`fg_planned_on` — va har uchalasida `next_shop_planned_on`. Shu qoida
bo'limlar ekranidagi orqaga sanash bilan BIR manbadan chiqadi, aks
holda boshliq qo'ygan kun o'sha ekranda ko'rinmasdi. Bo'sh yuborilgani
«tegma» emas, «yo'q» degani — xato sana olib tashlanadi.

Bo'limsiz kiritilgan konverda keyingi tsex yo'q, lekin **T/M ombor
sanasi bor**: u marshrutning to'liq uzunligidan chiqadi va konver
qayerda turganini bilishni talab qilmaydi.

Zavod ko'rinishidagi (`/zavod.html`) jamlanma muddat hali ham
quvvatdan hisoblanadi (`v_position_eta`, `v_section_rate`) — u boshqa
savolga javob beradi: bitta konver emas, bo'lim oldidagi butun navbat.

**Harakat** (`unit_moves`) — konver bo'limdan bo'limga o'tdi. Har o'tkazish
jamlanma `flow_log` ga ham yoziladi (hisobotlar shundan hisoblanadi).
Harakatda `qty` (nechta dona ko'chdi) va `from_section_id` (qayerdan) bor.

**Konver bo'linadi.** 10 ta stulning 3 tasi keyingi bo'limga o'tadi, 7 tasi
joyida qoladi — ya'ni konver bir vaqtda bir nechta bo'limda turadi. Alohida
"joylashuvlar" jadvali yo'q: har bo'lak O'ZI qator bo'ladi, raqami bir xil,
`part` bilan farqlanadi. Shuning uchun ekran, jurnal, muddat va ombor
eskicha ishlaydi — har qator baribir bitta joydagi bitta konver.
Bo'laklar uchrashsa QO'SHILADI va bo'shab qolgan qator o'chadi (tarixi
qo'shilgan qatorga ko'chadi), shuning uchun donama-dona o'tkazilsa ham
qatorlar ko'paymaydi. Yagona joy: `placePieces()` — o'tkazish ham,
qaytarish ham shundan o'tadi.

**Topshirish ikki bosqich.** Tsexdan tsexga o'tish:
jo'natuvchi «jo'natdim» (`production_units.handover_*`) → qabul qiluvchi
o'tkazadi. Jo'natilmagan konverni qabul qilib bo'lmaydi. Jo'natish —
harakat EMAS, mahsulot joyidan qimirlamaydi.

**Omborlar** (`warehouses`) — zavodda bitta ombor yo'q: T/M ombor, uchta
vitrina (showroom) va xom ashyo omborlari. Ro'yxat bazada,
`sql/warehouse.sql` da. `kind='fg'` — qoldiq konver hisobida;
`kind='material'` — xom ashyo (hali yozilmagan). `is_active=FALSE` ombor
ro'yxatda «rejada» bo'lib turadi, ochilmaydi. Yangi ombor qo'shish — shu
faylga bitta qator, sahifaga tegilmaydi.

Konver qaysi omborda turgani `production_units.warehouse_id` da. NULL —
T/M ombor: ustun qo'shilgunga qadar kiritilgan konverlar shu yerda deb
o'qiladi (`v_fg_units` COALESCE bilan). Har ombor bitta sahifadan
ochiladi — `/ombor.html?w=VITR-ABU` — va qoldiq, tarix, Excel hammasi
o'sha ombor haqida gapiradi.

**Vitrinaga mahsulot ikki yo'l bilan tushadi.** Ishlab chiqarish vitrinaga
TOPSHIRMAYDI: qadoqlash tsexidan kelgan mahsulot har doim T/M omborga
qabul qilinadi, vitrinaga u shu yerdan ko'chiriladi — aks holda ombor
mudiri ko'rmagan mahsulot hisobga tushib qolardi.

  1. **Ko'chirish** — T/M ombor qoldig'ida konver raqamini bosib, omborni
     tanlash (`warehouse/fg/transfer`). Konverning BIR QISMI ham ko'chadi:
     10 talikdan 3 tasi vitrinaga chiqadi, 7 tasi omborda qoladi —
     konver bo'linadi (`clonePart`), raqami bir xil qoladi. Buyurtmaga
     biriktirilgan konver ko'chmaydi: avval ajratiladi.
  2. **Boshlang'ich qoldiq** — «Tseh» ustunidan vitrina tanlanadi: hozir
     vitrinada turgan mahsulot to'g'ridan-to'g'ri o'sha yerga kiritiladi.
     Fayldan yuklashda ham shu — `warehouse_code` ustuni.

Kiritishda adashilsa — ombor o'rniga tsex tanlanib ketsa — konverni
o'sha zahoti omborga o'tkazadigan tuzatish bor:
`POST /api/units/:id/to-warehouse` (faqat `production.manage`). Bu
qabul qilish EMAS: marshrut bo'ylab haydab chiqarish yolg'on harakat
yozardi, o'chirib qayta kiritish esa konveyer raqamini yo'qotardi.
Turgan bo'limi saqlanadi, shuning uchun ombordan qaytarilsa o'z joyiga
qaytadi. **Jurnaldagi tugmasi yashirilgan** — boshlang'ich qoldiq
kiritilib bo'lgach kundalik ishda kerak emas. Qaytarish:
`public/jurnal.html` dagi `FIX_TO_WAREHOUSE` ni `true` qilish.

**Ombor tarixida KIM ustuni** — kirimda kim qabul qilgan, chiqimda kim
chiqargan (`production_units.fg_by` va `ship_by`, ko'chirishda esa
allaqachon bor `warehouse_moves.worker_id`). Dona yetishmaganda savol
aynan shu bo'ladi; audit jurnalida yozuv bor, lekin u ombor mudiriga
ochilmaydi va konver bo'yicha izlash uchun mo'ljallanmagan ham.

Konver raqami ostida **zakaz raqami**, bosilsa o'sha **yuk xati**
ochiladi: «kim chiqargan» degan savoldan keyingi savol «qaysi hujjat
bilan» bo'ladi. Ustun qo'shilgunga qadar chiqib ketganlarda «kim» bo'sh
qolardi — buyurtmadagi yozuvdan bir martalik ko'chirildi
(`migration_flags`: `ship-by-eski`).

Yonida **kirim/chiqim filtri** va **mijoz bo'yicha qidiruv**: mudirning
savoli ko'pincha bitta tomon haqida — «bugun nima keldi» — yoki bitta
mijoz haqida: «Qarshi Husanga nima chiqqan». Qidiruv katagi konver va
zakaz raqamini ham oladi, ya'ni qaysi ustunda izlashni o'ylash shart
emas. Ikkalasi ham SERVERDA (`?kind=`, `?q=`), chunki oraliq katta
bo'lsa qatorlar chegarasiga yetib, klientda yarmi yo'qolardi.

**Yig'indi kartochkalari kirim/chiqim filtridan QAT'I NAZAR**
hisoblanadi: «faqat kirim» tanlangan kunda chiqim nol bo'lib ko'rinsa,
mudir o'sha kuni hech narsa chiqmagan deb o'qirdi. Mijoz qidiruvi esa
yig'indiga TA'SIR QILADI — «shu mijozga qancha chiqqan» degan savolga
javob kerak, butun ombor aylanmasi emas.

Omborlar aro ko'chirish `warehouse_moves` ga yoziladi va ombor tarixida
IKKI qator bo'lib chiqadi: berganida chiqim, olganida kirim. Ishlab
chiqarishdan kirim esa mahsulot BIRINCHI tushgan omborga yoziladi, hozir
turganiga emas — aks holda ko'chirilgan mahsulot vitrinada ikki marta
kirim bo'lib ko'rinardi.

**Javobgar tsex** (`product_groups.owner_shop_id`) — bo'lim konver
QAYERDA ekanini aytadi, javobgar tsex esa KIM boshqarayotganini. Stul lak
ishini lak tsexining kabinasida oladi, lekin boshidan oxirigacha stul
tsexi boshlig'i yuritadi: lak ustasiga stul ko'rinmaydi, stul boshlig'i
esa lak bo'limlarini o'z ekranida ustun sifatida ko'radi va o'zi
o'tkazadi. Javobgar o'zgarmagani uchun topshirish ham so'ralmaydi.
Bo'sh bo'lsa (penal, kamod, sp, stol) — eskicha: turgan joyining tsexi
boshqaradi. Doira, topshirish va ekran — hammasi shu ustunga tayanadi
(`v_unit_register.owner_shop_id`).

**Tsex boshlig'i konverni kim kutayotganini ko'radi** — bo'limlar
ekranining O'ZIDA, alohida oyna emas. Konver yonida ikkita raqam turadi:
soni (jismonan nechta) va ostida «N buyurtmada». Qator bosilsa ostida
kim, nechta va qachonga kutayotgani chiqadi (`GET /api/units/:id/bron` —
jurnalda ham shu yo'l, ikkinchi so'rov yozilmadi). **Pul yo'q.**

Alohida tab qilinmadi: boshliq kun bo'yi bo'limlar ro'yxatida turadi va
javob o'sha yerda, ish qilayotgan joyida bo'lishi kerak — ikkinchi
ekranga o'tib, qaytib kelib o'tirmasin. Alohida ustun ham qilinmadi:
telefonda qator panjaraga aylanadi (`.board`, `style.css`) va yettinchi
ustunga joy yo'q, shuning uchun raqam SONI katagining ichida turadi.

`/:id/bron` huquqi `production.entry` ni ham oladi: tsex ustasida jurnal
yo'q, lekin o'z konverini kim kutayotganini bilishi kerak. Tsex doirasi
u yerda ham CHEGARA — boshqa tsexning konveri so'ralsa 403.

**Yangi buyurtma oltin nuqta bilan turadi** (`unit_bron_seen`). «N
buyurtmada» yozuvining o'zi yetarli emas: u har kuni turadi va ko'z unga
o'rganib qoladi — boshliq 10 talik konverni bir hafta ko'rib yurib,
bugun unga mijoz biriktirilganini sezmay qolardi. Shuning uchun har
xodim uchun «shu konverni qachon ochib ko'rdim» yozib boriladi: undan
keyin tushgan bron YANGI bo'lib turadi. Bo'lim sarlavhasida ham soni
chiqadi («2 ta yangi buyurtma») — telefonda bir bo'limga o'nlab qator
tushadi va ularni birma-bir ko'zdan kechirish kerak bo'lardi.

Belgi xodimga bog'langan: bir tsexda ikki boshliq bo'lsa, birining
ko'rgani ikkinchisiniki hisoblanmaydi. **Alohida «o'qildi» tugmasi
yo'q** — qatorni ochish ro'yxatni o'qish demak, va `/:id/bron` o'sha
so'rovning o'zida belgini o'chiradi (ikkinchi so'rov yozilmadi).

Bron SONI oshirilsa ham yangi — mijozga va'da qilingan dona o'zgardi;
`created_at` bunda qimirlamaydi, shuning uchun alohida `changed_at`.
Belgi ishga tushgan kungacha qo'yilgan bronlar yangi hisoblanmaydi
(`migration_flags`: `bron-korildi`): aks holda birinchi deploy'dan keyin
har tsexda o'nlab belgi chiqib, haqiqiy yangi buyurtma o'sha to'da
orasida ko'rinmay ketardi.

Telegram xabari **hozircha yozilmadi** (zavod qarori): ekrandagi belgi
yetarli. Navbat jadvali (`notifications`) va `erp/notify.js` bazada
tayyor turibdi — kerak bo'lganda yuboruvchi ulanadi, sahifaga tegilmaydi.

**★ KONVER TASDIQDAN O'TADI** (`unit_requests`, `/sorovlar.html`,
`sql/units.sql`). Zavod qarori (2026-09): konverni **hech kim o'zi
ochmaydi**. Kim kiritsa ham — ma'lumot kirituvchi bo'ladimi, tsex
boshlig'i bo'ladimi — yozgani navbatga tushadi va **rahbariyat
tasdiqlagandan keyin** konverga aylanadi. Sabab: konverning ochilishi
pulga tegadi — xom ashyo sarflanadi, ishbay oylik shu raqamga yoziladi
va ombor qoldig'i o'zgaradi.

  **Yozadi** — `production.request`: ma'lumot kirituvchi va tsex
  boshlig'i.
  **Tasdiqlaydi** — `production.approve`: direktor, ishlab chiqarish
  boshlig'i, administrator.

Konverni TO'G'RIDAN-TO'G'RI ochish (`POST /api/units/`) endi
`production.manage` da — ya'ni tasdiqlaydigan odamning o'zida.
Jurnaldagi «+ Yangi konver» tugmasi ham o'sha huquqda; qolganlarda u
umuman chizilmaydi.

`production.units` endi konver OCHMAYDI: u jurnalni TO'LDIRISH huquqi —
zakaz, mijoz, narx, rang, mato.

**Alohida jadval, `status='draft'` EMAS.** Konver jadvali butun tizimning
o'qi: jurnal, ombor qoldig'i, WIP, bron, balans va o'nlab view shundan
o'qiydi. Yarim haqiqiy qator o'sha yerda tursa, uni har bir so'rovda
chetlab o'tish kerak bo'lardi va bitta esdan chiqqan joy tasdiqlanmagan
mahsulotni qoldiqqa qo'shib yuborardi.

**★ KONVER RAQAMI SO'ROVDA YOZILADI va MAJBURIY.** Zavod raqamni o'z
daftarida yuritadi va mahsulotning o'ziga yozib qo'yadi: tizim bergan
raqam bilan qog'ozdagisi boshqa bo'lsa, tsexda turgan konverni jurnaldan
topib bo'lmasdi. Sahifa mahsulot tanlangan zahoti **keyingi raqamni
taklif qiladi** (`GET /api/units/requests/next-no`) — ketma-ketlikni
yodda saqlab o'tirish shart emas, lekin katak tahrirlanadi: qog'ozdagi
raqam boshqa bo'lsa o'sha yoziladi. Taklif navbatdagi so'rovlarni ham
hisobga oladi, ya'ni ikki odam bir vaqtda kiritsa bir xil raqam
chiqmaydi.

**Band raqam so'rov yozilayotganda tutiladi**, tasdiqlashda emas: aks
holda so'rov navbatda turib, direktor bosganda yiqilardi va sababi unga
ko'rinmasdi.

**Zahira belgisi ham so'rovda** (`is_stock`): buyurtmasiz, oldindan
ishlanayotgani kiritayotgan odamga boshidan ma'lum — tasdiqlangandan
keyin jurnaldan qidirib belgilash ortiqcha ish bo'lardi.

Tasdiqlangach konver ODATDAGI `createOne()` bilan ochiladi: raqami ham,
harakat yozuvi ham, jamlanma hisobot ham bir xil yo'ldan o'tadi.
**So'ralgani AYNAN o'sha holida** ochiladi — soni ham, rangi ham
o'zgartirilmaydi: tasdiqlovchi boshqacha xohlasa rad etadi va sababini
yozadi, aks holda boshliq nima so'raganini keyin solishtirib bo'lmasdi.

Chegara so'rashda ham bor: tsexi biriktirilgan xodim FAQAT o'z
tsexining mahsulotiga so'rov yozadi (mahsulot qaysi tsexniki —
`owner_shop_id`, bo'lmasa marshrutning birinchi qadami). Doirasi
bo'lmagan xodim hamma mahsulotga yozadi.

**Ro'yxatning O'ZI ham shu doira bo'yicha qisqaradi**: stul kiritadigan
odamga faqat stullar ko'rinadi — penal oldida turib, har safar
o'rtasidan izlab o'tirmasin. Buning uchun `/api/ref` har mahsulot yonida
`shop_id` ni ham beradi (javobgar tsex → marshrutni boshlaydigan
bo'limning tsexi), sahifa esa uni xodimning `scope_shop_ids` i bilan
solishtiradi. **Bu QULAYLIK, himoya emas**: chegara baribir serverda
(`shopOfProduct`) — ro'yxatni chetlab, id ni qo'lda yuborsa ham qabul
qilinmaydi.

Doira **Xodimlar sahifasida** qo'yiladi: rol yonidagi «Barcha tsex»
ro'yxatidan tsex tanlanadi. Kodga ism ham, tsex ham yozilmaydi
(4-qoida). Bo'lim so'ralmaydi: konver
«boshlanmagan» bo'lib ochiladi va boshliq uni o'z ekranidan bir bosishda
ishga tushiradi.

Rad etish ham, so'rovchining o'zi bekor qilishi ham bitta yo'ldan
(`/reject`), lekin holati boshqa: `rejected` — direktorniki,
`cancelled` — o'zinikidir. Sabab ikkalasida ham so'raladi: boshliq nega
bo'lmaganini bilmasa, o'sha so'rovni ertaga yana yozardi.

**Boshlanmagan konver** — bo'limsiz kiritilgan. U marshrutining BIRINCHI
qadamiga qarab egasini topadi: penal/kamod/sp/stol — korpus tsexi, stul —
stul tsexi. Tsex ekranining tepasida «Boshlanmagan» ro'yxati bo'lib
turadi, tugmasi marshrutning birinchi bo'limini yozadi («→ Arra»).

**O'lchov birligi** (`product_groups.uom`) — stul DONA bilan, penal, kamod,
sp va stol KOMPLEKT bilan sanaladi. Guruhga biriktiriladi, mahsulotga emas.
Ombor yig'indisi shu sababdan bitta raqam emas: `by_uom` bo'lib chiqadi —
dona bilan komplektni qo'shib bo'lmaydi.

**★ BOSHLANG'ICH QOLDIQ — FAQAT `production.manage`** (zavod qarori,
2026-09). Bu bir martalik ish va u bajarilib bo'lgan: kundalik konver
kiritadigan xodimga sahifa kerak emas va faqat chalg'itadi. Ochiq
qolsa oddiy konver adashib `Q` raqami bilan ochilib, jamlanma
hisobotga «boshlang'ich qoldiq» bo'lib tushib ketardi — va u yerdan
bo'lim quvvati hisobidan chiqarib tashlanardi.

Tekshiruv **serverda**, `createOne()` da: menyudan sahifani olib
qo'yish himoya emas. Fayldan yuklash (`POST /api/import/units`) ham
o'sha huquqda — u ham `is_opening` yo'li.

**Boshlang'ich qoldiqni omborga kiritish.** «Boshlang'ich qoldiq» sahifasida
**Tseh** ustunidan «T/M ombor» tanlansa, bo'lim katagi o'chadi va «T/M ombor»
ustunidagi sana REJA emas, omborga kirgan FAKT kun bo'ladi: konver darrov
`fg` holatida yaratiladi va qoldiqqa tushadi. Fayldan yuklashda xuddi shu
ish «Omborga kirgan» ustuni bilan bo'ladi. Qoida `createOne()` da — ikkala
yo'l ham shundan o'tadi.

**★ NARX — YUK XATIDAN.** Mijozning qarzi u imzolagan hujjatdagi
summadan hisoblanadi, konver kartochkasidagi narxdan emas: zavod qarori
(«programmani har doim yuk xatidan chiqib ketgan narx bo'yicha ol»).
Chiqarish tasdiqlanganda buyurtma qatoridagi narx konverga KO'CHIRILADI
(`production_units.unit_price`), shuning uchun balans, qarzdorlik va
dalolatnoma uchalasi bir xil raqamni aytadi. Ilgari ikki narx bo'lardi va
qog'ozdagi summa balansdan farq qilardi; narxsiz konver esa balansdan
butunlay tushib qolardi. Eski chiqimlar bir martalik ko'chirildi
(`migration_flags`: `sotilgan-narx`).

**Tan narx hali yo'q**: xom ashyo va ta'minot moduli yozilgandan keyin
shakllanadi; boshlang'ich qoldiq va hozir chiqayotgan mahsulotga zavod
o'zi qo'yadi.

**Mijoz balansi** (`v_customer_sales.balance`) — `boshlang'ich qarz +
CHIQIB KETGAN mahsulot summasi`. Zavod qoidasi: buyurtma yozilgani ham,
bron qo'yilgani ham hali qarz emas — mahsulot mijozda emas. To'lovlar
ayirilmaydi: kassa moduli yozilganda o'sha yerga bitta ayirma qo'shiladi.
Buyurtma oynasida mijoz tanlanganda balans ostida chiqadi.

**Qarzdorlik hisoboti** (`v_customer_ledger`, `/qarzdorlik.html`) — balans
bitta raqam, zavodga esa ORALIQ kerak: «1-sentabrda qancha edi, oy ichida
qancha qo'shildi, 30-sentabrda qancha bo'ldi». Shuning uchun hisobot
balansdan emas, uni hosil qiladigan HARAKATLARdan yig'iladi — har biri
o'z sanasi bilan:

    boshiga + qarzdor - haqdor = oxiriga

**Qarzdor** (debit) — MIJOZNING korxonaga qarzi; mahsulot chiqqanda
oshadi. **Haqdor** (kredit) — KORXONANING mijozga qarzi: oldindan to'lov,
ortiqcha o'tkazma. Saldo shu ikki tomondan birida turadi, shuning uchun
jadvalda bitta ishorali ustun emas, **ikkita ustun**: «boshiga qarzdor /
haqdor», «davr ichida qarzdor / haqdor», «oxiriga qarzdor / haqdor».
Ilgari bitta ustun edi va manfiy raqam haqdorni anglatardi, lekin buni
jadval hech qayerda aytmasdi — 300 ni ko'rgan odam kim kimga qarzdorligini
bilmasdi. Tomonga ajratish `v_customer_ledger` da boshlanadi
(`GREATEST(...)`): manfiy boshlang'ich qarz qarzdor ustunidagi minus emas,
haqdor yozuvi bo'ladi. Yig'indi ham tomon bo'yicha qo'shiladi, ishoralar
qisqartirilmaydi: biri 1000 qarzdor, boshqasi 1000 haqdor bo'lsa «0»
degan javob ikkalasini ham yashirardi.

Kassa moduli yozilmagani uchun haqdor aylanmasi hozircha deyarli bo'sh
(faqat manfiy boshlang'ich qarz tushadi): u yozilganda `v_customer_ledger` ga
bitta UNION shoxi qo'shiladi va hisobot o'zi to'ladi — sahifa ham, so'rov
ham o'zgarmaydi. Sanasi yo'q harakat 1900-01-01 bo'ladi: har qanday
oraliqdan oldin turadi va yig'indidan yo'qolib qolmaydi.

Qator bosilganda ostida o'sha mijozning harakatlari chiqadi (qaysi konver,
qaysi zakaz, qaysi kun) va yonida yugurib boradigan qoldiq. Chegara savdo
bilan bir xil: menejer faqat o'z yo'nalishidagi mijozlarni ko'radi.

**Solishtirma dalolatnoma** (`/dalolatnoma.html`) — o'sha lentaning
MIJOZGA beriladigan ko'rinishi: bitta mijoz, bitta oraliq, boshiga va
oxiriga saldosi bilan. Hisobot «kim qancha qarzdor» degan savolga zavod
ichida javob beradi, dalolatnoma esa mijoz bilan YUZMA-YUZ solishtirish
uchun — shuning uchun har qator HUJJATGA bog'langan:

  · chiqib ketgan mahsulot — zakaz raqami, bosilsa **yuk xati** ochiladi;
  · to'lov — order raqami (`P26-0004`), bosilsa **kirim orderi** ochiladi
    (`public/kirim-orderi.html`): kimdan, kim olib kelgan, summa, kurs.

«Bu 500 dollar qayerdan chiqdi» degan savolga jadvaldagi raqamning o'zi
javob bermasdi — mijoz hujjatni ko'rishi kerak. Ikkalasi ham ALOHIDA
oynada ochiladi: dalolatnoma yonida ochiq turadi, mijoz bilan qator
bo'yicha yuriladi.

Yo'li `v_customer_ledger` ga qo'shilgan `order_id`, `doc_no`, `op_id`
ustunlaridan keladi — sahifa qaysi hujjat ekanini o'zi biladi, ikkinchi
so'rov yozilmadi. To'lov hujjati `GET /api/sales/payment/:id` dan
o'qiladi (savdo huquqi, yo'nalish chegarasi bilan).

**Boshlang'ich qarzdorlik** (`customers.opening_debt`, `$`) — tizim ishga
tushgan kundagi mijoz qarzi. Bir martalik raqam, hisoblanmaydi: kassa
yozilganda qarz shundan davom etadi (`boshlang'ich + sotuvlar − to'lovlar`).
Maydon ISHORALI: musbat — mijoz korxonaga qarzdor, **manfiy — korxona
mijozga qarzdor** (haqdor, ya'ni oldindan to'lov). Ikkita maydon
qilinmadi: bittasi to'ldirilib ikkinchisi unutilsa qarz ikki joyda yotib
qolardi; hisobot uni o'zi tomonga ajratadi.

Ikki yo'ldan kiritiladi:
  1. **Mijoz kartochkasidan** — «Boshlang'ich qarz» va «Qarz sanasi».
     Haqdor minus bilan yoziladi va maydon ostida yozayotganda qaysi
     tomon ekani chiqib turadi.
  2. **Fayldan** — «Qarzdor» va «Haqdor» ALOHIDA ustun (zavod ro'yxati
     shunday yuritiladi va minus qo'yishni hech kim unutmaydi), ustiga
     «Qarz sanasi». Bitta ustunda minus bilan yozilgani ham o'qiladi:
     `opening_debt = qarzdor − haqdor` (`modules/import.js`).

Qayta yuklashda yozilgani O'CHMAYDI, faqat bo'sh bo'lsa to'ladi —
kartochkadan esa tuzatish ham, tozalash ham mumkin.

**Buyurtma** (`orders` + `order_items`) — mijoz nima so'ragani, qatorlari
bilan: bitta buyurtmada bir nechta mahsulot bo'ladi. Raqamni tizim beradi
(`Z26-0001`). Zavod uni IKKI manbadan bajaradi (zavod qarori): T/M omborda
tayyor turgan konverdan yoki buyurtma kutayotgan **zahiradan**. Buyurtma
uchun yangi konver OCHILMAYDI — ishlab chiqarish o'z rejasi bilan yuradi.

Sarlavhada: mijoz (balansi bilan), menejer, **buyurtma sanasi**,
**chiqib ketish sanasi**, **qayerga** (`order_destinations`: zavodga
kiradi / yuk terminaliga / mijoz uyiga / do'konga) va **kutib oluvchi
raqami**. Manzil faqat kerak bo'lgan yo'lda so'raladi va o'shanda
majburiy (`needs_address`) — mashina qayerga borishini keyin hech kim
topa olmasdi.

**★ QATOR MAVJUD KONVERLARDAN YOZILADI** (`/api/sales/stock`).
Buyurtma oynasi — **to'liq ekran** (`public/buyurtmalar.html`, `.order-view`;
nomi `sheet` EMAS — u style.css da band va to'qnashsa maydonlar ko'rinmay
qoladi). Maydonlar bir xil kenglikdagi panjarada, to'rttadan.

Qatorda **Mahsulot → Rangi → Matosi**, har biri alohida katak.
**Birinchi mahsulot tanlanadi** (turi uning yonida yozilib turadi):
menejer mijozdan «Milano penal» deb eshitadi, «penal» deb emas.
**Hammasi ro'yxatdan — qo'lda yozish yo'q**: zavodda mahsulot, rangi va
matosi birgalikda bitta narsa, ro'yxatda bo'lmagan rang esa hech qachon
konver topmasdi.

**Ro'yxatda dona soni yozilmaydi.** Tanlash paytida u chalg'itadi:
menejer mijoz so'ragan miqdorni yozadi, konverdagi qolgan dona esa
boshqa mijozniki. Mahsulot ostida faqat QAYERDAN kelishi turadi, aniq
soni esa bron oynasida, har konverning yonida.

Izohda **hamma manba** yoziladi, bittasi emas: «T/M omborda bor ·
ishlab chiqarishda». Ilgari faqat birinchisi chiqardi va omborda bori
ko'rinib, yo'ldagi konver yashirinib qolardi — menejer «T/M omborda
bor» ni o'qib, ishlab chiqarishdagini olish taklif qilinmagan deb
o'ylardi. Holbuki u ham biriktiriladi: «Konver» oynasida uchala manba
ham turadi va omborga eng yaqini tepada. Rang HALI TANLANMAGAN bo'lsa
mahsulotning hamma satri qaraladi — aks holda to'la ombor ustida
«omborda yo'q» deb yozilardi (`srcHint`). Shu sababdan bron qilingan konver yonida ham konverning umumiy
hajmi ko'rsatilmaydi (ilgari «4 / 48» edi va buyurtma 48 ta deb
o'qilardi) — faqat SHU buyurtmaga olingan soni.

Ro'yxat **uch manbadan**, shu tartibda:

  1. **T/M omborda** — tayyor turibdi, darrov beriladi.
  2. **Zahirada** — kutish bo'limida buyurtma kutmoqda va **rangi hali
     yo'q**: mijoz aytgan rangga bo'yaladi. Shuning uchun zahirasi bor
     mahsulotda rang ro'yxatiga «Zahiraga tanlanadi» guruhi qo'shiladi —
     zavodda ishlatilgan ranglarning hammasi (`/api/sales/suggest`).
  3. **Ishlab chiqarishda** — yo'lda, rangi allaqachon ma'lum.

To'rtinchi manba yo'q: «buyurtma uchun yangi konver ochilmaydi» degan
qoida sotiladigan narsa allaqachon mavjudligini anglatadi. Eski
buyurtma ochilganda ro'yxatda qolmagan qiymat «Ro'yxatda yo'q» guruhida
saqlanadi — qator o'z qiymatini yo'qotmaydi.

**Zakaz raqami qo'lda ham qo'yiladi** (`orders.order_no`, UNIQUE). Zavod
o'z daftarida raqam yuritadi va nakladnoyda o'sha raqam turishi kerak;
bo'sh qoldirilsa tizim beradi (`Z26-0001`). Raqam o'zgartirilsa
konverlardagi zakaz raqami ham ko'chadi (`production_units.order_no` —
matn), aks holda jurnaldagi raqam buyurtmanikidan ajralib qolardi.

**Vitrina savdoga umuman chiqmaydi.** Do'kondagi mahsulot ko'rgazmada
turadi: u yerdan ham sotilmaydi, sotuv T/M ombordan ketadi. Shuning
uchun qator ro'yxatida ham, bron nomzodlarida ham vitrina yo'q —
vitrina sotuvchisiga o'z nuqtasiniki ham. Tekshiruv serverda
(`CANDIDATE_WHERE` va `/assign`): to'g'ridan-to'g'ri id yuborilsa ham
qabul qilinmaydi. Ombor sahifasida qoldig'i ko'rinaveradi — chegara
savdoniki.

**★ BRON — konver bo'linmaydi** (`unit_reservations`). Konver
buyurtmaning aniq QATORIGA bron qilinadi: bir xil mahsulot ikki xil
rangda bo'lishi mumkin. Bitta konverda bir nechta mijozning broni
bo'ladi — «10 ta ishlanmoqda, 6 tasi Alisherga, 4 tasi bo'sh».

Ilgari bir qismi olinsa konver BO'LINARDI. Ishlab chiqarishdagi konver
uchun bu noto'g'ri: 10 ta stul bitta partiya bo'lib yuradi, bo'limdan
bo'limga birga o'tadi, jurnalda bitta qator bo'lib turishi kerak.
Shuning uchun bron alohida jadval, konverning o'zi qimirlamaydi.
Ombordagi mahsulotda ham xuddi shu — manba bitta bo'lsin.

Bron **uch manbaga** qo'yiladi: T/M ombor (tayyor — vitrina EMAS),
zahira (rangi tanlanadi) va **ishlab chiqarish** (hali yo'lda). Boshqa
buyurtmaga konverning faqat QOLGANI taklif qilinadi.

Ishlab chiqarishdagilar **omborga eng yaqini** bo'yicha saralanadi va
yonida omborga tushish sanasi turadi (`v_unit_register.fg_on`: fakt →
tsex boshlig'i qo'ygan reja → marshrut va quvvatdan taxmin). Mijoz
tezroq oladigan konver tepada tursin — menejer «shu kuni beramiz»
deyishi uchun.

**Ekranda «bron» so'zi yo'q.** Bron — ICHKI mexanizm (konverni qatorga
biriktirish); menejer esa buyurtma qay ahvolda ekanini o'qiydi:

  · **Tayyor** — hammasi T/M omborda, chiqarishga tayyor;
  · **Kutmoqda** — bir qismi hali ishlab chiqarishda, omborga kelmagan;
  · **Omborda** — savdo ombor mudiriga yubordi, u chiqarishni kutmoqda;
  · **Chiqib ketdi** — mudir tasdiqladi, mahsulot zavoddan chiqdi va
    mijoz balansiga qo'shildi.

Ikkalasi ham saqlanadigan holat EMAS, har safar bronlardan hisoblanadi
(`assigned_qty > in_warehouse_qty` bo'lsa «Kutmoqda»): saqlangan belgi
konver omborga kelgan kuni haqiqatdan ajralib qolardi. Ro'yxatda filtri
bor (`/api/sales/orders?status=waiting`). Buyurtma baribir BITTA
nakladnoy: yarmi tayyor bo'lgani uchun bo'linmaydi — hammasi omborga
yetib kelmaguncha chiqarilmaydi.

Shu sababdan buyurtma ekranida ham, ro'yxatda ham alohida «bron» ustuni
yo'q: u qator sonini takrorlardi («4 / 4»). **Konver biriktirish ham,
qaytarish ham bitta oynadan** — qatordagi «Konver» tugmasi. Nomzodlar
ro'yxatida shu qatorga allaqachon olingan konverlar eng tepada turadi va
yonida «Qaytarish» tugmasi bo'ladi (`CANDIDATE_WHERE` da `mine`).

**Yopilgan buyurtma YUK XATI bo'lib o'qiladi** (omborga yuborilgan,
chiqib ketgan yoki bekor qilingan) — qog'ozdagi hujjat kabi:

    tepada    korxona nomi (`FIRMA`) va «Yuk xati № 515 · 15.09.26»
    chapda    YETKAZIB BERUVCHI: korxona, menejer va uning telefoni
    o'ngda    MIJOZ: nomi, regioni, qayerga, kutib oluvchi raqami
    qatorlar  mahsulot · rangi · matosi · soni · narxi · summasi, «Jami»
    pastda    imzo joylari — chapda **chiqarib yuboruvchi: ombor mudiri**
              (mahsulotni zavoddan u chiqarib beradi), o'ngda qabul qilib
              oluvchi

Chiqarib yuboruvchining ismi va telefoni chiziq ustida turadi: tasdiqlagan
bo'lsa AYNAN o'sha odam (`shipped_by_name`), hali tasdiqlamagan bo'lsa
**ombor mudiri** — hujjat mahsulot berilayotganda chop etiladi, tasdiq
esa keyin bosiladi. Mudir `omborchi` rolidagi yagona faol xodimdan
olinadi (`keeper`, `GET /orders/:id`); bir nechta bo'lsa bo'sh qoladi va
qog'ozda qo'lda yoziladi. Administrator hisobga olinmaydi: unda hamma
huquq bor, lekin mahsulotni u chiqarmaydi. **Telefon xodim
kartochkasidan keladi** — Xodimlar sahifasida yozilmagan bo'lsa
hujjatda ham chiqmaydi.

Ikki tomon bir xil kenglikda — yuk xati shunday o'qiladi. Bo'sh maydon
umuman yozilmaydi. **Mijoz balansi ekranda turadi, qog'ozga chiqmaydi**
(`.no-print`): yuk xati mijozning qo'liga beriladi va u yerda korxonaning
ichki hisobi yozilib turishi shart emas. Pul kirim sanasi, «Omborga
yuborildi» qatori va «Qaytarib olish» tugmasi ham shunday — ular ish
qurollari, hujjatning o'zi emas. Ism ham, telefon ham BAZADAN keladi
(`shipped_by_name`, `shipped_by_phone`) — kodga yozilmaydi (4-qoida). **«Chop etish»** tugmasi bor: qog'ozga faqat hujjat
tushadi (ro'yxat ham, tugmalar ham chiqmaydi). Korxona nomi kodda bitta
qator (`FIRMA`) — u mijoz ma'lumoti emas, zavodning o'z nomi.

Ro'yxatda ham tugmasi boshqa: tahrirlanadiganda ✎, yopilganda 👁 —
qatorning o'zi ham bosiladi.

**Yuk xatini OMBOR MUDIRI chop etadi.** Zavodda tartib shunday:
mudir hujjatni chiqaradi → haydovchining qo'liga beradi → mashina
ortiladi → va SHUNDAN KEYIN «Chiqarib yubordim» ni bosadi. Tasdiqdan
keyin chop etish kech bo'lardi — qog'oz allaqachon yo'lda.

Uning savdo huquqi yo'q (`omborchi` — faqat `warehouse.*`), ya'ni
buyurtma oynasi unga ochilmaydi. Shuning uchun hujjatga alohida yo'l bor:
`GET /api/sales/waybill/:id` (savdo ham, ombor ham o'qiydi) va
`public/yukxati.html` — tugmasi ombor «Jo'natish» tabidagi har
kartochkada. Sahifa faqat O'QIYDI: buyurtma ham, bron ham u yerdan
o'zgarmaydi; balans ham berilmaydi — mijozning qarzi ombor mudirining
ishi emas.

**Hujjatning o'zi bitta faylda** — `public/yukxati.js`
(`Waybill.html(...)`), uslubi `public/yukxati.css` da. Uni ikki sahifa
chizadi (savdo buyurtmani ochganda va mudir chop etganda) va qog'ozda
ikkalasi bir xil chiqishi kerak: matn ikki nusxada bo'lsa biri ertaga
ikkinchisidan orqada qolardi.

**«Qayerda» ustuni** (tahrir ko'rinishida, qator oxirida) — biriktirilgan
konver hozir qayerda: «T/M ombor» yoki «Arra · Korpus tsexi», yonida
nechtaligi. Buyurtma omborga yuborilgach ustunlar hujjatga aylanadi,
shuning uchun o'sha ma'lumot **«Konverlar qayerda»** kartochkasiga
ko'chadi (`trackCard`): har konver, turgan bo'limi va tsexi, soni va
omborga tushish sanasi. Omborga tushgach bo'lim yozilmaydi — «T/M
ombor · turibdi» bo'lib qoladi: konver endi tsexda emas, javonda.
Kartochka `.no-print` — yuk xatiga chiqmaydi, u ish quroli. Chiqib
ketgan va bekor qilingan buyurtmada ko'rsatilmaydi: mahsulot zavodda
yo'q. Shusiz savdo «mahsulotim qayerda» degan savolga javob topolmasdi:
ombor sahifasida faqat omborga TUSHGANI ko'rinadi, tsexda yurgani
qoldiqda yo'q.

**Ro'yxatda ham shu ustun bor** (`joylar`, `/api/sales/orders` dagi
`places`): har buyurtmaning konverlari joyi bo'yicha guruhlangan holda
keladi, omborda turgani birinchi. Ilgari ro'yxatda faqat holat turardi
(«Kutmoqda») va joyini bilish uchun buyurtmalarni birma-bir ochish kerak
edi. Ikkitadan ko'p joy bo'lsa qolgani «+N» — hammasi buyurtma ichida.
Konver biriktirilmagan bo'lsa katak BO'SH: «Yangi» holati buni
allaqachon aytadi. Chiqib ketgan va bekor qilingan buyurtma so'ralmaydi
ham — mahsulot zavodda yo'q. Savdo xodimi mijozga «qayerda ekan» degan savolga shu
ustundan javob beradi. Konver keyingi bo'limga o'tsa **o'zi
yangilanadi**: ochiq buyurtma har daqiqada qayta o'qiladi — faqat
kutilayotgani (ishlab chiqarishda koneri bori), faqat oyna ochiq
turganda va BITTA zanjir bilan (izoh: `planTick`).

Server xabarlarida ham «bron» so'zi yo'q: «N tasi buyurtmada — avval
konverni qaytaring».

Bitta bron bo'lsa konverga mijoz va zakaz raqami yoziladi — jurnalda
tsex boshlig'i «bu Alisherniki» deb ko'radi. Bir nechta bo'lsa bo'sh
qoladi: **jurnalda qator bosilganda** ostida bronlar ro'yxati chiqadi
(`GET /api/units/:id/bron`) — kim, nechta, qaysi zakaz.

**Jurnalda uch ustun: «Soni · Bronda · Bo'sh»** — ombor qoldig'idagi
bilan bir xil: soni JISMONAN nechta, bronda mijozga va'da qilingani,
bo'sh esa qolgani. Tsex boshlig'i 10 talik konverni ko'rib «hammasi
bo'sh» deb o'ylardi, holbuki 6 tasi allaqachon mijozniki. **Narx va
summa ustunlari yo'q** (ekranda ham, Excelda ham): ishlab chiqarish
jurnali nechta mahsulot yasalayotganini sanaydi, pulini emas — u savdo
va kassaniki. Narx maydonining O'ZI kartochkada qoladi: mijoz balansi
o'shandan hisoblanadi.

Bronda turgan dona `unit_reservations` dan hisoblanadi va
`registerQuery` da, view da EMAS: `unit_reservations` savdo jadvali va
migratsiyada `register.sql` dan keyin yaratiladi — toza bazada
`v_unit_register` uni topa olmasdi.

«Bajarilgan» degan belgi saqlanmaydi, har safar bronlardan hisoblanadi
(`v_sales_orders`): saqlangan belgi bir kun haqiqatdan ajralib qolardi.

**★ CHIQARISHNI OMBOR MUDIRI NAZORAT QILADI.** Savdo buyurtmani yozadi
va bron qo'yadi, lekin mahsulotni zavoddan CHIQARIB YUBORMAYDI:

    yangi → tayyor/kutmoqda → **omborda** → chiqib ketdi
            (savdo biriktirdi)  (savdo yubordi) (mudir tasdiqladi)

«Omborga yuborish» dan keyin buyurtma savdo uchun YOPILADI — mudir
ko'rib turgan ro'yxat ostidan o'zgarib ketmasin. Kerak bo'lsa savdo
qaytarib oladi (`/unsend`), mudir hali chiqarmagan bo'lsa.

Mudirning «Jo'natish» tabida: nima, qancha, qayerga, kim kutib oladi va
har konver qayerda turgani. Tepasida **filtr**: chiqib ketish sanasi
(dan–gacha), mijoz va zakaz raqami (`shipF`, `shipRows`). Sana —
CHIQIB KETISH sanasi bo'yicha, savdo qachon yuborganiga qarab emas:
mudir kunini «bugun nima ketadi» deb tuzadi. Mijozlar ro'yxati SHU
ro'yxatdan yig'iladi — unga zavodning barcha mijozi emas, hozir
chiqishni kutayotganlari kerak. Filtr KLIENTDA: ro'yxat kichik (faqat
chiqarilishi kerak bo'lganlar) va yozgan zahoti javob beradi. **Bronning hammasi omborga yetib kelmaguncha
tugma ishlamaydi** — yarmi tsexda turganda «jo'natildi» deb yozib qo'yish
mijoz qarzini ham noto'g'ri oshirardi.

Tasdiqlashda mudir **chiqib ketgan sanani** qo'yadi.

**Pul kirim sanasi** (`orders.payment_on`) — SAVDONIKI, ombor mudiriniki
emas: pul masalasini mijoz bilan menejer kelishadi. Buyurtma
OLINAYOTGANDA so'ralmaydi — o'shanda hali gap bo'lmaydi; saqlangan
buyurtma kartochkasida istalgan payt yoziladi va tuzatiladi,
jo'natilgandan keyin ham (`PATCH /orders/:id/payment`). Bu SANA, summa
emas: mijoz balansiga tegmaydi, to'lovning o'zini kassa moduli yozadi.

**★ SOTILGAN NARX CHIQARISHDA KONVERGA KO'CHADI.** Mijoz YUK XATIDAGI
summani to'laydi, konver kartochkasidagini emas: kartochkadagi narx
ishlab chiqarish uchun qo'yilgan, buyurtma qatoridagi esa menejer mijoz
bilan kelishgani. Ikkalasi har xil bo'lsa balans hujjatdan farq qilib
qolardi — mijoz 2 100 imzolab, qarzdorlikda 2 160 turardi. Tsexdan
kelgan konverda narx umuman bo'lmasligi ham mumkin va o'shanda chiqib
ketgan mahsulot qarzga UMUMAN tushmasdi.

Qatorda narx yozilmagan bo'lsa kartochkadagisi qoladi — yolg'on nol
yozilmaydi. Allaqachon chiqib ketganlar bir martalik ko'chirish bilan
to'g'rilandi (`migration_flags`: `sotilgan-narx`), faqat ANIQ holatda:
buyurtmada shu mahsulotdan bitta qator bo'lsa. Ikkita bo'lsa (bir xil
mahsulot ikki rangda, ikki narxda) qaysi biri ekanini bilib bo'lmaydi
va taxmin qilingan narx yolg'on qarz yozardi.

Tasdiqlangach konverlar `shipped` bo'ladi, `ship_on` yoziladi, ombor
qoldig'idan chiqadi va mijoz balansiga qo'shiladi. Konverning faqat
BRON QILINGAN qismi chiqadi: qolgani boshqa mijozniki bo'lishi mumkin,
shuning uchun kerak bo'lsa shu yerda bo'linadi.

**Zahira** (`is_stock`) — buyurtmasiz, oldindan ishlangan mahsulot. U
`sections.is_hold` belgili bo'limda buyurtma kutadi (korpus → Rang sepish,
stul → Lak). Zahiraga muddat bashorat qilinmaydi.

---

## Kassa

**Ikkita pul joyi** (`cash_accounts`): **Asosiy kassa** (naqd) va **Bank
hisob raqami**. Ikkalasida ham so'm va dollar yuriydi. Ro'yxat bazada —
yangi hisob raqami ochilsa `sql/cash.sql` ga bitta qator, sahifaga
tegilmaydi (omborlar bilan bir xil).

**Har kassaning O'Z asosiy valyutasi** (`cash_accounts.main_ccy`):
asosiy kassada naqd DOLLAR yuradi, bank hisob raqamida esa oldi-berdi
SO'MDA bo'ladi. Hisob-kitob baribir dollarda, lekin ekrandagi KATTA
raqam o'sha joyda kunda ishlatiladigan pulda turadi — dollarga
aylantirilgan raqamni buxgalter bank ko'chirmasi bilan solishtira
olmasdi. Ostida ikkalasi ham yoziladi, ya'ni hech narsa yashirilmaydi.
Kassa ichida ham shu valyuta birinchi kartochka bo'lib turadi.
Belgi KASSADA, kodda emas.

**Hisob-kitob DOLLARDA.** So'mda kelgan pul o'sha operatsiyaning kursi
bilan dollarga aylanadi (`amount_usd`) va mijozning yoki ta'minotchining
qarzidan SHU dollar ayiriladi. Kurs operatsiya bilan birga qotib qoladi:
ertaga kurs o'zgarsa kechagi to'lov qayta hisoblanmaydi. **Kursni har
operatsiyada pulni kiritayotgan odam yozadi** (zavod qarori).

**★ HAR OPERATSIYA — QAYERDAN → QAYERGA.** Pul o'zidan-o'zi paydo
bo'lmaydi va yo'qolmaydi. Shuning uchun bitta jadval (`cash_ops`) va har
qatorda ikki tomon; tomon beshta turdan biri: `account` (kassa),
`worker` (xodimning qo'lidagi pul), `customer`, `supplier`,
`expense` (harajat). Zavoddagi hamma harakat shu ikkilik bilan yoziladi:

    menejer mijozdan pul oldi         mijoz    → menejer
    kassir menejerdan qabul qildi     menejer  → asosiy kassa
    xodim qo'liga pul berildi         kassa    → xodim
    ta'minotchiga to'lov              kassa    → ta'minotchi
    harajat                           kassa    → harajat moddasi
    kassalar aro / valyuta almashish  kassa    → kassa

Har operatsiya `v_cash_flow` da IKKI QATOR bo'lib ochiladi (beruvchida
minus, oluvchida plyus) — shundan keyin har qanday qoldiq bitta yig'indi
bo'lib qoladi: kassaniki ham, xodim qo'lidagi puliki ham, mijozning
to'lovi ham. Ikkita alohida hisob yozilmaydi va ular bir-biridan ajralib
ketmaydi.

**★ MENEJER OLGAN PUL DARROV KASSAGA TUSHMAYDI.** Menejer mijozdan pulni
oldi — **mijozning qarzi o'sha zahoti kamayadi** (mijoz to'ladi, uning
oldida savol qolmadi). Lekin pul hali kassada emas, MENEJERNING qo'lida:
u kassirga topshirguncha korxonaga qarzdor bo'lib turadi
(`v_worker_cash`). Kassir sanab olgach ikkinchi operatsiya yoziladi va
pul asosiy kassaga qo'shiladi. Ikki bosqich tsexdagi topshirish bilan
bir xil sababdan: hech kimning qo'l ko'tarishisiz pul kassaga kirib
qolmasin.

Xodim qo'liga berilgan pul ham shu balansda: ikkalasi ham bitta narsa —
xodimning qo'lidagi, korxonaga qarz pul.

**★ HARAJAT QAYSI OYNING FOYDA-ZARARIDA.** To'lov bugun ketadi, harajat
esa boshqa oyniki bo'lishi mumkin: sentabrda to'langan avgust ijarasi
AVGUST foydasini kamaytiradi. Shuning uchun to'lov sanasi (`op_date`) va
hisobot oyi (`pl_month`) ALOHIDA, va harajat yozilayotganda oy
**so'raladi**. Modda ham, oy ham majburiy (`cash_ops_expense_needs`):
ikkalasisiz harajat hisobotda «boshqa» bo'lib yo'qolib ketardi. Hisobot
`v_expenses` — to'lov sanasi bo'yicha emas, hisobot oyi bo'yicha.

**Harajat moddalari** (`expense_groups` → `expense_items`) — guruh va
kichik guruh. Zavod ro'yxati **kiritilgan** (`sql/cash.sql`): to'qqizta
guruh — ta'minot, asosiy vositalar, kommunal, maosh, xo'jalik,
marketing, moliyaviy, xizmat va boshqa.

Modda O'CHIRILMAYDI: u operatsiyalarda ishlatilgan bo'lishi mumkin va
eski hisobotdan yo'qolib qolardi — keraksizi `active = false` qilinadi.
Qayta deploy'da nomi ham tiklanmaydi (`ON CONFLICT DO NOTHING`):
saytdan tuzatilgan nom keyingi migratsiyada eskisiga qaytib qolmasin.

**Xodimning qo'lida ham boshlang'ich qoldiq bor** (`workers.opening_*`)
— tizim ishga tushgan kuni pul faqat kassada emas, odamlarning qo'lida
ham turadi: ta'minotchi bozorga ketgan, menejerda mijozdan olgani bor.
Kassadan berish bilan yozib qo'yilsa kassa qoldig'i shuncha kamayib
ketardi, holbuki o'sha pul kassadan bugun chiqmagan.

Shu sababdan xodimning qo'li ham **JOY** bo'lib ochiladi:
`/kassa.html?a=w12` — sarlavhada «qo'ldagi pul» yorlig'i bilan, ichida
o'sha odamning lentasi va «✎ Boshlang'ich qoldiq» tugmasi. Kassalar
ro'yxatida ostida «Xodimlar qo'lidagi pul» bo'limi turadi: qo'lida puli
borlar VA belgisi bor xodimlar (`can_hold_cash`) — biri «kimdan pul
olsam bo'ladi», ikkinchisi «kimga qoldiq yozishim kerak» degan savolning
javobi.

**Kassa — kartochka, xodim — JADVAL.** Kassa ikkita va har biri o'z
joyi: qoldig'i yirik raqam bo'lib turishi kerak. Xodim esa o'ntacha va
ko'pchiligining qo'lida nol turadi — o'nta kartochka butun ekranni
egallab, javobi bor bittasi ularning orasida yo'qolib ketardi.

Jadval UCH ustun: **kim · qo'lida · jami $**. Beshta ustun keng
ekranda bir-biridan uzoqlashib, ismning javobi narigi chekkada
qolardi; ustiga ko'pchilikning katagi bo'sh bo'lib, jadval siyrak
ko'rinardi. Oxirgi harakat ismning OSTIDA, mayda yozuvda — u tafsilot,
ustun emas. «Qo'lida» faqat QO'SHIMCHA gap aytganda yoziladi: dollari
bo'lgan odamning yonida «630,00 $ · 630,00 $» turardi, so'm bo'lsa esa
jami uni kurs bilan aylantirgan va tafsilot qo'lida aslida nima
turganini aytadi. Eng ko'p puli bori tepada, qator bosilsa o'sha
odamning sahifasi ochiladi.

**«Mening qo'limdagi pul» kassirda alohida kartochka EMAS** — uning
puli kassada, qo'lida emas, va kartochka baribir nol bo'lib turardi.
Qo'liga pul olsa jadvalda o'zi chiqadi. Menejerda esa u yagona joy,
shuning uchun unga kartochka bo'lib qoladi. Sahifa u yerda faqat O'QIYDI: pul berish ham, qabul qilish ham
kassaning o'z oynasidan bo'ladi, chunki ikkinchi tomoni baribir kassa.
Yozadigan odam — kassir (`cash.manage`), xodimning o'zi emas.

**Boshlang'ich qoldiq** (`cash_accounts.opening_*`) — tizim ishga
tushgan kundagi pul. Bir martalik raqam, mijozning `opening_debt` i
bilan bir xil mantiq: operatsiya EMAS, chunki uning «qayerdan» i yo'q —
pul tizimdan oldin ham bor edi. Shusiz kassa birinchi kundanoq minusda
turardi. So'mdagi qoldiq uchun o'sha kundagi kurs ham yoziladi.

**Operatsiya O'CHMAYDI, bekor qilinadi** (`status='cancelled'`):
qoldiqdan chiqadi, tarixda qoladi. Pulda o'chirilgan qator eng yomon
narsa.

**Avval KASSALAR ro'yxati, keyin kassaning ichi** — omborlar bilan bir
xil idiom: zavodda ikkita pul joyi bor va ular bir-biriga o'xshamaydi,
qoldig'i ham alohida sanaladi. `/kassalar.html` — ro'yxat (har kassa
kartochkasida so'm, dollar va jami $, yonida xodimning o'z puli);
`/kassa.html?a=MAIN` — bitta kassaning ichi. `a=me` — xodimning O'Z
qo'lidagi puli: menejer uchun bu uning yagona «kassasi», shuning uchun
ro'yxat unga to'g'ridan-to'g'ri o'sha sahifani ochadi (bitta ombor
qolganda ham shunday).

Kassa ichida **uchta tab** — bu yerga nima KELDI, bu yerdan nima KETDI,
va hammasi. Yo'nalish SHU joyga nisbatan: menejerdan kassaga o'tgan pul
menejerda chiqim, kassada kirim, va ikkalasi ham to'g'ri. Lentada
ikkinchi tomon yoziladi, o'zi emas — har qatorda bittasi baribir
«Asosiy kassa» bo'lardi.

**Order — bankdagi to'lov topshiriqnomasiga o'xshash oyna.** Kassir
qog'ozdagi hujjatni to'ldirgandek to'ldiradi: tepada hujjat nomi va
qaysi kassa, ostida sana, kimdan/kimga, summa, valyuta va kurs, eng
pastda dollardagi raqam yirik shrift bilan. **Harajat ham chiqimning bir
turi**: «Kimga» ro'yxatidan harajat moddasi tanlansa foyda-zarar oyi shu
zahoti so'raladi.

**★ CHIQIM IKKI BOSQICH: avval GURUH, keyin uning ichidagi.** Bitta
ro'yxatda o'ttizta «Guruh · Modda» qatori turardi va kassir kerakligini
topguncha butun ro'yxatni o'qib chiqardi. Endi «Kimga» da avval
to'qqizta harajat guruhi ko'rinadi, ustiga **Ta'minotchiga to'lov** va
**Xodim qo'liga pul** — kassir uchun ular ham «qayerga» degan savolning
javobi, guruhlardan farqi yo'q. Tanlangach ikkinchi katak ochiladi va
faqat o'shaning ichidagilar turadi.

**★ TA'MINOTCHIGA TO'LOVDA UCHINCHI BOSQICH.** «Ta'minotchilarga
to'lov» moddasi tanlansa QAYSI ta'minotchi ekani so'raladi: pul ma'lum
bir odamga ketadi va uning qarzidan ayrilishi kerak, modda esa
foyda-zararda qoladi. Ikkalasi ham yoziladi — tomon `supplier`, yonida
`expense_item_id` va `pl_month`. Shu sababdan `v_expenses` endi
`to_kind = 'expense'` ni emas, **moddaning O'ZINI** qidiradi: aks holda
ta'minotchiga to'langan pul hisobotdan yo'qolib ketardi.

Belgi MODDADA (`expense_items.needs_supplier`), kodda emas: ertaga
«Yetkazib berish xarajati» ham ta'minotchiga bog'lansa, o'sha qatorga
bitta `true` yoziladi.

**Ta'minotchiga to'lovni PODOTCHYOT OLGAN XODIM ham yozadi**: ombor
mudiri bozorda naqd to'laydi va o'sha odamning qarzi kamayishi kerak.
Pul xodimning qo'lidan chiqadi (`worker → supplier`), modda esa
foyda-zararda o'z qatorida qoladi va **majburiy**: xodim qaysi guruhga
sarflay olishi shundan tekshiriladi. Shu sababdan ta'minotchilar
ro'yxati `/refs` da HAMMAGA keladi — u spravochnik, unda na qarz bor,
na to'lov. Ilgari faqat kassirga kelardi va xodimda uchinchi bosqich
bo'sh chiqardi.

**Qirqta ta'minotchi ro'yxatdan ko'z bilan qidirilmaydi** — uzun
ro'yxat ustida qidiruv katagi turadi (o'ntadan oshsa o'zi chiqadi).
**Foyda-zarar oyi ham yozilmaydi, TANLANADI**: «2026-09» ni terish
formatni eslab turishni talab qilardi, ro'yxatda esa oy nomi bilan
turadi va xato yozib bo'lmaydi.

**Ta'minotchi va xodim ro'yxatda HAR DOIM turadi**, bo'sh bo'lsa ham:
ilgari bo'sh bo'lsa qator umuman chiqmasdi va kassir «xodimga pul
berish yo'q ekan» deb o'ylardi. Endi tanlanadi va ikkinchi katak nima
qilish kerakligini aytadi — «Xodimlar sahifasida belgilang».

**Kurs oldindan to'ldiriladi** — oxirgi ishlatilgani (`/refs` dagi
`rate`). Zavod qoidasi o'zgarmadi, kursni baribir odam yozadi; lekin
uni har safar noldan terib o'tirish shart emas: kurs kunda bir marta
o'zgaradi, operatsiya esa kuniga o'nlab bo'ladi. **Kursning O'ZI
hisoblanmaydi**: so'm va dollar qoldig'i ikkita ALOHIDA pul, biri
ikkinchisining aylantirilgani emas — `uzs/usd` bo'lsa o'ylab topilgan
kurs chiqardi va butun hisob shunga qurilardi. Boshlang'ich qoldiq
oynasida esa **jami dollarda** saqlashdan OLDIN ko'rinadi: bir nol
ortiqcha yozilgani shu yerda bilinadi.

**Kirim va chiqim ro'yxatida XODIM YO'Q** (zavod qarori): korxonaga pul
mijozdan keladi, ta'minotchiga va harajatga ketadi. Xodimning qo'lidagi
pul korxonaning O'Z puli — uning kassaga kelishi kirim emas,
TOPSHIRISH. Shuning uchun u alohida oynada: **«Xodimdan qabul qilish»**.

Tugma faqat qo'lida korxona puli bor xodim bo'lganda chiqadi va
ro'yxatda faqat o'shalar turadi — yonida qo'lidagi summa bilan («Alisher
· 400,00 $»), kassir sanab olgan pulini shu raqam bilan solishtiradi.
Zavodning yigirmata xodimini ro'yxatga chiqarish «kimdan pul olsam
bo'ladi» degan savolga javob bermasdi. Topshirilgach xodim ro'yxatdan
o'zi chiqadi: qo'lida hech narsa qolmadi, ikkinchi marta qabul qilib
bo'lmaydi.

**★ PODOTCHYOT «HISOB BERISH SHARTI BILAN»** — xodim qo'lidagi puldan
nimaga sarflaganini O'ZI yozadi («Mening pulim» sahifasidagi «Harajat
yozish»). Pul qo'lidan chiqadi va harajatga aylanadi, podotchyot shu
bilan yopiladi. Kassirga og'zaki aytib, u yozib o'tirmaydi.

Lekin hamma hamma narsani yoza olmaydi: **qaysi harajat guruhlariga
sarflay olishi XODIMDA belgilanadi** (`worker_expense_groups`) — ombor
mudiri va korpus boshlig'i barcha harajatni qiladi, tsex boshliqlari
esa faqat oylik uchun. Cheklov GURUH bo'yicha: yangi modda qo'shilsa
ro'yxat o'zi kengayadi. **Qator yo'q = hamma guruh** — tsex doirasi
bilan bir xil qoida (`scope_shop_id`).

Huquqi `cash.entry`, ya'ni `omborchi` va `ishlab_boshl` ham oladi —
lekin bu unga kassani ochmaydi: qoldiq ham, boshqa xodimning puli ham
ko'rinmaydi. Tomonlarni ham server qo'yadi: xodim yuborgan `from_kind`
e'tiborga olinmaydi, pul FAQAT o'z qo'lidan chiqadi. «Mijozdan pul
olindi» tugmasi esa savdo huquqi bor xodimda — tsex boshlig'iga u
tugma ko'rsatilmaydi.

**Pul hamma xodimga BERILMAYDI** — zavodda beshta odam oladi (zavod
qarori). Shuning uchun berish ham alohida oynada: **«Xodimga
podotchyot»**, ro'yxatida faqat belgisi qo'yilganlar.

Tugmasi «Xodimdan qabul qilish» ning YONIDA turadi — ikkalasi bitta
ishning ikki tomoni va kassir ularni kuniga bir necha marta qiladi.
Chiqimning ichida ham qolaveradi («Xodim qo'liga pul» guruhi), lekin
o'sha yo'l har safar ikki bosqichdan o'tishni talab qilardi. Ro'yxat
bo'sh bo'lsa sababi yoziladi: «Xodimlar sahifasida «Qo'liga pul
beriladi» katagini belgilang». Belgi XODIMDA
(`workers.can_hold_cash`), Xodimlar sahifasida qo'yiladi — pul olish
lavozimga emas, ishonchga bog'liq, va ro'yxat kodga yozilmaydi
(4-qoida): oltinchi odam qo'shilsa bitta katakcha belgilanadi.

Tekshiruv **serverda**: kassadan xodimga pul faqat belgisi bor odamga
chiqadi, to'g'ridan-to'g'ri id yuborilsa ham qabul qilinmaydi. Faqat
KASSADAN chiqqani tekshiriladi — menejer mijozdan olgan pul ham
«xodimga» tushadi, lekin u berilgan pul emas, o'zi yig'ib olgani.

Hujjat raqami SAQLASHDA beriladi (`P26-0004`) — oldindan band qilib
qo'yilsa, bekor qilingan oynadan bo'sh raqam qolardi.

**Boshlang'ich qoldiq** kassa ichidagi **«✎ Boshlang'ich qoldiq»**
tugmasida.

**Ikki xil odam, ikki xil ekran**:

  · **`cash.entry`** — SAVDO MENEJERI. Bitta yo'l (`mijoz → o'zi`), o'z
    qo'lidagi pul va o'z kirimlari; sahifa unga «Mening pulim» bo'lib
    ochiladi. Kassa qoldig'i ham, boshqa xodimning qo'lidagi puli ham unga
    ko'rinmaydi — serverda ham tomonlarni o'zi qo'yadi, klient
    boshqasini yuborsa qabul qilinmaydi. O'z qo'lidagi pulni sarflay
    olmaydi ham: chiqim tugmasi faqat kassada va faqat kassirda.
  · **`cash.manage`** — KASSIR va BUXGALTER: kassalar ro'yxati, har
    kassaning kirim/chiqimi, ko'chirish, boshlang'ich qoldiq, bekor
    qilish.
  · **`cash.view`** — faqat o'qish (rahbariyat).

Savdo yo'nalishi chegarasi bu yerda ham: B2B menejeri eksport mijozidan
to'lov yozib qo'ya olmaydi (`channelsOf`).

**Mijoz balansi to'ldi**: `boshlang'ich qarz + chiqib ketgan mahsulot −
TO'LOVLAR`. Shu sababdan `v_customer_sales` va `v_customer_ledger`
**`sql/cash.sql` ga ko'chirildi** — ular endi `cash_ops` ni o'qiydi, u
esa migratsiyada eng oxirida yaratiladi. Eski joyida qolsa toza bazada
yo'q jadvalni izlab yiqilardi, ya'ni sayt ko'tarilmasdi.

---

## Moliyaviy hisobotlar

Kassaga yozilgan harajat IKKI hisobotga boradi va ikkalasi bir xil
raqamni bermaydi — bermasligi ham kerak:

**Foyda-zarar** (`v_pl_month`, `/foyda-zarar.html`) — «qancha ishladik».
Tushum CHIQIB KETGAN mahsulotdan (`ship_on`), buyurtma yozilgan kundan
emas: buyurtma hali pul emas. Harajat esa HISOBOT OYI bo'yicha
(`pl_month`) — sentabrda to'langan avgust ijarasi avgust foydasini
kamaytiradi.

**Pul oqimi** (`v_cash_month`, `/pul-oqimi.html`) — «pul qayerda».
Sanasi TO'LOV kuni, kirimi esa sotuv emas, MIJOZDAN KELGAN PUL. Ichki
harakat hisobga olinmaydi: menejerdan kassaga topshirish ham, kassalar
aro ko'chirish ham pulni korxonadan chiqarmaydi — aks holda bitta to'lov
ikki marta kirim bo'lib ko'rinardi.

Shuning uchun «foyda bor, pul yo'q» degan holat aynan shu ikki hisobotni
yonma-yon qo'yganda ko'rinadi.

**Sof aylanma kapital** (`/aylanma-kapital.html`,
`GET /api/cash/working-capital`) — uchinchi savol: «qo'limizda nima
qoldi». Foyda-zarar «qancha ishladik», pul oqimi «pul qayerda» deydi,
bu esa korxonaning AYLANMA mablag'i: aktivdan majburiyat ayirilgani.
Foyda bo'lishi, lekin uning hammasi mijozning qarzida yotishi mumkin —
buni faqat shu hisobot ko'rsatadi.

**Ustun — SANA HOLATI, oy emas**: balans oraliqning emas, kunning
suratini oladi. Oyiga ikkita nuqta — **15-sana va oyning oxirgi kuni**
(zavod qarori). Kelajakdagi sana ustun bo'lmaydi: u bugungi holatni
boshqa kun deb yozib qo'yardi.

    AKTIV   T/M ombor · ishlab chiqarishda · xom ashyo · kassa va bank ·
            xodimlar qo'lida · mijozlarning qarzi · ta'minotchiga avans
    PASSIV  ta'minotchilarga qarz · mijozlardan avans
    SOF     aktiv − passiv

Har raqam O'SHA KUN holatiga hisoblanadi: kassa — boshlang'ich qoldiq
(sanasi kelgan bo'lsa) va o'sha kungacha bo'lgan harakat; ombor —
o'sha kuni javonda turgani (`fg_on <= kun` va chiqib ketgani keyin);
qarzlar — lentadagi saldo. **Xodim qo'lidagi pul AKTIV**: u
korxonaning puli, shunchaki javonda emas.

**Ishlab chiqarishdagi mahsulot ham aktiv** — tugallanmagan ishlab
chiqarish: zaxira xom ashyodan tayyor mahsulotgacha uchta holatda
turadi va o'rtadagisi ham korxonaniki. Qatori ochilsa **tsex kesimi**
chiqadi va konver o'sha kunda QAYSI tsexda turgani TARIXDAN o'qiladi
(`unit_moves`), hozirgi joyidan emas — aks holda avgust ustuni
bugungi joylashuvni avgust deb yozib qo'yardi.

**Xom ashyo qatori TURADI, lekin nol** — moduli hali yozilmagan.
Qator umuman chizilmasa hisobot to'la ko'rinardi, holbuki bitta aktivi
yetishmaydi: bo'sh qator savol, yo'q qator esa yolg'on.

**Tannarx hali yo'q**, shuning uchun tayyor mahsulot ham, ishlab
chiqarishdagi ham SOTUV narxida sanalgan — ikkala raqam ham yuqori
chegara, ichida foyda ham turibdi. Sahifa buni o'zi aytib turadi. Xom
ashyo hisobi yozilgach tannarx shakllanadi va bu ikki qator o'zi
to'g'rilanadi; sahifa o'zgarmaydi.

**Ustun — OY.** Direktorning savoli «qaysi oyda nima bo'ldi»: bitta
yig'indi raqam unga javob bermaydi, oylar yonma-yon turgandagina o'sish
ham, sakrash ham ko'rinadi. Oylar ORALIQdan chiqadi, ma'lumotdan emas —
harajati yo'q oy ham bo'sh ustun bo'lib tursin: bo'sh ustun javob, yo'q
ustun esa savol. Guruh qatori bosilsa ostidan moddalari chiqadi. Manfiy
raqam qizil.

**Tannarx yo'q** — xom ashyo hisobi hali yozilmagan, shuning uchun bu
«yalpi foyda» emas: tushumdan zavodning PUL harajatlari ayirilgani.
Sahifa buni o'zi aytib turadi, aks holda raqam boshqa narsa deb
o'qilardi.

Huquqi `cash.view` / `cash.manage`: pul hisoboti buxgalter va
rahbariyatniki. Shu sababdan «Hisobotlar» moduli endi ikki huquqdan
birini oladi — ishlab chiqarish hisobotlari `production.reports` da
qolaveradi.

---

## Kim nima ko'radi

Huquqlar: `permissions` → `roles` → `role_permissions` → `worker_roles`.
Rol huquqlari **kodda** (`sql/core-seed.sql`), saytdan tahrirlanmaydi.

| Rol | Huquq | Ko'radi |
|---|---|---|
| `tsex_usta` | `production.entry`, `production.request`, `production.plan` | faqat «Bo'limlar aro harakat», faqat o'z tsexi; konver so'raydi va muddat rejasini qo'yadi |
| `kirituvchi` | `production.entry`, `production.request` | **faqat «Konver qo'shish»**: ishlab chiqarishga nima kirishini yozadi, konverni rahbariyat ochadi. Jurnal, boshlang'ich qoldiq va hisobotlar YO'Q |
| `ishlab_boshl` | + `production.manage` | hammasi, tarixni tuzatish |
| `omborchi` | `warehouse.*` | faqat «Ombor» bo'limi — barcha omborlar |
| `sotuvchi` | `sales.*`, `warehouse.view`, `production.view` | mijozlar, buyurtmalar, T/M ombor + vitrinalar qoldig'i, jurnal — ombordan **faqat o'qish**. Vitrina biriktirilsa faqat o'sha nuqta + T/M ombor |
| `admin` | barchasi | hammasi |

**`production.view` jurnalni ochadi, `production.reports` esa zavod
ko'rinishi va panelni.** Ikkisi alohida: sotuvchi o'z buyurtmasi qaysi
bo'limda turganini bilishi kerak, zavod yuklamasi esa uning ishi emas.

**Savdo jurnalni o'zgartira olmaydi.** Filtr ishlaydi, qolgani yo'q:
konver yaratish, o'tkazish, tahrirlash va bekor qilish — hammasi ishlab
chiqarishniki. Omborda esa faqat qoldiq: qabul qilish va kirim/chiqim
tarixi ombor mudiriniki. Tekshiruv serverda, tugmani yashirish bilan
chegaralanilmaydi.

**Qaysi omborni kim ko'rishi — `warehouses.perm` ustunida**, kodda emas.
`NULL` — `warehouse.view` yetarli (T/M ombor va vitrinalar: ikkalasida ham
tayyor mahsulot turadi); `warehouse.material` — xom ashyo, MDF, furnitura
(ombor mudiri va ta'minot; savdoga ko'rinmaydi). Yangi ombor qo'shilganda
huquq shu qatorga yoziladi, modulga tegilmaydi. Ko'rinadigan ombor bitta
bo'lsa, «Omborlar» sahifasi to'g'ridan-to'g'ri o'shanga o'tkazadi.

**Vitrina doirasi** — `worker_roles.scope_warehouse_id`. Vitrinalar
shaharning uch nuqtasida va har birida o'z sotuvchisi bor. Sotuvchiga
nuqtasi biriktirilsa u FAQAT o'sha vitrinaning qoldig'ini ko'radi —
ustiga **T/M omborni**: zavodda nima turganini bilmasa mijozga «olib
kelamiz» deya olmaydi (`warehousesOf` → `whScope`,
`modules/warehouse.js`). Bu KO'RISH doirasi: buyurtmaga esa vitrina
mahsuloti umuman biriktirilmaydi — o'zinikiniki ham.

Doira bo'sh = hamma ombor: bosh ofis menejeri (B2B, B2C, eksport) barcha
tayyor mahsulot omborlarini ko'radi. **Ishlab chiqarish jurnali esa
hammaga ochiq** — chegara omborniki, jurnalniki emas: sotuvchi o'z
buyurtmasi qaysi bo'limda turganini bilishi kerak. Xodimlar sahifasida
savdo roli tanlanganda yo'nalish yonida vitrina ham so'raladi.

**Savdo yo'nalishi** — `worker_roles.scope_channel`. Menejerga kanal
biriktirilsa (B2B, EXPORT...), u faqat o'sha kanaldagi mijozlarni ko'radi.
Bo'sh = hamma kanal. Tsex doirasi bilan bir xil: filtr emas, **chegara**
(`channelsOf(req)`). Xodimlar sahifasida savdo roli tanlanganda tsex
o'rniga yo'nalish so'raladi.

**Tsex doirasi** — `worker_roles.scope_shop_id`. Doira bo'sh = hamma tsex.
Bu filtr emas, **chegara**: `scopeOf(req)` orqali so'rovga qo'shiladi,
klient uni o'chira olmaydi.

**Tarixga tegadigan maydonlar** faqat `production.manage` da: konveyer
raqami, soni, **mahsulot**, turgan joyi, FAKT sanalar.

**Mahsulotni jurnaldan tuzatish mumkin**: qog'oz jurnaldan ko'chirishda
boshqa fason tanlab qo'yish oddiy hol va keyin konverni o'chirib, qayta
kiritishdan boshqa yo'l qolmasdi — u esa konveyer raqamini yo'qotardi.
Uchta chegara bor: chiqib ketgan konverning mahsuloti o'zgarmaydi (u
mijozning yuk xatida va balansida), bronda turgani ham (mijozga AYNAN
shu mahsulot va'da qilingan), va turgan bo'limi yangi marshrutda
bo'lishi shart — aks holda konver marshrutdan tashqarida qolib, usta
ekranida «keyingi bo'lim» tugmasi yo'qolardi. Mahsulot almashsa
`flow_log` yozuvlari ham ko'chadi (zavod ko'rinishida eski mahsulot
yasalayotgandek turmasin) va T/M ombor qoldig'i ikkala mahsulot bo'yicha
qayta hisoblanadi. Oynada mahsulot tanlanganda bo'limlar ro'yxati shu
zahoti YANGI marshrutdan o'qiladi. Tekshiruv **serverda**
(`modules/units.js`, `RESTRICTED`) — katakni yashirish himoya emas.

**Ombor qoldig'i — AYLANMA.** Jadvalda to'rtta raqam: **Kirdi ·
Chiqdi · Bronda · Qoldiq**. Sana ikki xil ishlaydi va buni bilib
qo'yish kerak: **kirdi/chiqdi tanlangan ORALIQ bo'yicha**, **bronda va
qoldiq esa HOZIRGI holat**. Boshqacha bo'lishi mumkin emas —
«1-sentabrdagi qoldiq» boshqa savol va uni oraliq filtri bilan
aralashtirib bo'lmaydi; sahifa buni o'zi yozib turadi.

Qator IKKI manbadan tushadi (`FULL JOIN`): hozir omborda turgani
(`v_fg_units`) va davr ichida qimirlagani (`v_fg_moves`) — kelib, o'sha
davrning o'zida chiqib ketgan mahsulot ham qatorda ko'rinishi kerak,
garchi undan omborda hech narsa qolmagan bo'lsa ham.

Eng ostida **JAMI** qatori, o'lchov birligi bo'yicha ajratilgan: dona
bilan komplektni qo'shib bo'lmaydi. Alohida kartochka qilinmadi — ko'z
jadvaldan chiqib, qaysi raqam qaysi ustunniki ekanini qidirib qolardi.

**Qabul qilish ro'yxatida ham «N buyurtmada» turadi** — jurnaldagi bilan
bir xil raqam, `v_unit_bron` dan. Qabul qiluvchining ishi navbat tuzish:
ichida mijoz kutayotgan konver avval qabul qilinsa, o'sha kuniyoq
chiqarib yuboriladi. Shu sababdan saralash ham shunga qarab
(`ORDER BY booked_qty DESC`), va yonida jo'natilgan sanasi bilan kim
jo'natgani turadi. Bitta mijoz bo'lsa ismi yoziladi, ko'p bo'lsa faqat
soni: qatorga uchta ism sig'maydi va baribir o'qilmasdi.

**T/M ombor qoldig'i — dona hisobi, pul emas.** Ombor mudiri mahsulotni
SANAYDI, shuning uchun T/M omborda narx va summa ustunlari yo'q; ularning
o'rnida uch raqam turadi:

  · **Soni** — omborda JISMONAN turgani. Bronda turgani ham shu yerda: u
    hali chiqib ketmagan, javonda turibdi. **Inventarizatsiyada sanaladigan
    raqam shu** — mudir javondagi donani shu ustun bilan solishtiradi.
  · **Bronda** — buyurtmaga olingani (`unit_reservations`).
  · **Bo'sh** — broni ayirilgani, ya'ni sotish mumkin bo'lgani.

Yuqorida ham shu: «Jami» kartochkasi (bronda turgani bilan birga) va
«Bo'sh» kartochkasi. Ikkalasi ham o'lchov birligi bilan — dona bilan
komplektni qo'shib bo'lmaydi.

**Vitrinada esa narx va summa qoladi**: u yerda nuqta hisobi yuritiladi
va bron bo'lmaydi (vitrina savdoga chiqmaydi), ya'ni ikkita nol ustun
faqat joy egallardi.

**Ombordagi konverning sonini to'g'rilash.** Kiritishda adashish
bo'ladi: 2 talik mahsulot 4 ta bo'lib yozilib ketadi. Omborga tushgan
konver jurnaldan chiqadi, ya'ni uni tahrirlaydigan joy qolmasdi —
shuning uchun ombor qoldig'ida konver raqamini bosganda «Sonini
to'g'rilash» turadi. Yo'l o'sha: `PATCH /api/units/:id` bilan `qty`,
ya'ni qoldiq, jamlanma hisobot va audit birga yangilanadi. Ombor
mudirida bu ko'rinmaydi — soni tarixga tegadi. **Bron qo'yilgan donadan
kam qilib bo'lmaydi**: mijozga va'da qilingan mahsulot jimgina
yo'qolib qolardi.

**Noto'g'ri kiritilgan konverni bekor qilish** — xuddi shu oynada,
«Konverni bekor qilish». Jurnaldagi «×» bilan bitta yo'l
(`PATCH /api/units/:id`, `status='cancelled'`), lekin omborga tushgan
konver jurnaldan chiqib ketadi va u yerdan topilmasdi. Qoldiqdan ham,
jamlanma `fg_stock` dan ham chiqadi; tarixi o'chmaydi — konver «bekor
qilingan» bo'lib qoladi. Ikki holda bekor qilinmaydi: **bronda turgani**
(mijozga va'da qilingan) va **chiqib ketgani** (u mijozda va balansida —
qaytishi «Qaytib olish» bilan yoziladi, u hali yo'q).

---

## Fayllar

```
erp/
  server.js            modullarni ulaydi
  migrate.js           FILES ro'yxati — TARTIB MUHIM
  db.js                pool, wrap(), audit()
  auth.js              PIN, sessiya, need() guard
  xlsx.js              .xlsx o'qish (kutubxonasiz)
  backup.js            pg_dump → fayl
  sql/                 migratsiya, migrate.js dagi tartibda
  modules/             express router'lar
  public/              sahifalar; app.js — menyu va sessiya
                       yukxati.js — yuk xati hujjati (ikki sahifa chizadi)
                       kassa-form.js — kirim/chiqim orderi oynasi
                       foyda-zarar.html, pul-oqimi.html — moliyaviy hisobot
  test/                node:test, HTTP orqali
```

`sql/` tartibi: core → core-seed → production → production-seed →
catalog-groups → production-sku → units → register → catalog → purchasing →
routes → sales → warehouse → **cash**. Yangi fayl qo'shsangiz `migrate.js` ga
ham yozing. Ombor savdodan keyin: uning view'i savdo qo'shadigan ustunni ham
o'qiydi. Kassa eng oxirida: mijoz balansi va qarzdorlik lentasi endi
to'lovlarni ham o'qiydi.

**Menyuning yagona manbai** — `public/app.js` dagi `MODULES` va `PAGES`.
Yangi sahifa faqat shu ro'yxatga qo'shiladi.

---

## Bir martalik ma'lumot ko'chirishlar

Saytdan qilingan o'zgarishni keyingi deploy qaytarib qo'ymasligi uchun
`migration_flags` ishlatiladi:

```sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM migration_flags WHERE key = 'nom') THEN
    -- ...
    INSERT INTO migration_flags (key) VALUES ('nom');
  END IF;
END $$;
```

---

## Sinash

```bash
npm test
```

Lokal PostgreSQL kerak. Boshqa manzil: `TEST_ADMIN_URL`.
Har ishga tushirishda toza baza quriladi, migratsiya ikki marta o'tkaziladi
(idempotentlik), keyin server ko'tarilib so'rovlar HTTP orqali yuboriladi.

**Buni GitHub ham bajaradi** (`.github/workflows/test.yml`): har push va
har PR da toza PostgreSQL ko'tariladi, testlar yuriydi va migratsiya toza
bazada uch marta o'tkaziladi. Commit yonida yashil yoki qizil belgi
turadi.

⚠️ **Qizil natija deployni TO'XTATMAYDI** — Railway `main` ni baribir
deploy qiladi. To'xtatish uchun GitHub'da `main` himoyalanadi
(Settings → Branches) va o'zgarish PR orqali kiritiladi: shunda
tekshiruvdan o'tmagan kod `main` ga umuman yetib bormaydi.

Deploydan oldin qo'lda ham tekshiring:

```bash
# toza bazada uch marta
npm run erp:migrate && npm run erp:migrate && npm run erp:migrate
# eski baza ustida ham — bu «cannot drop columns from view» ni tutadi
```

---

## Keyingi qadamlar

Tartib muhim: modul ma'lumotsiz ishga tushmaydi, ma'lumot esa zavoddan
keladi. Shuning uchun avval kiritish, keyin modul.

1. **T/M ombor qoldig'i** — omborda hozir turgan mahsulotlar: konveyer
   raqami, mahsulot, soni, rangi, matosi, omborga kirgan sanasi.
2. **Mijozlar bazasi** — nomi, telefoni, regioni, kanali.
   (Ikkalasi ham Excel'da bo'lsa yuklash yoziladi, qo'lda terilmaydi.)
3. **Savdo** — YOZILDI (`sql/sales.sql`, `modules/sales.js`,
   `public/buyurtmalar.html`, `public/qarzdorlik.html`): buyurtma, bron
   (ombor, zahira va ishlab chiqarishdan), chiqarishni ombor mudiri
   nazorat qilishi va oraliq bo'yicha qarzdorlik.
4. **Kassa** — YOZILDI (`sql/cash.sql`, `modules/cash.js`,
   `public/kassa.html`): ikkita hisob, so'm va dollar, menejer
   qo'lidagi puli, harajat foyda-zarar oyi bilan. Mijoz balansi to'ldi.
   Harajat moddalari zavod ro'yxati bilan kiritildi; foyda-zarar va pul
   oqimi hisobotlari yozildi.
   **Ta'minotchilar ro'yxati FAYLDAN yuklanadi**
   (`POST /api/import/suppliers`, Ta'minot → Ta'minotchilar): zavod uni
   Excel'da yuritadi va o'ttiz ikkita qatorni qo'lda terib chiqish bir
   soatlik ish va o'nta xato bo'lardi. Mijozlar bilan bir xil yo'l —
   avval TEKSHIRIB ko'rsatiladi, xato qator bo'lsa hech narsa
   saqlanmaydi; qayta yuklashda yozilgani o'chmaydi, faqat bo'sh
   maydon to'ladi. Ustunlar sarlavhasidan topiladi, tartibi muhim
   emas. Yo'nalish KODI bilan ham, NOMI bilan ham yoziladi: zavod
   faylida ustun «TURI» deb ataladi va ichida «Qadoqlash materiali»
   turadi, kod emas. Matn bo'lib yopishtirish ham qoldi — bitta-ikkita
   qator uchun fayl yasash ortiqcha.

   **Ta'minotchining BOSHLANG'ICH QARZI** (`suppliers.opening_debt`, `$`)
   — tizim ishga tushgan kundagi holat. Mijozning `opening_debt` i
   bilan bir xil mantiq va bir xil sabab: shusiz kassadan qilingan
   birinchi to'lov ta'minotchini MINUSGA tushirardi — biz unga
   qarzdor bo'lganimiz hech qayerda yozilmagan edi.

   Maydon ISHORALI va tomoni mijoznikiga **TESKARI**: musbat —
   KORXONA ta'minotchiga qarzdor (odatiy hol: mol olindi, puli
   berilmadi), manfiy — ta'minotchi korxonaga qarzdor (oldindan
   to'lov). Kartochkada maydon ostida qaysi tomon ekani yozilib
   turadi — ishorali maydonda minus qo'yishni unutgan odam qarzni
   teskari tomonga yozib qo'yardi va buni keyin hech narsa aytmasdi.

   Ikki yo'ldan kiritiladi, mijoz bilan bir xil: **kartochkadan**
   («Boshlang'ich qarz» + «Qarz sanasi») va **fayldan** («Qarzdor» va
   «Haqdor» alohida ustun, yoki bitta ustunda minus bilan). Qayta
   yuklashda yozilgani O'CHMAYDI, kartochkadan esa tuzatiladi ham,
   tozalanadi ham — bo'sh qoldirilgani «tegma» emas, «yo'q» degani.

   **Qarzdorlik hisoboti** (`v_supplier_ledger`,
   `/taminot-qarzdorlik.html`) — mijozlarniki bilan BIR XIL shakl:
   aylanma-saldo qaydnomasi (ОСВ), ya'ni `boshiga · davr ichida ·
   oxiriga`, har biri ikki ustun bo'lib. Qator bosilsa harakatlari va
   yugurib boradigan qoldiq chiqadi; to'lov raqami bosilsa kirim
   orderi alohida oynada ochiladi.

   **★ TOMONI MIJOZNIKIGA TESKARI** — ta'minotchi PASSIV hisob:

     **Haqdor** (kredit) — bizning qarzimiz OSHADI: boshlang'ich qarz,
     kelgan mol (kirim hujjati yozilganda).
     **Qarzdor** (debet) — qarzimiz KAMAYADI: to'lov; oldindan to'lov
     ham shu tomonda.

         boshiga + haqdor − qarzdor = oxiriga

   Saldo = `kredit − debet`, ya'ni musbat bo'lsa BIZ qarzdormiz —
   `v_supplier_debt.balance` bilan bir xil raqam. Sahifa ostida
   ikkalasining ma'nosi yozilib turadi: mijozlar hisobotiga o'rgangan
   ko'z bu yerda tomonni teskari o'qib qo'yardi.

      **Qarzi ro'yxatda turadi** (`v_supplier_debt.balance` =
   `boshlang'ich qarz − to'langani`): «kimga qancha qarzmiz»
   ta'minotchilar sahifasidagi birinchi savol. View `sql/cash.sql` da,
   `purchasing.sql` da EMAS — u `cash_ops` ni o'qiydi va u migratsiyada
   eng oxirida yaratiladi (mijoz balansi bilan bir xil sabab). Kirim
   hujjati yozilganda shu yerga bitta qo'shiluvchi qo'shiladi, sahifa
   ham, so'rov ham o'zgarmaydi.

      **Yo'nalish nomlari zavodnikidek** (`supplier_categories`): MDF,
   Furnitura, Mato, Lak, Qadoqlash materiali, Oyna, Yarim tayyor
   mahsulot, Xizmat, Boshqa. Kod ham nom bilan bir xil — aks holda
   ekranda MDF turib, import matnida LDSP yozilardi. «Yarim tayyor
   mahsulot» (po'kak, rezina, plastmas oyoq, stul karkasi, smala) —
   zavodning eng katta guruhlaridan biri, «Boshqa» ga qo'shilsa
   bo'linish yo'qolardi.

## Ochiq savollar — zavoddan javob kutilmoqda

Bular hal bo'lmaguncha tegishli kod YOZILMAYDI: javobsiz taxmin qilib
qo'yilgan qoida keyin jimgina noto'g'ri ishlaydi.

**Xom ashyo spravochnigi** (ombor moduli shundan boshlanadi)
- ✅ HAL BO'LDI: **har rang ALOHIDA material** (zavod qarori).
  `LDSP 16mm oq` va `LDSP 16mm venge` — ikkita qator, har birining o'z
  qoldig'i va o'z narxi. Rang ustun EMAS: ustun bo'lsa qoldiq material
  bo'yicha yig'ilib, «oq LDSP tugadi» degan savolga javob bo'lmasdi.
  Tayyor mahsulotdagi `color` bilan adashtirmaslik kerak — u yerda rang
  konverning xususiyati, bu yerda esa materialning O'ZI boshqa.
- Ro'yxat Excel'dan yuklanadi (qo'lda terilmaydi). Kerakli ustunlar:
  nomi · o'lchov birligi (dona, m², kg, rulon…) · turkumi.

**Jo'natma**
- Mashina raqami, haydovchi va hujjat raqami yoziladimi? Hozir buyurtmada
  faqat qayerga, manzil va kutib oluvchining raqami bor.
- Buyurtma QISMAN chiqadimi? Hozir yo'q: bronning hammasi omborga
  kelmaguncha chiqarib bo'lmaydi.

**Kassa** — ✅ HAL BO'LDI va yozildi. Zavod qarorlari: pulni savdo
menejeri o'zi kiritadi va mijozning qarzi o'sha zahoti kamayadi; pul
kassirga topshirilguncha menejerning qo'lida turadi; kursni har
operatsiyada kiritayotgan odam yozadi; harajatda foyda-zarar oyi
so'raladi.
- Hali yo'q: **to'lov turi** (naqd / plastik / o'tkazma) alohida ustun
  qilinmadi — kerak bo'lsa `cash_ops` ga bitta ustun va shakfga bitta
  katak qo'shiladi.

---

## Xavfsizlik

**★ PIN BAZADA OCHIQ MATNDA TURMAYDI** (`erp/pin.js`). Ilgari turardi:
bazani ochgan har kim — biz, hosting muhandisi, zaxira faylini qo'lga
kiritgan odam — hamma xodimning, shu jumladan direktorning PIN'ini
o'qiy olardi. Endi `workers.pin_hash` da uning IZI turadi va izdan
raqamni qaytarib bo'lmaydi.

**Iz bcrypt bilan emas, MAXFIY KALIT bilan hisoblanadi**
(`ERP_PIN_SECRET`, HMAC-SHA256). Sabab: PIN — 4 raqam, ya'ni 10 000
variant, va tuzli-sekin hash uni himoya qilmaydi — hamma variantni
sanab chiqish bir necha daqiqa. Kalit esa bazada emas, server
sozlamasida turadi: zaxira fayli oqib ketsa unda kalit yo'q va izlar
hech narsa bermaydi. Yon foydasi: iz deterministik, ya'ni
`pin_hash UNIQUE` ishlayveradi va kirish bitta indeksli so'rov bo'lib
qoladi.

**Kalit o'zgarsa hamma PIN ishlamay qoladi** — bir marta qo'yiladi va
saqlanadi. Kalit umuman qo'yilmagan bo'lsa tizim ESKICHA (ochiq matn
bilan) ishlayveradi va konsolga ogohlantirish yozadi: kalitni unutish
butun zavodni ishdan to'xtatgandan ko'ra shu yaxshi. Kalit qo'yilgach
ochiq ustun migratsiyada o'zi bo'shaydi (`erp/migrate.js`, `hashPins`).
`migration_flags` ishlatilmadi — bu bir martalik ko'chirish emas,
doimiy qoida: eski bazadan ochiq PIN bilan kelgan qator keyingi
migratsiyada ham tozalanadi.

Shu sababdan `production-seed.sql` dagi test xodimlari endi PIN bo'yicha
emas, ISM bo'yicha tekshiriladi: ochiq ustun bo'shagach PIN bo'yicha
tekshirish o'sha xodimlarni ikkinchi marta yaratib qo'yardi.

**Unutilgan PIN topilmaydi, YANGISI qo'yiladi.** Xodimlar sahifasida PIN
ustuni endi «qo'yilgan / —» deb turadi, kartochkadagi maydon esa har
doim bo'sh ochiladi. Qidiruv ham PIN'siz.

**Urinishlar cheklovi** (`ERP_PIN_TRIES`, standart 5) — iz o'zi yetarli
emas, xato urinish sekinlashishi kerak. Lekin tsexdagi bir nechta
terminal BITTA internetdan chiqadi: qat'iy blok qo'yilsa bitta
hazilkash butun zavodni to'xtatardi. Shuning uchun blok qisqa (eng ko'pi
5 daqiqa) va har muvaffaqiyatli kirish uni tozalaydi — haqiqiy xodim
kirdi, demak hujum emas. `ERP_PIN_TRIES=0` butunlay o'chiradi.

---

## Proksi va HTTPS

Server proksi ortida turadi (Railway, keyin o'z domenimiz), shuning uchun
`app.set('trust proxy', 1)` — usiz har so'rov proksining manzili bilan
kelardi va PIN urinishlari cheklovi butun zavodni BITTA manzil deb
o'qirdi: bitta telefondagi xato urinish qolganlarni ham bloklardi.

**HSTS** — HTTPS ustida ochilgan so'rovga «bu saytga boshqa hech qachon
http bilan borma» sarlavhasi qo'shiladi: tsexdagi telefon ochiq Wi-Fi'da
turadi va bitta http so'rovi sessiya tokenini ko'chaga chiqarardi. Shart
SO'ROVDAN o'qiladi (`req.secure` yoki `x-forwarded-proto`), muhitdan
emas — lokalda `http://localhost` bilan ishlaganda sarlavha qo'yilsa
brauzer saytni bir yil davomida https'ga majburlab, ochilmay qolardi.

---

## Zaxira

`npm run erp:backup` — butun bazani bitta faylga tushiradi
(`erp/backup.js`). Railway'ning o'z zaxirasi bor, lekin u BIR JOYDA
turadi: hisob yopilsa yoki to'lov uzilsa zaxira ham u bilan ketadi.

**★ NUSXA IKKI JOYDA va ikkalasi bir-biriga bog'liq emas:**

  1. **Telegram** — serverning O'ZI yopiq kanalga yuboradi
     (`BACKUP_TG_TOKEN` + `BACKUP_TG_CHAT`). Kanal shu sababdan yaxshi:
     zaxira to'xtaganini alohida nazorat qilish shart emas — bugungi
     fayl yo'q bo'lsa ko'rinib turadi. Telegram 50 MB dan katta faylni
     olmaydi va baza o'sganda bu jim to'xtamasin: chegara oshsa skript
     aniq aytadi va xato kodi bilan chiqadi.
  2. **OneDrive** — zavod kompyuterida `BACKUP_DIR` OneDrive papkasiga
     qo'yiladi, qolganini OneDrive ilovasining o'zi qiladi. **Serverni
     OneDrive'ga ulab bo'lmaydi**: uning kaliti jim o'ladi va zaxira
     to'xtaganini hech kim sezmasdi.

**★ FAYL SHIFRLANADI** (`BACKUP_PASS`, AES-256-GCM, kalit scrypt bilan).
Dump ichida mijozlarning telefonlari, xodimlar ismi va butun moliyaviy
hisob turadi — shifrlanmagan nusxani bulutga qo'yish uni ko'chaga
qo'yish bilan barobar. Ochish: `node erp/backup.js --och <fayl>`.
**Parol yo'qolsa nusxa ochilmaydi.** Parolsiz ishlatsa ham bo'ladi,
lekin skript ogohlantiradi va faylni bulutga qo'ymaslikni aytadi.

**Kunlik jadval** — `BACKUP_AT=03:00` (izoh: `erp/server.js`). Alohida
cron xizmati ko'tarilmadi: zaxira kuniga bir marta olinadi va uni
ikkinchi nazorat qilinadigan joyga aylantirish ortiqcha. Konteyner
qayta ishga tushsa taymer noldan boshlanadi, shuning uchun «bugun
olindimi» degan xotira emas, VAQT OYNASI ishlatiladi: zaxira faqat
belgilangan vaqtdan keyingi 15 daqiqa ichida olinadi. Vaqt SERVER
vaqti bo'yicha — Railway'da UTC, mahalliy vaqt kerak bo'lsa
`TZ=Asia/Tashkent` ham qo'yiladi.

`pg_dump` kerak. Railway'da yo'q bo'lsa `NIXPACKS_PKGS=postgresql`
sozlamasi qo'shiladi; skript buni xato xabarida ham aytadi.

---

## Hali yo'q

Ombor (xom ashyo), ishbay oylik, sifat nazorati (brakda
aybdor bo'lim va «tuzatishga qaytarildi» holati yo'q), offline rejim.
