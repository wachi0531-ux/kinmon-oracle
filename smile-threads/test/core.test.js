'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { start, mockServer, lineSig } = require('./helpers');
const { maskPII, lintText, verifyPassword, hashPassword, encrypt, decrypt } = require('../lib/util');
const { verifySignature } = require('../lib/line');

test('util: 個人情報マスク / 文面チェック / 暗号化 / パスワード', () => {
  const m = maskPII('田中です。tel 090-1234-5678 mail a@b.com 持病の糖尿病があります');
  assert.ok(!/090-1234|a@b\.com|糖尿病/.test(m.text)); assert.ok(m.found.includes('電話番号') && m.found.includes('メール'));
  assert.ok(lintText('必ず保障されます').some((i) => i.code === 'assert'));
  assert.ok(lintText('今すぐ入らないと後悔します').some((i) => i.code === 'fear'));
  assert.ok(lintText('月額1,000円です').some((i) => i.code === 'number'));
  assert.ok(lintText('持病を教えてください').some((i) => i.level === 'block'));
  assert.equal(lintText('備えについて一緒に考えましょう').length, 0);
  assert.equal(decrypt(encrypt('tok-123', 's'), 's'), 'tok-123');
  assert.throws(() => decrypt(encrypt('x', 's'), 'other'));
  assert.ok(verifyPassword('a', hashPassword('a')) && !verifyPassword('b', hashPassword('a')));
});

test('LINE署名検証: 正しい署名のみ通る', () => {
  const body = Buffer.from('{"events":[]}');
  assert.ok(verifySignature(body, lineSig(body, 'sec'), 'sec'));
  assert.ok(!verifySignature(body, lineSig(body, 'other'), 'sec'));
  assert.ok(!verifySignature(Buffer.from('{"events":[1]}'), lineSig(body, 'sec'), 'sec'));
  assert.ok(!verifySignature(body, '', 'sec') && !verifySignature(body, 'x', ''));
});

test('認証: 未ログインは拒否 / CSRF対策 / 誤パスワード', async () => {
  const t = await start();
  assert.equal((await t.call('GET', '/api/dashboard', undefined, { noCookie: true })).status, 401);
  assert.equal((await t.call('POST', '/api/login', { password: 'bad' })).status, 401);
  assert.equal((await t.login()).status, 200);
  assert.equal((await t.call('GET', '/api/dashboard')).status, 200);
  assert.equal((await t.call('POST', '/api/posts', { body: 'x' }, { noCsrf: true })).status, 403);
  assert.equal((await t.call('GET', '/../server.js')).status, 404);
  assert.equal((await t.call('POST', '/api/logout-all', {})).status, 200);
  assert.equal((await t.call('GET', '/api/dashboard')).status, 401); // 既存セッションが失効
  t.close();
});

test('ログインは5回失敗でロック', async () => {
  const t = await start();
  for (let i = 0; i < 5; i++) await t.call('POST', '/api/login', { password: 'bad' });
  assert.equal((await t.call('POST', '/api/login', { password: 'pw-test' })).status, 429);
  t.close();
});

test('投稿: 承認なしで予約不可 / 所属先確認・チェック必須 / 秘密は返さない', async () => {
  const t = await start(); await t.login();
  const g = await t.call('POST', '/api/posts/generate', { theme: '家族の安心' });
  assert.equal(g.json.via, 'template'); assert.equal(g.json.post.status, '要確認');
  const id = g.json.post.id; const future = new Date(Date.now() + 3600e3).toISOString();
  assert.equal((await t.call('POST', `/api/posts/${id}/transition`, { to: '予約済み', scheduled_at: future })).status, 400);
  assert.match((await t.call('POST', `/api/posts/${id}/transition`, { to: '承認済み', checked: true })).json.error, /所属先/);
  await t.call('PUT', '/api/settings', { affiliation_rule_confirmed: '1' });
  assert.match((await t.call('POST', `/api/posts/${id}/transition`, { to: '承認済み' })).json.error, /チェック/);
  assert.equal((await t.call('POST', `/api/posts/${id}/transition`, { to: '承認済み', checked: true })).json.status, '承認済み');
  assert.equal((await t.call('POST', `/api/posts/${id}/transition`, { to: '予約済み', scheduled_at: future })).json.status, '予約済み');
  // 本文を変えると承認が取り消される
  const up = await t.call('PUT', `/api/posts/${id}`, { body: '書き換えました' });
  assert.equal(up.json.status, '要確認');
  // 使えない表現は承認不可
  const b = await t.call('POST', '/api/posts', { theme: 'x', body: '病歴を教えてください' });
  await t.call('PUT', `/api/posts/${b.json.id}`, { checked: 1 });
  assert.equal((await t.call('POST', `/api/posts/${b.json.id}/transition`, { to: '承認済み', checked: true })).status, 400);
  // 秘密情報は設定済みかどうかのみ
  await t.call('PUT', '/api/secrets', { threads_token: 'SUPER-SECRET-TOKEN' });
  const s = await t.call('GET', '/api/settings');
  assert.equal(s.json.secrets.threads_token, true); assert.ok(!JSON.stringify(s.json).includes('SUPER-SECRET'));
  assert.ok(!JSON.stringify(t.db.q('SELECT * FROM secrets')).includes('SUPER-SECRET'));
  t.close();
});

async function approved(t, body = '備えについて考えるきっかけに。') {
  await t.call('PUT', '/api/settings', { affiliation_rule_confirmed: '1' });
  const p = await t.call('POST', '/api/posts', { theme: '家族の安心', body });
  return (await t.call('POST', `/api/posts/${p.json.id}/transition`, { to: '承認済み', checked: true })).json.id;
}

test('予約投稿: 連携待ち表示 / 一時停止 / 時刻になれば1回だけ投稿(テストモード)', async () => {
  const t = await start(); await t.login();
  const id = await approved(t);
  await t.call('POST', `/api/posts/${id}/transition`, { to: '予約済み', scheduled_at: new Date(Date.now() + 500).toISOString() });
  await t.call('PUT', '/api/settings', { threads_mode: 'live', confirm_live: '本番' }); // 未連携の本番
  assert.equal((await t.call('GET', `/api/posts/${id}`)).json.display_status, '連携待ち');
  await new Promise((r) => setTimeout(r, 700));
  assert.deepEqual(await t.svc.runDuePosts(), { waiting: true });
  assert.equal(t.svc.getPost(id).status, '予約済み'); // 投稿済みに見せない
  await t.call('PUT', '/api/settings', { threads_mode: 'test' });
  await t.call('POST', '/api/pause', { paused: true });
  assert.deepEqual(await t.svc.runDuePosts(), { paused: true });
  assert.equal(t.svc.getPost(id).status, '予約済み');
  await t.call('POST', '/api/pause', { paused: false });
  await Promise.all([t.svc.runDuePosts(), t.svc.runDuePosts()]);
  const p = t.svc.getPost(id); assert.equal(p.status, '投稿済み'); assert.equal(p.publish_mode, 'test'); assert.equal(p.attempts, 1);
  const d = await t.call('GET', `/api/posts/${id}`); assert.equal(d.json.display_status, '投稿済み(テスト)');
  assert.equal((await t.call('GET', '/api/dashboard')).json.published, 0); // テストは公開件数に含めない
  t.close();
});

test('本番モードへ切替は確認語が必要 / 公式APIの呼び出し内容(モック)', async () => {
  const mock = await mockServer(({ method, url }) => {
    if (url.startsWith('/v1.0/U1/threads_publish')) return { json: { id: 'M1' } };
    if (url.startsWith('/v1.0/U1/threads')) return { json: { id: 'C1' } };
    if (url.startsWith('/v1.0/M1')) return { json: { permalink: 'https://www.threads.net/@x/post/abc' } };
    return { status: 404, json: { error: { message: 'no' } } };
  });
  process.env.THREADS_API_BASE = mock.url + '/v1.0';
  const t = await start(); await t.login();
  assert.equal((await t.call('PUT', '/api/settings', { threads_mode: 'live' })).status, 400);
  await t.call('PUT', '/api/secrets', { threads_token: 'TKN', threads_user_id: 'U1' });
  assert.equal((await t.call('PUT', '/api/settings', { threads_mode: 'live', confirm_live: '本番' })).status, 200);
  const id = await approved(t);
  assert.equal((await t.call('POST', `/api/posts/${id}/publish-now`, {})).status, 400); // 「投稿」確認なし
  const r = await t.call('POST', `/api/posts/${id}/publish-now`, { confirm: '投稿' });
  assert.equal(r.json.post.status, '投稿済み'); assert.equal(r.json.post.permalink, 'https://www.threads.net/@x/post/abc'); assert.equal(r.json.post.publish_mode, 'live');
  assert.ok(mock.calls[0].body.includes('media_type=TEXT')); assert.ok(mock.calls[1].body.includes('creation_id=C1'));
  assert.equal((await t.call('GET', '/api/dashboard')).json.published, 1);
  mock.close(); delete process.env.THREADS_API_BASE; t.close();
});

test('公開失敗はエラーとして記録され、投稿済みにならない', async () => {
  const mock = await mockServer(() => ({ status: 400, json: { error: { message: 'bad token' } } }));
  process.env.THREADS_API_BASE = mock.url + '/v1.0';
  const t = await start(); await t.login();
  await t.call('PUT', '/api/secrets', { threads_token: 'TKN', threads_user_id: 'U1' });
  await t.call('PUT', '/api/settings', { threads_mode: 'live', confirm_live: '本番' });
  const id = await approved(t);
  await t.call('POST', `/api/posts/${id}/publish-now`, { confirm: '投稿' });
  const p = t.svc.getPost(id); assert.equal(p.status, 'エラー'); assert.match(p.error, /bad token/); assert.ok(!p.error.includes('TKN'));
  assert.ok((await t.call('GET', '/api/dashboard')).json.attention.length >= 1);
  mock.close(); delete process.env.THREADS_API_BASE; t.close();
});

test('コメント自動返信: 初期オフ / キーワード一致のみ / 二重返信なし / 停止', async () => {
  const sent = [];
  const mock = await mockServer(({ url, body }) => {
    if (url.startsWith('/v1.0/U1/threads_publish')) return { json: { id: 'R' + sent.length } };
    if (url.startsWith('/v1.0/U1/threads')) { sent.push(body); return { json: { id: 'C' } }; }
    if (url.startsWith('/v1.0/me')) return { json: { username: 'wacchi' } };
    if (url.startsWith('/v1.0/M9/replies')) return { json: { data: [{ id: 'c1', text: '詳しく知りたいです', username: 'a' }, { id: 'c2', text: 'いいね', username: 'b' }, { id: 'c3', text: '詳しく', username: 'wacchi' }] } };
    return { json: { permalink: '' } };
  });
  process.env.THREADS_API_BASE = mock.url + '/v1.0';
  const t = await start(); await t.login();
  assert.equal((await t.call('GET', '/api/settings')).json.auto_reply_enabled, '0');
  await t.call('PUT', '/api/secrets', { threads_token: 'T', threads_user_id: 'U1' });
  await t.call('PUT', '/api/settings', { threads_mode: 'live', confirm_live: '本番' });
  t.db.run("INSERT INTO posts(theme,body,status,threads_id,publish_mode,published_at,created_at) VALUES('x','y','投稿済み','M9','live',?,?)", new Date().toISOString(), new Date().toISOString());
  const pid = t.db.one('SELECT id FROM posts').id;
  assert.equal((await t.call('POST', '/api/auto-replies', { post_id: pid, keywords: '詳しく', reply_text: '病歴を教えてください' })).status, 400);
  const rule = await t.call('POST', '/api/auto-replies', { post_id: pid, keywords: '詳しく,知りたい', reply_text: 'ありがとうございます。プロフィールのリンクからご質問ください。' });
  assert.equal(rule.status, 200);
  let r = await t.call('POST', '/api/comments/sync', {}); // 自動返信オフ
  assert.equal(r.json.added, 2); assert.equal(sent.length, 0);
  await t.call('PUT', `/api/auto-replies/${rule.json.id}`, { enabled: true });
  await t.call('PUT', '/api/settings', { auto_reply_enabled: '1' });
  await t.call('POST', '/api/pause', { paused: true });
  await t.call('POST', '/api/comments/sync', {}); assert.equal(sent.length, 0); // 一括停止中
  await t.call('POST', '/api/pause', { paused: false });
  await t.call('POST', '/api/comments/sync', {}); await t.call('POST', '/api/comments/sync', {});
  assert.equal(sent.length, 1); assert.ok(sent[0].includes('reply_to_id=c1'));
  assert.equal(t.db.one("SELECT reply_status s FROM comments WHERE threads_comment_id='c2'").s, 'none');
  mock.close(); delete process.env.THREADS_API_BASE; t.close();
});

test('手入力コメントはAPI返信不可 / 返信は承認必須', async () => {
  const t = await start(); await t.login();
  const c = (await t.call('POST', '/api/comments', { username: 'x', text: 'こんにちは' })).json;
  const d = await t.call('POST', `/api/comments/${c.id}/draft`, {}); assert.ok(d.json.reply_draft);
  assert.equal((await t.call('POST', `/api/comments/${c.id}/send`, { approved: false })).status, 400);
  assert.match((await t.call('POST', `/api/comments/${c.id}/send`, { approved: true })).json.error, /手入力/);
  t.close();
});

test('DM支援: マスク・返信案(商品未登録は要確認)', async () => {
  const t = await start(); await t.login();
  const m = await t.call('POST', '/api/dm-mask', { text: '090-1111-2222 に電話ください' }); assert.ok(!m.json.text.includes('090'));
  const dm = (await t.call('POST', '/api/dms', { category: '掛金について知りたい', body: '掛金は？' })).json;
  assert.match(dm.reply_draft, /要確認/);
  await t.call('PUT', '/api/settings', { product: { premium: '【登録した掛金の文面】' } });
  const re = await t.call('PUT', `/api/dms/${dm.id}`, { regen: true }); assert.match(re.json.reply_draft, /登録した掛金の文面/);
  t.close();
});
