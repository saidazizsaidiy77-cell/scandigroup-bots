# Brauzerdan kirish — uch yo'l

Dastur qayerdadir ishlab turishi kerak, shundan keyingina brauzerdan
ochiladi. Vaziyatingizga qarab birini tanlang.

---

## 1 · Serverga qo'yish — jamoa uchun

**Qachon:** bir necha xodim bir vaqtda ishlaydi, ma'lumot doimiy saqlanadi.
Sizga aynan shu kerak.

### Railway

1. [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
2. `crmmixinfo/scandigroup-bots` ni tanlang.
3. **Settings → Source** da branch `main` ekanini tekshiring. ERP shu
   branchda turadi; boshqa branch tanlangan bo'lsa sayt eski kodda qoladi
   va push qilingan o'zgarishlar ko'rinmaydi.
4. Loyihada **+ New** → **Database** → **Add PostgreSQL**.
5. Dastur xizmatining **Variables** bo'limiga ikkita qator qo'shing:
   ```
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   ERP_AUTO_MIGRATE=1
   ```
   Birinchi qator bazani dasturga ulaydi. Railway uni har doim ham o'zi
   qo'shmaydi — `Variables` ro'yxatida `DATABASE_URL` allaqachon turgan
   bo'lsa, faqat ikkinchi qatorni qo'shing.
6. **Settings** → **Networking** → **Generate Domain**.

Tayyor. Manzilni oching, PIN `0000`.

**Qaysi versiya ishlayotganini bilish.** `/health` sahifasini oching:

```
{"ok":true,"version":"75fc528","started":"...","columns":["rang","mato",...]}
```

`version` — saytda ishlayotgan commit. GitHub'dagi oxirgi commit bilan bir xil
bo'lmasa, deploy o'tmagan: branch sozlamasini yoki deploy logini tekshiring.
`columns` ro'yxati jurnaldagi yangi ustunlar bor-yo'qligini ko'rsatadi —
brauzer eski nusxani ko'rsatayotganini shundan ajratasiz.

**Deploy logida nima ko'rinishi kerak:**
```
Migratsiya bajarildi: {"tsexlar":"4","bolimlar":"24","sku":"32",...}
ZELTA ERP → http://localhost:3000
```
Bu ikki qator chiqsa — hammasi joyida.

**Agar xato chiqsa:**

| Logdagi yozuv | Sabab | Yechim |
|---|---|---|
| `DATABASE_URL kiritilmagan` | baza ulanmagan | 5-qadamdagi birinchi qatorni qo'shing |
| `Cannot find module 'telegraf'` yoki bot xatosi | eski branch | 3-qadam: branch'ni tekshiring |
| Sayt ochiladi, lekin o'zgarish ko'rinmaydi | eski branch yoki deploy o'tmagan | `/health` dagi `version` ni GitHub'dagi oxirgi commit bilan solishtiring |
| `ECONNREFUSED` / `timeout` | baza hali ko'tarilmagan | 1-2 daqiqa kuting, **Redeploy** bosing |
| `self signed certificate` | SSL sozlamasi | `PGSSL` o'zgaruvchisi qo'shilgan bo'lsa, o'chiring |

Logda quyidagi ko'rinsa hammasi joyida:
```
Migratsiya bajarildi: {"tsexlar":"4","bolimlar":"24","sku":"32",...}
ZELTA ERP → http://localhost:3000
```

### Render

`render.yaml` tayyor — veb-xizmat va baza birga yaratiladi:
[render.com](https://render.com) → **New** → **Blueprint** → repozitoriyni tanlang.

---

## 2 · O'z kompyuteringizda, Docker bilan — bugun ko'rish uchun

**Qachon:** hozir ko'rmoqchisiz, hech qanday ro'yxatdan o'tish kerak emas.
Faqat shu kompyuterdan ochiladi.

[Docker Desktop](https://docker.com/products/docker-desktop) o'rnatilgan bo'lsa:

```bash
git clone -b main \
  https://github.com/crmmixinfo/scandigroup-bots.git
cd scandigroup-bots
docker compose up
```

Birinchi ishga tushish 1-2 daqiqa (Postgres va Node yuklab olinadi).
Keyin brauzerda: **http://localhost:3000** · PIN `0000`

To'xtatish: `Ctrl+C`. Ma'lumot `pgdata/` papkasida qoladi, qayta
`docker compose up` desangiz joyida turadi.

---

## 3 · O'z kompyuteringizda, Dockersiz

**Kerak:** Node.js 18+ va PostgreSQL 14+.

```bash
git clone -b main \
  https://github.com/crmmixinfo/scandigroup-bots.git
cd scandigroup-bots
cp .env.example .env
```

`.env` faylida:
```
DATABASE_URL=postgresql://postgres:parol@localhost:5432/scandi_erp
PGSSL=off
```

Keyin:
```bash
createdb scandi_erp
npm install
npm run erp:migrate
npm start
```

Brauzerda: **http://localhost:3000**

---

## Kirgandan keyin — birinchi yarim soat

| # | Sahifa | Ish |
|---|---|---|
| 1 | `/xodimlar.html` | Xodimlarni kiriting, PIN bering, rol biriktiring |
| 2 | `/xodimlar.html` | **Demo PIN'larni o'chiring** (`0000`, `1111`–`6666` hozir ochiq) |
| 3 | `/sozlamalar.html` | Bo'lim quvvatlari — ixtiyoriy. Kiritilsa muddat bashorati o'zi hisoblanadi, kiritilmasa muddat qo'lda qo'yiladi. Sahifa menyuda yo'q, manzil bilan ochiladi |
| 4 | `/mijozlar.html` | Mijozlar ro'yxatini import qiling |
| 5 | `/qoldiq.html` | Konveyerdagi va T/M omboridagi mahsulotlar |

Rollar:

| Rol | Kim | Nima qiladi |
|---|---|---|
| Administrator | 1 | hammasi |
| Direktor | 1 | hisobotlarni ko'radi |
| **Ma'lumot kirituvchi** | 5 | jurnal, qoldiq, mijozlar — sozlamalarga tegmaydi |

---

## Muhim

- **Demo PIN'lar ochiq turibdi.** Serverga qo'yganingizdan keyin birinchi ish —
  o'z xodimlaringizni kiritib, demo hisoblarni o'chirish.
- **Ma'lumot faqat bazada.** Railway/Render bazasi doimiy; Docker'da
  `pgdata/` papkasida. Bu papkani o'chirmang.
- **Zaxira nusxa.** Railway'da baza uchun avtomatik backup yoqib qo'ying.
