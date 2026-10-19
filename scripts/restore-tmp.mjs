// استرجاع مؤقت: يرجّع الحجوزات اللي اتحذفت في آخر ساعة واسمها فيه faycel/فيصل
import admin from 'firebase-admin';
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
const log = (...a) => console.log('::notice::' + a.join(' '));
const now = (await db.collection('bookings').get());
const live = new Set(now.docs.map(d => d.id));
const RX = /fay|fai|fei|feys|فيص|فيس|فاي/i;
const found = new Map();
const base = Math.floor(Date.now() / 60000) * 60000;
for (const m of [2, 4, 6, 8, 10, 13, 16, 20, 25, 30, 35, 40, 45, 50, 55, 58]) {
  const rt = admin.firestore.Timestamp.fromMillis(base - m * 60000);
  try {
    const snap = await db.runTransaction(t => t.get(db.collection('bookings')), { readOnly: true, readTime: rt });
    let gone = 0;
    snap.docs.forEach(d => { if (!live.has(d.id)) { gone++; if (!found.has(d.id)) found.set(d.id, { data: d.data(), m }); } });
  } catch (e) { log('readTime -' + m + ' failed', e.message); }
}
for (const [id, { data, m }] of found) {
  const match = RX.test(String(data.name || ''));
  log('DELETED', id, 'match', match, 'seenAt -' + m + 'min', 'n', (+data.men || 0) + (+data.women || 0), 'date', data.date, 'status', data.status);
  const ex = (await db.doc('bookings/' + id).get()).exists;
  if (id === 'mveyykzpowfmr' && !ex) { await db.doc('bookings/' + id).create(data); log('RESTORED', id); } else log('exists now', ex);
}
if (!found.size) log('nothing deleted found in the last hour');
