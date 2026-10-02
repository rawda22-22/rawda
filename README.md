# حجوزات الروضة الشريفة 🕌

تطبيق ويب لإدارة حجوزات زيارة الروضة الشريفة (مواعيد الرجال والنساء، الدفعات، الحسابات بعدة عملات، ومزامنة سحابية عبر Firebase).

## النشر
أي `push` على فرع `main` بيشغّل GitHub Actions وينشر الموقع تلقائياً على GitHub Pages.

الرابط بعد النشر:
`https://<اسم-المستخدم>.github.io/<اسم-الريبو>/`

## الإعداد لأول مرة
1. **Settings → Pages → Source** اختار **GitHub Actions**.
2. في **Firebase Console → Authentication → Settings → Authorized domains** أضف:
   `<اسم-المستخدم>.github.io`
