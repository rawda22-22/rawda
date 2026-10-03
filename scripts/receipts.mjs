// 🗂 بوت أرشيف الاسكرينات — منفصل تماماً عن الموقع.
// تبعتله صورة ← يحفظها ويرد برقم مرجعي (R-00001).  تبعتله الرقم بعدين ← يرجّعلك الصورة.
// بيشتغل من GitHub Actions كل 5 دقايق (.github/workflows/receipts.yml) — مفيش سيرفر.
//
// التوكن: Secret اسمه RECEIPTS_BOT_TOKEN لو عايز بوت مستقل، ولو مش موجود بيستخدم نفس بوت الإشعارات.
// الأمان: صاحب شات الإشعارات هو المدير. أي حد تاني يبعت، المدير بيوصله طلب وبيوافق بـ /allow.
// البيانات: Firestore في collection اسمها receipts (الموقع مابيقراهاش)، وحالة البوت في meta/receiptsBot.
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

export const h = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
export const latinDigits = (s) => String(s ?? '')
  .replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 0x0660)
  .replace(/[۰-۹]/g, (d) => d.charCodeAt(0) - 0x06F0);
export const refOf = (n) => 'R-' + String(n).padStart(5, '0');
/** "R-00012" أو "r12" أو "12" → 12 */
export function parseRef(text) {
  const m = latinDigits(text).trim().match(/^\/?(?:r|R|ر)?\s*-?\s*0*(\d{1,7})$/);
  return m ? +m[1] : null;
}
const fmtDate = (t) => new Date(t).toLocaleString('ar-EG-u-nu-latn', { timeZone: 'Africa/Cairo', dateStyle: 'medium', timeStyle: 'short' });
const nameOf = (f) => [f.first_name, f.last_name].filter(Boolean).join(' ') || (f.username ? '@' + f.username : String(f.id));

export function telegramApi(token) {
  const call = async (method, params = {}) => {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', body });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(`${method}: ${j.description || 'HTTP ' + r.status}`);
    return j.result;
  };
  return {
    getUpdates: (offset) => call('getUpdates', { offset, timeout: 0, allowed_updates: ['message'] }),
    send: (chatId, text, extra = {}) => call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra }),
    sendPhoto: (chatId, fileId, caption, extra = {}) => call('sendPhoto', { chat_id: chatId, photo: fileId, caption, parse_mode: 'HTML', ...extra }),
    sendDocument: (chatId, fileId, caption, extra = {}) => call('sendDocument', { chat_id: chatId, document: fileId, caption, parse_mode: 'HTML', ...extra }),
    download: async (fileId) => {
      const f = await call('getFile', { file_id: fileId });
      const r = await fetch(`https://api.telegram.org/file/bot${token}/${f.file_path}`);
      if (!r.ok) throw new Error('تحميل الصورة فشل: HTTP ' + r.status);
      return Buffer.from(await r.arrayBuffer());
    },
  };
}

const HELP = [
  '🗂 <b>أرشيف الاسكرينات</b>', '',
  '📥 <b>حفظ:</b> ابعت الصورة — هرد عليك برقم مرجعي زي <code>R-00012</code>.',
  'تقدر تكتب في وصف الصورة أي ملاحظة (اسم العميل مثلاً) وهتتحفظ معاها.', '',
  '📤 <b>استرجاع:</b> ابعت الرقم المرجعي (مثلاً <code>R-00012</code> أو <code>12</code>) وهرجّعلك الصورة.', '',
  'الرد بيوصل خلال دقايق مش فوراً.',
].join('\n');

export async function run({ db, token, tgFactory = telegramApi, now = () => Date.now(), log = console.log }) {
  const tgSnap = await db.doc('meta/telegram').get();
  const cfg = tgSnap.exists ? tgSnap.data() : {};
  token = token || cfg.token;
  if (!token) { log('مفيش Bot Token — البوت متوقف'); return { handled: 0 }; }
  const ownerId = String(cfg.chatId || '').trim();   // صاحب شات الإشعارات = المدير
  const tg = tgFactory(token);

  const stateRef = db.doc('meta/receiptsBot');
  const st = (await stateRef.get()).data?.() || {};
  let offset = st.offset || 0;
  const allowed = new Set((st.allowed || []).map(String));
  const isOwner = (id) => ownerId && String(id) === ownerId;
  const canUse = (id) => isOwner(id) || allowed.has(String(id));

  const updates = await tg.getUpdates(offset || undefined);
  if (!updates.length) { log('مفيش رسايل جديدة'); return { handled: 0 }; }

  const stats = { handled: 0, saved: 0, fetched: 0 };
  for (const u of updates) {
    offset = u.update_id + 1;
    const m = u.message;
    try {
      if (m && m.chat && m.chat.type === 'private' && m.from) { stats.handled++; await handle(m); }
    } catch (e) {
      console.error('خطأ في رسالة', u.update_id, e);
      try { await tg.send(m.chat.id, '⚠️ حصلت مشكلة، ابعتها تاني بعد شوية.', { reply_to_message_id: m.message_id }); } catch {}
    }
    await stateRef.set({ offset, allowed: [...allowed], updatedAt: now() }, { merge: true });
  }
  log(`رسايل: ${stats.handled} • صور اتحفظت: ${stats.saved} • صور اترجّعت: ${stats.fetched}`);
  return stats;

  function reply(m, text) { return tg.send(m.chat.id, text, { reply_to_message_id: m.message_id }); }

  async function handle(m) {
    const text = latinDigits(m.text || '').trim();

    // أوامر المدير: /allow 123  و  /remove 123  و  /users
    if (isOwner(m.from.id)) {
      const cmd = text.match(/^\/(allow|remove)\s+(\d+)/);
      if (cmd) {
        if (cmd[1] === 'allow') allowed.add(cmd[2]); else allowed.delete(cmd[2]);
        await reply(m, cmd[1] === 'allow' ? `✅ اتسمح لـ <code>${cmd[2]}</code> يستخدم الأرشيف.` : `⛔ اتشال <code>${cmd[2]}</code>.`);
        if (cmd[1] === 'allow') { try { await tg.send(cmd[2], '✅ المدير وافق — تقدر تستخدم الأرشيف دلوقتي.\n\n' + HELP); } catch {} }
        return;
      }
      if (text === '/users') {
        await reply(m, allowed.size ? '👥 المسموح لهم:\n' + [...allowed].map((x) => `• <code>${x}</code>  (/remove ${x})`).join('\n') : 'لسه مفيش حد غيرك.');
        return;
      }
    }

    if (!canUse(m.from.id)) {
      await reply(m, '🔒 الأرشيف ده خاص. اتبعت طلبك للمدير، وأول ما يوافق هبعتلك.');
      if (ownerId) await tg.send(ownerId, `🙋 <b>${h(nameOf(m.from))}</b> عايز يستخدم أرشيف الاسكرينات.\nللموافقة ابعت:\n<code>/allow ${m.from.id}</code>`);
      return;
    }

    const photo = m.photo && m.photo.length ? m.photo[m.photo.length - 1] : null;
    const doc = m.document && /^image\//.test(m.document.mime_type || '') ? m.document : null;
    if (photo || doc) { await save(m, photo || doc, !!doc); stats.saved++; return; }

    const n = parseRef(text);
    if (n) { if (await fetchBack(m, n)) stats.fetched++; return; }

    await reply(m, HELP);
  }

  async function save(m, file, isDoc) {
    const col = db.collection('receipts');
    let dup = await col.where('fileUid', '==', file.file_unique_id).limit(1).get();
    let hash = '';
    if (dup.empty) {
      hash = createHash('sha256').update(await tg.download(file.file_id)).digest('hex');
      dup = await col.where('hash', '==', hash).limit(1).get();
    }
    if (!dup.empty) {
      const d = dup.docs[0], p = d.data();
      await reply(m, `🚫 <b>الصورة دي متسجلة قبل كده</b>\nرقمها: <code>${d.id}</code>\nبتاريخ: ${fmtDate(p.at)} • من: ${h(p.fromName)}${p.note ? `\n📝 ${h(p.note)}` : ''}`);
      return;
    }
    const ref = await db.runTransaction(async (t) => {
      const s = await t.get(stateRef);
      const seq = ((s.exists && +s.data().seq) || 0) + 1, id = refOf(seq);
      t.set(stateRef, { seq }, { merge: true });
      t.set(db.doc('receipts/' + id), {
        ref: id, seq, at: now(), fileId: file.file_id, fileUid: file.file_unique_id, hash, isDoc,
        note: m.caption || '', from: m.from.id, fromName: nameOf(m.from),
      });
      return id;
    });
    await reply(m, `✅ اتحفظت\nالرقم المرجعي: <code>${ref}</code>${m.caption ? `\n📝 ${h(m.caption)}` : ''}`);
  }

  async function fetchBack(m, n) {
    const id = refOf(n), s = await db.doc('receipts/' + id).get();
    if (!s.exists) { await reply(m, `❌ مفيش صورة بالرقم <code>${id}</code>.`); return false; }
    const p = s.data();
    const cap = `🗂 <code>${id}</code>\n📅 ${fmtDate(p.at)} • من: ${h(p.fromName)}${p.note ? `\n📝 ${h(p.note)}` : ''}`;
    const extra = { reply_to_message_id: m.message_id };
    if (p.isDoc) await tg.sendDocument(m.chat.id, p.fileId, cap, extra); else await tg.sendPhoto(m.chat.id, p.fileId, cap, extra);
    return true;
  }
}

async function main() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) { console.log('::notice::مفتاح FIREBASE_SERVICE_ACCOUNT مش مضاف في GitHub Secrets — البوت متوقف'); return; }
  const { initializeApp, cert } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  initializeApp({ credential: cert(JSON.parse(raw)) });
  await run({ db: getFirestore(), token: process.env.RECEIPTS_BOT_TOKEN || '', log: (m) => console.log('::notice::' + m) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
