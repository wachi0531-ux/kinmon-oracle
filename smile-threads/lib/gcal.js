'use strict';
// Googleカレンダー連携(サービスアカウント)。※実アカウントでの動作は未検証。
// 必要: Google Cloudでサービスアカウント作成→JSONキーを設定画面に貼付→カレンダーをそのサービスアカウントのメールに共有(予定の変更権限)
const crypto = require('node:crypto');
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

function makeGcal(db) {
  const conf = () => {
    const raw = db.getSecret('gcal_sa_json'); const cal = db.getSecret('gcal_calendar_id');
    if (!raw || !cal) return null;
    try { return { sa: JSON.parse(raw), cal }; } catch { return null; }
  };
  const status = () => conf() ? { state: 'live', label: 'Googleカレンダー設定済み(未検証)' } : { state: 'waiting', label: '未連携(空き時間はこの画面の設定のみで管理)' };
  let cache = { token: '', exp: 0 };
  async function token() {
    if (cache.token && cache.exp > Date.now() + 60000) return cache.token;
    const { sa } = conf(); const now = Math.floor(Date.now() / 1000);
    const head = b64({ alg: 'RS256', typ: 'JWT' });
    const claim = b64({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/calendar', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
    const sig = crypto.createSign('RSA-SHA256').update(`${head}.${claim}`).sign(sa.private_key).toString('base64url');
    const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${sig}` }) });
    const j = await res.json(); if (!res.ok) throw new Error('Google認証に失敗しました');
    cache = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
    return cache.token;
  }
  // 予定が入っている時間帯(busy)
  async function busy(fromIso, toIso) {
    const c = conf(); if (!c) return [];
    const res = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', { method: 'POST', headers: { Authorization: 'Bearer ' + await token(), 'content-type': 'application/json' }, body: JSON.stringify({ timeMin: fromIso, timeMax: toIso, items: [{ id: c.cal }] }) });
    const j = await res.json(); if (!res.ok) throw new Error('Googleカレンダーの空き確認に失敗');
    return (j.calendars?.[c.cal]?.busy || []).map((b) => ({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() }));
  }
  async function createEvent({ summary, startIso, endIso, description }) {
    const c = conf(); if (!c) return null;
    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(c.cal)}/events`, { method: 'POST', headers: { Authorization: 'Bearer ' + await token(), 'content-type': 'application/json' }, body: JSON.stringify({ summary, description, start: { dateTime: startIso }, end: { dateTime: endIso } }) });
    const j = await res.json(); if (!res.ok) throw new Error('Googleカレンダーへの登録に失敗');
    return j.id;
  }
  return { status, busy, createEvent, configured: () => !!conf() };
}
module.exports = { makeGcal };
