'use strict';
const box = document.getElementById('box');
const lu = new URLSearchParams(location.search).get('lu') || '';
const el = (t, a = {}, ...c) => { const e = document.createElement(t); for (const [k, v] of Object.entries(a)) k === 'class' ? e.className = v : k.startsWith('on') ? e.addEventListener(k.slice(2), v) : e.setAttribute(k, v); for (const x of c.flat()) e.append(x?.nodeType ? x : document.createTextNode(x ?? '')); return e; };
(async () => {
  const r = await fetch('/api/public/slots'); const d = await r.json(); box.textContent = '';
  if (!d.slots?.length) { box.append(el('p', {}, '現在ご予約いただける日時がありません。恐れ入りますが、LINEでご連絡ください。')); return; }
  const slot = el('select'); d.slots.forEach((s) => slot.append(el('option', { value: s.start }, s.label)));
  const method = el('select'); d.methods.forEach((m) => method.append(el('option', {}, m)));
  const name = el('input', { maxlength: 40, placeholder: 'ニックネームでも大丈夫です' });
  const memo = el('textarea', { maxlength: 200, placeholder: '連絡方法のご希望など(任意・健康に関することは書かないでください)', style: 'min-height:80px' });
  const consent = el('input', { type: 'checkbox' });
  const msg = el('div'); const btn = el('button', { class: 'big' }, '予約する');
  btn.onclick = async () => {
    btn.disabled = true; msg.textContent = '';
    const res = await fetch('/api/public/book', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slot_start: slot.value, method: method.value, display_name: name.value, contact_note: memo.value, consent: consent.checked, lu }) });
    const j = await res.json();
    if (res.ok) { box.textContent = ''; box.append(el('h2', {}, 'ご予約を受け付けました'), el('p', {}, `日時: ${j.label}`), el('p', {}, `方法: ${j.method}`), el('div', { class: 'note ok' }, '担当のわっちからあらためてご案内します。変更をご希望の場合は、LINEでお知らせください。')); }
    else { msg.append(el('div', { class: 'note err' }, j.error || 'エラーが起きました')); btn.disabled = false; }
  };
  box.append(el('label', {}, '日時'), slot, el('label', {}, '相談の方法'), method, el('label', {}, 'お名前(ニックネーム可)'), name, el('label', {}, 'ひとこと(任意)'), memo,
    el('label', { class: 'chk' }, consent, '相談のご案内のため、お名前などを保存することに同意します。保存した情報は、ご希望により削除します。'), msg, btn);
})();
