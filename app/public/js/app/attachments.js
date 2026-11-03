import { attachmentDataUrl, formatAttachmentChipLabel, guessImageMime, pickPasteImageFiles } from '../logic/attachments.js';
import { t } from '../i18n.js';

const MAX_FILE = 10 * 1024 * 1024;
const MAX_TOTAL = 20 * 1024 * 1024;
const MAX_COUNT = 10;
// 与后端 uploads.js 的 MAX_THUMB_CHARS 对齐（single-source-of-truth.test.mjs 钉住相等）。
// 边界差一是有意的：这里 < ，服务端是 > ——恰好 MAX_THUMB 个字符时前端丢缩略图、服务端放行，
// 方向安全（前端少发一份缩略图不影响功能，服务端拒绝一条完整消息才是真正要避免的）。
const MAX_THUMB = 100_000;

export function createAttachmentController(context, options = {}) {
  const {
    autoBind = true,
    addBar = () => {},
    createElement = null,
    haptic = () => {},
    onChange = () => {},
    scheduleInsetResettle = () => {},
    // 附件 sheet 的开合原语：与 approval-questions.js 同款以「值」注入，模块自己不认识任何具体 sheet。
    // 不注入时退化成 no-op（单测可只验 addFiles/payload 而不必拉起 DOM 弹层）。
    openSheet = () => {},
    closeSheet = () => {},
    // 返回 false 则拒绝添加（如 CLI 驾驶只读）；可在回调内自行 addBar 说明。
    canAdd = () => true,
  } = options;
  const dom = context.dom;
  const deps = context.dependencies;
  let pending = [];

  function items() { return pending.slice(); }

  function payload() {
    return pending.map(({ _id, ...rest }) => rest);
  }

  function notifyChange() {
    render();
    onChange(items());
  }

  function ensureId(item) {
    if (!item || typeof item !== 'object') return item;
    if (item._id) return item;
    const now = (deps.now || Date.now)();
    const random = (deps.random || Math.random)();
    return {
      ...item,
      _id: `${now}-${random.toString(36).slice(2)}`,
    };
  }

  function setItems(next) {
    // payload()/发送失败回灌可能无 _id；补齐后 ✕ 才能按 id 移除（否则 undefined!==undefined 永 false）
    pending = Array.isArray(next) ? next.map(ensureId) : [];
    notifyChange();
  }

  function remove(id) {
    if (id == null) return false;
    const before = pending.length;
    pending = pending.filter(item => item._id !== id);
    if (pending.length === before) return false;
    notifyChange();
    return true;
  }

  function clear() {
    pending = [];
    notifyChange();
  }

  function readBase64(file) {
    const FileReaderCtor = deps.FileReader || globalThis.FileReader;
    return new Promise((resolve, reject) => {
      const reader = new FileReaderCtor();
      reader.onload = () => {
        const value = String(reader.result);
        const comma = value.indexOf(',');
        resolve(comma >= 0 ? value.slice(comma + 1) : value);
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  // 缩略图中间态也必须是 data: URL。CSP img-src 只许 'self' data:——createObjectURL 产出的
  // blob: 会被拦，Image.onerror → thumb=null，选图后气泡没预览却不报错（真机 console 可见 CSP）。
  // 与下方 stored preview / 灯箱同一契约：FileReader.readAsDataURL，不引入 blob:。
  function makeThumb(file) {
    return new Promise(resolve => {
      if (!file.type?.startsWith('image/')) return resolve(null);
      const FileReaderCtor = deps.FileReader || globalThis.FileReader;
      const ImageCtor = deps.Image || globalThis.Image;
      const doc = deps.document || globalThis.document;
      const reader = new FileReaderCtor();
      reader.onerror = () => resolve(null);
      reader.onload = () => {
        const dataUrl = String(reader.result || '');
        if (!dataUrl.startsWith('data:')) return resolve(null);
        const image = new ImageCtor();
        image.onload = () => {
          let width = image.width;
          let height = image.height;
          const max = 320;
          if (width > height && width > max) {
            height = Math.round(height * max / width);
            width = max;
          } else if (height >= width && height > max) {
            width = Math.round(width * max / height);
            height = max;
          }
          const canvas = doc.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          canvas.getContext('2d').drawImage(image, 0, 0, width, height);
          let output = null;
          try { output = canvas.toDataURL('image/jpeg', 0.6); } catch { /* optional preview */ }
          resolve(output);
        };
        image.onerror = () => resolve(null);
        image.src = dataUrl;
      };
      reader.readAsDataURL(file);
    });
  }

  async function addFiles(files) {
    if (canAdd() === false) return;
    const list = Array.isArray(files) ? files : [...(files || [])];
    for (const file of list) {
      if (!file) continue;
      if (pending.length >= MAX_COUNT) {
        addBar(`${t('附件数量已达上限（')}${MAX_COUNT}）`, 'text-danger');
        break;
      }
      if (file.size > MAX_FILE) {
        addBar(`「${file.name || t('附件')}」${t('超过 10MB，未添加')}`, 'text-danger');
        continue;
      }
      const total = pending.reduce((sum, attachment) => sum + attachment.size, 0);
      if (total + file.size > MAX_TOTAL) {
        addBar(t('附件总量将超过 20MB，未添加'), 'text-danger');
        break;
      }
      try {
        const [data, thumb] = await Promise.all([readBase64(file), makeThumb(file)]);
        const now = (deps.now || Date.now)();
        const random = (deps.random || Math.random)();
        const name = file.name?.trim()
          || `paste-${now}.${(file.type || '').split('/')[1] || 'png'}`;
        pending.push({
          _id: `${now}-${random.toString(36).slice(2)}`,
          name,
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          data,
          thumb: thumb && thumb.length < MAX_THUMB ? thumb : undefined,
        });
        notifyChange();
      } catch {
        addBar(`「${file.name || t('附件')}」${t('读取失败')}`, 'text-danger');
      }
    }
  }

  function closePreview() {
    if (!dom.attachPreviewModal) return;
    dom.attachPreviewModal.classList.add('hidden');
    dom.attachPreviewImg?.removeAttribute('src');
  }

  // E18：灯箱底层入口——接受现成 dataURL（发送前托盘的 attachmentDataUrl、气泡按需拉取的 loader 共用）
  function openPreviewUrl(name, url) {
    if (!dom.attachPreviewModal || !dom.attachPreviewImg || !url) return;
    dom.attachPreviewImg.src = url;
    if (dom.attachPreviewName) dom.attachPreviewName.textContent = name || '';
    dom.attachPreviewModal.classList.remove('hidden');
    haptic('tap');
  }

  function openPreview(attachment) {
    const url = attachmentDataUrl(attachment);
    if (!url) {
      addBar(attachment?.name ? `「${attachment.name}」${t('不是可预览图片')}` : t('该附件不可预览'), 'text-ink-faint');
      return;
    }
    openPreviewUrl(attachment.name, url);
  }

  function render() {
    const tray = dom.attachTray;
    if (!tray || !createElement) return;
    tray.innerHTML = '';
    if (!pending.length) {
      tray.classList.add('hidden');
      return;
    }
    // UX-020：同名序号 + 可选大小；优先缩略图
    const nameCount = new Map();
    for (const attachment of pending) {
      const base = attachment.name || t('附件');
      nameCount.set(base, (nameCount.get(base) || 0) + 1);
      attachment._nameOcc = nameCount.get(base);
    }
    for (const attachment of pending) {
      // 勿给 chip 挂 hit-44：其 ::after 叠在子节点之上，会吞掉内部 ✕ 的点击（手机点叉叉无效）。
      // 热区扩到 ✕ 按钮自身 + z-10，保证盖住 chip 点击预览。
      const chip = createElement('<div class="relative flex items-center gap-1.5 bg-sunk rounded-lg pl-1.5 pr-7 py-1 text-xs max-w-[12rem] cursor-pointer active:scale-[0.98] transition-transform" title="点击预览"></div>');
      if (attachment.thumb) {
        const image = createElement('<img class="w-8 h-8 rounded object-cover shrink-0">');
        image.src = attachment.thumb;
        chip.appendChild(image);
      } else {
        chip.appendChild(createElement('<span class="shrink-0">📎</span>'));
      }
      const name = createElement('<span class="truncate"></span>');
      name.textContent = formatAttachmentChipLabel(attachment.name, attachment._nameOcc, attachment.size);
      chip.appendChild(name);
      const removeBtn = createElement('<button type="button" class="absolute right-0 top-1/2 -translate-y-1/2 z-10 hit-44 w-7 h-7 flex items-center justify-center text-ink-faint active:text-danger" title="移除" aria-label="移除附件">✕</button>');
      removeBtn.onclick = event => {
        event.preventDefault();
        event.stopPropagation();
        remove(attachment._id);
      };
      chip.onclick = () => openPreview(attachment);
      chip.appendChild(removeBtn);
      tray.appendChild(chip);
    }
    tray.classList.remove('hidden');
  }

  function bind() {
    const doc = deps.document || globalThis.document;

    // 三个隐藏 input 共用的收口：清空 value（否则连选同一文件不触发 change）、
    // 关键盘重排、走同一套 addFiles（限额 / 缩略图 / 托盘 / canAdd 闸全部共用）。
    const wireInput = (input) => {
      if (!input) return;
      input.onchange = async () => {
        const files = [...input.files];
        input.value = '';
        scheduleInsetResettle();
        await addFiles(files);
      };
    };
    wireInput(dom.fileInput);
    wireInput(dom.imageInput);
    wireInput(dom.cameraInput);

    // 桌面选图钮：一键直达图片选择器，不绕 sheet。
    // 与附件钮并存是有意的——附件钮给「完整三项菜单」，这颗给桌面高频场景「就想发张图」省一次点击。
    // 可见性由 app.css 的 (hover:hover)+(pointer:fine) 媒体查询判，手机端恒隐藏。
    if (dom.btnImage && dom.imageInput) {
      dom.btnImage.onclick = () => {
        if (canAdd() === false) return;
        dom.imageInput.click();
      };
    }

    // 附件钮 → 打开 M3 来源选择 sheet（拍照 / 相册 / 上传文件）。
    // 桌面端点附件钮也走 sheet：三项里「拍照」按能力隐藏（无后置摄像头），剩相册与上传文件——
    // 与手机同一套交互，不必为两端各记一种行为。
    if (dom.btnAttach && dom.attachModal) {
      dom.btnAttach.onclick = () => {
        if (canAdd() === false) return;
        syncCameraAvailability();
        openSheet(dom.attachModal);
      };
    }
    // sheet 三项 + 取消：选完立即关 sheet 再开系统选择器。
    // 顺序不能反——文件选择器会把页面切到后台，先开选择器再关 sheet 时，回来会看到 sheet 还挂着。
    const pickAndClose = (input) => () => {
      closeSheet(dom.attachModal);
      if (canAdd() === false) return;
      input?.click();
    };
    if (dom.attachOptCamera) dom.attachOptCamera.onclick = pickAndClose(dom.cameraInput);
    if (dom.attachOptPhoto) dom.attachOptPhoto.onclick = pickAndClose(dom.imageInput);
    if (dom.attachOptFile) dom.attachOptFile.onclick = pickAndClose(dom.fileInput);
    if (dom.attachOptCancel) dom.attachOptCancel.onclick = () => closeSheet(dom.attachModal);
    // 点遮罩关闭：只认遮罩本身，sheet 容器上的点击不关（否则点子元素冒泡会误关）
    if (dom.attachModal) {
      dom.attachModal.onclick = event => {
        if (event.target === dom.attachModal) closeSheet(dom.attachModal);
      };
    }

    // 「拍照」项按设备能力显隐：桌面就不摆这一项（没有手持相机语义，点了只会弹文件浏览器）。
    //
    // 判据用 `(hover:hover) and (pointer:fine)` 取反，与 app.css 里控制 #btnImage 显隐的那条
    // **完全同一个媒体查询**。两处判据必须同源：一处说「这是桌面」、另一处说「这是手机」的话，
    // 会出现桌面既有选图快捷钮、又在 sheet 里摆着「拍照」这种自相矛盾的组合。
    //
    // 【为什么不用 navigator.maxTouchPoints 兜底】实测 Windows headless Chromium 桌面下
    // maxTouchPoints = 10（系统上报触屏能力），而 matchMedia('(pointer:coarse)') 为 false。
    // 用 `coarse || maxTouchPoints>0` 会把桌面误判成有相机，「拍照」项在电脑上凭空出现。
    // 探测异常时按「没有相机」处理：摆一个点了不拍照的按钮比不摆更糟（不做假按钮）。
    function syncCameraAvailability() {
      const opt = dom.attachOptCamera;
      if (!opt) return;
      // 默认按「桌面」处理（隐藏拍照项）：探测不到能力时宁可少摆一项，
      // 也不要摆一个点了不拍照的按钮——后者更糟（不做假按钮）。
      let isDesktop = true;
      try {
        const mm = deps.matchMedia;
        if (typeof mm === 'function') {
          isDesktop = mm('(hover: hover) and (pointer: fine)').matches === true;
        }
      } catch { /* 探测异常：保留上面的默认值（按桌面隐藏） */ }
      opt.classList.toggle('hidden', isDesktop);
    }

    dom.input?.addEventListener('paste', event => {
      const images = pickPasteImageFiles(event.clipboardData);
      if (!images.length) return;
      event.preventDefault();
      void addFiles(images);
    });
    if (dom.attachPreviewClose) {
      dom.attachPreviewClose.onclick = event => {
        event.stopPropagation();
        closePreview();
      };
    }
    if (dom.attachPreviewModal) {
      dom.attachPreviewModal.onclick = event => {
        if (event.target === dom.attachPreviewModal || event.target === dom.attachPreviewName) closePreview();
      };
    }
    doc?.addEventListener('keydown', event => {
      if (event.key === 'Escape' && dom.attachPreviewModal && !dom.attachPreviewModal.classList.contains('hidden')) {
        closePreview();
      }
    });
  }

  if (autoBind) bind();
  return { addFiles, clear, closePreview, items, openPreview, openPreviewUrl, payload, remove, render, setItems };
}

// ── E18 附件按需预览 loader ──────────────────────────────────────────────────────
// 气泡（live user_message / 历史 chip）点击附件 → attachment:read base64 分页拉原图字节（专用通道，
// 仍走鉴权+设备门；256KB 小片不阻塞弱网下的 live 事件流）→ Uint8Array 按 offset 拼装 →
// Blob → FileReader.readAsDataURL（CSP img-src data: 已允许，不引入 blob: URL）→ 灯箱 openPreviewUrl。
// 失败降级：文件被删/越界/超时 → toast；meta 里有 thumb（live 路径）则退回放大缩略图。
const PREVIEW_CHUNK_BYTES = 256 * 1024;      // 与服务端 MAX_BROWSE_BYTES 硬顶对齐
const PREVIEW_MAX_BYTES = 10 * 1024 * 1024;  // 与上传单文件上限对齐（正常上传的附件不会超）
const PREVIEW_CACHE_MAX = 5;                 // dataURL LRU：手机内存友好，重复点击秒开
const PREVIEW_CONCURRENCY = 3;               // 分片并发上限：快于串行、又不挤占 socket
const PREVIEW_CHUNK_TIMEOUT_MS = 20000;

export function createStoredPreviewLoader(context, options = {}) {
  const {
    addBar = () => {},
    openPreviewUrl = () => {},
    chunkBytes = PREVIEW_CHUNK_BYTES,
    maxTotalBytes = PREVIEW_MAX_BYTES,
    concurrency = PREVIEW_CONCURRENCY,
    cacheMax = PREVIEW_CACHE_MAX,
  } = options;
  const deps = context.dependencies;
  const cache = new Map(); // `${cwd}\0${storedName}` → dataURL（Map 插入序当 LRU：命中重插尾部）
  const inflight = new Set();

  // 只传 storedName（裸文件名），不再自己拼 `.ccm-uploads/<name>` 相对路径：附件已搬到 dataDir，
  // 目录由服务端按 cwd 算（新家优先、旧对话回落老位置），前端无从、也不需要表达任意路径。
  function readChunk(cwd, storedName, offset) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; reject(new Error(t('读取超时'))); }
      }, PREVIEW_CHUNK_TIMEOUT_MS);
      context.socket?.emit('attachment:read', { cwd, storedName, offset, maxBytes: chunkBytes }, res => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!res?.ok) return reject(new Error(res?.error || t('读取失败')));
        resolve(res);
      });
    });
  }

  function base64ToBytes(b64) {
    const atobFn = deps.atob || globalThis.atob;
    const bin = atobFn(String(b64 || ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function blobToDataUrl(blob) {
    const FileReaderCtor = deps.FileReader || globalThis.FileReader;
    return new Promise((resolve, reject) => {
      const reader = new FileReaderCtor();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error || new Error(t('附件读取失败')));
      reader.readAsDataURL(blob);
    });
  }

  async function open({ cwd, storedName, name, mimeType, thumb } = {}) {
    const label = name || storedName || t('附件');
    // 只预览图片：meta 带 image/* 直接用；历史路径无 mimeType 按文件名扩展名猜
    const mime = (typeof mimeType === 'string' && mimeType.startsWith('image/'))
      ? mimeType
      : guessImageMime(name || storedName);
    if (!mime) {
      addBar(`「${label}」${t('不是可预览图片')}`, 'text-ink-faint');
      return;
    }
    // storedName 只能是裸文件名（服务端 scope guard 兜底，这里先挡明显异常，省一次往返）
    if (typeof storedName !== 'string' || !storedName || /[/\\]/.test(storedName) || storedName.startsWith('.')) {
      addBar(t('该附件不可预览'), 'text-ink-faint');
      return;
    }
    const key = `${cwd || ''}\u0000${storedName}`;
    const hit = cache.get(key);
    if (hit) {
      cache.delete(key);
      cache.set(key, hit);
      openPreviewUrl(label, hit);
      return;
    }
    if (inflight.has(key)) return; // 同一附件正在拉取：忽略重复点击
    inflight.add(key);
    try {
      const first = await readChunk(cwd, storedName, 0);
      const totalSize = first.totalSize;
      if (!Number.isFinite(totalSize) || totalSize <= 0) throw new Error(t('附件为空'));
      if (totalSize > maxTotalBytes) {
        addBar(`「${label}」${t('过大（')}${(totalSize / 1048576).toFixed(1)}${t('MB），不支持预览')}`, 'text-danger');
        return;
      }
      const bytes = new Uint8Array(totalSize);
      const firstChunk = base64ToBytes(first.content);
      bytes.set(firstChunk, 0);
      let received = firstChunk.length;
      // 剩余片：固定 offset 网格 + 小并发池；按 offset 落位，完成顺序无关
      const offsets = [];
      for (let off = firstChunk.length; off < totalSize && firstChunk.length > 0; off += chunkBytes) offsets.push(off);
      let next = 0;
      const worker = async () => {
        while (next < offsets.length) {
          const off = offsets[next++];
          const res = await readChunk(cwd, storedName, off);
          const chunk = base64ToBytes(res.content);
          bytes.set(chunk, off);
          received += chunk.length;
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, offsets.length) }, worker));
      if (received !== totalSize) throw new Error(t('读取不完整（文件可能正被改写）'));
      const BlobCtor = deps.Blob || globalThis.Blob;
      const dataUrl = await blobToDataUrl(new BlobCtor([bytes], { type: mime }));
      cache.set(key, dataUrl);
      if (cache.size > cacheMax) cache.delete(cache.keys().next().value);
      openPreviewUrl(label, dataUrl);
    } catch (err) {
      addBar(`「${label}」${t('预览加载失败：')}${err?.message || err}`, 'text-danger');
      if (thumb) openPreviewUrl(label, thumb); // 降级：放大缩略图（live meta 才有；历史无 thumb 仅 toast）
    } finally {
      inflight.delete(key);
    }
  }

  return { open };
}
