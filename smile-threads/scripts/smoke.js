'use strict';
// 画面確認用の起動(テスト用の一時DB・一時パスワード。実運用では使わない)
process.env.APP_SECRET = 'smoke-secret-smoke-secret-1234'; process.env.PUBLIC_BASE_URL = 'https://example.test';
const { createApp } = require('../server'); const { hashPassword } = require('../lib/util');
const app = createApp({ dbFile: process.argv[2] || '/tmp/smoke.db', passwordHash: hashPassword('smoke-password') });
app.server.listen(Number(process.env.PORT) || 3111, () => console.log('smoke up'));
