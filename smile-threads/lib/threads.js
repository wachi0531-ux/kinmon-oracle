'use strict';
// Threads 公式API(Graph API)クライアント。
// ・公式に確認できたもの: 返信の取得(threads_read_replies)・返信の投稿(threads_manage_replies)・reply_to_id・投稿の2段階公開
// ・DM/自動フォロー/予約投稿パラメータ: 公式APIで確認できていないため実装しない(予約は当サーバーが時刻に合わせて公開)
const BASE = () => process.env.THREADS_API_BASE || 'https://graph.threads.net/v1.0';
const MAX_TEXT = 500; // Threads投稿の文字数上限(公式ドキュメントで再確認してください)

class ThreadsError extends Error {}

function makeThreads(db) {
  const creds = () => ({ token: db.getSecret('threads_token'), userId: db.getSecret('threads_user_id') });
  const connected = () => { const c = creds(); return !!(c.token && c.userId); };
  const mode = () => db.getSetting('threads_mode');

  async function call(method, path, params = {}) {
    const { token } = creds();
    const url = new URL(BASE() + path);
    const body = new URLSearchParams();
    if (method === 'GET') { for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v); url.searchParams.set('access_token', token); }
    else { for (const [k, v] of Object.entries(params)) body.set(k, v); body.set('access_token', token); }
    let res;
    try { res = await fetch(url, { method, body: method === 'GET' ? undefined : body, signal: AbortSignal.timeout(20000) }); }
    catch (e) { throw new ThreadsError('Threadsに接続できませんでした: ' + e.message); }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new ThreadsError(`Threads APIエラー(${res.status}): ${json?.error?.message || 'unknown'}`); // トークンは含めない
    return json;
  }

  // 状態: 画面表示用
  function status() {
    if (mode() === 'test') return { state: 'test', label: 'テストモード(実際には投稿されません)' };
    if (!connected()) return { state: 'waiting', label: '連携待ち(トークン未設定)' };
    return { state: 'live', label: '本番連携中' };
  }

  async function publishText(text, { replyTo } = {}) {
    if (text.length > MAX_TEXT) throw new ThreadsError(`${MAX_TEXT}文字を超えています(${text.length}文字)`);
    if (mode() === 'test') return { id: 'test_' + Date.now(), permalink: '', mode: 'test' };
    if (!connected()) throw new ThreadsError('Threadsが未連携です');
    const { userId } = creds();
    const p = { media_type: 'TEXT', text };
    if (replyTo) p.reply_to_id = replyTo;
    const c = await call('POST', `/${userId}/threads`, p);
    await new Promise((r) => setTimeout(r, Number(process.env.THREADS_WAIT_MS ?? 3000)));
    const pub = await call('POST', `/${userId}/threads_publish`, { creation_id: c.id });
    let permalink = '';
    try { permalink = (await call('GET', `/${pub.id}`, { fields: 'permalink' })).permalink || ''; } catch { /* permalinkは後から取得可 */ }
    return { id: pub.id, permalink, mode: 'live' };
  }

  async function fetchReplies(mediaId) {
    if (mode() === 'test' || !connected()) return [];
    const out = [];
    const j = await call('GET', `/${mediaId}/replies`, { fields: 'id,text,username,timestamp,permalink' });
    for (const r of j.data || []) out.push(r);
    return out;
  }
  async function fetchInsights(mediaId) {
    if (mode() === 'test' || !connected()) return null;
    const j = await call('GET', `/${mediaId}/insights`, { metric: 'views,likes,replies,reposts,quotes' });
    const o = {};
    for (const m of j.data || []) o[m.name] = m.values?.[0]?.value ?? m.total_value?.value ?? 0;
    return o;
  }
  async function myUsername() {
    if (!connected()) return '';
    try { return (await call('GET', '/me', { fields: 'username' })).username || ''; } catch { return ''; }
  }
  // 長期トークンの更新(公式: th_refresh_token)。失敗しても既存トークンは壊さない
  async function refreshToken() {
    if (!connected() || mode() === 'test') return false;
    const { token } = creds();
    const base = BASE().replace(/\/v\d+\.\d+$/, '');
    const u = new URL(base + '/refresh_access_token');
    u.searchParams.set('grant_type', 'th_refresh_token'); u.searchParams.set('access_token', token);
    const res = await fetch(u, { signal: AbortSignal.timeout(20000) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) throw new ThreadsError('トークン更新に失敗しました');
    db.setSecret('threads_token', j.access_token);
    db.setSetting('threads_token_refreshed_at', new Date().toISOString());
    return true;
  }
  return { status, connected, publishText, fetchReplies, fetchInsights, myUsername, refreshToken, MAX_TEXT };
}
module.exports = { makeThreads, ThreadsError };
