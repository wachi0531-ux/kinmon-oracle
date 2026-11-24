'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openDb, PRODUCT_KEYS } = require('./lib/db');
const { makeServices, httpErr } = require('./lib/services');
const { verifySignature } = require('./lib/line');
const { sign, safeEq, verifyPassword, lintText, maskPII, nowIso } = require('./lib/util');
const { THEMES, DM_CATEGORIES, dmReplyDraft } = require('./lib/templates');

try { // .env を読む(依存パッケージなし)
  for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^"|"$/g, ''); }
} catch { /* .envなし */ }

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
const SECRET_KEYS = ['threads_token', 'threads_user_id', 'line_channel_secret', 'line_access_token', 'ai_key', 'gcal_sa_json', 'gcal_calendar_id'];
const SETTING_KEYS = ['automation_paused', 'threads_mode', 'line_mode', 'line_bot_enabled', 'line_notify_owner', 'auto_reply_enabled', 'auto_reply_daily_cap', 'ai_provider', 'ai_model', 'ai_base_url', 'retention_days', 'booking_lead_hours', 'booking_horizon_days', 'line_add_friend_url', 'affiliation_rule_confirmed', 'affiliation_rule_note'];

function createApp({ dbFile, appSecret, passwordHash, cookieSecure = false, services } = {}) {
  const secret = appSecret || process.env.APP_SECRET;
  if (!secret || secret.length < 16) throw new Error('APP_SECRET が未設定です。`npm run setup` を実行してください');
  const db = openDb(dbFile || path.join(__dirname, 'data', 'app.db'), secret);
  const svc = services || makeServices(db, { appSecret: secret });
  const pwHash = passwordHash ?? process.env.ADMIN_PASSWORD_HASH;
  const fails = new Map(); const bookHits = new Map();

  const rate = (map, ip, max, windowMs) => { const t = Date.now(); const a = (map.get(ip) || []).filter((x) => t - x < windowMs); map.set(ip, a); if (a.length >= max) return false; a.push(t); return true; };
  const makeSession = () => { const exp = Date.now() + 12 * 3600 * 1000; const p = `${exp}.${db.getSetting('session_epoch') || '0'}`; return `${p}.${sign(p, secret)}`; };
  const sessionOk = (cookie) => {
    const m = /(?:^|;\s*)sid=([^;]+)/.exec(cookie || ''); if (!m) return false;
    const [exp, epoch, sig] = m[1].split('.');
    return !!sig && safeEq(sign(`${exp}.${epoch}`, secret), sig) && Number(exp) > Date.now() && epoch === (db.getSetting('session_epoch') || '0');
  };
  const send = (res, status, data, headers = {}) => {
    const body = typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', ...headers });
    res.end(body);
  };
  const readRaw = (req, limit = 1e6) => new Promise((ok, ng) => { const c = []; let n = 0; req.on('data', (b) => { n += b.length; if (n > limit) { ng(httpErr(413, '大きすぎます')); req.destroy(); } else c.push(b); }); req.on('end', () => ok(Buffer.concat(c))); req.on('error', ng); });
  const readJson = async (req) => { const b = await readRaw(req); if (!b.length) return {}; try { return JSON.parse(b.toString('utf8')); } catch { throw httpErr(400, '送信内容が正しくありません'); } };

  // ---- 設定画面用: 秘密情報は「設定済みか」だけ返す ----
  function settingsView() {
    const s = db.allSettings(); const out = {};
    for (const k of SETTING_KEYS) out[k] = s[k];
    out.secrets = Object.fromEntries(SECRET_KEYS.map((k) => [k, db.hasSecret(k)]));
    out.owner_registered = db.hasSecret('line_owner_user_id');
    out.owner_claim_code = s.owner_claim_code;
    out.product = Object.fromEntries(PRODUCT_KEYS.map(([k, label]) => [k, { label, value: s['product_' + k] || '' }]));
    out.webhook_url = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '') + '/webhook/line';
    out.booking_url = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '') + '/book';
    return out;
  }

  // ---- ルーティング ----
  const routes = [];
  const R = (method, pattern, fn, opts = {}) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn, ...opts });
  const num = (v) => Number(v);

  R('POST', '/api/login', async (req, res, { body, ip }) => {
    if (!pwHash) throw httpErr(503, 'パスワードが未設定です。npm run setup を実行してください');
    if (!rate(fails, ip, 5, 15 * 60000)) throw httpErr(429, '試行回数が多すぎます。15分ほど待ってください');
    if (!verifyPassword(String(body.password || ''), pwHash)) throw httpErr(401, 'パスワードが違います');
    send(res, 200, { ok: true }, { 'Set-Cookie': `sid=${makeSession()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${cookieSecure ? '; Secure' : ''}` });
  }, { public: true });
  R('POST', '/api/logout', async (req, res) => send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' }), { public: true });
  R('POST', '/api/logout-all', async (req, res) => { db.setSetting('session_epoch', String(Number(db.getSetting('session_epoch') || 0) + 1)); send(res, 200, { ok: true }); });
  R('GET', '/api/me', async (req, res) => send(res, 200, { ok: true }));

  R('GET', '/api/dashboard', async (req, res) => send(res, 200, svc.dashboard()));
  R('GET', '/api/meta', async (req, res) => send(res, 200, { themes: THEMES, dm_categories: DM_CATEGORIES, states: svc.STATES }));

  // 設定
  R('GET', '/api/settings', async (req, res) => send(res, 200, settingsView()));
  R('PUT', '/api/settings', async (req, res, { body }) => {
    for (const k of SETTING_KEYS) if (k in body) {
      if (k === 'line_mode' || k === 'threads_mode') {
        if (!['test', 'live'].includes(body[k])) throw httpErr(400, 'モードが正しくありません');
        if (body[k] === 'live' && db.getSetting(k) !== 'live' && body.confirm_live !== '本番') throw httpErr(400, '本番に切り替えるには、確認欄に「本番」と入力してください');
      }
      db.setSetting(k, body[k]);
    }
    if (body.product) for (const [k] of PRODUCT_KEYS) if (k in body.product) db.setSetting('product_' + k, String(body.product[k]).slice(0, 4000));
    send(res, 200, settingsView());
  });
  R('PUT', '/api/secrets', async (req, res, { body }) => { // 書き込み専用: 値は二度と返さない
    for (const k of SECRET_KEYS) if (k in body) { const v = String(body[k] || '').trim(); if (v) db.setSecret(k, v); else db.deleteSecret(k); }
    send(res, 200, settingsView());
  });
  R('POST', '/api/pause', async (req, res, { body }) => { db.setSetting('automation_paused', body.paused ? '1' : '0'); send(res, 200, { paused: !!body.paused }); });

  // 資料
  R('GET', '/api/materials', async (req, res) => send(res, 200, db.q('SELECT * FROM materials ORDER BY id DESC')));
  R('POST', '/api/materials', async (req, res, { body }) => {
    if (!body.title) throw httpErr(400, 'タイトルを入力してください');
    const r = db.run('INSERT INTO materials(title,kind,url,content,verified_at,created_at) VALUES(?,?,?,?,?,?)', body.title, body.kind || '公式資料', body.url || '', body.content || '', body.verified ? nowIso() : null, nowIso());
    send(res, 200, db.one('SELECT * FROM materials WHERE id=?', Number(r.lastInsertRowid)));
  });
  R('DELETE', '/api/materials/:id', async (req, res, { p }) => { db.run('DELETE FROM materials WHERE id=?', num(p.id)); send(res, 200, { ok: true }); });

  // 投稿
  R('GET', '/api/posts', async (req, res, { query }) => {
    const rows = query.status ? db.q('SELECT * FROM posts WHERE status=? ORDER BY COALESCE(scheduled_at,created_at) DESC', query.status) : db.q('SELECT * FROM posts ORDER BY COALESCE(scheduled_at,created_at) DESC LIMIT 200');
    send(res, 200, rows.map(svc.decoratePost));
  });
  R('GET', '/api/posts/:id', async (req, res, { p }) => { const x = svc.getPost(num(p.id)); if (!x) throw httpErr(404, '見つかりません'); send(res, 200, { ...svc.decoratePost(x), metrics: db.q('SELECT * FROM metrics WHERE post_id=? ORDER BY id DESC', x.id) }); });
  R('POST', '/api/posts', async (req, res, { body }) => { if (!body.body?.trim()) throw httpErr(400, '本文を入力してください'); send(res, 200, svc.decoratePost(svc.createPost({ theme: body.theme || THEMES[0], body: body.body, scheduled_at: body.scheduled_at, check_notes: body.check_notes, material_id: body.material_id }))); });
  R('POST', '/api/posts/generate', async (req, res, { body }) => send(res, 200, await svc.generateDraft({ theme: body.theme || THEMES[0], hint: String(body.hint || '').slice(0, 500) })));
  R('PUT', '/api/posts/:id', async (req, res, { p, body }) => {
    if ('body' in body && body.body.length > svc.threads.MAX_TEXT) throw httpErr(400, `${svc.threads.MAX_TEXT}文字以内にしてください`);
    send(res, 200, svc.decoratePost(svc.updatePost(num(p.id), body)));
  });
  R('POST', '/api/posts/:id/transition', async (req, res, { p, body }) => send(res, 200, svc.decoratePost(svc.transition(num(p.id), body.to, body))));
  R('POST', '/api/posts/:id/publish-now', async (req, res, { p, body }) => {
    const x = svc.getPost(num(p.id));
    if (x.status !== '承認済み') throw httpErr(400, '承認済みの投稿のみ公開できます');
    if (svc.paused()) throw httpErr(400, '自動投稿が一時停止中です');
    if (svc.threads.status().state === 'live' && body.confirm !== '投稿') throw httpErr(400, '本番へ実際に投稿します。確認欄に「投稿」と入力してください');
    svc.transition(x.id, '予約済み', { scheduled_at: new Date().toISOString() });
    send(res, 200, { result: await svc.publishPost(x.id), post: svc.decoratePost(svc.getPost(x.id)) });
  });
  R('DELETE', '/api/posts/:id', async (req, res, { p }) => { const x = svc.getPost(num(p.id)); if (x && ['投稿済み', '予約済み'].includes(x.status)) throw httpErr(400, '投稿済み・予約済みの投稿は削除できません'); db.run('DELETE FROM posts WHERE id=?', num(p.id)); send(res, 200, { ok: true }); });
  R('POST', '/api/lint', async (req, res, { body }) => send(res, 200, svc.lintPost(String(body.text || ''))));

  // コメント
  R('GET', '/api/comments', async (req, res) => send(res, 200, db.q('SELECT c.*, p.theme post_theme FROM comments c LEFT JOIN posts p ON p.id=c.post_id ORDER BY c.id DESC LIMIT 200')));
  R('POST', '/api/comments', async (req, res, { body }) => { const c = svc.addComment({ post_id: body.post_id, username: body.username, text: body.text, source: 'manual' }); send(res, 200, c); });
  R('PUT', '/api/comments/:id', async (req, res, { p, body }) => { for (const k of ['status', 'reply_draft']) if (k in body) db.run(`UPDATE comments SET ${k}=? WHERE id=?`, body[k], num(p.id)); send(res, 200, db.one('SELECT * FROM comments WHERE id=?', num(p.id))); });
  R('POST', '/api/comments/:id/draft', async (req, res, { p }) => send(res, 200, svc.commentDraft(num(p.id))));
  R('POST', '/api/comments/:id/send', async (req, res, { p, body }) => send(res, 200, await svc.sendCommentReply(num(p.id), { approved: !!body.approved })));
  R('POST', '/api/comments/sync', async (req, res) => send(res, 200, await svc.syncComments()));
  R('GET', '/api/auto-replies', async (req, res) => send(res, 200, db.q('SELECT * FROM auto_reply_rules ORDER BY id DESC')));
  R('POST', '/api/auto-replies', async (req, res, { body }) => {
    if (!body.post_id || !body.keywords || !body.reply_text) throw httpErr(400, '対象の投稿・キーワード・返信文をすべて入力してください');
    const is = svc.ruleIssues(body); if (is.some((i) => i.level === 'block')) throw httpErr(400, is.map((i) => i.msg).join(' '));
    const r = db.run('INSERT INTO auto_reply_rules(post_id,keywords,reply_text,enabled,created_at) VALUES(?,?,?,0,?)', num(body.post_id), body.keywords, body.reply_text, nowIso());
    send(res, 200, db.one('SELECT * FROM auto_reply_rules WHERE id=?', Number(r.lastInsertRowid)));
  });
  R('PUT', '/api/auto-replies/:id', async (req, res, { p, body }) => { db.run('UPDATE auto_reply_rules SET enabled=? WHERE id=?', body.enabled ? 1 : 0, num(p.id)); send(res, 200, { ok: true }); });
  R('DELETE', '/api/auto-replies/:id', async (req, res, { p }) => { db.run('DELETE FROM auto_reply_rules WHERE id=?', num(p.id)); send(res, 200, { ok: true }); });

  // DM(手動入力)
  R('GET', '/api/dms', async (req, res) => send(res, 200, db.q('SELECT * FROM dm_items ORDER BY id DESC LIMIT 200')));
  R('POST', '/api/dm-mask', async (req, res, { body }) => send(res, 200, maskPII(body.text)));
  R('POST', '/api/dms', async (req, res, { body }) => send(res, 200, svc.createDm({ label: String(body.label || '').slice(0, 40), category: body.category || 'その他', body: body.body })));
  R('PUT', '/api/dms/:id', async (req, res, { p, body }) => {
    for (const k of ['status', 'reply_draft', 'category', 'body']) if (k in body) db.run(`UPDATE dm_items SET ${k}=?, updated_at=? WHERE id=?`, body[k], nowIso(), num(p.id));
    if (body.regen) { const d = db.one('SELECT * FROM dm_items WHERE id=?', num(p.id)); db.run('UPDATE dm_items SET reply_draft=? WHERE id=?', dmReplyDraft(d.category, svc.productInfo()), d.id); }
    send(res, 200, db.one('SELECT * FROM dm_items WHERE id=?', num(p.id)));
  });
  R('DELETE', '/api/dms/:id', async (req, res, { p }) => { db.run('DELETE FROM dm_items WHERE id=?', num(p.id)); send(res, 200, { ok: true }); });

  // LINE
  R('GET', '/api/line', async (req, res) => send(res, 200, { status: svc.line.status(), menu: db.q('SELECT * FROM line_menu ORDER BY sort'), log: db.q('SELECT * FROM line_log ORDER BY id DESC LIMIT 50'), notice: svc.AUTO_NOTICE.trim() }));
  R('PUT', '/api/line/menu/:key', async (req, res, { p, body }) => {
    const is = lintText(body.response_text || ''); if (is.some((i) => i.level === 'block')) throw httpErr(400, is.map((i) => i.msg).join(' '));
    db.run('UPDATE line_menu SET label=COALESCE(?,label), response_text=COALESCE(?,response_text), verified=COALESCE(?,verified), enabled=COALESCE(?,enabled) WHERE key=?', body.label ?? null, body.response_text ?? null, body.verified == null ? null : (body.verified ? 1 : 0), body.enabled == null ? null : (body.enabled ? 1 : 0), p.key);
    send(res, 200, { ok: true, issues: is });
  });
  // テスト用: 署名なしで受信をシミュレート(管理者ログイン必須・テストモードでのみ動く)
  R('POST', '/api/line/simulate', async (req, res, { body }) => {
    if (svc.line.mode() !== 'test') throw httpErr(400, 'テストモードのときだけ使えます');
    const uid = 'Utest' + (body.user || '001');
    const ev = body.type === 'follow' ? { type: 'follow', source: { userId: uid }, replyToken: 'test' }
      : body.type === 'postback' ? { type: 'postback', source: { userId: uid }, replyToken: 'test', postback: { data: 'menu=' + body.key } }
      : { type: 'message', source: { userId: uid }, replyToken: 'test', message: { type: 'text', text: String(body.text || '') } };
    await svc.handleLineEvent(ev);
    send(res, 200, { log: db.q("SELECT * FROM line_log WHERE mode='test' ORDER BY id DESC LIMIT 6") });
  });

  // 問い合わせ
  R('GET', '/api/inquiries', async (req, res) => send(res, 200, db.q('SELECT * FROM inquiries ORDER BY COALESCE(last_action_at,created_at) DESC LIMIT 300')));
  R('POST', '/api/inquiries', async (req, res, { body }) => send(res, 200, svc.createInquiry(body)));
  R('PUT', '/api/inquiries/:id', async (req, res, { p, body }) => {
    for (const k of ['display_name', 'channel', 'category', 'status', 'next_action_at', 'memo']) if (k in body) db.run(`UPDATE inquiries SET ${k}=? WHERE id=?`, body[k], num(p.id));
    db.run('UPDATE inquiries SET last_action_at=? WHERE id=?', nowIso(), num(p.id)); send(res, 200, db.one('SELECT * FROM inquiries WHERE id=?', num(p.id)));
  });
  R('DELETE', '/api/inquiries/:id', async (req, res, { p }) => { svc.deleteInquiry(num(p.id)); send(res, 200, { ok: true }); });
  R('POST', '/api/purge', async (req, res) => send(res, 200, { deleted: svc.purgeOld() }));
  R('POST', '/api/delete-demo', async (req, res) => { svc.deleteDemo(); send(res, 200, { ok: true }); });

  // 予約
  R('GET', '/api/bookings', async (req, res) => send(res, 200, db.q('SELECT * FROM bookings ORDER BY slot_start DESC LIMIT 200')));
  R('POST', '/api/bookings/:id/cancel', async (req, res, { p }) => { svc.cancelBooking(num(p.id)); send(res, 200, { ok: true }); });
  R('GET', '/api/availability', async (req, res) => send(res, 200, db.q('SELECT * FROM availability ORDER BY weekday,start_time')));
  R('PUT', '/api/availability', async (req, res, { body }) => {
    const rows = Array.isArray(body.rows) ? body.rows : []; const re = /^\d{2}:\d{2}$/;
    for (const r of rows) if (!(r.weekday >= 0 && r.weekday <= 6) || !re.test(r.start_time) || !re.test(r.end_time) || r.start_time >= r.end_time) throw httpErr(400, '曜日・開始・終了時刻が正しくありません');
    db.run('DELETE FROM availability'); for (const r of rows) db.run('INSERT INTO availability(weekday,start_time,end_time,slot_min) VALUES(?,?,?,?)', r.weekday, r.start_time, r.end_time, Math.max(15, Math.min(180, num(r.slot_min) || 60)));
    send(res, 200, db.q('SELECT * FROM availability ORDER BY weekday,start_time'));
  });

  // 数字
  R('GET', '/api/metrics', async (req, res) => {
    const posts = db.q("SELECT id, theme, published_at, permalink, publish_mode FROM posts WHERE status='投稿済み' ORDER BY published_at DESC LIMIT 100");
    const lastBy = (pid) => db.q('SELECT metric, value, source FROM metrics WHERE post_id=? ORDER BY id DESC', pid);
    const totals = db.q("SELECT metric, source, SUM(value) v FROM metrics WHERE post_id IS NULL GROUP BY metric, source");
    send(res, 200, { posts: posts.map((p) => ({ ...p, metrics: lastBy(p.id) })), totals, links: db.q('SELECT * FROM short_links ORDER BY created_at DESC'), counts: { posts_live: svc.dashboard().published, line_friends_auto: db.one("SELECT COALESCE(SUM(value),0) n FROM metrics WHERE metric='LINE友だち追加' AND source='自動取得'").n, dm: db.one('SELECT COUNT(*) n FROM dm_items').n, bookings: db.one("SELECT COUNT(*) n FROM bookings WHERE status='confirmed'").n } });
  });
  R('POST', '/api/metrics', async (req, res, { body }) => {
    if (!body.metric || isNaN(Number(body.value))) throw httpErr(400, '項目と数値を入力してください');
    db.run('INSERT INTO metrics(date,metric,value,source,post_id,note,created_at) VALUES(?,?,?,?,?,?,?)', body.date || nowIso().slice(0, 10), body.metric, Number(body.value), '手入力', body.post_id || null, body.note || '', nowIso());
    send(res, 200, { ok: true });
  });
  R('POST', '/api/metrics/fetch', async (req, res) => {
    if (svc.threads.status().state !== 'live') throw httpErr(400, 'Threadsが本番連携中でないため、自動取得できません。手入力をご利用ください');
    let n = 0; for (const p of db.q("SELECT id, threads_id FROM posts WHERE status='投稿済み' AND publish_mode='live' ORDER BY published_at DESC LIMIT 20")) {
      try { const ins = await svc.threads.fetchInsights(p.threads_id); for (const [k, v] of Object.entries(ins || {})) { db.run('INSERT INTO metrics(date,metric,value,source,post_id,created_at) VALUES(?,?,?,?,?,?)', nowIso().slice(0, 10), k, v, '自動取得', p.id, nowIso()); n++; } } catch (e) { db.notify('warn', 'metrics', '反応の取得に失敗', e.message); }
    }
    send(res, 200, { fetched: n });
  });
  R('POST', '/api/links', async (req, res, { body }) => {
    const target = String(body.target || db.getSetting('line_add_friend_url') || ''); if (!/^https:\/\//.test(target)) throw httpErr(400, '転送先は https:// から始まるURLにしてください(設定でLINE友だち追加URLを登録できます)');
    const code = require('node:crypto').randomBytes(4).toString('hex');
    db.run('INSERT INTO short_links(code,label,target,created_at) VALUES(?,?,?,?)', code, String(body.label || '').slice(0, 40), target, nowIso());
    send(res, 200, { code, url: (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '') + '/r/' + code });
  });

  // フォロー支援(登録・記録のみ。フォロー操作は自分でThreads上で行う)
  R('GET', '/api/follows', async (req, res) => send(res, 200, db.q('SELECT * FROM follows ORDER BY (status=\'未対応\') DESC, next_check')));
  R('POST', '/api/follows', async (req, res, { body }) => { if (body.profile_url && !/^https?:\/\//.test(body.profile_url)) throw httpErr(400, 'URLは http(s):// から入力してください'); const r = db.run('INSERT INTO follows(name,profile_url,reason,next_check,created_at) VALUES(?,?,?,?,?)', body.name || '', body.profile_url || '', body.reason || '', body.next_check || null, nowIso()); send(res, 200, db.one('SELECT * FROM follows WHERE id=?', Number(r.lastInsertRowid))); });
  R('PUT', '/api/follows/:id', async (req, res, { p, body }) => { for (const k of ['status', 'next_check', 'reason']) if (k in body) db.run(`UPDATE follows SET ${k}=? WHERE id=?`, body[k], num(p.id)); send(res, 200, { ok: true }); });
  R('DELETE', '/api/follows/:id', async (req, res, { p }) => { db.run('DELETE FROM follows WHERE id=?', num(p.id)); send(res, 200, { ok: true }); });

  R('GET', '/api/notifications', async (req, res) => send(res, 200, db.q('SELECT * FROM notifications ORDER BY id DESC LIMIT 100')));
  R('POST', '/api/notifications/read', async (req, res) => { db.run('UPDATE notifications SET read=1'); send(res, 200, { ok: true }); });
  R('POST', '/api/tick', async (req, res) => send(res, 200, await svc.tick())); // 手動で「今すぐ確認」

  // ---- 公開エンドポイント(ログイン不要) ----
  R('GET', '/health', async (req, res) => send(res, 200, { ok: true }), { public: true });
  R('GET', '/api/public/slots', async (req, res) => send(res, 200, { slots: await svc.listSlots(), methods: ['オンライン相談', '電話相談', 'その他'] }), { public: true });
  R('POST', '/api/public/book', async (req, res, { body, ip }) => {
    if (!rate(bookHits, ip, 8, 3600000)) throw httpErr(429, '時間をおいてもう一度お試しください');
    send(res, 200, await svc.book(body));
  }, { public: true });
  R('GET', '/r/:code', async (req, res, { p }) => {
    const l = db.one('SELECT * FROM short_links WHERE code=?', p.code); if (!l) return send(res, 404, 'not found');
    db.run('UPDATE short_links SET clicks=clicks+1 WHERE code=?', p.code); res.writeHead(302, { Location: l.target }); res.end();
  }, { public: true });
  // LINE Webhook: 署名検証に成功したものだけ処理する
  R('POST', '/webhook/line', async (req, res) => {
    const raw = await readRaw(req);
    const chSecret = db.getSecret('line_channel_secret');
    if (!chSecret) return send(res, 503, 'LINE not configured');
    if (!verifySignature(raw, req.headers['x-line-signature'], chSecret)) { svc.line.log('in', '', '[署名検証に失敗した受信を破棄]', 'rejected'); return send(res, 401, 'bad signature'); }
    let payload; try { payload = JSON.parse(raw.toString('utf8')); } catch { return send(res, 400, 'bad json'); }
    send(res, 200, 'ok'); // 先に応答(LINEは素早い応答を期待)
    for (const ev of payload.events || []) { try { await svc.handleLineEvent(ev); } catch (e) { try { svc.line.log('in', ev.source?.userId, '[処理エラー]', 'error', e.message); db.notify('error', 'line', 'LINEの処理でエラー', e.message); } catch { /* DB停止中など */ } } }
  }, { public: true, raw: true });

  async function handler(req, res) {
    const url = new URL(req.url, 'http://x'); const ip = req.socket.remoteAddress || '';
    try {
      for (const r of routes) {
        if (r.method !== req.method) continue; const m = r.re.exec(url.pathname); if (!m) continue;
        if (!r.public) {
          if (!sessionOk(req.headers.cookie)) return send(res, 401, { error: 'ログインが必要です' });
          if (req.method !== 'GET' && req.headers['x-requested-by'] !== 'smile') return send(res, 403, { error: '不正なリクエストです' });
        }
        const body = !r.raw && ['POST', 'PUT', 'DELETE'].includes(req.method) ? await readJson(req) : {};
        return await r.fn(req, res, { p: m.groups || {}, query: Object.fromEntries(url.searchParams), body, ip });
      }
      // 静的ファイル
      if (req.method === 'GET') {
        let f = url.pathname === '/' ? '/index.html' : url.pathname === '/book' ? '/book.html' : url.pathname;
        const full = path.normalize(path.join(PUBLIC_DIR, f));
        if (full.startsWith(PUBLIC_DIR + path.sep) && fs.existsSync(full) && fs.statSync(full).isFile()) {
          return send(res, 200, fs.readFileSync(full), { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'", 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
        }
      }
      send(res, 404, { error: '見つかりません' });
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error('[error]', e.message);
      if (res.headersSent) return;
      send(res, status, { error: status === 500 ? 'サーバーでエラーが起きました' : e.message });
    }
  }
  return { handler, db, svc, server: http.createServer(handler) };
}

if (require.main === module) {
  const app = createApp({ cookieSecure: process.env.COOKIE_SECURE === '1' });
  const port = Number(process.env.PORT) || 3000;
  app.server.listen(port, () => console.log(`スマイル共済 Threads管理 → http://localhost:${port}`));
  // 予約投稿・コメント取得などの定期処理(30秒ごと)
  setInterval(() => app.svc.tick().catch((e) => console.error('[tick]', e.message)), 30000);
}
module.exports = { createApp };
