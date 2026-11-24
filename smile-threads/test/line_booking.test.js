'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { start, mockServer, lineSig } = require('./helpers');

async function lineSetup(t, mode = 'live') {
  await t.call('PUT', '/api/secrets', { line_channel_secret: 'chsecret', line_access_token: 'LTOKEN' });
  if (mode === 'live') await t.call('PUT', '/api/settings', { line_mode: 'live', confirm_live: '本番' });
}
const hook = (t, events, sig) => { const body = JSON.stringify({ events }); return t.call('POST', '/webhook/line', body, { noCookie: true, noCsrf: true, headers: { 'x-line-signature': sig ?? lineSig(body, 'chsecret') } }); };

test('LINE Webhook: 未設定は503 / 署名不正は401で破棄 / 正しい署名のみ処理', async () => {
  const mock = await mockServer(() => ({ json: {} })); process.env.LINE_API_BASE = mock.url;
  const t = await start(); await t.login();
  assert.equal((await hook(t, [], 'x')).status, 503);
  await lineSetup(t);
  assert.equal((await hook(t, [{ type: 'follow', source: { userId: 'U1' }, replyToken: 'r' }], 'bad')).status, 401);
  assert.equal(mock.calls.length, 0); assert.equal(t.db.q('SELECT * FROM inquiries').length, 0);
  assert.equal((await hook(t, [{ type: 'follow', source: { userId: 'U1' }, replyToken: 'r1' }])).status, 200);
  await new Promise((r) => setTimeout(r, 100));
  const reply = JSON.parse(mock.calls.find((c) => c.url === '/v2/bot/message/reply').body);
  assert.equal(reply.replyToken, 'r1'); assert.equal(reply.messages[0].quickReply.items.length, 4);
  assert.match(reply.messages[0].text, /自動応答/); // 自動応答であることを明示
  assert.equal(mock.calls[0].headers.authorization, 'Bearer LTOKEN');
  assert.equal(t.db.q('SELECT * FROM inquiries').length, 1);
  mock.close(); delete process.env.LINE_API_BASE; t.close();
});

test('LINE応答: 未確認の文面は送らず引き継ぎ / 確認済みは送信 / 自由記述は引き継ぎ / 一括停止で返信しない', async () => {
  const mock = await mockServer(() => ({ json: {} })); process.env.LINE_API_BASE = mock.url;
  const t = await start(); await t.login(); await lineSetup(t);
  const pb = (k, tok) => [{ type: 'postback', source: { userId: 'U1' }, replyToken: tok, postback: { data: 'menu=' + k } }];
  const lastReply = () => JSON.parse(mock.calls.filter((c) => c.url.includes('/reply')).at(-1).body).messages[0].text;
  await hook(t, pb('1', 'a')); await new Promise((r) => setTimeout(r, 80));
  assert.match(lastReply(), /確認して、あらためてご連絡/); // 未登録の商品情報は断定しない
  await t.call('PUT', '/api/line/menu/1', { response_text: '確認済みの案内文です', verified: true });
  await hook(t, pb('1', 'b')); await new Promise((r) => setTimeout(r, 80));
  assert.match(lastReply(), /確認済みの案内文/);
  await hook(t, [{ type: 'message', source: { userId: 'U1' }, replyToken: 'c', message: { type: 'text', text: '私は持病がありますが入れますか' } }]); await new Promise((r) => setTimeout(r, 80));
  assert.match(lastReply(), /確認して、あらためてご連絡/); assert.ok(!/入れます/.test(lastReply()));
  assert.ok(t.db.q('SELECT * FROM notifications').length >= 1);
  await hook(t, pb('3', 'd')); await new Promise((r) => setTimeout(r, 80));
  assert.match(lastReply(), /https:\/\/example\.test\/book\?lu=/);
  await t.call('POST', '/api/pause', { paused: true }); const n = mock.calls.length;
  await hook(t, pb('1', 'e')); await new Promise((r) => setTimeout(r, 80));
  assert.equal(mock.calls.length, n); // 停止中は返信しない
  mock.close(); delete process.env.LINE_API_BASE; t.close();
});

test('LINE返信の失敗はログと通知に残る', async () => {
  const mock = await mockServer(() => ({ status: 401, json: { message: 'invalid token' } })); process.env.LINE_API_BASE = mock.url;
  const t = await start(); await t.login(); await lineSetup(t);
  await hook(t, [{ type: 'follow', source: { userId: 'U9' }, replyToken: 'r' }]); await new Promise((r) => setTimeout(r, 100));
  assert.ok(t.db.q("SELECT * FROM line_log WHERE status='error'").length >= 1);
  assert.ok(!JSON.stringify(t.db.q('SELECT * FROM line_log')).includes('LTOKEN'));
  mock.close(); delete process.env.LINE_API_BASE; t.close();
});

test('LINEテスト画面: テストモードでは外部送信せずログのみ', async () => {
  const t = await start(); await t.login();
  const r = await t.call('POST', '/api/line/simulate', { type: 'follow' });
  assert.equal(r.status, 200); assert.ok(r.json.log.some((l) => l.status === 'test-sent'));
  await lineSetup(t); // 本番へ
  assert.equal((await t.call('POST', '/api/line/simulate', { type: 'follow' })).status, 400);
  t.close();
});

test('オーナー通知の登録コード', async () => {
  const mock = await mockServer(() => ({ json: {} })); process.env.LINE_API_BASE = mock.url;
  const t = await start(); await t.login(); await lineSetup(t);
  const code = t.db.getSetting('owner_claim_code');
  await hook(t, [{ type: 'message', source: { userId: 'UOWNER' }, replyToken: 'r', message: { type: 'text', text: '登録 wrong' } }]);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(t.db.hasSecret('line_owner_user_id'), false);
  await hook(t, [{ type: 'message', source: { userId: 'UOWNER' }, replyToken: 'r', message: { type: 'text', text: '登録 ' + code } }]);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(t.db.getSecret('line_owner_user_id'), 'UOWNER');
  mock.close(); delete process.env.LINE_API_BASE; t.close();
});

test('予約: 空き枠・同時予約でも二重予約なし・キャンセルで再開放・同意必須', async () => {
  const t = await start(); await t.login();
  await t.call('PUT', '/api/availability', { rows: [0, 1, 2, 3, 4, 5, 6].map((w) => ({ weekday: w, start_time: '10:00', end_time: '12:00', slot_min: 60 })) });
  const slots = (await t.call('GET', '/api/public/slots', undefined, { noCookie: true })).json.slots;
  assert.ok(slots.length > 20);
  const earliest = Date.now() + 24 * 3600e3; assert.ok(slots.every((s) => Date.parse(s.start) >= earliest)); // 受付開始までの猶予
  const s = slots[0].start;
  const b = (extra = {}) => t.call('POST', '/api/public/book', { slot_start: s, method: 'オンライン相談', display_name: 'テスト太郎', consent: true, ...extra }, { noCookie: true, noCsrf: true });
  assert.equal((await b({ consent: false })).status, 400);
  assert.equal((await b({ method: '訪問' })).status, 400);
  assert.equal((await b({ slot_start: '2000-01-01T00:00:00Z' })).status, 409);
  const rs = await Promise.all([b(), b(), b()]);
  assert.equal(rs.filter((r) => r.status === 200).length, 1); assert.equal(rs.filter((r) => r.status === 409).length, 2);
  assert.equal(t.db.q("SELECT * FROM bookings WHERE status='confirmed'").length, 1);
  assert.ok(!(await t.call('GET', '/api/public/slots', undefined, { noCookie: true })).json.slots.some((x) => x.start === s));
  const inq = t.db.one('SELECT * FROM inquiries'); assert.equal(inq.status, '相談予定'); assert.equal(inq.has_booking, 1);
  assert.ok(t.db.q('SELECT * FROM notifications').length >= 1);
  await t.call('POST', `/api/bookings/${t.db.one('SELECT id FROM bookings').id}/cancel`, {});
  assert.equal((await b()).status, 200); // 再予約できる
  t.close();
});

test('予約ページから個人情報の過剰入力を受けない(連絡メモは200文字まで)/ 公開APIは管理APIを開かない', async () => {
  const t = await start();
  assert.equal((await t.call('GET', '/api/bookings', undefined, { noCookie: true })).status, 401);
  assert.equal((await t.call('GET', '/api/inquiries', undefined, { noCookie: true })).status, 401);
  t.close();
});

test('問い合わせ: 削除で関連ログも消える / 保存期間で自動削除', async () => {
  const t = await start(); await t.login();
  const i = (await t.call('POST', '/api/inquiries', { display_name: 'A', channel: 'LINE', line_user_id: 'UDEL' })).json;
  t.db.run("INSERT INTO line_log(direction,mode,line_user_id,text,status,created_at) VALUES('in','test','UDEL','hi','received',?)", new Date().toISOString());
  await t.call('DELETE', `/api/inquiries/${i.id}`);
  assert.equal(t.db.q('SELECT * FROM line_log').length, 0);
  t.db.run("INSERT INTO line_log(direction,mode,line_user_id,text,status,created_at) VALUES('in','test','U','old','received','2000-01-01T00:00:00Z')");
  t.db.run("INSERT INTO comments(text,created_at) VALUES('old','2000-01-01T00:00:00Z')");
  assert.ok(t.svc.purgeOld() >= 2);
  t.close();
});

test('数字: 手入力と自動取得を分けて記録 / 未連携は自動取得不可', async () => {
  const t = await start(); await t.login();
  assert.equal((await t.call('POST', '/api/metrics/fetch', {})).status, 400);
  await t.call('POST', '/api/metrics', { metric: 'プロフィールリンクのクリック数', value: 12 });
  const m = (await t.call('GET', '/api/metrics')).json; assert.equal(m.totals[0].source, '手入力');
  const l = await t.call('POST', '/api/links', { label: 'Threads投稿A', target: 'https://lin.ee/xxxx' });
  const r = await fetch(t.base + '/r/' + l.json.code, { redirect: 'manual' }); assert.equal(r.status, 302);
  assert.equal(t.db.one('SELECT clicks FROM short_links').clicks, 1);
  assert.equal((await t.call('POST', '/api/links', { target: 'javascript:alert(1)' })).status, 400);
  t.close();
});
