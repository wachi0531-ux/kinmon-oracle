'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { encrypt, decrypt, nowIso } = require('./util');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS secrets  (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
CREATE TABLE IF NOT EXISTS materials (id INTEGER PRIMARY KEY, title TEXT NOT NULL, kind TEXT, url TEXT, content TEXT, verified_at TEXT, created_at TEXT, is_demo INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY, theme TEXT NOT NULL, body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '下書き',
  scheduled_at TEXT, created_at TEXT, updated_at TEXT,
  permalink TEXT, threads_id TEXT, publish_mode TEXT, published_at TEXT,
  error TEXT, checked INTEGER DEFAULT 0, check_notes TEXT, material_id INTEGER,
  claimed_at TEXT, attempts INTEGER DEFAULT 0, is_demo INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY, post_id INTEGER, threads_comment_id TEXT UNIQUE, username TEXT, text TEXT,
  status TEXT DEFAULT '未対応', reply_draft TEXT, reply_status TEXT DEFAULT 'none', reply_error TEXT,
  replied_at TEXT, source TEXT DEFAULT 'manual', created_at TEXT, is_demo INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS auto_reply_rules (id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL, keywords TEXT NOT NULL, reply_text TEXT NOT NULL, enabled INTEGER DEFAULT 0, created_at TEXT);
CREATE TABLE IF NOT EXISTS dm_items (id INTEGER PRIMARY KEY, label TEXT, category TEXT, body TEXT, reply_draft TEXT, status TEXT DEFAULT '未対応', created_at TEXT, updated_at TEXT, is_demo INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS inquiries (
  id INTEGER PRIMARY KEY, display_name TEXT NOT NULL, channel TEXT, category TEXT, status TEXT DEFAULT '未対応',
  last_action_at TEXT, next_action_at TEXT, has_booking INTEGER DEFAULT 0, memo TEXT, line_user_id TEXT, created_at TEXT, is_demo INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS line_menu (key TEXT PRIMARY KEY, label TEXT, response_text TEXT, verified INTEGER DEFAULT 0, enabled INTEGER DEFAULT 1, sort INTEGER);
CREATE TABLE IF NOT EXISTS line_log (id INTEGER PRIMARY KEY, direction TEXT, mode TEXT, line_user_id TEXT, text TEXT, status TEXT, error TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS availability (id INTEGER PRIMARY KEY, weekday INTEGER, start_time TEXT, end_time TEXT, slot_min INTEGER DEFAULT 60);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY, slot_start TEXT NOT NULL, slot_end TEXT NOT NULL, method TEXT, display_name TEXT, contact_note TEXT,
  status TEXT DEFAULT 'confirmed', inquiry_id INTEGER, gcal_event_id TEXT, line_user_id TEXT, mode TEXT, created_at TEXT, is_demo INTEGER DEFAULT 0);
CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_slot ON bookings(slot_start) WHERE status='confirmed';
CREATE TABLE IF NOT EXISTS metrics (id INTEGER PRIMARY KEY, date TEXT, metric TEXT, value REAL, source TEXT, post_id INTEGER, note TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS follows (id INTEGER PRIMARY KEY, name TEXT, profile_url TEXT, reason TEXT, next_check TEXT, status TEXT DEFAULT '未対応', created_at TEXT, is_demo INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY, level TEXT, kind TEXT, title TEXT, body TEXT, read INTEGER DEFAULT 0, created_at TEXT);
CREATE TABLE IF NOT EXISTS short_links (code TEXT PRIMARY KEY, label TEXT, target TEXT, clicks INTEGER DEFAULT 0, created_at TEXT);
`;

const DEFAULT_SETTINGS = {
  automation_paused: '0',        // 一括停止
  threads_mode: 'test',          // test | live
  line_mode: 'test',
  line_bot_enabled: '1',
  line_notify_owner: '0',
  auto_reply_enabled: '0',       // コメント自動返信(初期オフ)
  auto_reply_daily_cap: '20',
  ai_provider: 'openai',         // openai(既定) | anthropic | none
  ai_model: '',
  ai_base_url: '',
  retention_days: '365',
  booking_lead_hours: '24',
  booking_horizon_days: '14',
  line_add_friend_url: '',
  affiliation_rule_confirmed: '0',
  affiliation_rule_note: '',
  owner_claim_code: '',
};
const DEFAULT_MENU = [
  ['welcome', 'あいさつ(友だち追加時)', 'ご登録ありがとうございます。ご質問内容を下のメニューからお選びください。', 0, 0],
  ['1', 'スマイル共済について知りたい', '', 0, 1],
  ['2', '今の備えを確認したい', '', 0, 2],
  ['3', '個別相談を予約したい', '個別相談のご予約はこちらからお選びいただけます。', 1, 3],
  ['4', 'わっちに直接質問したい', 'ご質問ありがとうございます。担当のわっちが内容を確認して、あらためてご連絡します。お急ぎの場合や個別のご事情については、こちらではお答えできないことがあります。', 1, 4],
  ['fallback', '判断が難しいとき', 'メッセージありがとうございます。内容を担当のわっちが確認して、あらためてご連絡します。', 1, 5],
];
const PRODUCT_KEYS = [
  ['official_name', '正式名称'], ['operator', '運営元(共済団体名など)'], ['coverage', '保障内容'],
  ['premium', '掛金'], ['eligibility', '加入条件'], ['affiliation_rules', '所属先の案内・募集ルール'], ['contact_note', '相談窓口・連絡先(公開してよいもの)'],
];

function openDb(file, secret) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  db.exec(SCHEMA);
  const q = (sql, ...p) => db.prepare(sql).all(...p).map((r) => ({ ...r }));
  const one = (sql, ...p) => { const r = db.prepare(sql).get(...p); return r ? { ...r } : undefined; };
  const run = (sql, ...p) => db.prepare(sql).run(...p);
  const api = {
    raw: db, q, one, run,
    getSetting: (k) => { const r = one('SELECT value FROM settings WHERE key=?', k); return r ? r.value : (DEFAULT_SETTINGS[k] ?? ''); },
    setSetting: (k, v) => run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, String(v)),
    allSettings: () => { const o = { ...DEFAULT_SETTINGS }; for (const r of q('SELECT * FROM settings')) o[r.key] = r.value; return o; },
    // 秘密情報: DBには暗号化して保存。画面・ログには出さない。環境変数があればそちらを優先しない(UI入力を優先)
    setSecret: (k, v) => run('INSERT INTO secrets(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at', k, encrypt(v, secret), nowIso()),
    getSecret: (k) => {
      const r = one('SELECT value FROM secrets WHERE key=?', k);
      if (r) { try { return decrypt(r.value, secret); } catch { return ''; } }
      return process.env[k.toUpperCase()] || '';
    },
    hasSecret: (k) => !!api.getSecret(k),
    deleteSecret: (k) => run('DELETE FROM secrets WHERE key=?', k),
    notify: (level, kind, title, body = '') => run('INSERT INTO notifications(level,kind,title,body,created_at) VALUES(?,?,?,?,?)', level, kind, title, body, nowIso()),
    close: () => db.close(),
  };
  // 初期データ(商品情報は「未登録」のまま)
  for (const [k, label, text, verified, sort] of DEFAULT_MENU.map((m, i) => [m[0], m[1], m[2], m[3], m[4]])) {
    if (!one('SELECT 1 x FROM line_menu WHERE key=?', k)) run('INSERT INTO line_menu(key,label,response_text,verified,enabled,sort) VALUES(?,?,?,?,1,?)', k, label, text, verified, sort);
  }
  if (!one("SELECT 1 x FROM settings WHERE key='owner_claim_code'")) api.setSetting('owner_claim_code', require('node:crypto').randomBytes(4).toString('hex'));
  if (!one('SELECT 1 x FROM availability')) for (const wd of [1, 2, 3, 4, 5]) run('INSERT INTO availability(weekday,start_time,end_time,slot_min) VALUES(?,?,?,60)', wd, '19:00', '21:00');
  return api;
}
module.exports = { openDb, PRODUCT_KEYS, DEFAULT_SETTINGS };
