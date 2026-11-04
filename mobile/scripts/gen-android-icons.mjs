// mobile/scripts/gen-android-icons.mjs —— 从 app/public/icons/icon.svg 派生 Android launcher 全套图标。
//
// 【为什么需要它】此前 mipmap/ 下的 PNG 是 10-29 手工放的旧图（上游 #D97757 底），APK 图标与
// M3 砖橙视觉割裂；且 adaptive icon 的 background 是纯白 @color，与砖橙前景不搭。
// 本脚本把图标变成「源 SVG 一处改、全密度重生成」，与 scripts/gen-icons.js（PWA 位图）同模式。
//
// 产物（均提交进仓库）：
//   mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_launcher.png        48/72/96/144/192
//   mipmap-*/ic_launcher_round.png                                 同尺寸圆形裁切
//   mipmap-*/ic_launcher_foreground.png                            432dp adaptive 前景层
//   values/ic_launcher_background.xml                              背景色 = M3 primary #9B442B
//
// adaptive foreground 规范：432×432 画布、内容收在中心 66%（直径 285px）safe zone 内——
// 启动器会裁圆形/圆角方形/水滴形，超出 safe zone 的图形会被切掉。
// 源 SVG 的主图形半径约 197px（512 画布），scale 0.66 后 = 130px < 142.5px safe 半径。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const SRC = join(REPO, 'app', 'public', 'icons', 'icon.svg');
const RES = join(REPO, 'mobile', 'android', 'app', 'src', 'main', 'res');

const DENSITIES = [
  ['mdpi', 48],
  ['hdpi', 72],
  ['xhdpi', 96],
  ['xxhdpi', 144],
  ['xxxhdpi', 192],
];
const FG_SIZE = 432;

const srcSvg = readFileSync(SRC, 'utf8');

// 主图形层 = 去掉背景 rect 与 <title>/<desc>（foreground 层必须透明底）
function extractMark(svg) {
  return svg
    .replace(/<\?xml[^>]*\?>/i, '')
    .replace(/<title[\s\S]*?<\/title>/i, '')
    .replace(/<desc[\s\S]*?<\/desc>/i, '')
    .replace(/<svg[^>]*>/i, '')
    .replace(/<\/svg>\s*$/i, '')
    .replace(/<rect\b[^>]*width="512"[^>]*height="512"[^>]*\/?>/i, '')
    .trim();
}
const mark = extractMark(srcSvg);
if (!/<use|circle|path/i.test(mark)) {
  console.error('icon.svg 解析主图形失败——需保留 defs/use/circle/path 结构');
  process.exit(1);
}

const foregroundSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${FG_SIZE} ${FG_SIZE}">
  <g transform="translate(${FG_SIZE / 2} ${FG_SIZE / 2}) scale(0.66) translate(-256 -256)">${mark}</g>
</svg>`;

// 把源 SVG 的 512 viewBox 内容缩放到目标尺寸（保留背景 rect 与渐变）
const legacyInner = srcSvg
  .replace(/<\?xml[^>]*\?>/i, '')
  .replace(/<title[\s\S]*?<\/title>/i, '')
  .replace(/<desc[\s\S]*?<\/desc>/i, '')
  .replace(/<svg\b[^>]*>/i, '')
  .replace(/<\/svg>\s*$/i, '')
  .trim();
const legacySvg = size => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}">${legacyInner}</svg>`;
// 圆形变体：源背景是 rx=112 圆角矩形，直接套圆形 clip 会在四角留下透明楔形
// （圆角矩形的角比圆 clip 收得更狠）。故圆形版用满幅无圆角背景。
const roundInner = legacyInner.replace(/(<rect\b[^>]*?)rx="112"/i, '$1');
const roundSvg = size => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}">
  <defs><clipPath id="rc"><circle cx="256" cy="256" r="256"/></clipPath></defs>
  <g clip-path="url(#rc)">${roundInner}</g>
</svg>`;

// adaptive 背景层（2026-11-04 修「图标穿帮」）：此前背景是纯色 @color，而前景层只有白色火花
// （渐变球体在背景 rect 里、被 extractMark 剥掉）→ 桌面图标 = 纯色块 + 小白花，与 PWA 渐变球不一致。
// 现在背景层 = 满幅渐变 rect（无圆角：启动器自己裁形状），前景 = 火花，两层合成即完整球体。
// defs 必须带上：rect 的 fill=url(#orb) 指向 defs 里的 radialGradient，只截 rect 会渲染成黑块。
const bgDefs = legacyInner.match(/<defs[\s\S]*?<\/defs>/i)?.[0] || '';
const bgRect = legacyInner.match(/<rect\b[^>]*\/>/i)?.[0] || '';
if (!bgDefs || !bgRect) {
  console.error('icon.svg 背景层解析失败——需要 defs(radialGradient) 与背景 rect');
  process.exit(1);
}
const backgroundSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${FG_SIZE}" height="${FG_SIZE}">${bgDefs}${bgRect.replace('rx="112"', '')}</svg>`;

async function renderPng(browser, svg, size, outPath) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;line-height:0;background:transparent">${svg}</body></html>`,
    { waitUntil: 'load' },
  );
  const buf = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: size, height: size }, omitBackground: true });
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, buf);
  await page.close();
  console.log(`✔ ${outPath.replace(REPO + '/', '')} (${size}×${size}, ${buf.length}B)`);
}

const browser = await chromium.launch({ headless: true });
try {
  for (const [name, size] of DENSITIES) {
    const dir = join(RES, `mipmap-${name}`);
    await renderPng(browser, legacySvg(size), size, join(dir, 'ic_launcher.png'));
    await renderPng(browser, roundSvg(size), size, join(dir, 'ic_launcher_round.png'));
    await renderPng(browser, foregroundSvg, FG_SIZE, join(dir, 'ic_launcher_foreground.png'));
    await renderPng(browser, backgroundSvg, FG_SIZE, join(dir, 'ic_launcher_background.png'));
  }
  // adaptive 背景 = 渐变球体位图（见上方 backgroundSvg 注释）；values 里的纯色仅作 API <26 回落引用不到时的兜底。
  writeFileSync(
    join(RES, 'values', 'ic_launcher_background.xml'),
    `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#9B442B</color>\n</resources>\n`,
  );
  console.log('✔ values/ic_launcher_background.xml -> #9B442B');
} finally {
  await browser.close();
}
console.log('✅ Android launcher 图标生成完成（5 密度 × 3 图 + adaptive 背景色）');
