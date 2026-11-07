/* Image Resizer — 純前端圖片尺寸調整工具 */
(() => {
  'use strict';

  const MAX_SIDE = 10000;
  const $ = (id) => document.getElementById(id);

  const el = {
    dropZone: $('dropZone'), fileInput: $('fileInput'), list: $('list'), status: $('status'),
    width: $('width'), height: $('height'), lockRatio: $('lockRatio'), swapBtn: $('swapBtn'),
    mode: $('mode'), anchor: $('anchor'), anchorField: $('anchorField'),
    bgColor: $('bgColor'), transparentBg: $('transparentBg'), bgField: $('bgField'),
    format: $('format'), quality: $('quality'), qualityValue: $('qualityValue'), qualityField: $('qualityField'),
    noUpscale: $('noUpscale'), presets: $('presets'),
    processBtn: $('processBtn'), zipBtn: $('zipBtn'), clearBtn: $('clearBtn'),
  };

  /** @type {{id:number,file:File,name:string,srcW:number,srcH:number,srcUrl:string,out?:Blob,outUrl?:string,outName?:string,outW?:number,outH?:number,error?:string,node:HTMLElement}[]} */
  let items = [];
  let nextId = 1;
  let lockedRatio = null;
  let busy = false;
  let dirtyDuringRun = false;

  /* ---------- 工具函式 ---------- */
  const formatBytes = (b) => {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / 1024 / 1024).toFixed(2)} MB`;
  };

  const clampInt = (v, fallback) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < 1) return fallback;
    return Math.min(n, MAX_SIDE);
  };

  const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const setStatus = (msg, isError = false) => {
    el.status.textContent = msg;
    el.status.style.color = isError ? 'var(--danger)' : '';
  };

  const getSettings = () => {
    const w = clampInt(el.width.value, 400);
    const h = clampInt(el.height.value, 500);
    el.width.value = w;
    el.height.value = h;
    return {
      w, h,
      mode: el.mode.value,
      anchor: el.anchor.value,
      bg: el.bgColor.value,
      transparent: el.transparentBg.checked,
      format: el.format.value,
      quality: Number(el.quality.value) / 100,
      noUpscale: el.noUpscale.checked,
    };
  };

  const resolveMime = (file, format) => {
    if (format !== 'original') return format;
    return ['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ? file.type : 'image/png';
  };

  const extOf = (mime) => ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[mime] || 'png');

  /* ---------- 讀取圖片（自動套用 EXIF 方向） ---------- */
  async function decodeImage(file) {
    if ('createImageBitmap' in window) {
      try {
        return await createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch (_) { /* 退回 <img> */ }
    }
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('無法讀取此圖片')); };
      img.src = url;
    });
  }

  const sizeOf = (img) => ({ w: img.naturalWidth || img.width, h: img.naturalHeight || img.height });

  /* ---------- 高品質縮小：逐步減半，避免鋸齒與摩爾紋 ---------- */
  function drawHQ(ctx, src, sx, sy, sw, sh, dx, dy, dw, dh) {
    let cur = src, cx = sx, cy = sy, cw = sw, ch = sh;
    while (cw / 2 >= dw && ch / 2 >= dh) {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.ceil(cw / 2));
      c.height = Math.max(1, Math.ceil(ch / 2));
      const cctx = c.getContext('2d');
      cctx.imageSmoothingEnabled = true;
      cctx.imageSmoothingQuality = 'high';
      cctx.drawImage(cur, cx, cy, cw, ch, 0, 0, c.width, c.height);
      cur = c; cx = 0; cy = 0; cw = c.width; ch = c.height;
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, cx, cy, cw, ch, dx, dy, dw, dh);
  }

  /* ---------- 核心：依模式計算並輸出 ---------- */
  async function resizeOne(item, s) {
    const img = await decodeImage(item.file);
    const { w: sw, h: sh } = sizeOf(img);
    const mime = resolveMime(item.file, s.format);
    const allowAlpha = s.transparent && mime !== 'image/jpeg';

    let canvasW = s.w, canvasH = s.h;
    let src = { x: 0, y: 0, w: sw, h: sh };
    let dst = { x: 0, y: 0, w: s.w, h: s.h };

    if (s.mode === 'stretch') {
      if (s.noUpscale) { canvasW = Math.min(s.w, sw); canvasH = Math.min(s.h, sh); }
      dst = { x: 0, y: 0, w: canvasW, h: canvasH };

    } else if (s.mode === 'cover') {
      let scale = Math.max(s.w / sw, s.h / sh);
      if (s.noUpscale && scale > 1) {
        scale = 1;
        canvasW = Math.min(s.w, sw);
        canvasH = Math.min(s.h, sh);
      }
      const cropW = canvasW / scale;
      const cropH = canvasH / scale;
      let cx = (sw - cropW) / 2;
      let cy = (sh - cropH) / 2;
      if (s.anchor === 'top') cy = 0;
      if (s.anchor === 'bottom') cy = sh - cropH;
      if (s.anchor === 'left') cx = 0;
      if (s.anchor === 'right') cx = sw - cropW;
      src = { x: cx, y: cy, w: cropW, h: cropH };
      dst = { x: 0, y: 0, w: canvasW, h: canvasH };

    } else { // contain
      let scale = Math.min(s.w / sw, s.h / sh);
      if (s.noUpscale && scale > 1) scale = 1;
      const dw = Math.max(1, Math.round(sw * scale));
      const dh = Math.max(1, Math.round(sh * scale));
      dst = { x: Math.round((s.w - dw) / 2), y: Math.round((s.h - dh) / 2), w: dw, h: dh };
    }

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(canvasW));
    canvas.height = Math.max(1, Math.round(canvasH));
    const ctx = canvas.getContext('2d', { alpha: allowAlpha });

    if (!allowAlpha) {
      ctx.fillStyle = s.bg;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    drawHQ(ctx, img, src.x, src.y, src.w, src.h, dst.x, dst.y, dst.w, dst.h);
    if (img.close) img.close();

    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('輸出失敗（尺寸可能過大）'))),
        mime,
        mime === 'image/png' ? undefined : s.quality,
      );
    });

    // 某些瀏覽器（如舊版 Safari）不支援 WebP 編碼，會退回 PNG
    const realMime = blob.type || mime;
    const base = item.name.replace(/\.[^.]+$/, '') || 'image';
    return {
      blob,
      w: canvas.width,
      h: canvas.height,
      name: `${base}_${canvas.width}x${canvas.height}.${extOf(realMime)}`,
      fellBack: realMime !== mime,
    };
  }

  /* ---------- 清單 UI ---------- */
  function renderItem(item) {
    const node = document.createElement('div');
    node.className = 'item';
    node.innerHTML = `
      <img class="thumb" alt="" src="${item.srcUrl}" />
      <div class="meta">
        <div class="name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
        <div class="info">原始：${item.srcW}×${item.srcH} · ${formatBytes(item.file.size)}</div>
        <div class="info result">尚未處理</div>
      </div>
      <div class="item-actions">
        <a class="download hidden" href="#">下載</a>
        <button type="button" class="remove">移除</button>
      </div>`;
    node.querySelector('.remove').addEventListener('click', () => removeItem(item.id));
    item.node = node;
    el.list.appendChild(node);
  }

  function updateItemView(item) {
    const result = item.node.querySelector('.result');
    const link = item.node.querySelector('.download');
    if (item.error) {
      result.innerHTML = `<span class="err">❌ ${escapeHtml(item.error)}</span>`;
      link.classList.add('hidden');
      return;
    }
    if (!item.out) {
      result.textContent = '尚未處理';
      link.classList.add('hidden');
      return;
    }
    const diff = item.out.size - item.file.size;
    const pct = item.file.size ? Math.round((diff / item.file.size) * 100) : 0;
    const sign = pct > 0 ? '+' : '';
    result.innerHTML = `<span class="ok">✔ ${item.outW}×${item.outH}</span> · ${formatBytes(item.out.size)}（${sign}${pct}%）`;
    item.node.querySelector('.thumb').src = item.outUrl;
    link.href = item.outUrl;
    link.download = item.outName;
    link.classList.remove('hidden');
  }

  function clearOutput(item) {
    if (item.outUrl) URL.revokeObjectURL(item.outUrl);
    item.out = item.outUrl = item.outName = undefined;
    item.error = undefined;
    if (item.node) item.node.querySelector('.thumb').src = item.srcUrl;
  }

  function removeItem(id) {
    const idx = items.findIndex((i) => i.id === id);
    if (idx === -1) return;
    const [item] = items.splice(idx, 1);
    clearOutput(item);
    URL.revokeObjectURL(item.srcUrl);
    item.node.remove();
    if (items.length === 0) lockedRatio = null;
    refreshButtons();
  }

  function refreshButtons() {
    el.processBtn.disabled = busy || items.length === 0;
    el.clearBtn.disabled = busy || items.length === 0;
    el.zipBtn.disabled = busy || !items.some((i) => i.out);
  }

  function markStale() {
    if (busy) { dirtyDuringRun = true; return; }
    let had = false;
    items.forEach((i) => { if (i.out || i.error) { had = true; clearOutput(i); updateItemView(i); } });
    if (had) setStatus('設定已變更，請重新按「開始調整」。');
    refreshButtons();
  }

  /* ---------- 加入檔案 ---------- */
  async function addFiles(fileList) {
    const files = [...fileList].filter((f) => f.type.startsWith('image/'));
    if (!files.length) { setStatus('沒有可用的圖片檔。', true); return; }
    const wasEmpty = items.length === 0;
    let added = 0;
    for (const file of files) {
      try {
        const img = await decodeImage(file);
        const { w, h } = sizeOf(img);
        if (img.close) img.close();
        const item = {
          id: nextId++, file,
          name: file.name || `pasted-${Date.now()}.png`,
          srcW: w, srcH: h,
          srcUrl: URL.createObjectURL(file),
        };
        items.push(item);
        renderItem(item);
        added++;
      } catch (e) {
        setStatus(`${file.name}：${e.message}`, true);
      }
    }
    if (added) {
      if (el.lockRatio.checked && (wasEmpty || lockedRatio === null)) { applyLockFromFirst(); syncFieldStates(); }
      setStatus(`已加入 ${added} 張圖片，共 ${items.length} 張。`);
    }
    refreshButtons();
  }

  /* ---------- 比例鎖定 ---------- */
  function applyLockFromFirst() {
    if (items.length) {
      lockedRatio = items[0].srcW / items[0].srcH;
    } else {
      lockedRatio = clampInt(el.width.value, 400) / clampInt(el.height.value, 500);
    }
    el.height.value = clampInt(Math.round(clampInt(el.width.value, 400) / lockedRatio), 1);
  }

  /* ---------- 批次處理 ---------- */
  async function processAll() {
    if (busy || !items.length) return;
    busy = true;
    dirtyDuringRun = false;
    refreshButtons();
    const s = getSettings();
    let ok = 0, fallback = false;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      setStatus(`處理中… ${i + 1} / ${items.length}`);
      clearOutput(item);
      try {
        const r = await resizeOne(item, s);
        item.out = r.blob;
        item.outUrl = URL.createObjectURL(r.blob);
        item.outName = r.name;
        item.outW = r.w;
        item.outH = r.h;
        if (r.fellBack) fallback = true;
        ok++;
      } catch (e) {
        item.error = e.message || '處理失敗';
      }
      updateItemView(item);
      await new Promise((r) => setTimeout(r, 0)); // 讓畫面有機會更新
    }
    busy = false;
    refreshButtons();
    if (dirtyDuringRun) { dirtyDuringRun = false; markStale(); return; }
    const failed = items.length - ok;
    setStatus(
      `完成 ${ok} 張${failed ? `，失敗 ${failed} 張` : ''}。` +
      (fallback ? '（此瀏覽器不支援 WebP 輸出，已改用 PNG）' : ''),
      failed > 0,
    );
  }

  async function downloadZip() {
    const done = items.filter((i) => i.out);
    if (!done.length) return;
    busy = true; refreshButtons();
    setStatus('打包 ZIP 中…');
    try {
      const used = new Map();
      const files = done.map((i) => {
        let name = i.outName;
        const n = used.get(name) || 0;
        used.set(name, n + 1);
        if (n) name = name.replace(/(\.[^.]+)$/, `(${n})$1`);
        return { name, blob: i.out };
      });
      const zip = await window.createZip(files);
      const s = getSettings();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(zip);
      a.download = `resized_${s.w}x${s.h}_${done.length}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      setStatus(`已下載 ZIP（${done.length} 張，${formatBytes(zip.size)}）。`);
    } catch (e) {
      setStatus(`ZIP 打包失敗：${e.message}`, true);
    }
    busy = false; refreshButtons();
  }

  /* ---------- 設定區 UI 連動 ---------- */
  function syncFieldStates() {
    const mode = el.mode.value;
    const fmt = el.format.value;
    el.anchorField.classList.toggle('disabled', mode !== 'cover');
    // JPG 不支援透明
    const jpgOnly = fmt === 'image/jpeg';
    el.transparentBg.disabled = jpgOnly;
    if (jpgOnly) el.transparentBg.checked = false;
    el.qualityField.classList.toggle('disabled', fmt === 'image/png');
    // 預設按鈕高亮
    const w = String(el.width.value), h = String(el.height.value);
    el.presets.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', b.dataset.w === w && b.dataset.h === h);
    });
  }

  el.presets.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    el.width.value = btn.dataset.w;
    el.height.value = btn.dataset.h;
    if (el.lockRatio.checked) { el.lockRatio.checked = false; lockedRatio = null; }
    syncFieldStates(); markStale();
  });

  el.width.addEventListener('input', () => {
    if (el.lockRatio.checked && lockedRatio && el.width.value) {
      el.height.value = clampInt(Math.round(Number(el.width.value) / lockedRatio), 1);
    }
    syncFieldStates(); markStale();
  });
  el.height.addEventListener('input', () => {
    if (el.lockRatio.checked && lockedRatio && el.height.value) {
      el.width.value = clampInt(Math.round(Number(el.height.value) * lockedRatio), 1);
    }
    syncFieldStates(); markStale();
  });
  [el.width, el.height].forEach((inp) => inp.addEventListener('change', () => { getSettings(); syncFieldStates(); }));

  el.lockRatio.addEventListener('change', () => {
    if (el.lockRatio.checked) applyLockFromFirst(); else lockedRatio = null;
    syncFieldStates(); markStale();
  });

  el.swapBtn.addEventListener('click', () => {
    const w = el.width.value;
    el.width.value = el.height.value;
    el.height.value = w;
    if (lockedRatio) lockedRatio = 1 / lockedRatio;
    syncFieldStates(); markStale();
  });

  el.quality.addEventListener('input', () => { el.qualityValue.textContent = el.quality.value; });
  [el.mode, el.anchor, el.bgColor, el.transparentBg, el.format, el.quality, el.noUpscale]
    .forEach((x) => x.addEventListener('change', () => { syncFieldStates(); markStale(); }));

  el.processBtn.addEventListener('click', processAll);
  el.zipBtn.addEventListener('click', downloadZip);
  el.clearBtn.addEventListener('click', () => {
    [...items].forEach((i) => removeItem(i.id));
    el.fileInput.value = '';
    setStatus('已清除。');
  });

  /* ---------- 上傳：點擊 / 鍵盤 / 拖曳 / 貼上 ---------- */
  el.dropZone.addEventListener('click', () => el.fileInput.click());
  el.dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.fileInput.click(); }
  });
  el.fileInput.addEventListener('change', () => {
    if (el.fileInput.files.length) addFiles(el.fileInput.files);
    el.fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach((ev) => el.dropZone.addEventListener(ev, (e) => {
    e.preventDefault(); el.dropZone.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach((ev) => el.dropZone.addEventListener(ev, (e) => {
    e.preventDefault(); el.dropZone.classList.remove('dragover');
  }));
  el.dropZone.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });
  // 避免拖到頁面其他地方時瀏覽器直接開啟圖片
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  document.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.items || [])]
      .filter((i) => i.kind === 'file' && i.type.startsWith('image/'))
      .map((i) => i.getAsFile())
      .filter(Boolean);
    if (files.length) addFiles(files);
  });

  syncFieldStates();
  refreshButtons();
})();
