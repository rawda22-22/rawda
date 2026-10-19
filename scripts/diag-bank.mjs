// إصلاح مؤقت لمرة واحدة: العدّاد يقفز فوق الأرقام الممسوحة لحد قبل أول إيميل متاح
import admin from 'firebase-admin';
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
const log = (...a) => console.log('::notice::' + a.join(' '));
const mref = db.doc('emailMeta/main');
await db.runTransaction(async t => {
  const m = (await t.get(mref)).data() || {}, next = +m.next || 0;
  const q = await t.get(db.collection('emailBank').where('seq', '>', next).orderBy('seq').limit(1));
  if (q.empty) { log('no available docs'); return; }
  const target = +q.docs[0].get('seq') - 1;
  if (target <= next) { log('no gap, next', next); return; }
  t.update(mref, { next: target }); log('next', next, '->', target);
});
