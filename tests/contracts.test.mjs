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
  assert.ok(css.includes('@media (max-height: 700px) {\n  .coach { min-height: 186px; }\n  .coach-circle { width: 160px; height: 160px; }'));
});

test('1Panel systemd 与部署文档使用同一个 docker0 监听地址', () => {
  const service = read('sync-server/sync.service');
  const deploy = read('DEPLOY-SYNC.md');
  assert.match(service, /^Environment=HOST=172\.17\.0\.1$/m);
  assert.ok(deploy.includes('172.17.0.1:8787'));
  assert.equal(deploy.includes('systemd 跑后端在宿主 `127.0.0.1:8787`'), false);
});
