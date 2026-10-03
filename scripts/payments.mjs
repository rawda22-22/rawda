// 🧾 بوت أرشيف المدفوعات (اسكرينات التحويل)
// بيشتغل من GitHub Actions كل 5 دقايق (.github/workflows/payments.yml) — مفيش سيرفر ولا خدمة خارجية.
//
// الموظف يبعت للبوت (في الخاص) صورة التحويل، ويكتب في وصف الصورة:
//     كود الحجز (أو رقم تليفون العميل)  [المبلغ]  [محفظة/تحويل/بطاقة]
//     مثال:  K7Q2M 500      أو      0501234567
// لو المبلغ مش مكتوب، بيتسجل المتبقي كله.
//
// البوت: يتأكد إن الموظف مربوط بحساب في الموقع ← يرفض الاسكرين المكرر ← يحفظ الصورة في قناة الأرشيف
//        ← يسجّل الدفعة برقم مرجعي (P-00001) في Firestore ويحدّث المدفوع في الحجز ← يرد على الموظف.
//
// نفس البوت ونفس الإعدادات اللي في الموقع (Firestore: meta/telegram). وحالة البوت نفسه في meta/tgbot.
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const CUR_SYM = { SAR: 'ر.س', EGP: 'ج.م', USD: '$' };
const METHOD_NAMES = { cash: 'نقداً', transfer: 'تحويل', card: 'بطاقة', wallet: 'محفظة' };
const LINK_CODE_TTL = 2 * 864e5;   // كود ربط الموظف صالح يومين

/* ===== أدوات صغيرة ===== */
export const round2 = (v) => Math.round(v * 100) / 100;
export const h = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
/** أرقام عربية/فارسية → إنجليزي */
export const latinDigits = (s) => String(s ?? '')
  .replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 0x0660)
  .replace(/[۰-۹]/g, (d) => d.charCodeAt(0) - 0x06F0)
  .replace(/[٫]/g, '.').replace(/[٬،]/g, ' ');
const onlyDigits = (s) => latinDigits(s).replace(/\D/g, '');
/** كود الحجز اللي بيظهر في الموقع = آخر 5 حروف من رقم الحجز */
export const bookingCode = (id) => String(id || '').slice(-5).toUpperCase();
const money = (v, cur) => `${round2(v)} ${CUR_SYM[cur] || cur || ''}`.trim();

/** حساب الإجمالي والمتبقي — نفس معادلة الموقع */
export function calc(b) {
  const n = (+b.men || 0) + (+b.women || 0), sub = n * (+b.price || 0);
  const manual = b.discType === 'percent' ? sub * Math.min(+b.disc || 0, 100) / 100 : Math.min(+b.disc || 0, sub);
  const total = Math.max(0, round2(sub - manual - (sub - manual) * (+b.bulkPct || 0) / 100));
  const paid = Math.max(0, +b.paid || 0);
  return { n, total, paid, rem: Math.max(0, round2(total - paid)), cur: b.currency || 'SAR' };
}

/** قراءة وصف الصورة: الكلمات اللي ممكن تكون كود/تليفون + طريقة الدفع */
export function parseCaption(caption) {
  const text = latinDigits(caption).trim().replace(/(\d),(\d{3})(?!\d)/g, '$1$2');
  let method = 'transfer';
  if (/محفظ|فودافون|كاش|انستا|إنستا|instapay|wallet|stc|urpay/i.test(text)) method = 'wallet';
  else if (/بطاق|مدى|card|visa|فيزا/i.test(text)) method = 'card';
  const tokens = text.split(/[\s,:;\/\\|#=]+/).map((t) => t.replace(/^\+/, '')).filter(Boolean);
  // مرشّحين للمرجع: كود (حروف وأرقام) أو رقم تليفون (8 أرقام فأكتر)
  const refs = tokens.filter((t) => (/^[A-Za-z0-9]{5,}$/.test(t) && /[A-Za-z]/.test(t)) || /^\d{5}$/.test(t) || /^\d{8,15}$/.test(t))
    .map((t) => t.toUpperCase());
  return { tokens, refs, method };
}

/** تحديد الحجز والمبلغ من الوصف: أول مرشّح يطابق حجز هو المرجع، وأول رقم تاني (لحد 7 أرقام) هو المبلغ */
export function resolveCaption(bookings, caption) {
  const { tokens, refs, method } = parseCaption(caption);
  let ref = '', found = [];
  for (const r of refs) { const f = findBookings(bookings, r); if (f.length) { ref = r; found = f; break; } }
  if (!ref && refs.length) ref = refs[0];
  const num = tokens.find((t) => t.toUpperCase() !== ref && /^\d+(\.\d+)?$/.test(t) && t.replace('.', '').length <= 7);
  return { ref, found, amount: num === undefined ? null : +num, method };
}

/** البحث عن الحجز بالكود أو برقم التليفون */
export function findBookings(bookings, ref) {
  if (!ref) return [];
  const live = bookings.filter((b) => b.status !== 'cancelled');
  const digits = onlyDigits(ref);
  let found;
  if (/^\d{8,}$/.test(ref)) {
    const tail = digits.slice(-9);
    found = live.filter((b) => { const p = onlyDigits(b.phone); return p.length >= 8 && p.slice(-9) === tail; });
  } else {
    const R = ref.toUpperCase();
    found = live.filter((b) => b.id.toUpperCase() === R || bookingCode(b.id) === R);
  }
  if (found.length > 1) {
    const withRem = found.filter((b) => calc(b).rem > 0);
    if (withRem.length) found = withRem;
  }
  return found;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
/** رابط رسالة في قناة/جروب خاص (للأعضاء بس) */
export function messageLink(chatId, msgId) {
  const s = String(chatId);
  return s.startsWith('-100') && msgId ? `https://t.me/c/${s.slice(4)}/${msgId}` : '';
}

/* ===== واجهة تليجرام ===== */
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
    sendPhoto: (chatId, fileId, caption) => call('sendPhoto', { chat_id: chatId, photo: fileId, caption, parse_mode: 'HTML' }),
    sendDocument: (chatId, fileId, caption) => call('sendDocument', { chat_id: chatId, document: fileId, caption, parse_mode: 'HTML' }),
    editCaption: (chatId, msgId, caption) => call('editMessageCaption', { chat_id: chatId, message_id: msgId, caption, parse_mode: 'HTML' }),
    download: async (fileId) => {
      const f = await call('getFile', { file_id: fileId });
      const r = await fetch(`https://api.telegram.org/file/bot${token}/${f.file_path}`);
      if (!r.ok) throw new Error('تحميل الصورة فشل: HTTP ' + r.status);
      return Buffer.from(await r.arrayBuffer());
    },
  };
}

const HELP = [
  '🧾 <b>بوت أرشيف المدفوعات</b>', '',
  'ابعت صورة التحويل، واكتب في <b>وصف الصورة</b>:',
  '• كود الحجز (موجود جنب اسم العميل في الموقع 🔖) أو رقم تليفون العميل',
  '• المبلغ (اختياري — لو مش مكتوب بيتسجل المتبقي كله)', '',
  'أمثلة:', '<code>K7Q2M 500</code>', '<code>0501234567 محفظة</code>', '',
  'البوت بيراجع الرسايل كل كام دقيقة، فالرد بيوصل خلال دقايق.',
].join('\n');

/* ===== التشغيل ===== */
export async function run({ db, tgFactory = telegramApi, now = () => Date.now(), log = console.log }) {
  const tgSnap = await db.doc('meta/telegram').get();
  const cfg = tgSnap.exists ? tgSnap.data() : {};
  if (!cfg.token) { log('مفيش Bot Token في إعدادات الموقع — البوت متوقف'); return { handled: 0 }; }
  const tg = tgFactory(cfg.token);
  const archiveChat = String(cfg.archiveChatId || cfg.chatId || '').trim();

  const botRef = db.doc('meta/tgbot');
  const botSnap = await botRef.get();
  let offset = (botSnap.exists && botSnap.data().offset) || 0;
  const updates = await tg.getUpdates(offset || undefined);
  if (!updates.length) { log('مفيش رسايل جديدة'); return { handled: 0 }; }

  // كاش لكل تشغيلة: الموظفين والحجوزات بيتقروا مرة واحدة بس لو فيه حاجة محتاجاهم
  let usersCache = null, bookingsCache = null;
  const users = async () => {
    if (!usersCache) { usersCache = []; (await db.collection('users').get()).forEach((d) => usersCache.push({ ...d.data(), email: d.id })); }
    return usersCache;
  };
  const bookings = async () => {
    if (!bookingsCache) { bookingsCache = []; (await db.collection('bookings').get()).forEach((d) => bookingsCache.push({ ...d.data(), id: d.id })); }
    return bookingsCache;
  };
  const staffOf = async (tgId) => (await users()).find((u) => String(u.tgId || '') === String(tgId) && u.active !== false);

  const stats = { handled: 0, payments: 0, rejected: 0 };
  for (const u of updates) {
    offset = u.update_id + 1;
    const m = u.message;
    try {
      if (m && m.chat && m.chat.type === 'private') {
        stats.handled++;
        const r = await handleMessage(m);
        if (r === 'paid') stats.payments++; else if (r === 'rejected') stats.rejected++;
      }
    } catch (e) {
      console.error('خطأ في رسالة', u.update_id, e);
      try { await tg.send(m.chat.id, '⚠️ حصلت مشكلة وأنا بسجل الرسالة دي، ابعتها تاني بعد شوية أو كلّم المدير.\n<code>' + h(e.message) + '</code>', { reply_to_message_id: m.message_id }); } catch {}
    }
    await botRef.set({ offset, updatedAt: now() }, { merge: true });   // نحفظ بعد كل رسالة عشان ماتتعالجش مرتين
  }
  log(`رسايل: ${stats.handled} • دفعات اتسجلت: ${stats.payments} • مرفوضة: ${stats.rejected}`);
  return stats;

  async function reply(m, text) { return tg.send(m.chat.id, text, { reply_to_message_id: m.message_id }); }

  async function handleMessage(m) {
    const text = latinDigits(m.text || '').trim();

    // ربط الموظف: /link 123456  (الكود بيطلعه المدير من قائمة الموظفين في الموقع)
    const link = text.match(/^\/(?:link|start)\s+(\d{6})\b/);
    if (link) {
      const code = link[1], list = await users();
      const u = list.find((x) => String(x.tgCode || '') === code && now() - (+x.tgCodeAt || 0) < LINK_CODE_TTL);
      if (!u) { await reply(m, '❌ الكود غلط أو انتهى. اطلب كود جديد من المدير.'); return 'rejected'; }
      const tgName = [m.from.first_name, m.from.last_name].filter(Boolean).join(' ') || m.from.username || '';
      for (const other of list) if (other.email !== u.email && String(other.tgId || '') === String(m.from.id)) {
        await db.doc('users/' + other.email).update({ tgId: null, tgName: null }); other.tgId = null;
      }
      await db.doc('users/' + u.email).update({ tgId: m.from.id, tgName, tgCode: null, tgCodeAt: null, tgLinkedAt: now() });
      Object.assign(u, { tgId: m.from.id, tgName, tgCode: null });
      await reply(m, `✅ تم ربط حسابك: <b>${h(u.name || u.email)}</b>\n\n` + HELP);
      return 'linked';
    }

    const staff = await staffOf(m.from.id);
    if (!staff) {
      await reply(m, `👋 حسابك على تليجرام مش مربوط بحساب في الموقع.\nاطلب من المدير «كود ربط» من قائمة الموظفين، وابعتهولي كده:\n<code>/link 123456</code>`);
      return 'rejected';
    }

    const photo = m.photo && m.photo.length ? m.photo[m.photo.length - 1] : null;
    const doc = m.document && /^image\//.test(m.document.mime_type || '') ? m.document : null;
    const file = photo || doc;
    if (!file) {
      if (m.document) { await reply(m, '❌ ابعت الاسكرين كصورة (مش ملف PDF أو غيره).'); return 'rejected'; }
      await reply(m, HELP); return 'help';
    }
    return handlePayment(m, staff, file, !!doc);
  }

  async function handlePayment(m, staff, file, isDoc) {
    const { ref, found, amount, method } = resolveCaption(await bookings(), m.caption || '');
    if (!ref) { await reply(m, '❌ مكتبتش كود الحجز.\nابعت الصورة تاني واكتب في الوصف كود الحجز أو تليفون العميل، مثلاً:\n<code>K7Q2M 500</code>'); return 'rejected'; }
    if (!found.length) { await reply(m, `❌ مفيش حجز بالكود/الرقم <code>${h(ref)}</code>. راجع الكود في الموقع وابعت تاني.`); return 'rejected'; }
    if (found.length > 1) {
      const L = found.slice(0, 8).map((b) => `• <code>${bookingCode(b.id)}</code> — ${h(b.name)} (${h(b.date)})`);
      await reply(m, `⚠️ فيه أكتر من حجز بالرقم ده. ابعت الصورة تاني بكود الحجز:\n` + L.join('\n'));
      return 'rejected';
    }
    const booking = found[0], c = calc(booking);
    if (c.rem <= 0) { await reply(m, `ℹ️ حجز <b>${h(booking.name)}</b> مدفوع بالكامل بالفعل — مااتسجلش حاجة.`); return 'rejected'; }
    if (amount !== null && amount <= 0) { await reply(m, '❌ المبلغ غلط.'); return 'rejected'; }
    const amt = round2(amount === null ? c.rem : amount);

    // منع التكرار: نفس الملف على تليجرام، أو نفس محتوى الصورة بالظبط
    const dupByUid = await db.collection('payments').where('fileUid', '==', file.file_unique_id).limit(1).get();
    let hash = '';
    let dup = dupByUid.empty ? null : dupByUid.docs[0];
    if (!dup) {
      hash = sha256(await tg.download(file.file_id));
      const dupByHash = await db.collection('payments').where('hash', '==', hash).limit(1).get();
      if (!dupByHash.empty) dup = dupByHash.docs[0];
    }
    if (dup) {
      const p = dup.data();
      await reply(m, `🚫 <b>الاسكرين ده اتسجل قبل كده</b>\nرقم الدفعة: <code>${dup.id}</code>\nالعميل: ${h(p.bookingName)} • ${money(p.amount, p.currency)}\nبتاريخ: ${new Date(p.at).toLocaleString('ar-EG-u-nu-latn', { timeZone: 'Africa/Cairo' })}`);
      return 'rejected';
    }

    // 1) الأرشيف أولاً (عشان نحفظ رابط الصورة مع الدفعة)
    const staffName = staff.name || staff.email.split('@')[0];
    const capBase = (pid) => [
      `🧾 <b>${pid ? 'دفعة ' + pid : 'دفعة جديدة'}</b>`,
      `👤 ${h(booking.name)} • 🔖 <code>${bookingCode(booking.id)}</code>`,
      `💵 ${money(amt, c.cur)} • ${METHOD_NAMES[method]}`,
      `👨‍💼 ${h(staffName)}`,
    ].join('\n');
    let archived = null;
    if (archiveChat) {
      try { archived = isDoc ? await tg.sendDocument(archiveChat, file.file_id, capBase('')) : await tg.sendPhoto(archiveChat, file.file_id, capBase('')); }
      catch (e) { console.error('الأرشيف فشل:', e.message); }
    }
    const proofLink = archived ? messageLink(archiveChat, archived.message_id) : '';

    // 2) تسجيل الدفعة وتحديث الحجز مع بعض (Transaction) عشان مايحصلش تضارب
    const result = await db.runTransaction(async (t) => {
      const bRef = db.doc('bookings/' + booking.id), botRef = db.doc('meta/tgbot');
      const [bs, bot] = [await t.get(bRef), await t.get(botRef)];
      if (!bs.exists) throw new Error('الحجز اتمسح');
      const b = bs.data(), cc = calc(b);
      if (cc.rem <= 0) return { already: true };
      const seq = ((bot.exists && +bot.data().seq) || 0) + 1, pid = 'P-' + String(seq).padStart(5, '0');
      const at = now(), paid = round2((+b.paid || 0) + amt), after = calc({ ...b, paid });
      const entry = { amt, currency: cc.cur, method, at, by: staff.email, pid, proof: proofLink || null };
      const upd = { paid, payMethod: method, payments: [...(Array.isArray(b.payments) ? b.payments : []), entry], updatedAt: at, updatedBy: staff.email };
      if (b.status === 'new' && after.rem === 0) upd.status = 'confirmed';
      t.set(botRef, { seq }, { merge: true });
      t.update(bRef, upd);
      t.set(db.doc('payments/' + pid), {
        pid, bookingId: booking.id, bookingCode: bookingCode(booking.id), bookingName: b.name || '', phone: b.phone || '',
        amount: amt, currency: cc.cur, method, by: staff.email, byName: staffName, tgUserId: m.from.id, at,
        fileId: file.file_id, fileUid: file.file_unique_id, hash, caption: m.caption || '',
        archiveChatId: archived ? archiveChat : null, archiveMsgId: archived ? archived.message_id : null, proof: proofLink || null,
        over: amt > cc.rem, remBefore: cc.rem, remAfter: after.rem,
      });
      return { pid, after, over: amt > cc.rem, remBefore: cc.rem };
    });

    if (result.already) {
      await reply(m, `ℹ️ حجز <b>${h(booking.name)}</b> اتدفع بالكامل من شوية — مااتسجلش حاجة.`);
      return 'rejected';
    }
    Object.assign(booking, { paid: round2((+booking.paid || 0) + amt) });   // تحديث الكاش لو جه اسكرين تاني لنفس الحجز

    if (archived) { try { await tg.editCaption(archiveChat, archived.message_id, capBase(result.pid) + (result.after.rem > 0 ? `\n⏳ المتبقي: ${money(result.after.rem, c.cur)}` : '\n✅ الحجز مدفوع بالكامل')); } catch {} }

    const L = [`✅ <b>اتسجلت الدفعة</b> — رقمها <code>${result.pid}</code>`, '',
      `👤 ${h(booking.name)} • 🔖 <code>${bookingCode(booking.id)}</code>`,
      `💵 ${money(amt, c.cur)} (${METHOD_NAMES[method]})`,
      result.after.rem > 0 ? `⏳ المتبقي: <b>${money(result.after.rem, c.cur)}</b>` : '🟢 الحجز بقى <b>مدفوع بالكامل</b>'];
    if (result.over) L.push('', `⚠️ المبلغ أكبر من المتبقي (${money(result.remBefore, c.cur)}) — راجع المبلغ.`);
    if (!archived && archiveChat) L.push('', '⚠️ الصورة ماتحفظتش في قناة الأرشيف (اتأكد إن البوت أدمن فيها) — بس الدفعة اتسجلت.');
    await reply(m, L.join('\n'));
    return 'paid';
  }
}

async function main() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) { console.log('::notice::مفتاح FIREBASE_SERVICE_ACCOUNT مش مضاف في GitHub Secrets — البوت متوقف'); return; }
  const { initializeApp, cert } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  initializeApp({ credential: cert(JSON.parse(raw)) });
  await run({ db: getFirestore(), log: (m) => console.log('::notice::' + m) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
