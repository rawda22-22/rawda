// تنبيه تليجرام قبل كل موعد بساعتين و10 دقايق: "اطبع الحجز وسلّمه للعميل"
// بيشتغل من GitHub Actions كمراقب متواصل (.github/workflows/remind.yml) ومش محتاج الموقع يكون مفتوح.
// إعدادات تليجرام (Token / Chat ID) بتتقرا من نفس إعدادات الموقع (Firestore: meta/telegram).
import { pathToFileURL } from 'node:url';
import { appendFileSync } from 'node:fs';

// المطلوب: التنبيه يوصل قبل الموعد بساعتين و10 دقايق على الأقل.
// السكربت بقى "مراقب" شغال على طول وبيفحص كل 20 ثانية (مش معتمد على جدولة GitHub اللي بتتأخر ساعات)،
// فبنبعت أول ما يفضل ساعتين و11 دقيقة → التنبيه يوصل قبل الموعد بساعتين و10 دقايق بالظبط تقريباً.
export const LEAD_MIN = 131;
const TICK_MS = 20000;
const CUR_SYM = { SAR: 'ر.س', EGP: 'ج.م', USD: '$' };

/* تحويل "تاريخ + ساعة" بتوقيت منطقة معيّنة إلى لحظة زمنية (ms) — من غير مكتبات */
export function zonedEpoch(date, time, tz) {
  const [y, mo, d] = date.split('-').map(Number), [h, mi] = time.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const offset = (t) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(t / 1000) * 1000;
  };
  let t = guess - offset(guess);
  t = guess - offset(t);
  return t;
}

/* تاريخ اليوم (وبكرة لو قرّبنا من نص الليل) بتوقيت المنطقة — عشان نقرا حجوزات يومين بس ونوفّر قراءات Firestore */
export function datesToQuery(now, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', minute: 'numeric',
  }).formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  const today = `${p.year}-${p.month}-${p.day}`, minutes = +p.hour * 60 + +p.minute;
  if (minutes < 24 * 60 - LEAD_MIN - 10) return [today];
  const t = new Date(Date.UTC(+p.year, +p.month - 1, +p.day + 1));
  return [today, t.toISOString().slice(0, 10)];
}

/* مواعيد الحجز (رجال / نساء) — نفس منطق الموقع */
export function appointments(b) {
  const out = [];
  if (+b.men && b.menSlot) out.push({ g: 'm', n: +b.men, date: b.menDate || b.date, slot: b.menSlot });
  if (+b.women && b.womenSlot) out.push({ g: 'w', n: +b.women, date: b.womenDate || b.date, slot: b.womenSlot });
  return out;
}

/* المواعيد اللي فاضل عليها أقل من/يساوي ساعتين و10 دقايق (ولسه ما بدأتش) */
export function dueReminders(bookings, now, tz, leadMin = LEAD_MIN) {
  const out = [];
  for (const b of bookings) {
    if (b.status === 'cancelled' || b.status === 'done') continue;
    for (const a of appointments(b)) {
      if (!a.date || !a.slot || (b.entered && b.entered[a.g])) continue;   // الفئة دي دخلت خلاص
      const dt = zonedEpoch(a.date, a.slot, tz), ms = dt - now;
      if (ms > 0 && ms <= leadMin * 60000) out.push({ b, ...a, dt, ms, key: `${b.id}|${a.g}|${a.date}T${a.slot}` });
    }
  }
  return out.sort((x, y) => x.dt - y.dt);
}

const h = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const fmt12 = (t) => { let [hh, mm] = t.split(':').map(Number); const ap = hh < 12 ? 'ص' : 'م'; hh = hh % 12 || 12; return `${hh}:${String(mm).padStart(2, '0')} ${ap}`; };
const minWord = (m) => (m === 1 ? 'دقيقة' : m === 2 ? 'دقيقتين' : m <= 10 ? `${m} دقائق` : `${m} دقيقة`);
export function leftText(ms) {
  const m = Math.round(ms / 60000), hh = Math.floor(m / 60), mm = m % 60;
  if (hh === 0) return minWord(mm);
  return `${hh === 1 ? 'ساعة' : hh === 2 ? 'ساعتين' : hh + ' ساعات'}${mm ? ` و${minWord(mm)}` : ''}`;
}

export function reminderMessage(r, empName, siteUrl) {
  const b = r.b; // من غير أي مبالغ في التنبيه
  const day = new Date(r.date + 'T12:00:00Z').toLocaleDateString('ar-u-nu-latn', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
  const L = ['🖨 <b>اطبع الحجز وسلّمه للعميل</b>', '', `⏰ الموعد بعد <b>${leftText(r.ms)}</b>`,
    `${r.g === 'm' ? '🧔 رجال' : '🧕 نساء'} (${r.n}) — ${day} • ${fmt12(r.slot)}`, '',
    `👤 ${h(b.name)}`, `📞 <code>${h(b.phone)}</code>`];
  if (b.notes) L.push(`📝 ${h(b.notes)}`);
  L.push('', `👨‍💼 الموظف المسؤول: ${h(empName || 'غير معروف')}`);
  if (siteUrl) L.push(`🔗 <a href="${siteUrl}?print=${encodeURIComponent(b.id)}">افتح الحجز للطباعة</a>`);
  return L.join('\n');
}

/* رقم دولي لواتساب — نفس منطق الموقع: 00 → بدون، 05xxxxxxxx (سعودي) → 9665…، 01xxxxxxxxx (مصري) → 201… */
export function phoneDigits(p) {
  let d = String(p ?? '').replace(/[٠-٩]/g, (x) => x.charCodeAt(0) - 0x660).replace(/[^\d]/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  else if (/^05\d{8}$/.test(d)) d = '966' + d.slice(1);
  else if (/^01\d{9}$/.test(d)) d = '20' + d.slice(1);
  return d;
}

/* زرار تحت رسالة التنبيه: يفتح محادثة العميل على واتساب مباشرة */
export function reminderButtons(r) {
  const d = phoneDigits(r.b.phone);
  if (d.length < 8) return null;
  return { inline_keyboard: [[{ text: '🟢 فتح واتساب العميل', url: `https://wa.me/${d}` }]] };
}

export async function tgSend(token, chatId, text, markup) {
  const body = new URLSearchParams({ chat_id: String(chatId), text, parse_mode: 'HTML', disable_web_page_preview: 'true' });
  if (markup) body.set('reply_markup', JSON.stringify(markup));
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', body });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.description || 'HTTP ' + r.status);
}

export async function run({ db, send = tgSend, now = Date.now(), tz = 'Africa/Cairo', siteUrl = '', log = console.log }) {
  const tgSnap = await db.doc('meta/telegram').get();
  const tg = tgSnap.exists ? tgSnap.data() : null;
  if (!tg || !tg.on || !tg.token || !tg.chatId) { log('تليجرام مش مفعّل في إعدادات الموقع — مفيش إرسال'); return { sent: 0, failed: 0 }; }

  const found = new Map();
  for (const d of datesToQuery(now, tz)) {
    for (const field of ['date', 'menDate', 'womenDate']) {
      const snap = await db.collection('bookings').where(field, '==', d).get();
      snap.forEach((doc) => found.set(doc.id, { ...doc.data(), id: doc.id }));
    }
  }

  const rs = await db.doc('meta/reminders').get();
  const sent = { ...((rs.exists && rs.data().sent) || {}) };
  const due = dueReminders([...found.values()], now, tz).filter((r) => !sent[r.key]);
  log(`حجوزات متقرية: ${found.size} • تنبيهات مستحقة: ${due.length} • الآن بتوقيت ${tz}: ${new Date(now).toLocaleString('en-GB', { timeZone: tz })}`);

  const names = {};
  const nameOf = async (email) => {
    email = String(email || '').toLowerCase();
    if (!email) return '';
    if (!(email in names)) {
      const u = await db.doc('users/' + email).get();
      names[email] = (u.exists && u.data().name) || email.split('@')[0];
    }
    return names[email];
  };

  let ok = 0, failed = 0;
  for (const r of due) {
    try {
      await send(tg.token, tg.chatId, reminderMessage(r, await nameOf(r.b.createdBy), siteUrl), reminderButtons(r));
      sent[r.key] = now; ok++;
      for (const k of Object.keys(sent)) if (now - sent[k] > 3 * 864e5) delete sent[k];
      await db.doc('meta/reminders').set({ sent, updatedAt: now });
    } catch (e) { failed++; console.error('تعذر إرسال تنبيه', r.key, '-', e.message); }
  }
  return { sent: ok, failed };
}


/* ===== 🚦 تنبيهات مراحل الحجز على المنصة (النظام الجديد بس — الحجوزات من 10 أكتوبر 2026) =====
   ✔️ تأكيد الموعد بيفتح قبل الموعد بـ 48 ساعة • 🖨 طباعة الباركود قبل الموعد بساعتين */
export const PAX_FROM = 1791579600000;
export const CONF_MIN = 48 * 60, BAR_MIN = 120;
const paxOn = (b) => (+b.createdAt || 0) >= PAX_FROM || (Array.isArray(b.pax) && b.pax.some((r) => r && (r.email || r.visa || r.pass)));
export function stageAlerts(bookings, now, tz) {
  const out = [];
  for (const b of bookings) {
    if (b.status === 'cancelled' || b.status === 'done' || !paxOn(b)) continue;
    for (const a of appointments(b)) {
      if (!a.date || !a.slot || (b.entered && b.entered[a.g])) continue;
      const dt = zonedEpoch(a.date, a.slot, tz), ms = dt - now, id = `${b.id}|${a.g}|${a.date}T${a.slot}`;
      if (ms <= 0) continue;
      if (ms <= CONF_MIN * 60000) {
        if (!b.booked) out.push({ kind: 'nobk', b, ...a, dt, ms, key: 'nobk|' + id });
        else if (!(b.conf && b.conf[a.g])) out.push({ kind: 'conf', b, ...a, dt, ms, key: 'conf|' + id });
      }
      if (b.booked && ms <= BAR_MIN * 60000 && !(b.bar && b.bar[a.g])) out.push({ kind: 'bar', b, ...a, dt, ms, key: 'bar|' + id });
    }
  }
  return out.sort((x, y) => x.dt - y.dt);
}
export function stageMessage(r, empName) {
  const b = r.b;
  const day = new Date(r.date + 'T12:00:00Z').toLocaleDateString('ar-u-nu-latn', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
  const head = { conf: '✔️ <b>وقت تأكيد الموعد</b>', bar: '🖨 <b>اطبع الباركود</b>', nobk: '⚠️ <b>الموعد قرّب ولسه ماتحجزش على المنصة!</b>' }[r.kind];
  const L = [head, '', `👤 ${h(b.name)}`, `${r.g === 'm' ? '🧔 رجال' : '🧕 نساء'} (${r.n}) — ${day} • ${fmt12(r.slot)}`, `⏰ الموعد بعد <b>${leftText(r.ms)}</b>`];
  const em = (Array.isArray(b.pax) ? b.pax : []).filter((x) => x && x.email);
  if (r.kind !== 'nobk' && em.length) { L.push(''); em.forEach((x, i) => L.push(`${i + 1}) <code>${h(x.email)}</code>`)); }
  L.push('', `👨‍💼 الموظف المسؤول: ${h(empName || 'غير معروف')}`);
  return L.join('\n');
}
/* الأيام اللي محتاجين نراقبها: النهارده + 3 أيام (عشان تنبيه الـ 48 ساعة) */
export function nextDays(now, tz, n = 4) {
  const [today] = datesToQuery(now, tz);
  const [y, m, d] = today.split('-').map(Number);
  return Array.from({ length: n }, (_, i) => new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10));
}

/* تاريخ اليوم وبكرة بتوقيت المنطقة */
export function todayTomorrow(now, tz) {
  const [today] = datesToQuery(now, tz);
  const [y, m, d] = today.split('-').map(Number);
  return [today, new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)];
}

/* وضع المراقبة: بيفضل شغال لمدة `minutes` ويفحص كل 20 ثانية.
   بيستخدم Firestore listeners: الحجوزات بتتقري مرة واحدة في البداية وبعدها التعديلات بس — فالقراءات قليلة جداً. */
export async function watch({ db, send = tgSend, minutes = 340, tz = 'Africa/Cairo', siteUrl = '', log = console.log, clock = () => Date.now() }) {
  const endAt = clock() + minutes * 60000;
  let tg = null, sent = {}, totalSent = 0, totalFailed = 0;
  const rs = await db.doc('meta/reminders').get();
  sent = { ...((rs.exists && rs.data().sent) || {}) };

  const unsubTg = db.doc('meta/telegram').onSnapshot((s) => { tg = s.exists ? s.data() : null; }, (e) => console.error('telegram listener:', e.message));

  // listeners الحجوزات (يوم النهارده + بكرة) — بتتجدد لما اليوم يتغيّر
  let days = '', subs = [], parts = [];
  const resubscribe = (now) => {
    const dd = nextDays(now, tz);
    if (dd.join() === days) return;
    days = dd.join(); subs.forEach((u) => u()); parts = [];
    subs = ['date', 'menDate', 'womenDate'].map((field, i) => {
      parts[i] = new Map();
      return db.collection('bookings').where(field, 'in', dd).onSnapshot((snap) => {
        const m = new Map(); snap.forEach((doc) => m.set(doc.id, { ...doc.data(), id: doc.id })); parts[i] = m;
      }, (e) => console.error(`bookings listener (${field}):`, e.message));
    });
    log(`بنراقب حجوزات ${dd.join(' و ')}`);
  };

  const names = {};
  const nameOf = async (email) => {
    email = String(email || '').toLowerCase();
    if (!email) return '';
    if (!(email in names)) { const u = await db.doc('users/' + email).get(); names[email] = (u.exists && u.data().name) || email.split('@')[0]; }
    return names[email];
  };

  try {
    while (clock() < endAt) {
      const now = clock();
      resubscribe(now);
      if (tg && tg.on && tg.token && tg.chatId) {
        const all = new Map(); parts.forEach((p) => p.forEach((v, k) => all.set(k, v)));
        const due = dueReminders([...all.values()], now, tz).filter((r) => !sent[r.key]);
        for (const r of due) {
          try {
            await send(tg.token, tg.chatId, reminderMessage(r, await nameOf(r.b.createdBy), siteUrl), reminderButtons(r));
            sent[r.key] = now; totalSent++;
            for (const k of Object.keys(sent)) if (now - sent[k] > 3 * 864e5) delete sent[k];
            await db.doc('meta/reminders').set({ sent, updatedAt: now });
            log(`اتبعت تنبيه: ${r.b.name || r.b.id} • قبل الموعد بـ ${leftText(r.ms)}`);
          } catch (e) { totalFailed++; console.error('تعذر إرسال تنبيه', r.key, '-', e.message); }
        }
        for (const r of stageAlerts([...all.values()], now, tz).filter((x) => !sent[x.key])) {
          try {
            await send(tg.token, tg.chatId, stageMessage(r, await nameOf(r.b.createdBy)));
            sent[r.key] = now; totalSent++;
            await db.doc('meta/reminders').set({ sent, updatedAt: now });
            log(`اتبعت تنبيه مرحلة (${r.kind}): ${r.b.name || r.b.id}`);
          } catch (e) { totalFailed++; console.error('تعذر إرسال تنبيه', r.key, '-', e.message); }
        }
      }
      await new Promise((ok) => setTimeout(ok, Math.min(TICK_MS, Math.max(0, endAt - clock()))));
    }
  } finally {
    subs.forEach((u) => u()); unsubTg();
  }
  return { sent: totalSent, failed: totalFailed };
}

async function main() {
  const started = Date.now();
  // لو المراقب اشتغل فترة كويسة (حتى لو وقع)، بنقول للـ workflow يشغّل التالي على طول
  const chain = () => { if (process.env.GITHUB_OUTPUT && Date.now() - started > 10 * 60000) appendFileSync(process.env.GITHUB_OUTPUT, 'chain=true\n'); };
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) { console.log('::notice::مفتاح FIREBASE_SERVICE_ACCOUNT مش مضاف في GitHub Secrets — التنبيهات متوقفة لحد ما تضيفه'); return; }
  const { initializeApp, cert } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  initializeApp({ credential: cert(JSON.parse(raw)) });
  const [owner, repo] = (process.env.GITHUB_REPOSITORY || '/').split('/');
  const siteUrl = process.env.SITE_URL || (owner && repo ? `https://${owner}.github.io/${repo}/` : '');
  const opts = { db: getFirestore(), tz: process.env.APP_TZ || 'Africa/Cairo', siteUrl, log: (m) => console.log('::notice::' + m) };
  const watchMin = +process.env.WATCH_MINUTES || 0;
  try {
    const res = watchMin > 0 ? await watch({ ...opts, minutes: watchMin }) : await run(opts);
    console.log(`::notice::اتبعت ${res.sent} تنبيه${res.failed ? ` • فشل ${res.failed}` : ''}`);
    if (res.failed) process.exitCode = 1;
  } finally { chain(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
