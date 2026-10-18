// 🔑 أكواد نسك من الجيميل ← تليجرام خلال ثواني
// بيشتغل من GitHub Actions (.github/workflows/codes.yml) ومتصل بالجيميل على طول (IMAP IDLE):
// جوجل نفسها بتبلّغه أول ما الإيميل يوصل — فمفيش انتظار دقيقة زي الفحص الدوري.
// الإيميلات اللي بالنقط (ahmed.ali / ah.med.ali …) كلها بتوصل لنفس الصندوق، فكفاية نراقب الحساب الأساسي.
//
// المطلوب في GitHub Secrets:
//   FIREBASE_SERVICE_ACCOUNT  (موجود خلاص — منه بنقرا توكن ورقم شات تليجرام من إعدادات الموقع)
//   GMAIL_ACCOUNTS  = الحساب الأساسي وكلمة سر التطبيقات:   name@gmail.com:abcdabcdabcdabcd
//                     ولو أكتر من حساب افصل بينهم بفاصلة:   a@gmail.com:xxxx,b@gmail.com:yyyy
import { pathToFileURL } from 'node:url';
import { tgSend } from './remind.mjs';

const MAX_AGE_MS = 15 * 60000;   // أي كود أقدم من ربع ساعة مالوش لازمة
const SENDER = /nusuk/i;         // إيميلات نسك بس

/* استخراج الكود: رقم جنب كلمة «كود / رمز / OTP / verification» — ولو مفيش: رقم لوحده في العنوان */
export function extractCode(subject, text) {
  const norm = (s) => String(s || '').replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 0x660);
  const s = norm(subject), t = norm(text);
  const near = (s + '\n' + t).match(/(?:code|otp|pin|verification|verify|passcode|رمز|كود|التحقق|التفعيل)[^0-9]{0,60}(\d{4,8})(?!\d)/i);
  if (near) return near[1];
  const subj = s.match(/(?:^|\D)(\d{4,8})(?!\d)/);
  if (subj) return subj[1];
  const lone = t.match(/(?:^|\n)\s*(\d{4,8})\s*(?:\n|$)/);   // رقم لوحده في سطر
  return lone ? lone[1] : '';
}

const h = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
export function codeMessage({ to, code, subject, date, lag, gm, tz = 'Africa/Cairo' }) {
  const time = new Date(date).toLocaleTimeString('ar-u-nu-latn', { timeZone: tz, hour: 'numeric', minute: '2-digit', second: '2-digit' });
  // ⚡ lag = من أول ما الإيميل دخل الجيميل لحد ما اتبعت هنا (لو صغير والكود لسه متأخر عندك يبقى التأخير من نسك نفسها)
  return ['🔑 <b>كود نسك</b>', `📧 <code>${h(to)}</code>`, `🔢 <code>${h(code)}</code>`, `🕒 ${time}${lag != null ? ` • ⚡ ${lag} ث${gm != null ? ` (جيميل ${gm} + إحنا ${Math.max(0, lag - gm)})` : ''}` : ''}`, subject ? `✉️ ${h(String(subject).slice(0, 80))}` : '']
    .filter(Boolean).join('\n');
}

/* الإيميل اللي الكود اتبعتله (بالنقط زي ما هو) */
function recipient(parsed, account) {
  const base = account.split('@')[0].replace(/\./g, '').toLowerCase();
  const all = [parsed.to, parsed.cc].flatMap((x) => (x ? (Array.isArray(x) ? x : [x]) : [])).flatMap((x) => x.value || []).map((x) => x.address).filter(Boolean);
  return all.find((a) => a.split('@')[0].replace(/\./g, '').toLowerCase().split('+')[0] === base) || all[0] || account;
}

const mask = (a) => String(a).replace(/^(.).*(.)@/, '$1***$2@');

/* 🧪 تشخيص: بيبعت على تليجرام (مش في سجلات GitHub) آخر الإيميلات اللي وصلت في آخر ساعتين — الوارد والسبام */
async function diagAccount({ account, pass, tg }) {
  const { ImapFlow } = await import('imapflow');
  const { simpleParser } = await import('mailparser');
  const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: account, pass }, logger: false });
  const L = [`🧪 <b>تشخيص أكواد نسك</b>`, `📮 ${h(account)}`];
  try { await client.connect(); }
  catch (e) { console.log(`::error::تشخيص ${mask(account)}: الدخول فشل — ${e.responseText || e.message}`); await tgSend(tg.token, tg.chatId, L.concat(`❌ مش قادر يدخل الحساب: ${h(e.responseText || e.message)}`).join('\n')); return; }
  console.log(`::notice::تشخيص ${mask(account)}: الدخول تمام`);
  L.push('✅ الدخول للحساب تمام');
  const boxes = await client.list();
  const pick = (u, fb) => boxes.find((b) => b.specialUse === u)?.path || fb;
  for (const [name, path] of [['📥 الوارد', 'INBOX'], ['🚫 السبام', pick('\\Junk', '[Gmail]/Spam')]]) {
    const lock = await client.getMailboxLock(path).catch(() => null); if (!lock) { L.push('', `${name}: مش لاقيه`); continue; }
    try {
      const ms = [];
      for await (const m of client.fetch({ since: new Date(Date.now() - 2 * 3600e3) }, { uid: true, envelope: true, internalDate: true, source: true })) ms.push(m);
      L.push('', `${name}: ${ms.length} إيميل في آخر ساعتين`);
      console.log(`::notice::تشخيص ${mask(account)} ${path}: ${ms.length} إيميل في آخر ساعتين • منهم من نسك ${ms.filter((m) => SENDER.test((m.envelope?.from || []).map((x) => x.address).join(' '))).length}`);
      let nk = 0, withCode = 0, sample = '';
      for (const m of ms) { const f = (m.envelope?.from || []).map((x) => x.address).join(' '); if (!SENDER.test(f)) continue; nk++;
        const p = await simpleParser(m.source), c = extractCode(p.subject, p.text || p.html?.replace(/<[^>]+>/g, ' ')); if (c) withCode++; else if (!sample) sample = String(p.subject || '').slice(0, 60); }
      if (nk) console.log(`::notice::تشخيص ${mask(account)} ${path}: إيميلات نسك ${nk} • لقيت فيها كود ${withCode}${sample ? ` • مثال من غير كود: ${sample}` : ''}`);
      for (const m of ms.slice(-8)) {
        const p = await simpleParser(m.source), from = (m.envelope?.from || []).map((x) => x.address).join(' ');
        const code = extractCode(p.subject, p.text || p.html?.replace(/<[^>]+>/g, ' '));
        const t = new Date(m.internalDate).toLocaleTimeString('ar-u-nu-latn', { timeZone: 'Africa/Cairo', hour: 'numeric', minute: '2-digit' });
        L.push(`• ${t} من <code>${h(from)}</code>${SENDER.test(from) ? ' ✅نسك' : ''}\n   إلى ${h(recipient(p, account))} • ${h(String(p.subject || '').slice(0, 50))} • ${code ? 'كود: ' + h(code) : 'مفيش كود'}`);
      }
    } finally { lock.release(); }
  }
  await client.logout().catch(() => {});
  await tgSend(tg.token, tg.chatId, L.join('\n').slice(0, 4000));
}

const POLL_MS = 1000;
/* اتصال IMAP تاني بيسأل «آخر رقم إيميل كام؟» (STATUS UIDNEXT) كل ثانيتين — خفيف جداً ومابيحمّلش أي إيميلات */
function startPoller({ ImapFlow, account, pass, every, uidNow, onNew }) {
  let c = null, stopped = false, busy = false;
  const tick = async () => {
    if (stopped || busy) return; busy = true;
    try {
      if (!c || !c.usable) {
        c = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: account, pass }, logger: false });
        c.on('error', () => {});
        await c.connect();
      }
      const s = await c.status('INBOX', { uidNext: true });
      if (s && s.uidNext - 1 > uidNow()) onNew();
    } catch { try { c?.close(); } catch {} c = null; }
    finally { busy = false; }
  };
  const t = setInterval(tick, every); tick();
  return () => { stopped = true; clearInterval(t); c?.logout().catch(() => {}); };
}

async function watchAccount({ account, pass, db, tg, endAt, log }) {
  const { ImapFlow } = await import('imapflow');
  const { simpleParser } = await import('mailparser');
  let lastUid = 0, first = true;
  const startedAt = Date.now();
  const seen = new Set();

  const handle = async (client, msg) => {
    const seenAt = Date.now();   // اللحظة اللي الإيميل ظهر لنا فيها من الجيميل
    if (msg.uid > lastUid) lastUid = msg.uid;
    const from = (msg.envelope?.from || []).map((x) => x.address || '').join(' ');
    if (!SENDER.test(from)) return;
    const date = msg.internalDate ? new Date(msg.internalDate).getTime() : Date.now();
    if (Date.now() - date > MAX_AGE_MS) return;
    // ✋ منع التكرار حتى لو فيه مراقبين شغالين مع بعض: create بيفشل لو المستند موجود
    const key = `${account}|${msg.envelope?.messageId || msg.uid}`.replace(/[\/]/g, '_').slice(0, 900);
    if (seen.has(key)) return; seen.add(key);
    // ⚡ منع التكرار وقراءة الإيميل بيحصلوا مع بعض في نفس اللحظة (بدل ما نستنى واحد ورا التاني)
    // 🔒 فحص التكرار في Firestore بس في الدقيقتين اللي فيهم مراقبين شغالين مع بعض (وقت التسليم) — غير كده مابنستناش
    const handover = Date.now() < startedAt + 3 * 60000 || Date.now() > endAt - 3 * 60000;
    const ref = db.collection('codeSent').doc(Buffer.from(key).toString('base64url'));
    const [dup, parsed] = await Promise.all([
      handover ? ref.create({ at: Date.now() }).then(() => false, () => true) : Promise.resolve(false),
      simpleParser(msg.source),
    ]);
    if (dup) return;
    if (!handover) ref.create({ at: Date.now() }).catch(() => {});
    const code = extractCode(parsed.subject, parsed.text || parsed.html?.replace(/<[^>]+>/g, ' '));
    if (!code) { log(`إيميل نسك من غير كود: ${parsed.subject || ''}`); return; }
    const to = recipient(parsed, account);
    await tgSend(tg.token, tg.chatId, codeMessage({ to, code, subject: parsed.subject, date, lag: Math.max(0, Math.round((Date.now() - date) / 1000)), gm: Math.max(0, Math.round((seenAt - date) / 1000)) }));
    log(`✓ اتبعت كود (بعد ${Math.round((Date.now() - date) / 1000)} ثانية من وصوله)`);   // من غير الإيميل — سجلات GitHub عامة
  };

  const fetchNew = async (client) => {
    const range = first ? { since: new Date(Date.now() - MAX_AGE_MS) } : { uid: `${lastUid + 1}:*` };
    first = false;
    const list = [];
    for await (const m of client.fetch(range, { uid: true, envelope: true, internalDate: true, source: true }, { uid: !!range.uid })) list.push(m);
    for (const m of list) if (!(range.uid && m.uid <= lastUid)) await handle(client, m).catch((e) => console.error('خطأ في إيميل', e.message));
  };

  while (Date.now() < endAt) {
    const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: account, pass }, logger: false, maxIdleTime: 4 * 60000 });
    client.on('error', (e) => console.error(mask(account), 'IMAP:', e.message));
    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        log(`متصل بـ ${mask(account)} — مستني الأكواد`);
        await fetchNew(client);
        lastUid = Math.max(lastUid, (client.mailbox?.uidNext || 1) - 1);
        let busy = Promise.resolve(), queued = false;
        const kick = () => { if (queued) return; queued = true; busy = busy.then(() => { queued = false; return fetchNew(client); }).catch((e) => console.error(e.message)); };
        client.on('exists', kick);
        // ⚡ جيميل أحياناً بيتأخر في تبليغ IDLE — فاتصال تاني صغير بيبص على الصندوق كل ثانيتين ولو فيه جديد بيصحّي الأول على طول
        const stopPoll = startPoller({ ImapFlow, account, pass, every: POLL_MS, uidNow: () => lastUid, onNew: kick });
        try {
          while (Date.now() < endAt && client.usable) await client.idle().catch(() => {});
          await busy;
        } finally { stopPoll(); }
      } finally { lock.release(); }
      await client.logout().catch(() => {});
    } catch (e) {
      console.error(mask(account), 'تعذر الاتصال:', e.message);
      if (/auth|credential|password|AUTHENTICATIONFAILED/i.test(e.message + (e.responseText || ''))) { console.log(`::error::كلمة سر التطبيقات لـ ${mask(account)} غلط`); await tgSend(tg.token, tg.chatId, `⚠️ أكواد نسك: كلمة سر التطبيقات لـ <code>${h(account)}</code> غلط — اعمل واحدة جديدة وحدّث GMAIL_ACCOUNTS`).catch(() => {}); return; }
      await new Promise((ok) => setTimeout(ok, 5000));
    }
  }
}

async function main() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT, accs = (process.env.GMAIL_ACCOUNTS || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!raw || !accs.length) { console.log('::notice::محتاج FIREBASE_SERVICE_ACCOUNT و GMAIL_ACCOUNTS في GitHub Secrets — الأكواد متوقفة'); return; }
  const { initializeApp, cert } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  initializeApp({ credential: cert(JSON.parse(raw)) });
  const db = getFirestore(), log = (m) => console.log('::notice::' + m);
  const diag = process.env.DIAG === 'true';
  const minutes = +process.env.WATCH_MINUTES || 345, endAt = Date.now() + minutes * 60000;

  // 🔒 مراقب واحد بس في نفس الوقت (الاحتياطي بالساعة بيخرج لو فيه واحد شغال) — والتالي بيبدأ قبل ما اللي قبله يخلص بدقيقتين
  const runId = process.env.GITHUB_RUN_ID || String(Date.now());
  // الشغال بيحدّث «beat» كل 30 ثانية — لو وقف (اتلغى/وقع) أكتر من دقيقة ونص، أي مراقب جديد يمسك مكانه
  const lease = db.doc('meta/codesLease');
  const ok = diag || await db.runTransaction(async (t) => {
    const s = await t.get(lease), L = s.exists ? s.data() : null, now = Date.now();
    const alive = L && L.runId !== runId && now - (L.beat || 0) < 90000 && (L.until || 0) > now + 3 * 60000;
    if (alive) return false;
    t.set(lease, { runId, until: endAt, beat: now }); return true;
  });
  if (!ok) { log('فيه مراقب أكواد شغال بالفعل — خروج'); return; }
  if (!diag) {
    // نبض كل 30 ثانية — ولو مراقب جديد استلم مكاننا نخرج على طول (عشان مايبقاش فيه اتنين شغالين مع بعض)
    setInterval(() => db.runTransaction(async (t) => {
      const s = await t.get(lease), L = s.exists ? s.data() : null;
      if (L && L.runId !== runId) return false;
      t.set(lease, { runId, until: endAt, beat: Date.now() }); return true;
    }).then((mine) => { if (!mine) { log('المراقب الجديد استلم — خروج'); process.exit(0); } }).catch(() => {}), 30000);
    // خروج مضمون في الميعاد (قبل حد الـ 6 ساعات بتاع GitHub)
    setTimeout(() => { log('خلص وقت المراقب — خروج'); process.exit(0); }, Math.max(0, endAt - Date.now()) + 30000);
  }

  // تشغيل المراقب اللي بعده قبل النهاية بدقيقتين (عشان مفيش ولا ثانية من غير مراقبة)
  const repo = process.env.GITHUB_REPOSITORY, token = process.env.GH_TOKEN;
  if (repo && token && !diag) setTimeout(() => fetch(`https://api.github.com/repos/${repo}/actions/workflows/codes.yml/dispatches`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
    body: JSON.stringify({ ref: process.env.GITHUB_REF_NAME || 'main' }),
  }).then((r) => log(`تشغيل المراقب التالي: ${r.status}`)).catch((e) => console.error(e.message)), Math.max(0, endAt - Date.now() - 2 * 60000));

  let tg = null;
  db.doc('meta/telegram').onSnapshot((d) => { tg = d.exists ? d.data() : null; });
  for (let i = 0; tg === null && i < 40; i++) await new Promise((r) => setTimeout(r, 500));
  if (!tg || !tg.token || !tg.chatId) { console.log('::error::إعدادات تليجرام (التوكن ورقم الشات) مش موجودة في الموقع'); return; }

  if (diag) {
    for (const a of accs) { const i = a.indexOf(':'); await diagAccount({ account: a.slice(0, i).trim(), pass: a.slice(i + 1).replace(/\s+/g, ''), tg }).catch((e) => console.error(e.message)); }
    process.exit(0);
  }

  // 🔥 نخلي الاتصال بتليجرام وFirestore سخن على طول، عشان أول كود مايستناش فتح اتصال جديد
  setInterval(() => { fetch(`https://api.telegram.org/bot${tg.token}/getMe`).then((r) => r.arrayBuffer()).catch(() => {}); lease.get().catch(() => {}); }, 3000);

  await Promise.all(accs.map((a) => { const i = a.indexOf(':'); return watchAccount({ account: a.slice(0, i).trim(), pass: a.slice(i + 1).replace(/\s+/g, ''), db, tg: new Proxy({}, { get: (_, k) => tg[k] }), endAt, log }); }));
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
