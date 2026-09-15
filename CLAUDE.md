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
Boshlang'ich qoldiqda raqami noma'lum mahsulot bo'ladi — raqam katagi
bo'sh qoldiriladi va tizim `Q26-0007` beradi: **Q** bosh harfi raqamni
zavod emas, tizim qo'yganini aytadi.
Sifat shikoyati, ishbay oylik va xom ashyo sarfi — hammasi shu raqamga
bog'lanadi, shuning uchun ombor qoldig'i ham dona emas, konver hisobida.

**Marshrut** — mahsulot qaysi bo'limlardan, qaysi tartibda o'tadi.
`route_templates` + `route_steps`, mahsulotga `route_template_id` orqali
biriktiriladi. Haqiqiy manba: **`sql/routes.sql`** — tartib faqat shu yerda.

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

**Boshlanmagan konver** — bo'limsiz kiritilgan. U marshrutining BIRINCHI
qadamiga qarab egasini topadi: penal/kamod/sp/stol — korpus tsexi, stul —
stul tsexi. Tsex ekranining tepasida «Boshlanmagan» ro'yxati bo'lib
turadi, tugmasi marshrutning birinchi bo'limini yozadi («→ Arra»).

**O'lchov birligi** (`product_groups.uom`) — stul DONA bilan, penal, kamod,
sp va stol KOMPLEKT bilan sanaladi. Guruhga biriktiriladi, mahsulotga emas.
Ombor yig'indisi shu sababdan bitta raqam emas: `by_uom` bo'lib chiqadi —
dona bilan komplektni qo'shib bo'lmaydi.

**Boshlang'ich qoldiqni omborga kiritish.** «Boshlang'ich qoldiq» sahifasida
**Tseh** ustunidan «T/M ombor» tanlansa, bo'lim katagi o'chadi va «T/M ombor»
ustunidagi sana REJA emas, omborga kirgan FAKT kun bo'ladi: konver darrov
`fg` holatida yaratiladi va qoldiqqa tushadi. Fayldan yuklashda xuddi shu
ish «Omborga kirgan» ustuni bilan bo'ladi. Qoida `createOne()` da — ikkala
yo'l ham shundan o'tadi.

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
boshqa mijozniki. Mahsulot ostida faqat QAYERDAN kelishi turadi
(«T/M omborda bor» / «Zahirada — rangi tanlanadi» / «Omborda yo'q —
ishlab chiqarishdan»), aniq soni esa bron oynasida, har konverning
yonida. Shu sababdan bron qilingan konver yonida ham konverning umumiy
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
              (mahsulotni zavoddan u chiqarib beradi; tasdiqlagan bo'lsa
              ismi va telefoni chiziq ustida turadi), o'ngda qabul qilib
              oluvchi

Ikki tomon bir xil kenglikda — yuk xati shunday o'qiladi. Bo'sh maydon
umuman yozilmaydi. Ism ham, telefon ham BAZADAN keladi
(`shipped_by_name`, `shipped_by_phone`) — kodga yozilmaydi (4-qoida). **«Chop etish»** tugmasi bor: qog'ozga faqat hujjat
tushadi (ro'yxat ham, tugmalar ham chiqmaydi). Korxona nomi kodda bitta
qator (`FIRMA`) — u mijoz ma'lumoti emas, zavodning o'z nomi.

Ro'yxatda ham tugmasi boshqa: tahrirlanadiganda ✎, yopilganda 👁 —
qatorning o'zi ham bosiladi.

**«Qayerda» ustuni** (tahrir ko'rinishida, qator oxirida) — biriktirilgan
konver hozir qayerda: «T/M ombor» yoki «Arra · Korpus tsexi», yonida
nechtaligi. Savdo xodimi mijozga «qayerda ekan» degan savolga shu
ustundan javob beradi. Konver keyingi bo'limga o'tsa **o'zi
yangilanadi**: ochiq buyurtma har daqiqada qayta o'qiladi — faqat
kutilayotgani (ishlab chiqarishda koneri bori), faqat oyna ochiq
turganda va BITTA zanjir bilan (izoh: `planTick`).

Server xabarlarida ham «bron» so'zi yo'q: «N tasi buyurtmada — avval
konverni qaytaring».

Bitta bron bo'lsa konverga mijoz va zakaz raqami yoziladi — jurnalda
tsex boshlig'i «bu Alisherniki» deb ko'radi. Bir nechta bo'lsa bo'sh
qoladi: **jurnalda qator bosilganda** ostida bronlar ro'yxati chiqadi
(`GET /api/units/:id/bron`). Alohida ustun yo'q — konverlarning ko'pida
bron bo'lmaydi.

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
har konver qayerda turgani. **Bronning hammasi omborga yetib kelmaguncha
tugma ishlamaydi** — yarmi tsexda turganda «jo'natildi» deb yozib qo'yish
mijoz qarzini ham noto'g'ri oshirardi.

Tasdiqlashda mudir **chiqib ketgan sanani** qo'yadi.

**Pul kirim sanasi** (`orders.payment_on`) — SAVDONIKI, ombor mudiriniki
emas: pul masalasini mijoz bilan menejer kelishadi. Buyurtma
OLINAYOTGANDA so'ralmaydi — o'shanda hali gap bo'lmaydi; saqlangan
buyurtma kartochkasida istalgan payt yoziladi va tuzatiladi,
jo'natilgandan keyin ham (`PATCH /orders/:id/payment`). Bu SANA, summa
emas: mijoz balansiga tegmaydi, to'lovning o'zini kassa moduli yozadi.

Tasdiqlangach konverlar `shipped` bo'ladi, `ship_on` yoziladi, ombor
qoldig'idan chiqadi va mijoz balansiga qo'shiladi. Konverning faqat
BRON QILINGAN qismi chiqadi: qolgani boshqa mijozniki bo'lishi mumkin,
shuning uchun kerak bo'lsa shu yerda bo'linadi.

**Zahira** (`is_stock`) — buyurtmasiz, oldindan ishlangan mahsulot. U
`sections.is_hold` belgili bo'limda buyurtma kutadi (korpus → Rang sepish,
stul → Lak). Zahiraga muddat bashorat qilinmaydi.

---

## Kim nima ko'radi

Huquqlar: `permissions` → `roles` → `role_permissions` → `worker_roles`.
Rol huquqlari **kodda** (`sql/core-seed.sql`), saytdan tahrirlanmaydi.

| Rol | Huquq | Ko'radi |
|---|---|---|
| `tsex_usta` | `production.entry` | faqat «Bo'limlar aro harakat», faqat o'z tsexi |
| `kirituvchi` | + `production.units`, `production.reports` | jurnal, boshlang'ich qoldiq, hisobotlar |
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
raqami, soni, turgan joyi, FAKT sanalar. Tekshiruv **serverda**
(`modules/units.js`, `RESTRICTED`) — katakni yashirish himoya emas.

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
  test/                node:test, HTTP orqali
```

`sql/` tartibi: core → core-seed → production → production-seed →
catalog-groups → production-sku → units → register → catalog → purchasing →
routes → sales → warehouse. Yangi fayl qo'shsangiz `migrate.js` ga ham yozing.
Ombor oxirida: uning view'i savdo qo'shadigan ustunni ham o'qiydi.

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
4. **Kassa** — kirim hujjatlari. Mahsulot narxi `$`, harajat `so'm` ham.
   Balans shunda to'liq bo'ladi: hozir to'lovlar ayirilmaydi.

## Ochiq savollar — zavoddan javob kutilmoqda

Bular hal bo'lmaguncha tegishli kod YOZILMAYDI: javobsiz taxmin qilib
qo'yilgan qoida keyin jimgina noto'g'ri ishlaydi.

**Xom ashyo spravochnigi** (ombor moduli shundan boshlanadi)
- Ro'yxat Excel'da bormi? Bo'lsa ustunlariga moslab yuklash yoziladi.
- Bitta material bir nechta rangda bo'ladimi — `LDSP 16mm` oq, yong'oq,
  venge? Har rang alohida materialmi, yoki bitta material + rang ustunimi?
  Qoldiq rang bo'yicha yuritilmasa «oq LDSP tugadi» degan savolga javob
  bo'lmaydi.

**Jo'natma**
- Mashina raqami, haydovchi va hujjat raqami yoziladimi? Hozir buyurtmada
  faqat qayerga, manzil va kutib oluvchining raqami bor.
- Buyurtma QISMAN chiqadimi? Hozir yo'q: bronning hammasi omborga
  kelmaguncha chiqarib bo'lmaydi.

**Kassa**
- ✅ HAL BO'LDI: pulni **savdo bo'limi o'zi kiritadi** (alohida kassir
  emas) va u mijozning qarzidan ayriladi — ya'ni balans
  `boshlang'ich + chiqib ketgan mahsulot − to'lovlar` bo'ladi.
- Kirim hujjatida yana nima bo'ladi — qaysi buyurtma uchun, valyuta,
  kurs, to'lov turi (naqd / plastik / o'tkazma)?

---

## Hali yo'q

Ombor (xom ashyo), kassa, ishbay oylik, sifat nazorati (brakda
aybdor bo'lim va «tuzatishga qaytarildi» holati yo'q), offline rejim,
PIN uchun urinishlar cheklovi (ataylab — zavod qarori).
