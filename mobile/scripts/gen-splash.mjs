// mobile/scripts/gen-splash.mjs —— 从 app/public/icons/icon.svg 派生 Android 启动屏全套 splash.png。
//
// 【为什么需要它】res/drawable*/splash.png 是 Capacitor 脚手架默认图（蓝斜杠 logo，
// 10-29 随壳提交后从未更新），而启动 activity 主题 AppTheme.NoActionBarLaunch
// （styles.xml）直接引用 @drawable/splash —— 每次开 App 先闪一帧框架默认品牌，
// 即用户报的「应用内图标穿帮」之一。本脚本把启动屏换成 M3 canvas 底 + 居中渐变球，
// 与桌面图标/PWA 图标同一视觉源（icon.svg 一处改、全密度重生成）。
//
// 产物（均提交进仓库，尺寸沿用 Capacitor 默认桶，只换内容）：
//   drawable/splash.png                      480x320（回落）
//   drawable-{land,port}-{mdpi..xxxhdpi}/splash.png   10 个密度桶
//
// 背景色取 M3 light canvas #FEF1ED（app.css 的 --canvas），与 capacitor.config.json
// 的 android.backgroundColor 同值 —— WebView 加载前露出的窗口底色与启动屏无缝。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const SRC = join(REPO, 'app', 'public', 'icons', 'icon.svg');
const RES = join(REPO, 'mobile', 'android', 'app', 'src', 'main', 'res');

const CANVAS = '#FEF1ED';
// 球体直径 = 短边 40%：太小显空旷、太大压迫，与 Capacitor 默认 logo 占比同量级。
const MARK_RATIO = 0.4;

// [目录, 宽, 高] —— drawable/ 是 Capacitor 的无方向回落桶，尺寸同 land-mdpi。
const BUCKETS = [
  ['drawable', 480, 320],
  ['drawable-land-mdpi', 480, 320],
  ['drawable-land-hdpi', 800, 480],
  ['drawable-land-xhdpi', 1280, 720],
  ['drawable-land-xxhdpi', 1600, 960],
  ['drawable-land-xxxhdpi', 1920, 1280],
  ['drawable-port-mdpi', 320, 480],
  ['drawable-port-hdpi', 480, 800],
  ['drawable-port-xhdpi', 720, 1280],
  ['drawable-port-xxhdpi', 960, 1600],
  ['drawable-port-xxxhdpi', 1280, 1920],
];

const srcSvg = readFileSync(SRC, 'utf8');

// 完整图标内容（含渐变球背景 rect）——splash 要的是「整个 App 图标」居中，不是裸火花。
// 教训同 adaptive 背景层：球体就是那个 fill=url(#orb) 的背景 rect，剥掉它就只剩
// 白色火花，在浅色 canvas 底上几乎不可见（2026-11-04 首版就踩了）。
const inner = srcSvg
  .replace(/<\?xml[^>]*\?>/i, '')
  .replace(/<title[\s\S]*?<\/title>/i, '')
  .replace(/<desc[\s\S]*?<\/desc>/i, '')
  .replace(/<svg[^>]*>/i, '')
  .replace(/<\/svg>\s*$/i, '')
  .trim();
if (!/<rect|<use|circle|path/i.test(inner)) {
  console.error('icon.svg 解析失败——需保留 defs/rect/use/circle/path 结构');
  process.exit(1);
}

function splashSvg(w, h) {
  const s = Math.round(Math.min(w, h) * MARK_RATIO);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
  <rect width="${w}" height="${h}" fill="${CANVAS}"/>
  <g transform="translate(${w / 2} ${h / 2}) scale(${s / 512}) translate(-256 -256)">${inner}</g>
</svg>`;
}

async function renderPng(browser, svg, w, h, outPath) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;line-height:0">${svg}</body></html>`,
    { waitUntil: 'load' },
  );
  const buf = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: w, height: h } });
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, buf);
  await page.close();
  console.log(`✔ ${outPath.replace(REPO + '/', '')} (${w}×${h}, ${buf.length}B)`);
}

const browser = await chromium.launch({ headless: true });
try {
  for (const [dir, w, h] of BUCKETS) {
    await renderPng(browser, splashSvg(w, h), w, h, join(RES, dir, 'splash.png'));
  }
} finally {
  await browser.close();
}
console.log('✔ splash 全套生成完毕（M3 canvas 底 + 居中渐变球）');
