// نشر قواعد Firestore (firestore.rules) على Firebase تلقائياً — بيشتغل من .github/workflows/rules.yml
import { readFileSync } from 'node:fs';
const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!raw) { console.log('::error::مفتاح FIREBASE_SERVICE_ACCOUNT مش مضاف في GitHub Secrets'); process.exit(1); }
const { initializeApp, cert } = await import('firebase-admin/app');
const { getSecurityRules } = await import('firebase-admin/security-rules');
initializeApp({ credential: cert(JSON.parse(raw)) });
const source = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
const rs = await getSecurityRules().releaseFirestoreRulesetFromSource(source);
console.log('::notice::اتنشرت قواعد Firestore ✓ ' + rs.name);
