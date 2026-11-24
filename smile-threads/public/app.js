'use strict';
// 画面はすべて textContent で描画(入力文字をHTMLとして解釈しない)
const $app = document.getElementById('app');
const h = (t, a = {}, ...c) => { const e = document.createElement(t); for (const [k, v] of Object.entries(a || {})) { if (v === false || v == null) continue; if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (k === 'value') e.value = v; else if (k === 'checked') e.checked = !!v; else e.setAttribute(k, v === true ? '' : v); } for (const x of c.flat(9)) if (x != null && x !== false) e.append(x.nodeType ? x : document.createTextNode(x)); return e; };
let META = null, ROUTE = 'home', SUB = {};
const fmt = (iso) => { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? iso : d.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' }); };
const toast = (m) => { const t = h('div', { class: 'toast' }, m); document.body.append(t); setTimeout(() => t.remove(), 2600); };
async function api(method, path, body) {
  const r = await fetch('/api' + path, { method, headers: { 'content-type': 'application/json', 'x-requested-by': 'smile' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/login') { renderLogin(); throw new Error('login'); }
  if (!r.ok) throw new Error(j.error || 'エラーが起きました');
  return j;
}
const act = (fn, ok) => async (ev) => { const b = ev?.currentTarget; if (b) b.disabled = true; try { const r = await fn(); if (ok) toast(ok); return r; } catch (e) { if (e.message !== 'login') alert(e.message); } finally { if (b) b.disabled = false; } };
const copy = async (text) => { try { await navigator.clipboard.writeText(text); toast('コピーしました'); } catch { prompt('コピーしてください', text); } };
const badge = (s) => { const m = { live: ['b-ok', '連携中'], test: ['b-test', 'テスト'], waiting: ['b-warn', '連携待ち'], off: ['', '未接続'] }; const [c, t] = m[s.state] || ['', s.state]; return h('span', { class: 'badge ' + c }, t); };
const stBadge = (st) => h('span', { class: 'badge ' + ({ 投稿済み: 'b-ok', エラー: 'b-err', 要確認: 'b-warn', 連携待ち: 'b-warn', 承認済み: 'b-test', 予約済み: 'b-test' }[st] || '') }, st);
const field = (label, input, hint) => h('div', {}, h('label', {}, label), input, hint && h('div', { class: 'hint' }, hint));
const help = (title, ...body) => h('details', {}, h('summary', {}, '❓ ' + title), h('div', { class: 'note info' }, ...body));

// ---------- 画面の骨組み ----------
const TABS = [['home', '🏠', 'ホーム'], ['posts', '✏️', '投稿'], ['replies', '💬', '返信'], ['consult', '🤝', '相談'], ['settings', '⚙️', '設定']];
async function go(route) { ROUTE = route; location.hash = route; await render(); window.scrollTo(0, 0); }
async function render() {
  const main = h('main'); main.append(h('div', { class: 'card' }, '読み込み中…'));
  $app.replaceChildren(h('header', { class: 'top' }, h('h1', {}, 'スマイル共済 Threads管理'), h('button', { class: 'sec', style: 'margin:0;min-height:36px;padding:4px 12px', onclick: act(async () => { await api('POST', '/logout'); renderLogin(); }) }, 'ログアウト')), main,
    h('nav', { class: 'tabs' }, TABS.map(([k, ic, l]) => h('a', { href: '#' + k, class: k === ROUTE ? 'on' : '', onclick: (e) => { e.preventDefault(); go(k); } }, h('b', {}, ic), l))));
  try { const page = await PAGES[ROUTE](); main.replaceChildren(...page.flat(9).filter((x) => x != null && x !== false)); } catch (e) { if (e.message !== 'login') main.replaceChildren(h('div', { class: 'note err' }, e.message)); }
}
const refresh = () => render();
function pills(name, items, def) { SUB[name] = SUB[name] || def; return h('div', { class: 'pills' }, items.map((i) => h('button', { class: SUB[name] === i ? '' : 'sec', onclick: () => { SUB[name] = i; refresh(); } }, i))); }

// ---------- ログイン ----------
function renderLogin() {
  const pw = h('input', { type: 'password', placeholder: 'パスワード', autocomplete: 'current-password' });
  const go2 = act(async () => { await api('POST', '/login', { password: pw.value }); META = null; await boot(); });
  pw.addEventListener('keydown', (e) => e.key === 'Enter' && go2());
  $app.replaceChildren(h('div', { class: 'login' }, h('div', { class: 'card' }, h('h2', {}, 'スマイル共済 Threads管理'), h('p', { class: 'hint' }, '管理者パスワードを入力してください。'), pw, h('button', { class: 'big', onclick: go2 }, 'ログイン'))));
}

// ---------- ホーム ----------
const PAGES = {};
PAGES.home = async () => {
  const d = await api('GET', '/dashboard'); const s = d.statuses;
  const stat = (n, l, tag) => h('div', { class: 'stat' }, h('div', { class: 'n' }, n), h('div', { class: 'l' }, l, tag && h('span', { class: 'badge ' + tag[0] }, tag[1])));
  const unl = (cond, n) => cond ? n : '未連携';
  return [
    h('div', { class: 'card pause' + (s.paused ? ' on' : '') },
      h('h2', {}, s.paused ? '⏸ 自動投稿・自動返信は【停止中】です' : '▶ 自動投稿・自動返信は動いています'),
      h('p', { class: 'hint' }, '押すと、自動投稿・コメントの自動返信・LINEの自動応答をまとめて止めます(受信の記録は続きます)。'),
      h('button', { class: s.paused ? '' : 'danger', onclick: act(async () => { await api('POST', '/pause', { paused: !s.paused }); refresh(); }) }, s.paused ? '再開する' : 'すべて一時停止')),
    d.todo.length ? h('div', { class: 'card' }, h('h2', {}, '📌 最初にやること'), h('ul', {}, d.todo.map((t) => h('li', {}, t))), h('button', { class: 'sec', onclick: () => go('settings') }, '設定を開く')) : null,
    d.attention.length ? h('div', { class: 'card' }, h('h2', {}, '⚠️ 対応が必要です'), d.attention.map((a) => h('div', { class: 'note err' }, a.msg))) : null,
    h('div', { class: 'card' }, h('h2', {}, '接続の状態'),
      h('div', { class: 'item' }, 'Threads ', badge(s.threads), h('div', { class: 'sub' }, s.threads.label)),
      h('div', { class: 'item' }, 'LINE公式 ', badge(s.line), h('div', { class: 'sub' }, s.line.label)),
      h('div', { class: 'item' }, 'AI下書き ', badge(s.ai), h('div', { class: 'sub' }, s.ai.label)),
      h('div', { class: 'item' }, 'Googleカレンダー ', badge(s.gcal), h('div', { class: 'sub' }, s.gcal.label))),
    h('div', { class: 'card' }, h('h2', {}, '今日の投稿予定'), d.today_posts.length ? d.today_posts.map((p) => h('div', { class: 'item' }, fmt(p.scheduled_at), ' ', stBadge(p.status), ' ', p.theme)) : h('p', { class: 'hint' }, '今日の予定はありません。')),
    h('div', { class: 'grid' },
      stat(d.drafts, '下書き・承認待ち', null), stat(d.awaiting_approval, 'うち「要確認」', null),
      stat(d.published, '公開済みの投稿', d.published_test ? ['b-test', `他にテスト${d.published_test}`] : null),
      stat(unl(d.comments_api, d.comments_open), '未対応コメント', d.comments_api ? null : ['b-warn', '手入力のみ']),
      stat(d.dm_open, 'DM 対応中', ['b-man', '手入力']), stat(d.line_inquiries, 'LINEの問い合わせ', s.line.state === 'live' ? ['b-ok', '自動'] : ['b-test', 'テスト/未連携']),
      stat(d.bookings_upcoming, '今後の相談予約', null), stat(d.follows_due, '確認日が来たフォロー候補', null)),
    h('div', { class: 'card' }, h('h2', {}, '🔰 はじめの流れ'), h('ol', { class: 'steps' },
      h('li', {}, '「設定」で商品情報・所属先ルールを登録'), h('li', {}, '「投稿」で投稿案を作成 → 内容を確認 → 承認'),
      h('li', {}, '日時を決めて予約(連携前はテスト動作)'), h('li', {}, 'プロフィールのリンクを、LINEや予約ページにしておく'),
      h('li', {}, '「返信」「相談」で届いた問い合わせに対応'), h('li', {}, '週に一度「相談」→「数字」を見直す'))),
    h('button', { class: 'sec big', onclick: act(async () => { await api('POST', '/tick'); refresh(); }, '確認しました') }, '🔄 いま予約・コメントを確認する'),
  ];
};

// ---------- 投稿 ----------
PAGES.posts = async () => {
  const states = ['すべて', ...META.states];
  const list = await api('GET', '/posts' + (SUB.pstatus && SUB.pstatus !== 'すべて' ? '?status=' + encodeURIComponent(SUB.pstatus) : ''));
  if (SUB.editPost) return postEditor(SUB.editPost);
  const theme = h('select', {}, META.themes.map((t) => h('option', {}, t))); const hint = h('input', { placeholder: '例: 春の新生活にあわせて(任意)' });
  return [
    h('div', { class: 'card' }, h('h2', {}, '✏️ 投稿案をつくる'),
      field('テーマ', theme), field('ひとこと指示(任意)', hint),
      h('button', { class: 'big', onclick: act(async () => { const r = await api('POST', '/posts/generate', { theme: theme.value, hint: hint.value }); toast(r.via === 'ai' ? 'AIで下書きを作りました' : 'テンプレートで下書きを作りました'); SUB.editPost = r.post.id; refresh(); }) }, '下書きを作る'),
      h('button', { class: 'sec big', onclick: act(async () => { const p = await api('POST', '/posts', { theme: theme.value, body: '(ここに本文を書いてください)' }); SUB.editPost = p.id; refresh(); }) }, '自分で書く'),
      help('AIは使われますか？', 'AIを接続していない間は、事実を含まないテンプレートで下書きを作ります。AIを使う場合も、結果は必ず「要確認」の下書きになり、あなたが承認するまで投稿されません。実体験・お客様の声・保障内容・料金はAIに作らせない設定です。')),
    h('div', { class: 'card' }, h('h2', {}, '投稿の一覧'), pills('pstatus', states, 'すべて'),
      list.length ? list.map((p) => h('div', { class: 'item' }, h('div', {}, stBadge(p.display_status), ' ', h('b', {}, p.theme), p.issues.some((i) => i.level === 'block') ? h('span', { class: 'badge b-err' }, '使えない表現') : p.issues.length ? h('span', { class: 'badge b-warn' }, `確認${p.issues.length}件`) : null),
        h('div', { class: 'sub' }, p.scheduled_at ? '予定 ' + fmt(p.scheduled_at) : '日時未設定', p.is_demo ? ' ・デモ' : ''), h('div', {}, p.body.slice(0, 60) + (p.body.length > 60 ? '…' : '')), p.note && h('div', { class: 'sub' }, p.note),
        h('button', { class: 'sec', onclick: () => { SUB.editPost = p.id; refresh(); } }, '開く'))) : h('p', { class: 'hint' }, 'まだありません。')),
  ];
};
async function postEditor(id) {
  const p = await api('GET', '/posts/' + id); const locked = p.status === '投稿済み';
  const body = h('textarea', { maxlength: 500 }); body.value = p.body; if (locked) body.disabled = true;
  const cnt = h('div', { class: 'hint' }); const lintBox = h('div');
  const theme = h('select', { disabled: locked }, META.themes.map((t) => h('option', { selected: t === p.theme }, t)));
  const when = h('input', { type: 'datetime-local', value: p.scheduled_at ? new Date(new Date(p.scheduled_at).getTime() + 9 * 3600e3).toISOString().slice(0, 16) : '' });
  const toIso = (v) => v ? new Date(v + ':00+09:00').toISOString() : null;
  const notes = h('textarea', { style: 'min-height:70px', placeholder: '例: 掛金の数字は公式資料p.3で確認済み' }); notes.value = p.check_notes || '';
  const checked = h('input', { type: 'checkbox', checked: !!p.checked });
  const link = h('input', { placeholder: 'https://www.threads.net/…', value: p.permalink || '' });
  const upd = async () => { const l = await api('POST', '/lint', { text: body.value }); cnt.textContent = `${body.value.length} / 500文字`; lintBox.replaceChildren(...l.map((i) => h('div', { class: 'note' + (i.level === 'block' ? ' err' : '') }, (i.level === 'block' ? '🚫 ' : '⚠️ ') + i.msg + (i.hit ? `(「${i.hit}」)` : '')))); };
  body.addEventListener('input', upd); setTimeout(upd, 0);
  const save = async () => { await api('PUT', '/posts/' + id, { body: body.value, theme: theme.value, scheduled_at: toIso(when.value), check_notes: notes.value, permalink: link.value, checked: checked.checked ? 1 : 0 }); };
  const mat = await api('GET', '/materials');
  const tr = (to, extra = {}) => act(async () => { await save(); await api('POST', `/posts/${id}/transition`, { to, checked: checked.checked, ...extra }); refresh(); }, `「${to}」にしました`);
  const mname = h('input', { placeholder: '例: 指標名(閲覧数 など)' }), mval = h('input', { type: 'number', placeholder: '数値' });
  return [
    h('button', { class: 'sec', onclick: () => { SUB.editPost = null; refresh(); } }, '← 一覧にもどる'),
    h('div', { class: 'card' }, h('h2', {}, `投稿 #${id} `, stBadge(p.display_status)), p.note && h('div', { class: 'note' }, p.note), p.error && h('div', { class: 'note err' }, 'エラー内容: ' + p.error),
      p.publish_mode === 'test' && h('div', { class: 'note info' }, 'テストモードで処理されました。実際のThreadsには投稿されていません。'),
      field('テーマ', theme), field('本文', body), cnt, lintBox,
      field('確認事項メモ', notes, '数値・保障内容などを、どの公式資料で確認したか書いておくと安心です。'),
      field('関連する公式資料', h('div', { class: 'sub' }, mat.filter((m) => !m.is_demo).length ? mat.filter((m) => !m.is_demo).map((m) => m.title).join(' / ') : '未登録(設定 → 公式資料)')),
      !locked && h('label', { class: 'chk' }, checked, '数値・保障内容・表現を確認しました(必須)'),
      h('div', { class: 'row' }, !locked && h('button', { class: 'sec', onclick: act(async () => { await save(); refresh(); }, '保存しました') }, '保存'),
        ['下書き', '要確認', 'エラー'].includes(p.status) && h('button', { onclick: tr('承認済み') }, '✅ 承認する'),
        p.status === '承認済み' && h('button', { class: 'sec', onclick: tr('要確認') }, '要確認に戻す'),
        p.status === '予約済み' && h('button', { class: 'sec', onclick: tr('承認済み') }, '予約を取り消す'))),
    p.status === '承認済み' && h('div', { class: 'card' }, h('h2', {}, '📅 予約・投稿'), field('投稿予定日時(日本時間)', when),
      h('button', { class: 'big', onclick: act(async () => { await save(); if (!when.value) throw new Error('投稿予定日時を入れてください'); await api('POST', `/posts/${id}/transition`, { to: '予約済み', scheduled_at: toIso(when.value) }); refresh(); }, '予約しました') }, '予約する'),
      h('button', { class: 'sec big', onclick: act(async () => { await save(); const live = (await api('GET', '/dashboard')).statuses.threads.state === 'live'; let confirm; if (live) { confirm = prompt('本番のThreadsに今すぐ投稿します。よければ「投稿」と入力してください'); if (confirm !== '投稿') return; } const r = await api('POST', `/posts/${id}/publish-now`, { confirm }); toast(r.post.display_status); refresh(); }) }, '今すぐ投稿(テスト/本番は設定に従います)')),
    h('div', { class: 'card' }, h('h2', {}, '📈 公開と反応の記録'), field('投稿へのリンク', link, '投稿後にリンクが自動で入らない場合は、Threadsの投稿リンクを貼ってください。'), !locked ? null : h('button', { class: 'sec', onclick: act(async () => { await save(); refresh(); }, '保存しました') }, 'リンクを保存'),
      p.metrics.length ? p.metrics.map((m) => h('div', { class: 'sub' }, `${m.metric}: ${m.value} `, h('span', { class: 'badge ' + (m.source === '手入力' ? 'b-man' : 'b-ok') }, m.source))) : h('p', { class: 'hint' }, '反応の記録はまだありません。'),
      h('div', { class: 'grid' }, mname, mval), h('button', { class: 'sec', onclick: act(async () => { await api('POST', '/metrics', { metric: mname.value, value: mval.value, post_id: id }); refresh(); }, '記録しました') }, '反応を手入力で記録')),
    !['投稿済み', '予約済み'].includes(p.status) && h('button', { class: 'danger', onclick: act(async () => { if (confirm('この投稿案を削除しますか？')) { await api('DELETE', '/posts/' + id); SUB.editPost = null; refresh(); } }) }, '削除'),
  ];
}

// ---------- 返信(コメント / DM) ----------
PAGES.replies = async () => {
  const tabs = pills('rtab', ['コメント', 'ThreadsのDM'], 'コメント');
  return [tabs, ...(SUB.rtab === 'ThreadsのDM' ? await dmPage() : await commentPage())];
};
async function commentPage() {
  const [cs, posts, rules, st] = await Promise.all([api('GET', '/comments'), api('GET', '/posts?status=投稿済み'), api('GET', '/auto-replies'), api('GET', '/settings')]);
  const apiLive = (await api('GET', '/dashboard')).statuses.threads.state === 'live';
  const cu = h('input', { placeholder: '相手のユーザー名(任意)' }), ct = h('textarea', { style: 'min-height:80px', placeholder: 'コメントの内容' }), cp = h('select', {}, h('option', { value: '' }, '(投稿を選ばない)'), posts.map((p) => h('option', { value: p.id }, `#${p.id} ${p.body.slice(0, 20)}`)));
  const kw = h('input', { placeholder: '例: 詳しく, 知りたい' }), rt = h('textarea', { style: 'min-height:80px', placeholder: '例: コメントありがとうございます。詳しくはプロフィールのリンクからお気軽にどうぞ。' }), rp = h('select', {}, posts.map((p) => h('option', { value: p.id }, `#${p.id} ${p.body.slice(0, 20)}`)));
  return [
    h('div', { class: 'note ' + (apiLive ? 'ok' : '') }, apiLive ? 'コメントは自動で取り込まれます(5分ごと)。' : 'Threadsが本番連携中ではないため、コメントは自動取得されません。下の欄に手入力できます。'),
    apiLive && h('button', { class: 'sec', onclick: act(async () => { const r = await api('POST', '/comments/sync'); toast(`新しいコメント ${r.added ?? 0}件`); refresh(); }) }, '🔄 コメントを取り込む'),
    h('div', { class: 'card' }, h('h2', {}, 'コメント一覧'), cs.length ? cs.map((c) => { const dr = h('textarea', { style: 'min-height:90px' }); dr.value = c.reply_draft || '';
      return h('div', { class: 'item' }, h('div', {}, h('span', { class: 'badge ' + (c.status === '未対応' ? 'b-warn' : 'b-ok') }, c.status), h('span', { class: 'badge ' + (c.source === 'api' ? 'b-ok' : 'b-man') }, c.source === 'api' ? '自動取得' : '手入力'), c.reply_status === 'sent' && h('span', { class: 'badge b-ok' }, '返信済み')), h('div', { class: 'sub' }, `${c.username || '不明'} ・ ${fmt(c.created_at)}`), h('div', {}, c.text), c.reply_error && h('div', { class: 'note err' }, c.reply_error),
        h('label', {}, '返信文'), dr,
        h('div', { class: 'row' }, h('button', { class: 'sec', onclick: act(async () => { const r = await api('POST', `/comments/${c.id}/draft`); dr.value = r.reply_draft; }) }, '返信案を作る'),
          h('button', { class: 'sec', onclick: () => copy(dr.value) }, '📋 コピー'),
          c.threads_comment_id && c.reply_status !== 'sent' && h('button', { onclick: act(async () => { await api('PUT', '/comments/' + c.id, { reply_draft: dr.value }); if (!confirm('この内容で公開返信します。よろしいですか？')) return; await api('POST', `/comments/${c.id}/send`, { approved: true }); refresh(); }, '返信しました') }, '承認して公開返信'),
          h('button', { class: 'sec', onclick: act(async () => { await api('PUT', '/comments/' + c.id, { status: c.status === '未対応' ? '対応済み' : '未対応', reply_draft: dr.value }); refresh(); }) }, c.status === '未対応' ? '対応済みにする' : '未対応に戻す'))); }) : h('p', { class: 'hint' }, 'コメントはまだありません。')),
    h('div', { class: 'card' }, h('h2', {}, 'コメントを手入力'), field('投稿', cp), field('ユーザー名', cu), field('内容', ct), h('div', { class: 'note' }, '相手が病歴などを書いている場合は、保存せず、所属先のルールに沿って対応してください。'), h('button', { onclick: act(async () => { await api('POST', '/comments', { post_id: cp.value || null, username: cu.value, text: ct.value }); refresh(); }) }, '追加')),
    h('div', { class: 'card' }, h('h2', {}, '🤖 コメントへの自動返信'), h('div', { class: 'note' }, '初期設定はオフです。自動返信は「一般的な案内」だけにしてください。保障の個別判断はしません。病歴や個人情報を書くよう促す文面は登録できません。'),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: st.auto_reply_enabled === '1', onchange: (e) => api('PUT', '/settings', { auto_reply_enabled: e.target.checked ? '1' : '0' }).then(() => toast(e.target.checked ? '自動返信をオンにしました' : '自動返信をオフにしました')) }), '自動返信を使う(全体スイッチ。オフなら何も送りません)'),
      h('p', { class: 'hint' }, '1日の上限: ', st.auto_reply_daily_cap, '件 / 同じコメントには1回だけ返信します。'),
      rules.map((r) => h('div', { class: 'item' }, h('div', {}, `投稿 #${r.post_id} / キーワード: ${r.keywords}`), h('div', { class: 'sub' }, r.reply_text), h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: !!r.enabled, onchange: (e) => api('PUT', '/auto-replies/' + r.id, { enabled: e.target.checked }) }), 'このルールを有効にする'), h('button', { class: 'sec', onclick: act(async () => { await api('DELETE', '/auto-replies/' + r.id); refresh(); }) }, '削除'))),
      posts.length ? [h('h3', {}, 'ルールを追加'), field('対象の投稿(公開済み)', rp), field('反応するキーワード(カンマ区切り)', kw), field('公開返信の文面', rt), h('button', { onclick: act(async () => { await api('POST', '/auto-replies', { post_id: rp.value, keywords: kw.value, reply_text: rt.value }); refresh(); }, 'ルールを追加しました(無効の状態です)') }, '追加')] : h('p', { class: 'hint' }, '公開済みの投稿ができると、ここでルールを作れます。')),
  ];
}
async function dmPage() {
  const dms = await api('GET', '/dms');
  const label = h('input', { placeholder: '相手の呼び名(例: Aさん)。本名でなくて構いません', maxlength: 40 });
  const cat = h('select', {}, META.dm_categories.map((c) => h('option', {}, c)));
  const text = h('textarea', { placeholder: 'DMの内容をここに貼り付け' });
  const maskNote = h('div');
  return [
    h('div', { class: 'note' }, h('b', {}, 'ThreadsのDMは、公式APIで自動の取得・送信ができることを確認できていません。'), 'そのため、DMはあなたがThreadsアプリで読み、ここへ貼り付けて返信案を作り、Threadsで自分で送信します。'),
    h('div', { class: 'card' }, h('h2', {}, '💌 DMの内容を入れる'),
      h('div', { class: 'note err' }, '個人名・電話番号・メール・病歴などの個人情報は、貼り付ける前に消してください。「自動で隠す」を押すと一部を伏せ字にします(完全ではないので、目でも確認してください)。'),
      field('相手の呼び名', label), field('問い合わせの種類', cat), field('DMの内容', text),
      h('button', { class: 'sec', onclick: act(async () => { const r = await api('POST', '/dm-mask', { text: text.value }); text.value = r.text; maskNote.replaceChildren(r.found.length ? h('div', { class: 'note ok' }, '伏せ字にしたもの: ' + r.found.join('、')) : h('div', { class: 'note info' }, '自動で見つかった個人情報はありません。目でも確認してください。')); }) }, '🙈 個人情報を自動で隠す'), maskNote,
      h('button', { class: 'big', onclick: act(async () => { await api('POST', '/dms', { label: label.value, category: cat.value, body: text.value }); refresh(); }, '返信案を作りました') }, '返信案を作る')),
    h('div', { class: 'card' }, h('h2', {}, 'DM一覧'), dms.length ? dms.map((d) => { const dr = h('textarea', { style: 'min-height:150px' }); dr.value = d.reply_draft || '';
      const stSel = h('select', {}, ['未対応', '返信案作成済み', '返信済み', '返信待ち', '対応済み', '対応終了'].map((s) => h('option', { selected: s === d.status }, s)));
      return h('div', { class: 'item' }, h('div', {}, h('b', {}, d.label || '(呼び名なし)'), ' ', h('span', { class: 'badge' }, d.category), h('span', { class: 'badge b-man' }, '手入力')), h('div', { class: 'sub' }, fmt(d.created_at)), h('pre', { class: 'copy' }, d.body), h('label', {}, '返信案(編集できます)'), dr,
        field('対応状況', stSel), h('div', { class: 'note' }, '「【要確認:…】」の部分は、公式資料を見て書き換えてから送ってください。'),
        h('div', { class: 'row' }, h('button', { onclick: () => copy(dr.value) }, '📋 コピー'), h('button', { class: 'sec', onclick: act(async () => { await api('PUT', '/dms/' + d.id, { reply_draft: dr.value, status: stSel.value }); refresh(); }, '保存しました') }, '保存'), h('button', { class: 'sec', onclick: act(async () => { await api('PUT', '/dms/' + d.id, { regen: true }); refresh(); }) }, '返信案を作り直す'), h('button', { class: 'danger', onclick: act(async () => { if (confirm('削除しますか？')) { await api('DELETE', '/dms/' + d.id); refresh(); } }) }, '削除'))); }) : h('p', { class: 'hint' }, 'まだありません。')),
  ];
}

// ---------- 相談(問い合わせ / 予約 / フォロー / 数字) ----------
PAGES.consult = async () => [pills('ctab', ['問い合わせ', '予約', 'フォロー', '数字'], '問い合わせ'), ...await ({ 問い合わせ: inqPage, 予約: bookPage, フォロー: followPage, 数字: metricsPage }[SUB.ctab])()];
const INQ_ST = ['未対応', '返信待ち', '相談予定', '対応済み', '対応終了'];
async function inqPage() {
  const list = await api('GET', '/inquiries');
  const name = h('input', { placeholder: '表示名または管理用の識別子(本名でなくてOK)' }), ch = h('select', {}, ['LINE', 'Threads DM', 'Threads コメント', '予約ページ', 'その他'].map((c) => h('option', {}, c))), cat = h('input', { placeholder: '問い合わせの種類' });
  return [
    h('div', { class: 'note' }, '個人情報は必要最小限に。', h('b', {}, '健康情報・病歴は入力しないでください。'), '必要なときは、所属先のルールに沿った方法で別途対応してください。'),
    h('div', { class: 'card' }, h('h2', {}, '問い合わせ一覧'), list.length ? list.map((i) => { const memo = h('textarea', { style: 'min-height:70px' }); memo.value = i.memo || ''; const st = h('select', {}, INQ_ST.map((s) => h('option', { selected: s === i.status }, s))); const nx = h('input', { type: 'date', value: (i.next_action_at || '').slice(0, 10) });
      return h('details', {}, h('summary', {}, `${i.display_name} `, h('span', { class: 'badge ' + (i.status === '未対応' ? 'b-warn' : 'b-ok') }, i.status), h('span', { class: 'badge' }, i.channel), i.has_booking ? h('span', { class: 'badge b-test' }, '予約あり') : null),
        h('div', { class: 'sub' }, `種類: ${i.category || '-'} ・ 最終対応 ${fmt(i.last_action_at)}`), field('対応状況', st), field('次の対応予定日', nx), field('メモ(健康情報は書かない)', memo),
        h('div', { class: 'row' }, h('button', { onclick: act(async () => { await api('PUT', '/inquiries/' + i.id, { status: st.value, memo: memo.value, next_action_at: nx.value || null }); refresh(); }, '保存しました') }, '保存'), h('button', { class: 'danger', onclick: act(async () => { if (confirm('この記録と関連するLINEログを完全に削除します。よろしいですか？')) { await api('DELETE', '/inquiries/' + i.id); refresh(); } }) }, '削除'))); }) : h('p', { class: 'hint' }, 'まだありません。LINEや予約が入るとここに表示されます。')),
    h('div', { class: 'card' }, h('h2', {}, '手動で追加'), field('表示名', name), field('経路', ch), field('種類', cat), h('button', { onclick: act(async () => { await api('POST', '/inquiries', { display_name: name.value, channel: ch.value, category: cat.value }); refresh(); }) }, '追加')),
  ];
}
async function bookPage() {
  const [bs, av, st] = await Promise.all([api('GET', '/bookings'), api('GET', '/availability'), api('GET', '/settings')]);
  const days = ['日', '月', '火', '水', '木', '金', '土'];
  const rows = av.map((a) => ({ ...a }));
  const editor = h('div'); const draw = () => editor.replaceChildren(...rows.map((r, idx) => h('div', { class: 'row' }, h('select', { onchange: (e) => r.weekday = Number(e.target.value), style: 'width:80px' }, days.map((d, i) => h('option', { value: i, selected: i === r.weekday }, d))), h('input', { type: 'time', value: r.start_time, style: 'width:120px', onchange: (e) => r.start_time = e.target.value }), '〜', h('input', { type: 'time', value: r.end_time, style: 'width:120px', onchange: (e) => r.end_time = e.target.value }), h('button', { class: 'sec', onclick: () => { rows.splice(idx, 1); draw(); } }, '✕')))); draw();
  return [
    h('div', { class: 'card' }, h('h2', {}, '予約ページ'), h('p', {}, 'お客様に送るURL:'), h('pre', { class: 'copy' }, st.booking_url), h('button', { class: 'sec', onclick: () => copy(st.booking_url) }, 'URLをコピー'),
      h('p', { class: 'hint' }, 'LINEの「個別相談を予約したい」を押した人には、本人確認用の印つきURLが自動で送られます。')),
    h('div', { class: 'card' }, h('h2', {}, '相談できる時間(毎週)'), editor, h('div', { class: 'row' }, h('button', { class: 'sec', onclick: () => { rows.push({ weekday: 6, start_time: '10:00', end_time: '12:00', slot_min: 60 }); draw(); } }, '＋ 追加'), h('button', { onclick: act(async () => { await api('PUT', '/availability', { rows }); refresh(); }, '保存しました') }, '保存')),
      h('p', { class: 'hint' }, '1枠60分。今から', st.booking_lead_hours, '時間後以降が選べます(設定で変更)。同じ時間は二重に予約できません。Googleカレンダー連携後は、カレンダーの予定と重なる時間は自動で除外されます。')),
    h('div', { class: 'card' }, h('h2', {}, '予約一覧'), bs.length ? bs.map((b) => h('div', { class: 'item' }, h('div', {}, h('b', {}, fmt(b.slot_start)), ' ', h('span', { class: 'badge ' + (b.status === 'confirmed' ? 'b-ok' : '') }, b.status === 'confirmed' ? '確定' : 'キャンセル'), h('span', { class: 'badge' }, b.method)), h('div', { class: 'sub' }, b.display_name, b.contact_note ? ' ・ ' + b.contact_note : ''), b.status === 'confirmed' && h('button', { class: 'sec', onclick: act(async () => { if (confirm('キャンセルしますか？(相手への連絡は別途お願いします)')) { await api('POST', `/bookings/${b.id}/cancel`); refresh(); } }) }, 'キャンセル'))) : h('p', { class: 'hint' }, '予約はまだありません。')),
  ];
}
async function followPage() {
  const list = await api('GET', '/follows');
  const nm = h('input', { placeholder: '名前(表示名)' }), url = h('input', { placeholder: 'プロフィールURL(https://…)' }), why = h('textarea', { style: 'min-height:70px', placeholder: '気になった理由' }), nx = h('input', { type: 'date' });
  return [
    h('div', { class: 'note info' }, 'ここは「覚え書き」です。フォローの操作は、あなた自身がThreadsアプリで行います(自動フォロー・大量操作は、公式に認められていないため作っていません)。'),
    h('div', { class: 'card' }, h('h2', {}, 'フォローしたい人'), list.length ? list.map((f) => h('div', { class: 'item' }, h('div', {}, h('b', {}, f.name || '(名前なし)'), ' ', h('span', { class: 'badge ' + (f.status === '未対応' ? 'b-warn' : 'b-ok') }, f.status)), f.profile_url && h('a', { href: f.profile_url, target: '_blank', rel: 'noopener noreferrer' }, 'プロフィールを開く'), h('div', { class: 'sub' }, f.reason, f.next_check ? ` ・ 次の確認日 ${f.next_check}` : ''), h('div', { class: 'row' }, h('button', { class: 'sec', onclick: act(async () => { await api('PUT', '/follows/' + f.id, { status: f.status === '未対応' ? '対応済み' : '未対応' }); refresh(); }) }, f.status === '未対応' ? '対応済みにする' : '未対応に戻す'), h('button', { class: 'danger', onclick: act(async () => { await api('DELETE', '/follows/' + f.id); refresh(); }) }, '削除')))) : h('p', { class: 'hint' }, 'まだ登録がありません。')),
    h('div', { class: 'card' }, h('h2', {}, '追加'), field('名前', nm), field('プロフィールURL', url), field('気になった理由', why), field('次に確認する日', nx), h('button', { onclick: act(async () => { await api('POST', '/follows', { name: nm.value, profile_url: url.value, reason: why.value, next_check: nx.value || null }); refresh(); }) }, '追加')),
  ];
}
async function metricsPage() {
  const [m, d] = await Promise.all([api('GET', '/metrics'), api('GET', '/dashboard')]);
  const live = d.statuses.threads.state === 'live';
  const mn = h('select', {}, ['プロフィールリンクのクリック数', 'フォロワー数', 'LINE友だち追加数(手入力)', 'DM問い合わせ件数', '相談予約件数', 'その他'].map((x) => h('option', {}, x))), mv = h('input', { type: 'number', placeholder: '数値' }), mnote = h('input', { placeholder: 'メモ(例: 今週分)' });
  const ll = h('input', { placeholder: '投稿の名前(例: 3/1の家族の投稿)' });
  const src = (s) => h('span', { class: 'badge ' + (s === '手入力' ? 'b-man' : 'b-ok') }, s);
  return [
    h('div', { class: 'card' }, h('h2', {}, '📊 数字の一覧'),
      h('div', { class: 'grid' }, h('div', { class: 'stat' }, h('div', { class: 'n' }, m.counts.posts_live), h('div', { class: 'l' }, '公開した投稿', src('自動記録'))), h('div', { class: 'stat' }, h('div', { class: 'n' }, d.statuses.line.state === 'live' ? m.counts.line_friends_auto : '—'), h('div', { class: 'l' }, 'LINE友だち追加', d.statuses.line.state === 'live' ? src('自動取得') : h('span', { class: 'badge b-warn' }, '未連携'))),
        h('div', { class: 'stat' }, h('div', { class: 'n' }, m.counts.dm), h('div', { class: 'l' }, 'DM問い合わせ', src('手入力'))), h('div', { class: 'stat' }, h('div', { class: 'n' }, m.counts.bookings), h('div', { class: 'l' }, '相談予約(確定)', src('自動記録')))),
      m.totals.length ? m.totals.map((t) => h('div', { class: 'item' }, `${t.metric}: ${t.v} `, src(t.source))) : null,
      h('div', { class: 'note' }, 'プロフィールリンクのクリック数やThreadsの閲覧数は、', live ? '「自動取得」を試せます(取得できた分だけ表示)。' : 'Threadsが本番連携中ではないため、手入力になります。'), live && h('button', { class: 'sec', onclick: act(async () => { const r = await api('POST', '/metrics/fetch'); toast(`${r.fetched}件取得`); refresh(); }) }, '🔄 Threadsから反応を取得')),
    h('div', { class: 'card' }, h('h2', {}, '手入力で記録'), field('項目', mn), field('数値', mv), field('メモ', mnote), h('button', { onclick: act(async () => { await api('POST', '/metrics', { metric: mn.value, value: mv.value, note: mnote.value }); refresh(); }, '記録しました') }, '記録する')),
    h('div', { class: 'card' }, h('h2', {}, '投稿ごとの反応'), m.posts.length ? m.posts.map((p) => h('div', { class: 'item' }, h('div', {}, `#${p.id} ${p.theme} `, p.publish_mode === 'test' && h('span', { class: 'badge b-test' }, 'テスト')), p.metrics.length ? p.metrics.map((x) => h('span', { class: 'sub' }, `${x.metric} ${x.value} `, src(x.source), ' ')) : h('div', { class: 'sub' }, '記録なし'))) : h('p', { class: 'hint' }, '公開済みの投稿はまだありません。')),
    h('div', { class: 'card' }, h('h2', {}, '🔗 どの投稿から来たかを知る方法'), h('div', { class: 'note' }, 'ThreadsからLINEへの流入は、自動では完全に特定できません。次の方法で把握します。'), h('ol', {}, h('li', {}, '投稿ごとの「専用リンク」を作り、クリック数を数える(下)'), h('li', {}, 'LINEのあいさつや相談時に「どこで知りましたか？(任意)」と聞く')),
      field('専用リンクの名前', ll, '転送先は、設定に登録したLINE友だち追加URLです。クリック数は、この管理サーバーを経由した分のみです。'), h('button', { onclick: act(async () => { const r = await api('POST', '/links', { label: ll.value }); await copy(r.url); refresh(); }) }, '専用リンクを作ってコピー'),
      m.links.map((l) => h('div', { class: 'item' }, h('b', {}, l.label || l.code), h('div', { class: 'sub' }, `${location.origin}/r/${l.code} ・ クリック ${l.clicks}`)))),
  ];
}

// ---------- 設定 ----------
PAGES.settings = async () => {
  const [s, line, mats, d] = await Promise.all([api('GET', '/settings'), api('GET', '/line'), api('GET', '/materials'), api('GET', '/dashboard')]);
  const sec = (k, ph) => h('input', { type: 'password', placeholder: s.secrets[k] ? '✅ 設定済み(変更するときだけ入力)' : ph, autocomplete: 'off', 'data-k': k });
  const saveSecrets = (root) => act(async () => { const o = {}; root.querySelectorAll('[data-k]').forEach((i) => { if (i.value.trim()) o[i.dataset.k] = i.value; }); if (!Object.keys(o).length) return toast('入力がありません'); await api('PUT', '/secrets', o); refresh(); }, '安全に保存しました(画面には表示されません)');
  const mode = (key, label) => { const sel = h('select', {}, h('option', { value: 'test', selected: s[key] === 'test' }, 'テスト(実際には送らない)'), h('option', { value: 'live', selected: s[key] === 'live' }, '本番(実際に送る)')); return [field(label, sel), h('button', { class: 'sec', onclick: act(async () => { const body = { [key]: sel.value }; if (sel.value === 'live' && s[key] !== 'live') { const c = prompt('本番に切り替えます。実際の投稿・メッセージ送信が行われます。続けるには「本番」と入力してください'); if (c !== '本番') return; body.confirm_live = '本番'; } await api('PUT', '/settings', body); refresh(); }, '切り替えました') }, 'モードを保存')]; };
  // 商品情報
  const prod = {}; const prodBox = h('div', {}, Object.entries(s.product).map(([k, v]) => { const t = h('textarea', { style: 'min-height:70px', placeholder: '未登録' }); t.value = v.value; prod[k] = t; return field(v.label + (v.value ? '' : '(未登録)'), t); }));
  const aff = h('input', { type: 'checkbox', checked: s.affiliation_rule_confirmed === '1' });
  const mt = h('input', { placeholder: '資料の名前(例: パンフレット2026年版)' }), mu = h('input', { placeholder: '資料のURL(任意)' }), mc = h('textarea', { placeholder: '資料から転記した本文(AIに渡す根拠になります)', style: 'min-height:90px' });
  const tsRoot = h('div', {}, field('アクセストークン', sec('threads_token', 'Threads のアクセストークン')), field('ユーザーID', sec('threads_user_id', 'ThreadsのユーザーID')), h('button', { onclick: null }, '安全に保存'));
  const lnRoot = h('div', {}, field('チャネルシークレット', sec('line_channel_secret', 'LINE Developers → チャネル基本設定')), field('チャネルアクセストークン(長期)', sec('line_access_token', 'LINE Developers → Messaging API設定')), h('button', {}, '安全に保存'));
  tsRoot.lastChild.onclick = saveSecrets(tsRoot); lnRoot.lastChild.onclick = saveSecrets(lnRoot);
  const aiRoot = h('div', {}); const prov = h('select', {}, [['none', '使わない(テンプレートのみ)'], ['anthropic', 'Claude(Anthropic API)'], ['openai', 'OpenAI互換API']].map(([v, l]) => h('option', { value: v, selected: s.ai_provider === v }, l))); const model = h('input', { placeholder: '空欄なら既定のモデル', value: s.ai_model });
  aiRoot.append(field('使うAI', prov), field('モデル名(任意)', model), field('APIキー', sec('ai_key', 'APIキー')), h('button', { onclick: act(async () => { await api('PUT', '/settings', { ai_provider: prov.value, ai_model: model.value }); await saveSecrets(aiRoot)(); }) }, '保存'));
  const gcRoot = h('div', {}, field('カレンダーID', sec('gcal_calendar_id', 'xxxx@group.calendar.google.com')), field('サービスアカウントのJSONキー(全文)', h('textarea', { 'data-k': 'gcal_sa_json', style: 'min-height:80px', placeholder: s.secrets.gcal_sa_json ? '✅ 設定済み' : '{ … }' })), h('button', {}, '安全に保存')); gcRoot.lastChild.onclick = saveSecrets(gcRoot);
  const lineUrl = h('input', { value: s.line_add_friend_url, placeholder: 'https://lin.ee/xxxxxxx' });
  const sim = (body) => act(async () => { const r = await api('POST', '/line/simulate', body); simOut.replaceChildren(...r.log.map((l) => h('div', { class: 'item sub' }, `${l.direction === 'in' ? '⬅ 受信' : '➡ 送信'} [${l.status}] ${l.text}`))); }); const simOut = h('div'); const simText = h('input', { placeholder: '例: こんにちは' });
  const menuRows = line.menu.map((m) => { const t = h('textarea', { style: 'min-height:90px' }); t.value = m.response_text; const v = h('input', { type: 'checkbox', checked: !!m.verified }); const lb = h('input', { value: m.label });
    return h('details', {}, h('summary', {}, m.key === 'welcome' ? 'あいさつ' : m.key === 'fallback' ? '判断が難しいとき' : `メニュー${m.key}`, ': ', m.label, ' ', m.verified ? h('span', { class: 'badge b-ok' }, '確認済み') : h('span', { class: 'badge b-warn' }, '未確認(自動では送りません)')),
      ['1', '2', '3', '4'].includes(m.key) && field('ボタンの名前(20文字まで)', lb), field('応答文', t, m.key === '3' ? '予約ページのリンクが、この文のあとに自動でつきます。' : m.key === '4' ? 'わっちへの引き継ぎを案内する文面です。' : '公式資料にある内容だけを書き、「確認済み」にチェックしてください。未確認の文面は自動送信されず、引き継ぎ案内になります。'),
      h('label', { class: 'chk' }, v, 'この文面を確認しました(自動送信してよい)'), h('button', { onclick: act(async () => { await api('PUT', '/line/menu/' + m.key, { response_text: t.value, verified: v.checked, label: lb.value }); refresh(); }, '保存しました') }, '保存')); });
  const rd = h('input', { type: 'number', value: s.retention_days }), lead = h('input', { type: 'number', value: s.booking_lead_hours }), aff2 = h('textarea', { style: 'min-height:70px', placeholder: '所属先のルールの要点や、確認した日付・担当者をメモ' }); aff2.value = s.affiliation_rule_note;
  return [
    h('div', { class: 'card' }, h('h2', {}, '1. 商品情報と公式資料'), h('div', { class: 'note' }, '正式名称・運営元・保障内容・掛金・加入条件は、', h('b', {}, '正式な資料を見て、ご自身で入力'), 'してください。入力されていない項目は「未登録」として扱い、投稿案・自動応答で事実として使いません。'), prodBox,
      h('label', { class: 'chk' }, aff, '所属先の案内・募集ルールを確認しました(投稿の承認に必要)'), field('ルールのメモ', aff2), h('button', { onclick: act(async () => { const product = {}; for (const k in prod) product[k] = prod[k].value; await api('PUT', '/settings', { product, affiliation_rule_confirmed: aff.checked ? '1' : '0', affiliation_rule_note: aff2.value }); refresh(); }, '保存しました') }, '保存'),
      h('h3', {}, '公式資料の登録'), mats.map((m) => h('div', { class: 'item' }, h('b', {}, m.title), m.is_demo ? h('span', { class: 'badge b-man' }, 'デモ') : null, m.url && h('div', { class: 'sub' }, m.url), h('button', { class: 'sec', onclick: act(async () => { await api('DELETE', '/materials/' + m.id); refresh(); }) }, '削除'))), field('名前', mt), field('URL', mu), field('本文の転記(任意)', mc), h('button', { class: 'sec', onclick: act(async () => { await api('POST', '/materials', { title: mt.value, url: mu.value, content: mc.value, verified: true }); refresh(); }, '登録しました') }, '資料を登録')),
    h('div', { class: 'card' }, h('h2', {}, '2. Threads の接続'), badge(d.statuses.threads), h('div', { class: 'sub' }, d.statuses.threads.label), mode('threads_mode', 'モード'),
      help('Threadsをつなぐには？', h('ol', { class: 'steps' }, h('li', {}, 'Metaの開発者サイト(developers.facebook.com)でアプリを作り、「Threads API」を追加'), h('li', {}, '権限: 投稿=threads_basic, threads_content_publish / 返信の取得=threads_read_replies / 返信の投稿=threads_manage_replies / 反応=threads_manage_insights'), h('li', {}, 'ご自身のThreadsアカウントでアクセストークン(長期)とユーザーIDを取得'), h('li', {}, '下に貼り付けて保存 → 「本番」に切り替え')), h('p', {}, '※審査・必要な権限・アカウント条件はMetaの公式ドキュメントで必ず最新を確認してください。トークンの期限は約60日で、この画面のサーバーが自動更新を試みます。')), tsRoot),
    h('div', { class: 'card' }, h('h2', {}, '3. LINE公式アカウントの接続'), badge(d.statuses.line), h('div', { class: 'sub' }, d.statuses.line.label), mode('line_mode', 'モード'),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: s.line_bot_enabled === '1', onchange: (e) => api('PUT', '/settings', { line_bot_enabled: e.target.checked ? '1' : '0' }) }), '自動応答を使う(オフにすると、受信を記録して通知するだけになります)'),
      h('div', { class: 'note info' }, h('b', {}, 'このLINE応答は自動応答です。'), '返信には「', line.notice, '」の注記が必ずつきます。'),
      h('p', {}, 'Webhook URL(LINE Developersに貼ります。https必須):'), h('pre', { class: 'copy' }, s.webhook_url), h('button', { class: 'sec', onclick: () => copy(s.webhook_url) }, 'コピー'),
      help('LINEをつなぐには？', h('ol', { class: 'steps' }, h('li', {}, 'LINE公式アカウントを作成し、LINE Official Account Managerで「Messaging API」を有効化'), h('li', {}, 'LINE Developersで チャネルシークレット と チャネルアクセストークン(長期)を発行'), h('li', {}, 'Webhook URLを設定し、「Webhookの利用」をオン'), h('li', {}, 'LINE公式アカウント側の「応答メッセージ」「あいさつメッセージ」はオフ(二重返信を防ぐ)'), h('li', {}, '下に貼り付けて保存 → 「本番」に切り替え')), h('p', {}, '※送信数の料金プランは変わることがあります。LINE公式の料金ページで最新をご確認ください(返信メッセージは無料枠に数えられない扱いですが、通知や確認のプッシュ送信は数えられます)。')), lnRoot,
      field('LINE友だち追加URL(専用リンクの転送先)', lineUrl), h('button', { class: 'sec', onclick: act(async () => { await api('PUT', '/settings', { line_add_friend_url: lineUrl.value }); refresh(); }, '保存しました') }, '保存'),
      h('h3', {}, '通知'), h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: s.line_notify_owner === '1', onchange: (e) => api('PUT', '/settings', { line_notify_owner: e.target.checked ? '1' : '0' }) }), '新しい問い合わせを、わっちのLINEにも通知する(送信数に数えられます)'),
      h('p', { class: 'hint' }, s.owner_registered ? '✅ 通知先のLINEは登録済みです。' : `通知先の登録: ご自身のLINEから、このLINE公式アカウントへ「登録 ${s.owner_claim_code}」と送ってください。`), h('p', { class: 'hint' }, '画面の通知(ホームの⚠️)は常に有効です。'),
      h('h3', {}, 'メニューと応答文'), menuRows,
      h('h3', {}, '🧪 テスト画面'), s.line_mode === 'test' ? h('div', {}, h('div', { class: 'note info' }, 'テストモードです。実際のLINEには何も送られません。'), h('div', { class: 'row' }, h('button', { class: 'sec', onclick: sim({ type: 'follow' }) }, '友だち追加'), ['1', '2', '3', '4'].map((k) => h('button', { class: 'sec', onclick: sim({ type: 'postback', key: k }) }, 'メニュー' + k))), simText, h('button', { class: 'sec', onclick: sim({ type: 'message', text: simText.value }) }, '自由な文を送る'), simOut) : h('div', { class: 'note' }, '本番モードではテスト画面は使えません。'),
      h('h3', {}, '最近のやりとり(記録)'), line.log.slice(0, 15).map((l) => h('div', { class: 'item sub' }, `${fmt(l.created_at)} ${l.direction === 'in' ? '受信' : '送信'} [${l.mode}/${l.status}] ${l.text.slice(0, 40)} ${l.error || ''}`))),
    h('div', { class: 'card' }, h('h2', {}, '4. AI下書き(任意)'), badge(d.statuses.ai), h('div', { class: 'sub' }, d.statuses.ai.label),
      h('div', { class: 'note' }, h('b', {}, 'ChatGPTなどの有料プランと、API利用料金は別です。'), 'たとえばChatGPT Plusに入っていても、APIを使うには別途APIキーと従量課金の設定が必要になる場合があります。料金は各社の公式ページで最新を確認してください。'),
      h('p', {}, 'すでにAPIキーをお持ちですか？ お持ちなら下に貼り付け、なければ上で「使わない」のままで大丈夫です(テンプレートで動きます)。新しく用意する場合は、利用する会社のサイトでAPIキーを発行してください。'), aiRoot),
    h('div', { class: 'card' }, h('h2', {}, '5. Googleカレンダー(任意)'), badge(d.statuses.gcal), h('div', { class: 'sub' }, d.statuses.gcal.label),
      help('つなぐには？(未検証の機能です)', h('ol', { class: 'steps' }, h('li', {}, 'Google Cloudでプロジェクトを作り、Google Calendar APIを有効化'), h('li', {}, 'サービスアカウントを作成してJSONキーをダウンロード'), h('li', {}, '対象カレンダーの「共有」に、サービスアカウントのメールを「予定の変更」権限で追加'), h('li', {}, 'カレンダーIDとJSONキーを下に貼り付け')), h('p', {}, '未連携でも、「相談」→「予約」の空き時間設定だけで予約を受けられます。予約はこの管理画面にも保存されます。')), gcRoot, field('予約の受付開始(何時間後から)', lead), h('button', { class: 'sec', onclick: act(async () => { await api('PUT', '/settings', { booking_lead_hours: lead.value }); refresh(); }, '保存しました') }, '保存')),
    h('div', { class: 'card' }, h('h2', {}, '6. データの保存と削除'),
      h('div', { class: 'note info' }, '保存するもの: 投稿案、コメント、DMの手入力内容、問い合わせの表示名・経路・メモ、LINEのユーザーID(内部識別子)と受信/送信の記録、予約。保存場所: このサーバー内の data/app.db。APIキーなどは暗号化して保存し、画面には表示しません。'), field('保存期間(日)', rd, 'これを過ぎたログ・コメント・DM・終了した問い合わせは、毎日自動で削除します。'),
      h('div', { class: 'row' }, h('button', { class: 'sec', onclick: act(async () => { await api('PUT', '/settings', { retention_days: rd.value }); }, '保存しました') }, '保存'), h('button', { class: 'sec', onclick: act(async () => { const r = await api('POST', '/purge'); toast(`${r.deleted}件削除`); }) }, '期限切れを今すぐ削除'), h('button', { class: 'sec', onclick: act(async () => { if (confirm('デモ用データをすべて削除しますか？')) { await api('POST', '/delete-demo'); refresh(); } }) }, 'デモデータを削除'), h('button', { class: 'danger', onclick: act(async () => { if (confirm('すべての端末をログアウトします')) { await api('POST', '/logout-all'); renderLogin(); } }) }, '全端末ログアウト')),
      h('p', { class: 'hint' }, '個別の問い合わせは「相談 → 問い合わせ」から完全に削除できます。')),
    h('div', { class: 'card' }, h('h2', {}, '公式仕様で「できない」こと'), h('ul', {}, h('li', {}, 'ThreadsのDMの自動取得・自動送信(公式APIで確認できていません → 手入力方式)'), h('li', {}, 'Threadsでの自動フォロー(行いません)'), h('li', {}, 'ThreadsからLINEへの流入の完全な自動特定(専用リンク・アンケートで代用)'))),
  ];
};

async function boot() {
  try { META = await api('GET', '/meta'); } catch (e) { return renderLogin(); }
  ROUTE = location.hash.slice(1) in PAGES ? location.hash.slice(1) : 'home'; await render();
}
boot();
