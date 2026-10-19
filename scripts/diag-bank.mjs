// تشخيص مؤقت لبنك الإيميلات (قراءة بس — مابيكتبش أي حاجة ومابيطبعش إيميلات ولا أسماء)
import admin from 'firebase-admin';
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
const meta = (await db.doc('emailMeta/main').get()).data() || {};
console.log('META', JSON.stringify(meta));
const bank = await db.collection('emailBank').select('seq').get();
const seqs = bank.docs.map(d => ({ id: d.id, seq: +d.get('seq') })).sort((a, b) => a.seq - b.seq);
const next = +meta.next || 0, total = +meta.total || 0;
const avail = seqs.filter(x => x.seq > next);
const badId = seqs.filter(x => x.id !== 'e' + String(x.seq).padStart(6, '0'));
console.log('BANK docs', seqs.length, 'minSeq', seqs[0]?.seq, 'maxSeq', seqs.at(-1)?.seq);
console.log('available (seq>next)', avail.length, 'first', avail[0]?.seq, 'last', avail.at(-1)?.seq, 'beyond total', avail.filter(x => x.seq > total).length);
console.log('gap docs missing between next and first available', avail.length ? avail[0].seq - next - 1 : '-');
console.log('id/seq mismatch', badId.length, JSON.stringify(badId.slice(0, 5)));
const bs = await db.collection('bookings').get();
const L = bs.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 15);
for (const b of L) {
  const n = (+b.men || 0) + (+b.women || 0), pax = b.pax || [];
  console.log('BK', b.id.slice(0, 6), new Date(b.createdAt || 0).toISOString(), 'status', b.status, 'noData', !!b.noData, 'n', n, 'rows', pax.length, 'withEmail', pax.filter(r => r && r.email).length, 'updatedBy?', b.updatedBy ? 'yes' : 'no');
}
