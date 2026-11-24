'use strict';
// LINE Messaging API: 署名検証(HMAC-SHA256 + Base64, 生のボディ)・返信・プッシュ
const crypto = require('node:crypto');
const BASE = () => process.env.LINE_API_BASE || 'https://api.line.me';

function verifySignature(rawBody, signature, channelSecret) {
  if (!channelSecret || !signature) return false;
  const calc = crypto.createHmac('sha256', channelSecret).update(rawBody).digest();
  let got; try { got = Buffer.from(signature, 'base64'); } catch { return false; }
  return calc.length === got.length && crypto.timingSafeEqual(calc, got);
}

function makeLine(db) {
  const mode = () => db.getSetting('line_mode');
  const hasCreds = () => !!(db.getSecret('line_channel_secret') && db.getSecret('line_access_token'));
  function status() {
    if (mode() === 'test') return { state: 'test', label: 'テストモード(実際には送信されません)' };
    if (!hasCreds()) return { state: 'waiting', label: '連携待ち(チャネルシークレット/アクセストークン未設定)' };
    return { state: 'live', label: '本番連携中' };
  }
  const log = (direction, userId, text, st, error = '') =>
    db.run('INSERT INTO line_log(direction,mode,line_user_id,text,status,error,created_at) VALUES(?,?,?,?,?,?,?)', direction, mode(), userId || '', String(text || '').slice(0, 500), st, error, new Date().toISOString());

  async function post(path, body) {
    const res = await fetch(BASE() + path, {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + db.getSecret('line_access_token') },
      body: JSON.stringify(body),
    });
    if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`LINE APIエラー(${res.status}) ${t.slice(0, 120)}`); }
  }
  // messages: LINEのメッセージオブジェクト配列
  async function reply(replyToken, messages, userId) {
    const summary = messages.map((m) => m.text).join(' / ');
    if (mode() === 'test') { log('out', userId, summary, 'test-sent'); return { sent: false, test: true }; }
    if (!hasCreds()) { log('out', userId, summary, 'error', '未連携'); db.notify('error', 'line', 'LINEの返信に失敗', '未連携のため送信できません'); return { sent: false }; }
    try { await post('/v2/bot/message/reply', { replyToken, messages }); log('out', userId, summary, 'sent'); return { sent: true }; }
    catch (e) { log('out', userId, summary, 'error', e.message); db.notify('error', 'line', 'LINEの返信に失敗', e.message); return { sent: false, error: e.message }; }
  }
  async function push(to, messages) {
    const summary = messages.map((m) => m.text).join(' / ');
    if (mode() === 'test') { log('out', to, '[push] ' + summary, 'test-sent'); return { sent: false, test: true }; }
    if (!hasCreds()) return { sent: false };
    try { await post('/v2/bot/message/push', { to, messages }); log('out', to, '[push] ' + summary, 'sent'); return { sent: true }; }
    catch (e) { log('out', to, '[push] ' + summary, 'error', e.message); db.notify('error', 'line', 'LINEの送信に失敗', e.message); return { sent: false, error: e.message }; }
  }
  return { status, reply, push, log, hasCreds, mode };
}
module.exports = { verifySignature, makeLine };
