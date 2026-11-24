'use strict';
// 外部接続なしで画面を確認するためのデモデータ(すべて「デモ」印つき。設定画面から一括削除できます)
const path = require('node:path'); const fs = require('node:fs');
try { for (const l of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]; } } catch {}
const { openDb } = require('../lib/db'); const { makeServices } = require('../lib/services');
const db = openDb(path.join(__dirname, '..', 'data', 'app.db'), process.env.APP_SECRET); const svc = makeServices(db);
const t = new Date().toISOString(); const tomorrow = new Date(Date.now() + 86400e3).toISOString();
const post = (theme, body, status, extra = {}) => db.run('INSERT INTO posts(theme,body,status,scheduled_at,created_at,updated_at,is_demo,checked) VALUES(?,?,?,?,?,?,1,?)', theme, body, status, extra.at || null, t, t, status === '承認済み' ? 1 : 0);
post('家族の安心', '【デモ】家族が笑って過ごせる毎日を、支えているものを考えてみませんか。', '要確認');
post('現在の保障を確認するきっかけ', '【デモ】最後に保障を見直したのはいつですか？一覧にするだけでも気づきがあります。', '下書き');
post('LINEや個別相談への案内', '【デモ】気になる方はプロフィールのリンクからLINEへ。無理な勧誘はしません。', '承認済み', { at: tomorrow });
db.run("INSERT INTO comments(text,username,status,source,created_at,is_demo) VALUES('【デモ】詳しく知りたいです','demo_user','未対応','manual',?,1)", t);
db.run("INSERT INTO dm_items(label,category,body,reply_draft,created_at,updated_at,is_demo) VALUES('デモAさん','相談したい','【デモ】相談したいです',?,?,?,1)", '【デモ】メッセージありがとうございます。', t, t);
db.run("INSERT INTO inquiries(display_name,channel,category,status,last_action_at,created_at,is_demo) VALUES('デモ友だち#1','LINE','今の備えを確認したい','未対応',?,?,1)", t, t);
db.run("INSERT INTO follows(name,profile_url,reason,next_check,created_at,is_demo) VALUES('デモの方','https://www.threads.net/@example','家族の備えの投稿に共感','2026-12-01',?,1)", t);
db.run("INSERT INTO materials(title,kind,content,created_at,is_demo) VALUES('【デモ】公式パンフレット(ダミー)','公式資料','',?,1)", t);
console.log('デモデータを入れました。削除は 設定 → データの保存と削除 → デモデータを削除。');
