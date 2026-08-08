import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8');

test('app.js 的 DOM id 引用全部存在且 HTML id 不重复', () => {
  const app = read('app.js');
  const html = read('index.html');
  const refs = [...app.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1]);
  const htmlIds = [...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);
  const available = new Set(htmlIds);

  assert.equal(new Set(refs).size, refs.length, 'app.js 不应重复声明同一个 $() DOM 引用');
  assert.deepEqual(refs.filter((id) => !available.has(id)), []);
  assert.equal(new Set(htmlIds).size, htmlIds.length, 'index.html 不应有重复 id');
});

test('Service Worker 预缓存覆盖 app.js 的完整本地模块依赖图', () => {
  const sw = read('sw.js');
  const match = sw.match(/const\s+PRECACHE_URLS\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(match, '应能解析 PRECACHE_URLS');
  const precache = new Set(
    [...match[1].matchAll(/'([^']+)'/g)]
      .map((item) => item[1].replace(/^\.\//, '')),
  );

  for (const path of precache) {
    if (!path) continue;
    assert.equal(existsSync(resolve(ROOT, path)), true, `预缓存文件缺失:${path}`);
  }

  const visited = new Set();
  const visit = (path) => {
    if (visited.has(path)) return;
    visited.add(path);
    const source = read(path);
    for (const item of source.matchAll(/(?:from\s+|import\s*)['"]([^'"]+)['"]/g)) {
      if (!item[1].startsWith('.')) continue;
      const child = relative(ROOT, resolve(ROOT, dirname(path), item[1])).replaceAll('\\', '/');
      visit(child);
    }
  };
  visit('app.js');

  const missing = [...visited].filter((path) => !precache.has(path));
  assert.deepEqual(missing, [], `模块依赖必须全部离线预缓存:${missing.join(', ')}`);
  assert.ok(precache.has('sync/coordinator.mjs'));
});

test('响应式圆尺寸方向与设计契约一致', () => {
  const css = read('styles.css');
  assert.ok(css.includes('@media (min-width: 420px) {\n  .coach-circle { width: 200px; height: 200px; }'));
  assert.ok(css.includes('@media (max-height: 700px) {\n  .coach { min-height: 178px; }\n  .coach-circle { width: 150px; height: 150px; }'));
  // 进度环必须随圆一起缩放:环若停在基础尺寸,矮屏上会跟缩小的圆脱开一圈
  assert.ok(css.includes('.coach-ring { width: 258px; height: 258px; }'), '≥420px 断点要放大环');
  assert.ok(css.includes('.coach-ring { width: 200px; height: 200px; }'), '矮屏断点要缩小环');
});

/*
 * 进度环的三层结构是 CSS 陷阱防线,不是审美偏好:
 *   mask 会连同子元素一起裁 → 环一旦成为圆的父元素,圆就被掏没了。
 * 所以「环与圆是兄弟、靠 grid-area 叠层」这件事必须锁住。
 */
test('进度环与引导圆是兄弟层,环不得成为圆的父元素', () => {
  const html = read('index.html');
  const css = read('styles.css');

  // 环是自闭合的空元素,圆在另一层 .coach-stage 里
  assert.match(html, /<div class="coach-ring" id="coach-ring"[^>]*><\/div>/, '环必须是空元素,不能包住圆');
  assert.match(html, /<div class="coach-stage">\s*<button[^>]*id="coach-circle"/, '圆必须在 .coach-stage 内');

  // 叠层靠 grid-area,不是 position:absolute
  assert.ok(css.includes('.coach-ring,\n.coach-stage {\n  grid-area: 1 / 1;\n}'), '环与 stage 必须用 grid-area 叠在同一格');
  assert.match(css, /\.coach-ring \{[^}]*mask: radial-gradient/, '环靠 radial mask 掏空成环');
});

test('引导圆是可点按钮,且空闲态不再显示破折号', () => {
  const html = read('index.html');
  const app = read('app.js');
  assert.match(html, /<button[^>]*class="coach-circle"[^>]*id="coach-circle"/, '圆必须是 button 才能可点/可聚焦');
  assert.ok(app.includes("el.coachCircle.addEventListener('click'"), '圆要有点击处理器');
  // 点击必须转发到按钮而非复制逻辑:AudioContext/speechSynthesis 的手势上下文靠这条保证
  assert.ok(app.includes('el.btnPause.click()') && app.includes('el.btnStart.click()'));
  assert.equal(html.includes('id="overall-bar"'), false, '条形进度条已被进度环取代');
});

test('主密码强度门槛在 UI 上真的生效(不是只写在 hint 里)', () => {
  const app = read('app.js');
  assert.ok(app.includes('checkPassphrase'), 'app.js 必须引用 core 的强度校验');
  assert.ok(app.includes('function passphraseUsable()'));
  // 关键:不达标时给编排器空串,而不是把弱密码拿去加密真实数据
  assert.ok(
    app.includes("passphraseUsable() ? syncMasterPass : ''"),
    '强度不达标时必须给 coordinator 空密码',
  );
});

test('后端与 nginx 都不把 userId 写进日志', () => {
  const server = read('sync-server/server.mjs');
  const nginx = read('sync-server/nginx.conf.example');
  // req.url 含 ?key=<uuid>,任何直接打印它的日志都等于把读写凭据写进 journal
  assert.equal(/console\.log\([^)]*\$\{req\.url\}/.test(server), false, '后端不得整条打印 req.url');
  assert.ok(server.includes('function keyTag('), '应有 key 截断函数');
  assert.match(nginx, /^\s*access_log off;/m, 'nginx 必须关掉该 location 的 access_log');
});

test('1Panel systemd 与部署文档使用同一个 docker0 监听地址', () => {
  const service = read('sync-server/sync.service');
  const deploy = read('DEPLOY-SYNC.md');
  assert.match(service, /^Environment=HOST=172\.17\.0\.1$/m);
  assert.ok(deploy.includes('172.17.0.1:8787'));
  assert.equal(deploy.includes('systemd 跑后端在宿主 `127.0.0.1:8787`'), false);
});
