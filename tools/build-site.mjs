#!/usr/bin/env node
/**
 * tools/build-site.mjs — 组装部署目录(零依赖,确定性复制,不压缩不转换)
 *
 * 用法:node tools/build-site.mjs [--out dist]
 *
 * 产出结构(与 time-logger 的镜像布局一致):
 *   <out>/         ← site/ 落地页(根路径,SEO + 安装引导)
 *   <out>/app/     ← PWA 运行时,清单单一真源 = sw.js 的 PRECACHE_URLS
 *   <out>/.nojekyll
 *   <out>/CNAME    ← 仅当 site/CNAME 存在时(自定义域名切换开关,见 DEPLOY.md)
 *
 * 仓库红线:不新增产物目录 —— out 必须是 .gitignore 里的 dist/(或仓库外路径)。
 * 校验:PRECACHE_URLS 里任一文件缺失即报错退出,防止静默发坏包。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITE_DIR = join(ROOT, 'site');
const OUT = resolve(
  process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : join(ROOT, 'dist')
);

const SW = readFileSync(join(ROOT, 'sw.js'), 'utf8');
const match = SW.match(/const\s+PRECACHE_URLS\s*=\s*\[([\s\S]*?)\];/);
if (!match) {
  console.error('无法从 sw.js 解析 PRECACHE_URLS');
  process.exit(1);
}
const entries = [...match[1].matchAll(/'([^']+)'/g)]
  .map((m) => m[1])
  .filter((p) => p !== './');

if (!existsSync(SITE_DIR)) {
  console.error('缺少 site/ 落地页目录');
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'app'), { recursive: true });

for (const entry of entries) {
  const rel = entry.replace(/^\.\//, '');
  const src = join(ROOT, rel);
  const dst = join(OUT, 'app', rel);
  if (!existsSync(src)) {
    console.error(`预缓存清单里有文件缺失:${src}`);
    process.exit(1);
  }
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst);
}

// 落地页(含可选的 site/CNAME,有则切自定义域名;没有则 github.io 照常可用)
cpSync(SITE_DIR, OUT, { recursive: true });
writeFileSync(join(OUT, '.nojekyll'), '');

const cname = existsSync(join(OUT, 'CNAME')) ? readFileSync(join(OUT, 'CNAME'), 'utf8').trim() : '';
console.log(`组装完成 → ${OUT}`);
console.log(`  落地页:${OUT}/`);
console.log(`  应用:${OUT}/app/`);
console.log(cname ? `  自定义域名已启用:CNAME=${cname}` : '  未配置自定义域名(github.io 地址保持可用)');
