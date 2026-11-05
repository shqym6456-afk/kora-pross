# كورة برو (نسخة مسطّحة بدون مجلدات)

الملفات: `index.html` (الواجهة) و`server.js` (الخادم) و`teams.js` و`vercel.json` و`package.json`.

## Vercel
1. أنشئ مستودعاً جديداً على GitHub وارفع هذه الملفات كلها (من «Choose your files»، لا مجلدات).
2. في Vercel: Add New ← Project ← اختر المستودع ← Framework: **Other** ← أضف في Environment Variables:
   `API_FOOTBALL_KEY` = مفتاحك، و`COMPS` = `PL,PD,SA` ← Deploy.
3. افتح `رابطك/healthz`: يجب أن يظهر `"provider":"api-football"`.
4. (اختياري) لحفظ نقاط المسابقة: Storage ← Upstash Redis ← اربطه بالمشروع ← Redeploy.

## استضافة عادية (Koyeb وغيرها)
أمر التشغيل `npm start` ونفس المتغيرات.
