// shell-bridge.js —— 安卓壳（Capacitor APK）适配层。**纯浏览器 PWA 下完全惰性**，零行为变化。
//
// 为什么需要这一层：APK 把前端资源打包进本地（Capacitor webDir），页面 origin 变成
// http://localhost，而真正的 server 在用户电脑上（http://192.168.x.x:3000）。原前端
// 靠「同源」工作——io() 不传 URL 就连 location.origin，fetch('/health') 走相对路径——
// 在壳里全部指向 localhost，连不上电脑。本模块提供三件事：
//
//   1. getServerOrigin() —— 壳内返回用户配置的电脑地址，浏览器内返回 ''（保持同源语义）。
//      地址存在 localStorage（与项目既有的 token 存储同机制，不引额外依赖）。
//   2. socketTransportOptions() —— 壳内强制 transports:['websocket']。跨域时 socket.io
//      默认先用 HTTP polling 再升级，polling 受同源策略约束会被 CORS 拦死；而 WebSocket
//      握手**不受同源策略约束**（判据见 app/src/auth/origin-gate.js 头注），直连即通，
//      因此无需给后端加 CORS 放行。浏览器内返回 undefined，保持原有 polling+ws 升级策略。
//   3. isShell() —— 供壳内专属分支判定（如首屏配置页）。
//
// 【刻意不做的事：禁用 Service Worker 注册】Android WebView 无 Web Push（PushManager 与 SW 的
// push 事件被禁用），本以为要在壳内拦掉 notifications.js 的 `serviceWorker.register('/sw.js')`。
// 实测项目自带守卫已足够：environment() 判 `'PushManager' in window`（notifications.js:98）
// → pushEnvHint 返回 'unsupported'（logic/service-diag.js:44）→ setup() 提前 return
// （notifications.js:204-207），根本走不到注册那行。故此处不加冗余分支——多一道守卫等于多一处
// 与项目原有判据漂移的风险。
//
// 判定「是否在壳内」：Capacitor 注入 window.Capacitor.isNativePlatform()。用可选链 + try
// 兜底，浏览器内 window.Capacitor 为 undefined 时安静返回 false，不抛错。
//
// ★ 首屏配置页：壳内若还没存过 server 地址，getServerOrigin() 返回 ''，此时 app.js 会连
//   localhost 而失败。故壳内提供 ensureServerAddress()——地址缺失时渲染一个中文配置页
//   （纯 DOM，不依赖 tailwind/app.css，保证首屏必可用），填完存起来再放行主应用。

const STORAGE_KEY = 'ccm_server_origin';

// 是否在原生壳内运行（浏览器 PWA 恒为 false）
export function isShell() {
  try {
    return typeof window !== 'undefined'
      && !!window.Capacitor
      && typeof window.Capacitor.isNativePlatform === 'function'
      && window.Capacitor.isNativePlatform() === true;
  } catch { return false; }
}

// 归一化用户输入的地址：补协议、去尾部斜杠、去路径。
// 只接受 http/https 的「协议+主机+可选端口」，其余（含带路径的）一律拒绝——
// 带路径的地址会让 socket.io 与相对 fetch 拼出错位 URL，且失败症状是「一直转圈」，极难排查。
export function normalizeServerAddress(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, error: '请填写电脑上的服务地址' };
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  let u;
  try { u = new URL(withScheme); } catch { return { ok: false, error: '地址格式不对，示例：192.168.1.4:3000' }; }
  if (!u.hostname) return { ok: false, error: '地址里缺少主机名或 IP' };
  // 去掉路径/query/hash，只留 origin
  const origin = u.origin; // 形如 http://192.168.1.4:3000
  if (origin === 'null') return { ok: false, error: '地址格式不对，示例：192.168.1.4:3000' };
  return { ok: true, origin };
}

// 读取已保存的 server origin。浏览器内返回 ''（调用方据此走同源）。
export function getServerOrigin() {
  if (!isShell()) return '';
  try { return localStorage.getItem(STORAGE_KEY) || ''; } catch { return ''; }
}

// socket.io 的第一个参数：壳内是电脑 server 的 origin，浏览器内**必须是 undefined，不能是空串**。
//
// ★ 这里踩过一次真 bug：socket.io-client 的 lookup(uri, opts) 只在 `typeof uri === 'object'` 时
//   把第一个参数当 opts 丢弃，字符串会继续走 url(uri)。而 url() 的同源兜底判据是 `null == uri`
//   —— 空串不满足它，于是被当成主机名拼成 `http://` 再 parse，结果是
//   `source: 'http://'` / `id: 'http://:80/socket.io'`，PWA 模式整个连不上（实测确认）。
//   故浏览器内一律返回 undefined，让 socket.io 走它自己的 loc.protocol + '//' + loc.host 兜底。
export function socketUri() {
  const origin = getServerOrigin();
  return origin || undefined;
}

export function saveServerOrigin(origin) {
  try { localStorage.setItem(STORAGE_KEY, origin); } catch { /* 存不下也不崩，下次再问 */ }
}

// socket.io 连接选项：壳内强制 websocket（绕开跨域 polling 的 CORS 拦截），浏览器内返回 undefined
export function socketTransportOptions() {
  return isShell() ? { transports: ['websocket'] } : undefined;
}

// 把前端原本写成相对路径的请求 URL（'/health'、'/push/subscribe?...'）转成壳内可打的绝对 URL。
//
// 为什么 CapacitorHttp 不够：它自动 patch fetch/XHR 走原生层，**解决了跨域**，但不改 URL 解析——
// 相对路径仍按页面 origin 解析，而壳内 origin 是 http://localhost，于是请求打在 APK 自己身上
// （404）。故必须在调用点显式拼上 server origin。
//
// 浏览器内返回原值（相对路径按同源解析，语义完全不变），所以这几处改造对 PWA 零影响。
//
// 只处理以单个 '/' 开头的相对路径；已是绝对 URL（http/https/协议相对）原样返回，
// 避免把外部地址错拼到 server origin 上。
export function apiUrl(path) {
  const p = String(path ?? '');
  if (!p.startsWith('/') || p.startsWith('//')) return p;
  const base = getServerOrigin();
  return base ? `${base}${p}` : p;
}

// 壳内首屏：没有 server 地址时渲染中文配置页，填完存好再 resolve。
// 浏览器内直接 resolve（无需配置）。返回 Promise 以便 app 启动流程 await。
//
// 刻意用内联样式而非 tailwind/app.css：这个页面出现在主应用之前，此时若 CSS 尚未加载完，
// 用户会看到一个错位到无法使用的表单——而「填不进去地址」等于整个 APK 不可用。
export function ensureServerAddress(doc = document) {
  if (!isShell()) return Promise.resolve(true);
  if (getServerOrigin()) return Promise.resolve(true);

  return new Promise(resolve => {
    const overlay = doc.createElement('div');
    overlay.id = 'ccm-shell-setup';
    overlay.setAttribute('style', [
      'position:fixed', 'inset:0', 'z-index:2147483647',
      'background:#F4F3EE', 'color:#1F1E1B',
      'display:flex', 'flex-direction:column', 'align-items:center', 'justify-content:center',
      'padding:24px', 'font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif',
      'box-sizing:border-box',
    ].join(';'));
    overlay.innerHTML = `
      <div style="width:100%;max-width:420px;text-align:center">
        <div style="font-size:20px;font-weight:600;margin-bottom:8px">claude chat mobile richkobe</div>
        <div style="font-size:14px;line-height:1.6;margin-bottom:24px;opacity:.75">
          填写你电脑上正在运行的服务地址。<br>
          在电脑终端启动后，日志里「可访问」那一行就是它。
        </div>
        <input id="ccm-shell-addr" type="url" inputmode="url" autocapitalize="off" autocorrect="off"
               placeholder="例如 192.168.1.4:3000"
               style="width:100%;box-sizing:border-box;padding:14px;font-size:16px;border:1px solid #C9C6BC;border-radius:10px;background:#fff;color:#1F1E1B;margin-bottom:12px">
        <div id="ccm-shell-err" style="min-height:20px;font-size:13px;color:#B4232A;margin-bottom:8px"></div>
        <button id="ccm-shell-go" type="button"
                style="width:100%;padding:14px;font-size:16px;font-weight:600;border:0;border-radius:10px;background:#1F1E1B;color:#fff;cursor:pointer">
          连接
        </button>
        <div style="font-size:12px;line-height:1.7;margin-top:20px;opacity:.6;text-align:left">
          提示：手机和电脑需在同一 Wi-Fi。地址改了随时可在设置里重填（长按此处也可）。<br>
          电脑上服务未启动时，连接会失败——请先在电脑跑 npm start。
        </div>
      </div>`;
    doc.body.appendChild(overlay);

    const input = overlay.querySelector('#ccm-shell-addr');
    const err = overlay.querySelector('#ccm-shell-err');
    const go = overlay.querySelector('#ccm-shell-go');

    // 长按标题区重填（已存过地址后再次进入的入口由 app 内设置页承担，这里是兜底）
    const submit = () => {
      const r = normalizeServerAddress(input.value);
      if (!r.ok) { err.textContent = r.error; input.focus(); return; }
      saveServerOrigin(r.origin);
      err.textContent = '';
      overlay.remove();
      resolve(true);
    };
    go.addEventListener('click', submit);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    setTimeout(() => input.focus(), 50);
  });
}
