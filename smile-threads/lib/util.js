'use strict';
const crypto = require('node:crypto');

const nowIso = () => new Date().toISOString();
const rid = (n = 6) => crypto.randomBytes(n).toString('hex');

// ---- JST(日本標準時, DSTなし)ヘルパー ----
const JST_MS = 9 * 3600 * 1000;
const toJstParts = (d) => {
  const j = new Date(d.getTime() + JST_MS);
  return { y: j.getUTCFullYear(), m: j.getUTCMonth() + 1, d: j.getUTCDate(), wd: j.getUTCDay(), hh: j.getUTCHours(), mm: j.getUTCMinutes() };
};
// JSTの y-m-d hh:mm → UTC Date
const fromJst = (y, m, d, hh, mm) => new Date(Date.UTC(y, m - 1, d, hh, mm) - JST_MS);
const fmtJst = (iso) => {
  if (!iso) return '';
  const p = toJstParts(new Date(iso));
  const z = (n) => String(n).padStart(2, '0');
  return `${p.y}/${z(p.m)}/${z(p.d)} ${z(p.hh)}:${z(p.mm)}`;
};

// ---- 個人情報のマスク(AIに渡す前の補助。完全ではないので画面で必ず目視確認を促す) ----
function maskPII(text) {
  let t = String(text || '');
  const found = [];
  const rep = (re, label) => { t = t.replace(re, () => { found.push(label); return `【${label}を削除】`; }); };
  rep(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 'メール');
  rep(/https?:\/\/\S+/g, 'URL');
  rep(/0\d{1,4}[-ー\s]?\d{1,4}[-ー\s]?\d{3,4}/g, '電話番号');
  rep(/〒?\s?\d{3}[-ー]\d{4}/g, '郵便番号');
  rep(/@[A-Za-z0-9._]{2,}/g, 'アカウント名');
  rep(/(?:病気|病歴|持病|既往症?|通院|入院|手術|がん|癌|糖尿病|高血圧|うつ|心臓|透析|服薬|薬を飲)[^。\n]{0,30}/g, '健康に関する記述');
  return { text: t, found: [...new Set(found)] };
}

// ---- 投稿・自動応答の文面チェック(ルール § 5) ----
const RULES = [
  { code: 'assert', level: 'warn', re: /必ず|絶対|100\s?[%％]|確実に|間違いなく|誰でも(?:加入|入れ)|無条件|心配(?:いら|ありません)|損(?:は)?しない/, msg: '断定的な表現です。条件を添えるか、表現をやわらげてください。' },
  { code: 'fear', level: 'warn', re: /今すぐ|急いで|急がない?と|今だけ|手遅れ|後悔(?:する|します)|入らないと|何かあってから|明日は我が身/, msg: '不安をあおる・加入を急がせる表現の可能性があります。' },
  { code: 'number', level: 'warn', re: /\d[\d,]*\s*(?:円|万円|万|%|％|歳|年|日|ヶ月|か月)/, msg: '金額・数値・年齢・期間が含まれています。登録した公式資料と一致するか確認してください。' },
  { code: 'story', level: 'warn', re: /お客様の声|ご利用者様?の声|実際に(?:ご|お)?(?:加入|相談|利用)|私の(?:経験|体験)|(?:\d+|何)(?:人|件|組)の(?:方|ご家族|お客様)|実績/, msg: '体験談・お客様の声・実績の可能性があります。事実として確認できる内容のみ使ってください。' },
  { code: 'compare', level: 'warn', re: /他社|他の(?:保険|共済)|(?:保険|共済)(?:より|と比べ)|民間保険|生命保険/, msg: '他商品との比較は、確認できる根拠を示してください。' },
  { code: 'coverage', level: 'warn', re: /保障(?:される|します|対象)|給付(?:される|金)|支払われ|お支払い|加入(?:できます|できる)|加入条件/, msg: '保障内容・加入可否に触れています。公式資料にある内容か確認してください。' },
  { code: 'ask_private', level: 'block', re: /(?:病歴|持病|病気|既往症?|健康状態|年収|住所|電話番号|生年月日|氏名).{0,12}(?:教えて|書いて|記入|ください|お聞かせ|入力)|(?:教えて|書いて|記入|お聞かせ).{0,12}(?:病歴|持病|病気|既往症?|健康状態|年収|住所|電話番号|生年月日)/, msg: '病歴・個人情報の記入を促す文面は使えません。' },
];
function lintText(text) {
  const out = [];
  for (const r of RULES) {
    const m = String(text || '').match(r.re);
    if (m) out.push({ code: r.code, level: r.level, msg: r.msg, hit: m[0] });
  }
  return out;
}
const hasBlock = (issues) => issues.some((i) => i.level === 'block');

// ---- 暗号化(秘密情報をDBに保存するときに使う) ----
function keyFrom(secret) { return crypto.createHash('sha256').update('smile-secret-v1:' + secret).digest(); }
function encrypt(plain, secret) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}
function decrypt(blob, secret) {
  const [iv, tag, enc] = String(blob).split('.').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', keyFrom(secret), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

// ---- パスワード(scrypt) ----
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 32);
  return `scrypt$${salt.toString('base64')}$${h.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  try {
    const [, s, h] = String(stored).split('$');
    const calc = crypto.scryptSync(pw, Buffer.from(s, 'base64'), 32);
    const want = Buffer.from(h, 'base64');
    return calc.length === want.length && crypto.timingSafeEqual(calc, want);
  } catch { return false; }
}
const sign = (data, secret) => crypto.createHmac('sha256', secret).update(data).digest('base64url');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

module.exports = { nowIso, rid, toJstParts, fromJst, fmtJst, maskPII, lintText, hasBlock, encrypt, decrypt, hashPassword, verifyPassword, sign, safeEq };
