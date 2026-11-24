'use strict';
// 初期設定: パスワードを決めて .env を作ります(パスワード自体は保存せず、ハッシュのみ保存)
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto'); const readline = require('node:readline');
const { hashPassword } = require('../lib/util');
const file = path.join(__dirname, '..', '.env');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, r));
(async () => {
  if (fs.existsSync(file) && (await ask('.env がすでにあります。上書きしますか？ (yes/no) ')) !== 'yes') { rl.close(); return console.log('中止しました。'); }
  let pw = process.env.SETUP_PASSWORD || await ask('管理画面のパスワード(12文字以上)を決めてください: ');
  while (pw.length < 12) pw = await ask('12文字以上にしてください: ');
  const base = process.env.SETUP_BASE_URL || await ask('公開URL(まだなければそのままEnter → http://localhost:3000): ') || 'http://localhost:3000';
  const secure = base.startsWith('https://') ? '1' : '0';
  fs.writeFileSync(file, `PORT=3000\nPUBLIC_BASE_URL=${base}\nADMIN_PASSWORD_HASH=${hashPassword(pw)}\nAPP_SECRET=${crypto.randomBytes(32).toString('hex')}\nCOOKIE_SECURE=${secure}\n`, { mode: 0o600 });
  console.log('\n.env を作りました(Gitには上げないでください)。\n次: npm start  → ブラウザで ' + base + ' を開く');
  rl.close();
})();
