/* ============================================================================
 *  MUHIT O'ZGARUVCHILARI — NOMDAGI ORTIQCHA BO'SHLIQ
 *
 *  ★ ZAVOD HOLATI (2026-09). Railway sozlamasiga o'zgaruvchi nomi
 *  YOPISHTIRIB kiritiladi va yopishtirilgan matnning oxirida ko'pincha
 *  probel qolib ketadi. Natijada muhitda IKKITA qator turadi:
 *
 *      BACKUP_TG_TOKEN     ←  bo'sh, kod AYNAN shuni o'qiydi
 *      BACKUP_TG_TOKEN     ←  qiymat SHU YERDA (nomi oxirida probel)
 *
 *  Ekranda ikkalasi bir xil ko'rinadi — probelni ko'z ilg'amaydi.
 *  Zaxira aynan shu sababdan Telegramga ketmay qolgan edi: skript
 *  «tayyor» deb yozardi, fayl esa konteynerda qolardi.
 *
 *  Shuning uchun dastur ko'targanda muhit bir marta TOZALANADI: nomi
 *  bo'shliq bilan kelgan qiymat tozalangan nomga ko'chiriladi — lekin
 *  faqat tozalangani BO'SH bo'lsa. To'ldirilgani ustun turadi: ataylab
 *  qo'yilgan qiymat tasodifiy nusxa bilan almashtirilmaydi.
 *
 *  ★ JIM TUZATMAYDI. Yamoq qo'llanilgani jurnalga yoziladi: sozlamadagi
 *  xato nomi turaveradi va ertaga uchinchi o'zgaruvchi ham shunday
 *  kiritilsa, sababi noma'lum bo'lib qolardi. Kod chidamli bo'lgani
 *  sozlamani to'g'rilamaslikka asos emas.
 * ========================================================================== */
module.exports = function tozala(yoz = console.warn) {
  const yamoq = [];
  for (const [kalit, qiymat] of Object.entries(process.env)) {
    const nom = kalit.trim();
    if (nom === kalit || !nom) continue;
    if (String(process.env[nom] || '').trim()) continue;
    process.env[nom] = qiymat;
    yamoq.push(nom);
  }
  if (yamoq.length)
    yoz(`DIQQAT: sozlamada o'zgaruvchi nomining oxirida (yoki boshida) `
      + `ortiqcha bo'shliq bor: ${yamoq.join(', ')}. `
      + `Hozircha o'qildi, lekin nomni tuzatib qo'ying.`);
  return yamoq;
};
