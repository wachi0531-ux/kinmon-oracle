'use strict';
const { nowIso, toJstParts, fromJst, fmtJst, lintText, hasBlock, sign, safeEq } = require('./util');
const { makeThreads } = require('./threads');
const { makeLine } = require('./line');
const { makeAi } = require('./ai');
const { makeGcal } = require('./gcal');
const { templateFor, dmReplyDraft } = require('./templates');
const { PRODUCT_KEYS } = require('./db');

const STATES = ['下書き', '要確認', '承認済み', '予約済み', '投稿済み', 'エラー'];
const AUTO_NOTICE = '\n\n※このメッセージは自動応答です。';

function makeServices(db, opts = {}) {
  const threads = opts.threads || makeThreads(db);
  const line = opts.line || makeLine(db);
  const ai = opts.ai || makeAi(db);
  const gcal = opts.gcal || makeGcal(db);
  const secret = () => opts.appSecret || process.env.APP_SECRET || 'dev-secret';
  const paused = () => db.getSetting('automation_paused') === '1';
  const now = () => (opts.now ? opts.now() : new Date());

  // ---------- 商品情報(未登録なら空) ----------
  function productInfo() {
    const o = {};
    for (const [k, label] of PRODUCT_KEYS) { const v = db.getSetting('product_' + k); o[k] = v; o[k + '_label'] = label; }
    return o;
  }
  const productRegistered = () => PRODUCT_KEYS.some(([k]) => db.getSetting('product_' + k));
  function productContext() {
    const lines = PRODUCT_KEYS.map(([k, label]) => db.getSetting('product_' + k) ? `${label}: ${db.getSetting('product_' + k)}` : '').filter(Boolean);
    const mats = db.q("SELECT title, content FROM materials WHERE content IS NOT NULL AND content!='' AND is_demo=0 LIMIT 5").map((m) => `[資料:${m.title}] ${m.content.slice(0, 800)}`);
    return [...lines, ...mats].join('\n');
  }
  // 数値などが「登録済みの資料に含まれているか」を確認(含まれていなければ要確認)
  function lintPost(body) {
    const issues = lintText(body);
    if (/【要確認/.test(body)) issues.push({ code: 'todo', level: 'warn', msg: '「【要確認:…】」の記載が残っています。書き換えてから承認してください。' });
    if (issues.some((i) => ['number', 'coverage', 'compare'].includes(i.code)) && !productRegistered() && !db.one("SELECT 1 x FROM materials WHERE is_demo=0 AND content!=''")) {
      issues.push({ code: 'noref', level: 'warn', msg: '公式資料が未登録のため、数値や保障内容の根拠を確認できません。' });
    }
    return issues;
  }

  // ---------- 投稿 ----------
  const getPost = (id) => db.one('SELECT * FROM posts WHERE id=?', id);
  function decoratePost(p) {
    if (!p) return p;
    const issues = lintPost(p.body);
    const t = threads.status();
    let display = p.status;
    let note = '';
    if (p.status === '予約済み' && t.state === 'waiting') { display = '連携待ち'; note = 'Threadsが未連携のため、まだ投稿されません。'; }
    if (p.status === '予約済み' && paused()) { note = '自動投稿が一時停止中です。'; }
    if (p.status === '投稿済み' && p.publish_mode === 'test') { display = '投稿済み(テスト)'; note = 'テストモード: 実際のThreadsには投稿されていません。'; }
    return { ...p, issues, display_status: display, note, length: p.body.length };
  }
  function createPost({ theme, body, scheduled_at, check_notes, material_id }) {
    const t = nowIso();
    const r = db.run('INSERT INTO posts(theme,body,status,scheduled_at,created_at,updated_at,check_notes,material_id) VALUES(?,?,?,?,?,?,?,?)', theme, body, '下書き', scheduled_at || null, t, t, check_notes || '', material_id || null);
    return getPost(Number(r.lastInsertRowid));
  }
  function updatePost(id, f) {
    const p = getPost(id); if (!p) throw httpErr(404, '投稿が見つかりません');
    if (['投稿済み'].includes(p.status)) {
      // 投稿済みは本文・予定を変更不可(記録の保全)。URL・メモ・反応の記録のみ可
      const allowed = {}; for (const k of ['permalink', 'check_notes']) if (k in f) allowed[k] = f[k];
      f = allowed;
    }
    const sets = [], vals = [];
    for (const k of ['theme', 'body', 'scheduled_at', 'check_notes', 'permalink', 'checked']) if (k in f) { sets.push(`${k}=?`); vals.push(f[k]); }
    // 本文や予定を変更したら承認を取り消す(承認後のすり替え防止)
    if (('body' in f && f.body !== p.body) || ('scheduled_at' in f && f.scheduled_at !== p.scheduled_at)) {
      if (['承認済み', '予約済み'].includes(p.status)) { sets.push('status=?', 'checked=0'); vals.push('要確認'); }
    }
    if (sets.length) db.run(`UPDATE posts SET ${sets.join(',')}, updated_at=? WHERE id=?`, ...vals, nowIso(), id);
    return getPost(id);
  }
  const POST_FLOW = {
    '下書き': ['要確認', '承認済み'], '要確認': ['下書き', '承認済み'], '承認済み': ['要確認', '下書き', '予約済み'],
    '予約済み': ['承認済み'], 'エラー': ['下書き', '要確認', '承認済み'], '投稿済み': [],
  };
  function transition(id, to, extra = {}) {
    const p = getPost(id); if (!p) throw httpErr(404, '投稿が見つかりません');
    if (!POST_FLOW[p.status]?.includes(to)) throw httpErr(400, `「${p.status}」から「${to}」には変更できません`);
    const issues = lintPost(p.body);
    if (to === '承認済み') {
      if (hasBlock(issues)) throw httpErr(400, '使えない表現が含まれています: ' + issues.filter((i) => i.level === 'block').map((i) => i.msg).join(' '));
      if (issues.some((i) => i.code === 'todo')) throw httpErr(400, '「【要確認:…】」が残っています。書き換えてから承認してください');
      if (!extra.checked && !p.checked) throw httpErr(400, '「内容を確認しました」にチェックを入れてから承認してください');
      if (db.getSetting('affiliation_rule_confirmed') !== '1') throw httpErr(400, '先に設定画面で「所属先の案内・募集ルールを確認した」にチェックしてください');
      db.run('UPDATE posts SET checked=1 WHERE id=?', id);
    }
    if (to === '予約済み') {
      if (p.status !== '承認済み') throw httpErr(400, '承認済みの投稿のみ予約できます');
      const when = extra.scheduled_at || p.scheduled_at;
      if (!when || isNaN(Date.parse(when))) throw httpErr(400, '投稿予定日時を指定してください');
      if (Date.parse(when) < now().getTime() - 60000) throw httpErr(400, '過去の日時は予約できません');
      db.run('UPDATE posts SET scheduled_at=? WHERE id=?', new Date(when).toISOString(), id);
    }
    db.run(to === 'エラー' ? 'UPDATE posts SET status=?, claimed_at=NULL, updated_at=? WHERE id=?' : 'UPDATE posts SET status=?, error=NULL, claimed_at=NULL, updated_at=? WHERE id=?', to, nowIso(), id);
    return getPost(id);
  }
  async function generateDraft({ theme, hint }) {
    const info = productInfo();
    let body = null, via = 'template';
    try { body = await ai.generate({ theme, hint, productContext: productContext() }); if (body) via = 'ai'; } catch (e) { db.notify('warn', 'ai', 'AI下書きに失敗したためテンプレートを使いました', e.message); }
    if (!body) body = templateFor(theme, info.official_name);
    const post = createPost({ theme, body, check_notes: via === 'ai' ? 'AIが作成した下書きです。事実関係を必ず確認してください。' : 'テンプレートから作成。必要に応じて書き換えてください。' });
    db.run('UPDATE posts SET status=? WHERE id=?', '要確認', post.id);
    return { post: getPost(post.id), via };
  }

  // 公開処理: 同じ投稿を二重に公開しないよう、claimed_at を原子的に取得できた1回だけ実行する
  async function publishPost(id) {
    const claim = db.run("UPDATE posts SET claimed_at=?, attempts=attempts+1 WHERE id=? AND status='予約済み' AND claimed_at IS NULL", nowIso(), id);
    if (claim.changes !== 1) return { skipped: true };
    const p = getPost(id);
    try {
      const r = await threads.publishText(p.body);
      db.run("UPDATE posts SET status='投稿済み', threads_id=?, permalink=?, publish_mode=?, published_at=?, error=NULL, claimed_at=NULL WHERE id=?", r.id, r.permalink || '', r.mode, nowIso(), id);
      return { posted: true, mode: r.mode };
    } catch (e) {
      db.run("UPDATE posts SET status='エラー', error=?, claimed_at=NULL WHERE id=?", e.message, id);
      db.notify('error', 'post', `投稿に失敗しました(#${id})`, e.message);
      return { error: e.message };
    }
  }
  async function runDuePosts() {
    if (paused()) return { paused: true };
    if (threads.status().state === 'waiting') return { waiting: true };
    const due = db.q("SELECT id FROM posts WHERE status='予約済み' AND scheduled_at<=? AND claimed_at IS NULL ORDER BY scheduled_at LIMIT 5", now().toISOString());
    const res = [];
    for (const d of due) res.push(await publishPost(d.id));
    // 送信途中で止まった投稿(10分以上claimed)は二重投稿を避けるため自動再送せずエラーにする
    for (const s of db.q("SELECT id FROM posts WHERE status='予約済み' AND claimed_at IS NOT NULL AND claimed_at<?", new Date(now().getTime() - 600000).toISOString())) {
      db.run("UPDATE posts SET status='エラー', error='送信中に停止した可能性があります。Threadsで投稿済みか確認してから、必要なら再度予約してください。', claimed_at=NULL WHERE id=?", s.id);
      db.notify('error', 'post', `投稿の状態を確認してください(#${s.id})`, 'Threadsで投稿されているか確認してください。');
    }
    return res;
  }

  // ---------- コメント ----------
  function addComment({ post_id, username, text, threads_comment_id, source }) {
    const t = nowIso();
    try {
      const r = db.run('INSERT INTO comments(post_id,threads_comment_id,username,text,source,created_at) VALUES(?,?,?,?,?,?)', post_id || null, threads_comment_id || null, username || '', text || '', source || 'manual', t);
      return db.one('SELECT * FROM comments WHERE id=?', Number(r.lastInsertRowid));
    } catch (e) { if (/UNIQUE/.test(e.message)) return null; throw e; }
  }
  function commentDraft(id) {
    const c = db.one('SELECT * FROM comments WHERE id=?', id);
    const draft = 'コメントありがとうございます。\n詳しくは、プロフィールのリンクからLINEでお気軽にご質問ください。\n※個人的なご事情はここには書かなくて大丈夫です。';
    db.run('UPDATE comments SET reply_draft=? WHERE id=?', draft, id);
    return db.one('SELECT * FROM comments WHERE id=?', c.id);
  }
  async function sendCommentReply(id, { approved }) {
    const c = db.one('SELECT * FROM comments WHERE id=?', id); if (!c) throw httpErr(404, 'コメントが見つかりません');
    if (!approved) throw httpErr(400, '承認(確認)してから送信してください');
    if (!c.reply_draft) throw httpErr(400, '返信文がありません');
    if (!c.threads_comment_id) throw httpErr(400, '手入力のコメントにはAPIで返信できません。Threadsで直接返信してください(返信文はコピーできます)');
    const issues = lintText(c.reply_draft); if (hasBlock(issues)) throw httpErr(400, issues.map((i) => i.msg).join(' '));
    const g = db.run("UPDATE comments SET reply_status='sending' WHERE id=? AND reply_status IN ('none','error')", id);
    if (g.changes !== 1) throw httpErr(409, 'このコメントにはすでに返信済み、または送信中です');
    try {
      await threads.publishText(c.reply_draft, { replyTo: c.threads_comment_id });
      db.run("UPDATE comments SET reply_status='sent', status='対応済み', replied_at=?, reply_error=NULL WHERE id=?", nowIso(), id);
    } catch (e) {
      db.run("UPDATE comments SET reply_status='error', reply_error=? WHERE id=?", e.message, id);
      db.notify('error', 'comment', 'コメント返信に失敗', e.message);
      throw httpErr(502, e.message);
    }
    return db.one('SELECT * FROM comments WHERE id=?', id);
  }
  function ruleIssues(rule) {
    const i = lintText(rule.reply_text);
    if (/病|既往|持病|健康/.test(rule.reply_text) && /教え|書い|記入/.test(rule.reply_text)) i.push({ level: 'block', msg: '病歴などの記入を促せません' });
    return i;
  }
  // 公開コメントの取得 + 自動返信(オンのときのみ・停止中は何もしない)
  async function syncComments() {
    if (threads.status().state !== 'live') return { skipped: 'not-live' };
    const me = (await threads.myUsername()).toLowerCase();
    let added = 0;
    const since = new Date(now().getTime() - 7 * 86400000).toISOString();
    for (const p of db.q("SELECT id, threads_id FROM posts WHERE status='投稿済み' AND publish_mode='live' AND published_at>?", since)) {
      let rs = []; try { rs = await threads.fetchReplies(p.threads_id); } catch (e) { db.notify('error', 'comment', 'コメント取得に失敗', e.message); continue; }
      for (const r of rs) {
        if (me && (r.username || '').toLowerCase() === me) continue;
        if (addComment({ post_id: p.id, username: r.username, text: r.text, threads_comment_id: r.id, source: 'api' })) added++;
      }
    }
    return { added, auto: await runAutoReplies() };
  }
  async function runAutoReplies() {
    if (paused() || db.getSetting('auto_reply_enabled') !== '1') return { off: true };
    const cap = Number(db.getSetting('auto_reply_daily_cap')) || 20;
    const today = db.one("SELECT COUNT(*) n FROM comments WHERE reply_status='sent' AND source='api' AND replied_at>?", new Date(now().getTime() - 86400000).toISOString()).n;
    let left = cap - today, sent = 0;
    for (const rule of db.q('SELECT * FROM auto_reply_rules WHERE enabled=1')) {
      if (hasBlock(ruleIssues(rule))) continue;
      const kws = rule.keywords.split(/[,、\n]/).map((s) => s.trim()).filter(Boolean); if (!kws.length) continue;
      for (const c of db.q("SELECT * FROM comments WHERE post_id=? AND reply_status='none' AND source='api'", rule.post_id)) {
        if (left <= 0) return { sent, capped: true };
        if (!kws.some((k) => c.text.includes(k))) continue;
        db.run('UPDATE comments SET reply_draft=? WHERE id=?', rule.reply_text, c.id);
        try { await sendCommentReply(c.id, { approved: true }); sent++; left--; } catch { /* 失敗は通知済み */ }
      }
    }
    return { sent };
  }

  // ---------- DM返信支援(手入力のみ) ----------
  function createDm({ label, category, body }) {
    const t = nowIso();
    const r = db.run('INSERT INTO dm_items(label,category,body,reply_draft,created_at,updated_at) VALUES(?,?,?,?,?,?)', label || '', category, body || '', dmReplyDraft(category, productInfo()), t, t);
    return db.one('SELECT * FROM dm_items WHERE id=?', Number(r.lastInsertRowid));
  }

  // ---------- 問い合わせ ----------
  function createInquiry(f) {
    const t = nowIso();
    const r = db.run('INSERT INTO inquiries(display_name,channel,category,status,last_action_at,next_action_at,memo,line_user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)', f.display_name || '(名称未設定)', f.channel || 'その他', f.category || 'その他', f.status || '未対応', t, f.next_action_at || null, f.memo || '', f.line_user_id || null, t);
    return db.one('SELECT * FROM inquiries WHERE id=?', Number(r.lastInsertRowid));
  }

  // ---------- LINE ----------
  const menuItems = () => db.q("SELECT * FROM line_menu WHERE key IN ('1','2','3','4') AND enabled=1 ORDER BY sort");
  function menuMessage(text) {
    return { type: 'text', text: text + AUTO_NOTICE, quickReply: { items: menuItems().map((m) => ({ type: 'action', action: { type: 'postback', label: m.label.slice(0, 20), data: 'menu=' + m.key, displayText: m.label } })) } };
  }
  function bookingLink(lineUserId) {
    const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
    const tok = Buffer.from(lineUserId).toString('base64url');
    return `${base}/book?lu=${tok}.${sign('lu:' + lineUserId, secret()).slice(0, 20)}`;
  }
  function verifyLu(s) {
    try { const [a, b] = String(s).split('.'); const id = Buffer.from(a, 'base64url').toString(); return safeEq(sign('lu:' + id, secret()).slice(0, 20), b) ? id : null; } catch { return null; }
  }
  async function notifyOwner(title, body) {
    db.notify('info', 'inquiry', title, body);
    if (db.getSetting('line_notify_owner') === '1') {
      const owner = db.getSecret('line_owner_user_id');
      if (owner && !paused()) await line.push(owner, [{ type: 'text', text: `【通知】${title}\n管理画面で確認してください。` }]);
    }
  }
  function inquiryForLineUser(uid) {
    let i = db.one('SELECT * FROM inquiries WHERE line_user_id=?', uid);
    if (!i) i = createInquiry({ display_name: 'LINE友だち#' + (db.one("SELECT COUNT(*) n FROM inquiries WHERE channel='LINE'").n + 1), channel: 'LINE', category: '未選択', line_user_id: uid });
    return i;
  }
  // LINEイベント1件の処理。停止中・オフのときは返信せず、通知のみ。
  async function handleLineEvent(ev) {
    const uid = ev.source?.userId; if (!uid) return;
    const auto = !paused() && db.getSetting('line_bot_enabled') === '1';
    const reply = async (msgs) => { if (auto) await line.reply(ev.replyToken, msgs, uid); };
    if (ev.type === 'follow') {
      const inq = inquiryForLineUser(uid);
      db.run('INSERT INTO metrics(date,metric,value,source,note,created_at) VALUES(?,?,?,?,?,?)', nowIso().slice(0, 10), 'LINE友だち追加', 1, '自動取得', 'follow event', nowIso());
      line.log('in', uid, '[友だち追加]', 'received');
      await notifyOwner('LINEの友だち追加', `${inq.display_name} さんが友だち追加しました。`);
      return reply([menuMessage(db.one("SELECT response_text FROM line_menu WHERE key='welcome'").response_text)]);
    }
    if (ev.type === 'unfollow') { line.log('in', uid, '[ブロック/解除]', 'received'); return; }
    let key = null, text = '';
    if (ev.type === 'postback') { key = (new URLSearchParams(ev.postback?.data || '').get('menu')); text = '[メニュー]' + key; }
    else if (ev.type === 'message' && ev.message?.type === 'text') {
      text = ev.message.text.trim();
      const m = text.match(/^登録\s+(\w+)$/);
      if (m && m[1] === db.getSetting('owner_claim_code')) { db.setSecret('line_owner_user_id', uid); line.log('in', uid, '[オーナー登録]', 'received'); return reply([{ type: 'text', text: 'この LINE アカウントを通知の宛先として登録しました。' }]); }
      const hit = db.q("SELECT * FROM line_menu WHERE key IN ('1','2','3','4') AND enabled=1").find((x) => x.key === text || x.label === text);
      if (hit) key = hit.key;
    } else { line.log('in', uid, '[対応していないメッセージ形式]', 'received'); return reply([menuMessage(db.one("SELECT response_text FROM line_menu WHERE key='fallback'").response_text)]); }
    line.log('in', uid, text, 'received');
    const inq = inquiryForLineUser(uid);
    db.run('UPDATE inquiries SET last_action_at=? WHERE id=?', nowIso(), inq.id);
    if (key) {
      const m = db.one('SELECT * FROM line_menu WHERE key=?', key);
      db.run('UPDATE inquiries SET category=? WHERE id=?', m.label, inq.id);
      // 確認済みの文面のみ自動送信。未確認の文面は送らず、引き継ぎ案内にする
      let body = m.verified ? m.response_text : db.one("SELECT response_text FROM line_menu WHERE key='fallback'").response_text;
      if (key === '3') { body = m.response_text + '\n' + bookingLink(uid); }
      if (key === '4' || !m.verified) { db.run("UPDATE inquiries SET status='未対応' WHERE id=?", inq.id); await notifyOwner('LINEで確認依頼', `${inq.display_name}: 「${m.label}」`); }
      return reply([{ type: 'text', text: body + AUTO_NOTICE }]);
    }
    // 自由記述: 内容は自動で判断せず、わっちへ引き継ぐ
    if (inq.status === '対応済み' || inq.status === '対応終了') db.run("UPDATE inquiries SET status='未対応' WHERE id=?", inq.id);
    await notifyOwner('LINEにメッセージが届きました', `${inq.display_name} さんから(内容は管理画面で確認)`);
    return reply([menuMessage(db.one("SELECT response_text FROM line_menu WHERE key='fallback'").response_text)]);
  }

  // ---------- 予約 ----------
  const SLOT_FMT = (d) => d.toISOString();
  async function listSlots() {
    const lead = Number(db.getSetting('booking_lead_hours')) || 24;
    const days = Number(db.getSetting('booking_horizon_days')) || 14;
    const t0 = now(); const earliest = t0.getTime() + lead * 3600000;
    const rules = db.q('SELECT * FROM availability');
    const taken = new Set(db.q("SELECT slot_start FROM bookings WHERE status='confirmed'").map((b) => new Date(b.slot_start).getTime()));
    let busy = []; if (gcal.configured()) { try { busy = await gcal.busy(t0.toISOString(), new Date(t0.getTime() + (days + 1) * 86400000).toISOString()); } catch (e) { db.notify('warn', 'gcal', 'Googleカレンダーの空き確認に失敗(設定の空き時間のみで表示中)', e.message); } }
    const out = [];
    const jp = toJstParts(t0);
    for (let i = 0; i <= days; i++) {
      const day = new Date(Date.UTC(jp.y, jp.m - 1, jp.d + i));
      const y = day.getUTCFullYear(), m = day.getUTCMonth() + 1, d = day.getUTCDate(), wd = day.getUTCDay();
      for (const r of rules.filter((x) => x.weekday === wd)) {
        const [sh, sm] = r.start_time.split(':').map(Number), [eh, em] = r.end_time.split(':').map(Number);
        for (let mins = sh * 60 + sm; mins + r.slot_min <= eh * 60 + em; mins += r.slot_min) {
          const s = fromJst(y, m, d, Math.floor(mins / 60), mins % 60), e = new Date(s.getTime() + r.slot_min * 60000);
          if (s.getTime() < earliest || taken.has(s.getTime())) continue;
          if (busy.some((b) => s.getTime() < b.end && e.getTime() > b.start)) continue;
          out.push({ start: SLOT_FMT(s), end: SLOT_FMT(e), label: fmtJst(s.toISOString()) });
        }
      }
    }
    return out;
  }
  async function book({ slot_start, method, display_name, contact_note, lu, consent }) {
    if (!consent) throw httpErr(400, '「相談のためにお名前などを保存すること」への同意が必要です');
    if (!['オンライン相談', '電話相談', 'その他'].includes(method)) throw httpErr(400, '相談方法を選んでください');
    const name = String(display_name || '').trim().slice(0, 40); if (!name) throw httpErr(400, 'お名前(ニックネームで構いません)を入力してください');
    const slots = await listSlots();
    const slot = slots.find((s) => s.start === new Date(slot_start).toISOString());
    if (!slot) throw httpErr(409, 'この時間はすでに埋まっているか、選べません。別の時間を選んでください');
    const uid = lu ? verifyLu(lu) : null;
    let r;
    try {
      r = db.run("INSERT INTO bookings(slot_start,slot_end,method,display_name,contact_note,status,line_user_id,mode,created_at) VALUES(?,?,?,?,?,'confirmed',?,?,?)", slot.start, slot.end, method, name, String(contact_note || '').slice(0, 200), uid, line.mode(), nowIso());
    } catch (e) { if (/UNIQUE/.test(e.message)) throw httpErr(409, 'ほぼ同時に別の予約が入りました。別の時間を選んでください'); throw e; }
    const id = Number(r.lastInsertRowid);
    let inq = uid ? db.one('SELECT * FROM inquiries WHERE line_user_id=?', uid) : null;
    if (!inq) inq = createInquiry({ display_name: name, channel: uid ? 'LINE' : '予約ページ', category: '個別相談', line_user_id: uid });
    db.run("UPDATE inquiries SET has_booking=1, status='相談予定', next_action_at=?, last_action_at=? WHERE id=?", slot.start, nowIso(), inq.id);
    db.run('UPDATE bookings SET inquiry_id=? WHERE id=?', inq.id, id);
    try { const ev = await gcal.createEvent({ summary: `個別相談(${method}) ${name}`, startIso: slot.start, endIso: slot.end, description: '管理画面で詳細を確認' }); if (ev) db.run('UPDATE bookings SET gcal_event_id=? WHERE id=?', ev, id); }
    catch (e) { db.notify('warn', 'gcal', 'Googleカレンダーへの登録に失敗(予約自体は保存済み)', e.message); }
    await notifyOwner('相談予約が入りました', `${slot.label} / ${method} / ${name}`);
    if (uid && !paused()) await line.push(uid, [{ type: 'text', text: `ご予約を受け付けました。\n日時: ${slot.label}\n方法: ${method}\n変更をご希望の場合は、このLINEでお知らせください。${AUTO_NOTICE}` }]);
    return { id, label: slot.label, method };
  }
  function cancelBooking(id) {
    const b = db.one('SELECT * FROM bookings WHERE id=?', id); if (!b) throw httpErr(404, '予約が見つかりません');
    db.run("UPDATE bookings SET status='cancelled' WHERE id=?", id);
    if (b.inquiry_id) db.run("UPDATE inquiries SET has_booking=0, status='返信待ち' WHERE id=?", b.inquiry_id);
  }

  // ---------- 保存期間・削除 ----------
  function purgeOld() {
    const days = Number(db.getSetting('retention_days')) || 365;
    const cut = new Date(now().getTime() - days * 86400000).toISOString();
    let n = 0;
    n += db.run("DELETE FROM line_log WHERE created_at<?", cut).changes;
    n += db.run("DELETE FROM comments WHERE created_at<?", cut).changes;
    n += db.run("DELETE FROM dm_items WHERE created_at<?", cut).changes;
    n += db.run("DELETE FROM notifications WHERE created_at<?", cut).changes;
    n += db.run("DELETE FROM inquiries WHERE status='対応終了' AND last_action_at<?", cut).changes;
    n += db.run("DELETE FROM bookings WHERE slot_start<?", cut).changes;
    return n;
  }
  function deleteInquiry(id) {
    const i = db.one('SELECT * FROM inquiries WHERE id=?', id); if (!i) return;
    if (i.line_user_id) db.run('DELETE FROM line_log WHERE line_user_id=?', i.line_user_id);
    db.run('DELETE FROM bookings WHERE inquiry_id=?', id);
    db.run('DELETE FROM inquiries WHERE id=?', id);
  }
  function deleteDemo() {
    for (const t of ['materials', 'posts', 'comments', 'dm_items', 'inquiries', 'bookings', 'follows']) db.run(`DELETE FROM ${t} WHERE is_demo=1`);
  }

  // ---------- 定期処理 ----------
  async function tick() {
    const r = {};
    r.posts = await runDuePosts();
    const last = Number(db.getSetting('_last_sync') || 0);
    if (now().getTime() - last > 5 * 60000) { db.setSetting('_last_sync', now().getTime()); try { r.comments = await syncComments(); } catch (e) { db.notify('error', 'comment', 'コメント同期に失敗', e.message); } }
    const day = now().toISOString().slice(0, 10);
    if (db.getSetting('_last_purge') !== day) { db.setSetting('_last_purge', day); r.purged = purgeOld(); }
    const refreshed = db.getSetting('threads_token_refreshed_at');
    if (threads.status().state === 'live' && (!refreshed || now().getTime() - Date.parse(refreshed) > 30 * 86400000)) {
      try { await threads.refreshToken(); } catch (e) { db.notify('error', 'threads', 'Threadsトークンの更新に失敗(60日で期限切れになります)', e.message); }
    }
    return r;
  }

  // ---------- ダッシュボード ----------
  function dashboard() {
    const t0 = toJstParts(now());
    const dayStart = fromJst(t0.y, t0.m, t0.d, 0, 0).toISOString(), dayEnd = fromJst(t0.y, t0.m, t0.d + 1, 0, 0).toISOString();
    const c = (sql, ...p) => db.one(sql, ...p).n;
    const ts = threads.status(), ls = line.status();
    return {
      statuses: { threads: ts, line: ls, ai: ai.status(), gcal: gcal.status(), paused: paused() },
      today_posts: db.q("SELECT id, theme, scheduled_at, status FROM posts WHERE scheduled_at>=? AND scheduled_at<? ORDER BY scheduled_at", dayStart, dayEnd),
      drafts: c("SELECT COUNT(*) n FROM posts WHERE status IN ('下書き','要確認')"),
      awaiting_approval: c("SELECT COUNT(*) n FROM posts WHERE status='要確認'"),
      published: c("SELECT COUNT(*) n FROM posts WHERE status='投稿済み' AND publish_mode='live'"),
      published_test: c("SELECT COUNT(*) n FROM posts WHERE status='投稿済み' AND publish_mode='test'"),
      comments_open: c("SELECT COUNT(*) n FROM comments WHERE status='未対応'"),
      comments_api: ts.state === 'live',
      dm_open: c("SELECT COUNT(*) n FROM dm_items WHERE status!='対応済み' AND status!='対応終了'"),
      line_inquiries: c("SELECT COUNT(*) n FROM inquiries WHERE channel='LINE'"),
      line_open: c("SELECT COUNT(*) n FROM inquiries WHERE channel='LINE' AND status='未対応'"),
      bookings_upcoming: c("SELECT COUNT(*) n FROM bookings WHERE status='confirmed' AND slot_start>=?", now().toISOString()),
      follows_due: c("SELECT COUNT(*) n FROM follows WHERE status='未対応' AND next_check IS NOT NULL AND next_check<=?", now().toISOString().slice(0, 10)),
      attention: [
        ...db.q("SELECT id, 'post' kind, '投稿エラー #'||id||': '||COALESCE(error,'') msg FROM posts WHERE status='エラー'"),
        ...db.q("SELECT id, 'notice' kind, title||' '||COALESCE(body,'') msg FROM notifications WHERE read=0 AND level IN ('error','warn') ORDER BY id DESC LIMIT 10"),
        ...db.q("SELECT id, 'comment' kind, 'コメント返信エラー: '||COALESCE(reply_error,'') msg FROM comments WHERE reply_status='error'"),
      ],
      todo: [
        !productRegistered() && '商品情報(正式名称・保障内容など)が「未登録」です。公式資料を登録してください。',
        db.getSetting('affiliation_rule_confirmed') !== '1' && '所属先の案内・募集ルールの確認がまだです(投稿を承認できません)。',
        ts.state === 'waiting' && 'Threadsが連携待ちです。設定画面から接続してください。',
        ls.state === 'waiting' && 'LINEが連携待ちです。設定画面から接続してください。',
      ].filter(Boolean),
    };
  }

  return { threads, line, ai, gcal, STATES, AUTO_NOTICE, productInfo, productRegistered, lintPost, getPost, decoratePost, createPost, updatePost, transition, generateDraft, publishPost, runDuePosts, addComment, commentDraft, sendCommentReply, syncComments, runAutoReplies, ruleIssues, createDm, createInquiry, handleLineEvent, listSlots, book, cancelBooking, verifyLu, bookingLink, purgeOld, deleteInquiry, deleteDemo, tick, dashboard, paused };
}
function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }
module.exports = { makeServices, httpErr };
