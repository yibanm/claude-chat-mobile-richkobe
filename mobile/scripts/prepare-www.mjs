#!/usr/bin/env node
// prepare-www.mjs —— 把 PWA 前端产物准备成 Capacitor 的 webDir（mobile/www/）。
//
// 为什么不是简单拷贝 app/public：有一样东西在浏览器里由 **server 运行时端点**提供、磁盘上不存在——
// `/socket.io/socket.io.js`（index.html:47 引用；`app/public/socket.io/` 目录并不存在，实测
// `curl :3001/socket.io/socket.io.js` 得 200 / 153KB）。打进 APK 后没有 server，这个文件必须
// 从 socket.io 自带的 client-dist 补进去，否则 socket.io-client 加载失败、整个 App 连不上。
//
// 同理要处理的另两件事：
//   · index.html 由 server 动态改写（http.js 的 injectCfAccessFlag 改 data-cf-access、
//     rewriteIndexAssetUrls 给 /js /css /vendor 打 ?v= 版本戳）。APK 内无 server，故：
//     data-cf-access 保持静态壳自带的 "0"（局域网/自托管拓扑正是这个值，语义正确）；
//     版本戳不加——APK 资源随包更新、不存在浏览器长缓存陈旧问题，加了反而要同步维护。
//   · CSP 是 server 响应头（http.js:28），不写进 HTML，故 APK 内不受其约束，无需改动。
//
// 刻意不做的事：不复制 sw.js 之外的任何服务端逻辑、不改 index.html 内容。壳与 server 的唯一
// 契约是「同一份 app/public 静态资源」，改 index.html 会让两边行为分叉且难以察觉。

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));     // mobile/scripts
const MOBILE = dirname(HERE);                              // mobile/
const REPO = dirname(MOBILE);                              // 项目根
const PUBLIC = join(REPO, 'app', 'public');                // PWA 前端源
const WWW = join(MOBILE, 'www');                           // Capacitor webDir

// mobile/node_modules 里没有 socket.io（它只是壳工程的依赖），故用 createRequire 从项目根解析。
const requireFromRepo = createRequire(join(REPO, 'package.json'));

function fail(msg) {
  console.error(`✘ ${msg}`);
  process.exit(1);
}

// ── 1. 前置检查 ────────────────────────────────────────────────
if (!existsSync(PUBLIC) || !statSync(PUBLIC).isDirectory()) {
  fail(`找不到前端源目录：${PUBLIC}`);
}
if (!existsSync(join(PUBLIC, 'index.html'))) {
  fail(`${PUBLIC}/index.html 不存在——前端结构与预期不符，别硬打包`);
}

// socket.io client-dist 的确切路径。
//
// ★ 不能用 require.resolve('socket.io/client-dist/socket.io.js')：socket.io 的 package.json
//   exports 只暴露 '.' 与 './package.json' 两个入口，子路径解析会被 Node 的 exports 封装直接
//   拒绝（ERR_PACKAGE_PATH_NOT_EXPORTED），实测报「无法解析」。但 './package.json' 是放行的，
//   故以它为跳板定位包根、再自己拼 client-dist 路径——这样包被提升/嵌套到任意层级都成立。
let socketIoClientJs;
try {
  const pkgJsonPath = requireFromRepo.resolve('socket.io/package.json');
  socketIoClientJs = join(dirname(pkgJsonPath), 'client-dist', 'socket.io.js');
} catch {
  fail('无法解析 socket.io 包位置——项目根的 node_modules 里没装 socket.io？先 npm ci');
}
if (!existsSync(socketIoClientJs)) fail(`socket.io client-dist 不存在：${socketIoClientJs}`);

// ── 2. 清空并复制 app/public → mobile/www ──────────────────────
// 整目录删除而非逐个清理：www/ 是纯生成物（.gitignore 掉），残留旧文件会让「删了某前端文件
// 却在 APK 里还活着」这类幽灵问题无从排查。
if (existsSync(WWW)) rmSync(WWW, { recursive: true, force: true });
mkdirSync(WWW, { recursive: true });
cpSync(PUBLIC, WWW, { recursive: true });

// ── 3. 补 server 运行时端点才有的 socket.io.js ─────────────────
// index.html 引用的是 /socket.io/socket.io.js（绝对路径 → www/socket.io/socket.io.js）。
const socketIoDir = join(WWW, 'socket.io');
mkdirSync(socketIoDir, { recursive: true });
// client-dist 下还有 .map 与 min 变体；index.html 只引用 socket.io.js，故只补这一个文件，
// 少拷无用体积（APK 体积敏感）。若日后 index.html 改引 min 版，这里会因缺文件而在运行时 404，
// 由下面的引用自检兜住。
cpSync(socketIoClientJs, join(socketIoDir, 'socket.io.js'));

// ── 4. 引用自检：index.html 里每个本地绝对路径都必须在 www 里存在 ──
// 这道自检挡的正是上面那类「server 有、磁盘没有」的漏网之鱼。此前只针对 socket.io.js 手工
// 处理，一旦前端新增别的运行时端点引用，症状是 APK 白屏且无报错——故改成全量扫描。
const html = readFileSync(join(WWW, 'index.html'), 'utf8');
const referenced = new Set();
// src="/..." 与 href="/..."；跳过 //（协议相对外链）与 http(s)://（绝对外链）
for (const m of html.matchAll(/(?:src|href)="(\/[^"]+)"/g)) {
  const p = m[1];
  if (p.startsWith('//')) continue;
  referenced.add(p.split('?')[0].split('#')[0]);   // 去掉 query/hash
}
const missing = [...referenced].filter(p => {
  const local = join(WWW, p.replace(/^\//, ''));
  return !existsSync(local);
});
if (missing.length) {
  fail(`index.html 引用了 ${missing.length} 个 APK 内不存在的本地资源（server 运行时端点？需在上方补拷）：\n${missing.map(p => `  - ${p}`).join('\n')}`);
}

// ── 5. 产出摘要 ────────────────────────────────────────────────
let fileCount = 0;
let totalBytes = 0;
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else { fileCount += 1; totalBytes += statSync(full).size; }
  }
})(WWW);

console.log(`✓ www 已生成：${WWW}`);
console.log(`  文件 ${fileCount} 个，合计 ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
console.log(`  补入 socket.io.js（${(statSync(join(socketIoDir, 'socket.io.js')).size / 1024).toFixed(0)} KB，来自 ${socketIoClientJs.replace(REPO, '<repo>')}）`);
console.log(`  index.html 引用自检：${referenced.size} 条本地路径全部命中`);
