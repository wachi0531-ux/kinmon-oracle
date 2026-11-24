'use strict';
// AI下書き。キー未設定なら使わない(テンプレートのみ)。AIの出力は常に「要確認」の下書きとして保存される。
const GUARD = `あなたはスマイル共済の案内を行う個人担当者「わっち」のSNS投稿文の下書きを書く編集者です。
厳守:
- 「登録済みの公式情報」に書かれていない商品名・保障内容・掛金・加入条件・数値・制度を書かない。分からないことは書かず、「【要確認:○○】」と印を付ける。
- 実体験・お客様の声・実績・件数・体験談を創作しない。
- 不安を過度にあおらない。加入を急がせない。「必ず」「絶対」など条件を省いた断定をしない。
- 他商品との比較は、根拠が与えられていない限り書かない。
- 病歴・個人情報の記入を促さない。保障の個別判断はしない。
- 500文字以内。やさしい日本語。最後は相談やLINEへの案内を押しつけがましくなく添える。
- 出力は投稿本文のみ。`;

function makeAi(db) {
  const provider = () => db.getSetting('ai_provider');
  const status = () => {
    const p = provider();
    if (p === 'none') return { state: 'off', label: 'AI未接続(テンプレートで作成)' };
    return db.hasSecret('ai_key') ? { state: 'live', label: `AI接続済み(${p === 'openai' ? 'OpenAI' : 'Claude'})` } : { state: 'waiting', label: 'APIキー未設定(設定画面に貼り付けるまでテンプレートで動きます)' };
  };
  async function generate({ theme, hint, productContext }) {
    const p = provider();
    if (p === 'none' || !db.hasSecret('ai_key')) return null;
    const user = `テーマ: ${theme}\n追加の指示: ${hint || 'なし'}\n\n【登録済みの公式情報】\n${productContext || '(未登録。商品に関する具体的な記述は一切しないこと)'}`;
    const key = db.getSecret('ai_key');
    const model = db.getSetting('ai_model');
    let res, json;
    if (p === 'anthropic') {
      res = await fetch((db.getSetting('ai_base_url') || 'https://api.anthropic.com') + '/v1/messages', {
        method: 'POST', signal: AbortSignal.timeout(60000),
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: model || 'claude-sonnet-5-5', max_tokens: 800, system: GUARD, messages: [{ role: 'user', content: user }] }),
      });
      json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`AIエラー(${res.status})`);
      return (json.content || []).map((c) => c.text || '').join('').trim();
    }
    // OpenAI互換
    res = await fetch((db.getSetting('ai_base_url') || 'https://api.openai.com/v1') + '/chat/completions', {
      method: 'POST', signal: AbortSignal.timeout(60000),
      headers: { Authorization: 'Bearer ' + key, 'content-type': 'application/json' },
      body: JSON.stringify({ model: model || 'gpt-4o-mini', messages: [{ role: 'system', content: GUARD }, { role: 'user', content: user }] }),
    });
    json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`AIエラー(${res.status})`);
    return (json.choices?.[0]?.message?.content || '').trim();
  }
  // 接続テスト: 短い下書きを1回だけ作る(キーは返さない)
  async function test() {
    if (!db.hasSecret('ai_key')) return { ok: false, message: 'APIキーが未設定です' };
    try { const t = await generate({ theme: '接続テスト', hint: '「接続テストです」と20文字以内で1文だけ書く', productContext: '' }); return { ok: !!t, message: t ? '接続できました' : '応答が空でした', preview: (t || '').slice(0, 80) }; }
    catch (e) { return { ok: false, message: e.message }; }
  }
  return { status, generate, test, GUARD };
}
module.exports = { makeAi };
