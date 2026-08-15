(function () {
  'use strict';

  // このファイルは「切り抜き機能」専用。既存の光球演出(js/main.js)には一切触れず、
  // 完成したPNG(Blob)を window.LFDItems.addBlobAsItem() 経由でアイテムとして登録するだけ。

  var settingsScreen = document.getElementById('settingsScreen');
  var openCropBtn = document.getElementById('openCropBtn');

  var cropEntryScreen = document.getElementById('cropEntryScreen');
  var cropEntryBackBtn = document.getElementById('cropEntryBackBtn');
  var cropAutoEntryBtn = document.getElementById('cropAutoEntryBtn');
  var cropManualEntryBtn = document.getElementById('cropManualEntryBtn');
  var cropAutoFileInput = document.getElementById('cropAutoFileInput');
  var cropManualFileInput = document.getElementById('cropManualFileInput');

  var cropAutoScreen = document.getElementById('cropAutoScreen');
  var cropAutoCanvas = document.getElementById('cropAutoCanvas');
  var cropAutoBackBtn = document.getElementById('cropAutoBackBtn');
  var cropAutoDoneBtn = document.getElementById('cropAutoDoneBtn');
  var cropToleranceSlider = document.getElementById('cropToleranceSlider');

  var cropManualScreen = document.getElementById('cropManualScreen');
  var cropManualCanvas = document.getElementById('cropManualCanvas');
  var cropManualBackBtn = document.getElementById('cropManualBackBtn');
  var cropManualDoneBtn = document.getElementById('cropManualDoneBtn');
  var cropModeToggle = document.getElementById('cropModeToggle');
  var cropZoomOutBtn = document.getElementById('cropZoomOutBtn');
  var cropZoomInBtn = document.getElementById('cropZoomInBtn');
  var cropZoomResetBtn = document.getElementById('cropZoomResetBtn');
  var cropUndoBtn = document.getElementById('cropUndoBtn');

  var SOURCE_MAX_SIDE = 1600;   // 取り込み時にここまで縮小(表示・保存に十分な解像度を保ちつつ動作を軽くする)
  var AUTO_WORK_MAX_SIDE = 480; // 自動切り抜き(境界フラッドフィル)の計算用の縮小サイズ

  // ==== 共通ユーティリティ ====

  // 選んだ写真を(必要なら)縮小してcanvasとして読み込む。以降このcanvasを画像ソースとして扱う。
  function loadFileAsCappedCanvas(file, maxSide) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
        var w = Math.max(1, Math.round(img.naturalWidth * scale));
        var h = Math.max(1, Math.round(img.naturalHeight * scale));
        var cv = document.createElement('canvas');
        cv.width = w;
        cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(cv);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('image load failed'));
      };
      img.src = url;
    });
  }

  // 実質的に透明でないピクセルのバウンディングボックスを求める(結果の余白トリミング用)
  function computeAlphaBoundingBox(canvas) {
    var w = canvas.width, h = canvas.height;
    var data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    var minX = w, minY = h, maxX = -1, maxY = -1;
    for (var y = 0; y < h; y++) {
      var rowBase = y * w;
      for (var x = 0; x < w; x++) {
        if (data[(rowBase + x) * 4 + 3] > 8) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  // 不透明部分の外側の余白を切り落とす(本番での表示サイズいっぱいにアイテムを使うため)
  function trimToOpaqueBounds(canvas, padding) {
    var box = computeAlphaBoundingBox(canvas);
    if (!box) return null;
    var pad = padding || 0;
    var x = Math.max(0, box.x - pad);
    var y = Math.max(0, box.y - pad);
    var w = Math.min(canvas.width, box.x + box.w + pad) - x;
    var h = Math.min(canvas.height, box.y + box.h + pad) - y;
    var out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    out.getContext('2d').drawImage(canvas, x, y, w, h, 0, 0, w, h);
    return out;
  }

  function setupCanvasDPR(canvas) {
    var dpr = Math.max(1, window.devicePixelRatio || 1);
    var cw = canvas.clientWidth, ch = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(cw * dpr));
    canvas.height = Math.max(1, Math.round(ch * dpr));
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  // マスク済みcanvasを余白トリミングし、アイテムとして登録して切り抜き画面を閉じる
  function finishCutout(canvas, name) {
    var trimmed = trimToOpaqueBounds(canvas, 6);
    if (!trimmed) {
      window.alert('切り抜く範囲が見つかりませんでした。範囲の選択(または識別範囲)を調整してください。');
      return;
    }
    trimmed.toBlob(function (blob) {
      if (!blob) {
        window.alert('切り抜き画像の生成に失敗しました');
        return;
      }
      window.LFDItems.addBlobAsItem(blob, name).then(function () {
        closeAllCropScreens();
      }).catch(function () {
        window.alert('アイテムへの追加に失敗しました');
      });
    }, 'image/png');
  }

  // ==== 画面遷移 ====
  function openCropEntry() {
    settingsScreen.classList.add('hidden');
    cropEntryScreen.classList.remove('hidden');
  }
  function closeAllCropScreens() {
    cropEntryScreen.classList.add('hidden');
    cropAutoScreen.classList.add('hidden');
    cropManualScreen.classList.add('hidden');
    teardownAuto();
    teardownManual();
    settingsScreen.classList.remove('hidden');
  }
  function backToCropEntryFromAuto() {
    cropAutoScreen.classList.add('hidden');
    teardownAuto();
    cropEntryScreen.classList.remove('hidden');
  }
  function backToCropEntryFromManual() {
    cropManualScreen.classList.add('hidden');
    teardownManual();
    cropEntryScreen.classList.remove('hidden');
  }

  openCropBtn.addEventListener('click', openCropEntry);
  cropEntryBackBtn.addEventListener('click', function () {
    cropEntryScreen.classList.add('hidden');
    settingsScreen.classList.remove('hidden');
  });

  cropAutoEntryBtn.addEventListener('click', function () {
    cropAutoFileInput.value = '';
    cropAutoFileInput.click();
  });
  cropManualEntryBtn.addEventListener('click', function () {
    cropManualFileInput.value = '';
    cropManualFileInput.click();
  });

  cropAutoFileInput.addEventListener('change', function () {
    var file = cropAutoFileInput.files && cropAutoFileInput.files[0];
    if (!file) return;
    loadFileAsCappedCanvas(file, SOURCE_MAX_SIDE).then(function (cv) {
      cropEntryScreen.classList.add('hidden');
      startAutoScreen(cv);
    }).catch(function () {
      window.alert('画像の読み込みに失敗しました');
    });
  });

  cropManualFileInput.addEventListener('change', function () {
    var file = cropManualFileInput.files && cropManualFileInput.files[0];
    if (!file) return;
    loadFileAsCappedCanvas(file, SOURCE_MAX_SIDE).then(function (cv) {
      cropEntryScreen.classList.add('hidden');
      startManualScreen(cv);
    }).catch(function () {
      window.alert('画像の読み込みに失敗しました');
    });
  });

  // ================= 自動切り抜き =================
  // 画像の外周(境界)から色の近い部分をたどって背景とみなす「境界フラッドフィル」方式。
  // タップ操作は不要で、写真を選んだ時点で自動的に実行される。識別範囲(許容誤差)はスライダーで調整可能。
  var autoSourceCanvas = null;
  var autoWorkCanvas = null;  // 判定用の縮小コピー
  var autoMaskCanvas = null;  // 縮小サイズのアルファマスク(白=残す/透明=切り抜く)
  var autoRunning = false;
  var autoRenderScheduled = false;

  function startAutoScreen(sourceCanvas) {
    autoSourceCanvas = sourceCanvas;
    autoWorkCanvas = document.createElement('canvas');
    var wScale = Math.min(1, AUTO_WORK_MAX_SIDE / Math.max(sourceCanvas.width, sourceCanvas.height));
    autoWorkCanvas.width = Math.max(1, Math.round(sourceCanvas.width * wScale));
    autoWorkCanvas.height = Math.max(1, Math.round(sourceCanvas.height * wScale));
    autoWorkCanvas.getContext('2d').drawImage(sourceCanvas, 0, 0, autoWorkCanvas.width, autoWorkCanvas.height);

    cropAutoScreen.classList.remove('hidden');
    autoRunning = true;
    requestAnimationFrame(function () {
      setupCanvasDPR(cropAutoCanvas);
      recomputeAutoMask();
      renderAutoPreview();
    });
  }

  function teardownAuto() {
    autoRunning = false;
    autoSourceCanvas = null;
    autoWorkCanvas = null;
    autoMaskCanvas = null;
  }

  function recomputeAutoMask() {
    if (!autoWorkCanvas) return;
    var tolerance = Number(cropToleranceSlider.value);
    autoMaskCanvas = buildBorderFloodFillMask(autoWorkCanvas, tolerance);
  }

  function buildBorderFloodFillMask(srcCanvas, tolerance) {
    var w = srcCanvas.width, h = srcCanvas.height;
    var data = srcCanvas.getContext('2d').getImageData(0, 0, w, h).data;
    var visited = new Uint8Array(w * h); // 0=未処理 1=背景確定 2=キュー投入済み
    var stack = [];
    var tol2 = tolerance * tolerance * 3;

    function tryPush(x, y) {
      var i = y * w + x;
      if (!visited[i]) {
        visited[i] = 2;
        stack.push(i);
      }
    }
    for (var x = 0; x < w; x++) { tryPush(x, 0); tryPush(x, h - 1); }
    for (var y = 0; y < h; y++) { tryPush(0, y); tryPush(w - 1, y); }

    while (stack.length) {
      var i = stack.pop();
      visited[i] = 1;
      var x0 = i % w, y0 = (i / w) | 0;
      var pr = data[i * 4], pg = data[i * 4 + 1], pb = data[i * 4 + 2];

      checkNeighbor(x0 > 0, x0 - 1, y0);
      checkNeighbor(x0 < w - 1, x0 + 1, y0);
      checkNeighbor(y0 > 0, x0, y0 - 1);
      checkNeighbor(y0 < h - 1, x0, y0 + 1);

      function checkNeighbor(inBounds, nx, ny) {
        if (!inBounds) return;
        var ni = ny * w + nx;
        if (visited[ni]) return;
        var dr = data[ni * 4] - pr, dg = data[ni * 4 + 1] - pg, db = data[ni * 4 + 2] - pb;
        if (dr * dr + dg * dg + db * db <= tol2) {
          visited[ni] = 2;
          stack.push(ni);
        }
      }
    }

    var maskCanvas = document.createElement('canvas');
    maskCanvas.width = w;
    maskCanvas.height = h;
    var maskCtx = maskCanvas.getContext('2d');
    var maskData = maskCtx.createImageData(w, h);
    var md = maskData.data;
    for (var p = 0; p < w * h; p++) {
      var a = visited[p] === 1 ? 0 : 255;
      md[p * 4] = 255; md[p * 4 + 1] = 255; md[p * 4 + 2] = 255; md[p * 4 + 3] = a;
    }
    maskCtx.putImageData(maskData, 0, 0);
    return maskCanvas;
  }

  function renderAutoPreview() {
    if (!autoRunning || !autoSourceCanvas) return;
    var ctx = cropAutoCanvas.getContext('2d');
    var cw = cropAutoCanvas.clientWidth, ch = cropAutoCanvas.clientHeight;
    ctx.clearRect(0, 0, cw, ch);

    var iw = autoSourceCanvas.width, ih = autoSourceCanvas.height;
    var scale = Math.min(cw / iw, ch / ih) * 0.95;
    var dx = (cw - iw * scale) / 2, dy = (ch - ih * scale) / 2;

    var off = document.createElement('canvas');
    off.width = iw; off.height = ih;
    var octx = off.getContext('2d');
    octx.drawImage(autoSourceCanvas, 0, 0);
    if (autoMaskCanvas) {
      octx.globalCompositeOperation = 'destination-in';
      octx.drawImage(autoMaskCanvas, 0, 0, iw, ih);
      octx.globalCompositeOperation = 'source-over';
    }
    ctx.drawImage(off, dx, dy, iw * scale, ih * scale);
  }

  function scheduleAutoUpdate() {
    if (autoRenderScheduled) return;
    autoRenderScheduled = true;
    requestAnimationFrame(function () {
      autoRenderScheduled = false;
      recomputeAutoMask();
      renderAutoPreview();
    });
  }

  cropToleranceSlider.addEventListener('input', scheduleAutoUpdate);
  cropAutoBackBtn.addEventListener('click', backToCropEntryFromAuto);

  cropAutoDoneBtn.addEventListener('click', function () {
    if (!autoSourceCanvas || !autoMaskCanvas) return;
    var iw = autoSourceCanvas.width, ih = autoSourceCanvas.height;
    var out = document.createElement('canvas');
    out.width = iw; out.height = ih;
    var octx = out.getContext('2d');
    octx.drawImage(autoSourceCanvas, 0, 0);
    octx.globalCompositeOperation = 'destination-in';
    octx.drawImage(autoMaskCanvas, 0, 0, iw, ih);
    finishCutout(out, 'cutout_auto.png');
  });

  // ================= 手動切り抜き =================
  // 1本指: 現在のモード(追加/除外)で範囲をなぞる。2本指: ピンチでズーム/移動。
  // なぞった座標は常に「画像上のピクセル座標」で記録するため、ズーム後に描いても位置がずれない。
  var manualSourceCanvas = null;
  var manualRunning = false;
  var manualMode = 'add'; // 'pan' | 'add' | 'subtract'
  var manualScale = 1, manualOffsetX = 0, manualOffsetY = 0;
  var manualViewInit = false;
  var manualStrokes = [];          // {mode:'add'|'subtract', pts:[{x,y}]} (画像ピクセル座標)
  var manualActiveStroke = null;
  var manualMaskCanvas = null;     // 画像と同解像度。白=保持/透明=切り抜き
  var manualMaskTintCanvas = null; // プレビュー用の着色版
  var manualPointers = {};         // pointerId -> {x,y}(client座標)
  var manualPointerOrder = [];
  var manualPanLast = null;
  var manualPinch = null;

  function startManualScreen(sourceCanvas) {
    manualSourceCanvas = sourceCanvas;
    manualStrokes = [];
    manualActiveStroke = null;
    manualMaskCanvas = null;
    manualMaskTintCanvas = null;
    manualViewInit = false;
    setManualMode('add');

    cropManualScreen.classList.remove('hidden');
    manualRunning = true;
    requestAnimationFrame(function () {
      setupCanvasDPR(cropManualCanvas);
      resetManualView();
      manualFrame();
    });
  }

  function teardownManual() {
    manualRunning = false;
    manualSourceCanvas = null;
    manualStrokes = [];
    manualActiveStroke = null;
    manualMaskCanvas = null;
    manualMaskTintCanvas = null;
    manualPointers = {};
    manualPointerOrder = [];
    manualPanLast = null;
    manualPinch = null;
  }

  function resetManualView() {
    if (!manualSourceCanvas) return;
    var cw = cropManualCanvas.clientWidth, ch = cropManualCanvas.clientHeight;
    var iw = manualSourceCanvas.width, ih = manualSourceCanvas.height;
    var fit = Math.min(cw / iw, ch / ih) * 0.95;
    manualScale = fit;
    manualOffsetX = (cw - iw * fit) / 2;
    manualOffsetY = (ch - ih * fit) / 2;
    manualViewInit = true;
  }

  function setManualMode(mode) {
    manualMode = mode;
    var btns = cropModeToggle.querySelectorAll('.cropModeToggleBtn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('selected', btns[i].dataset.mode === mode);
    }
  }
  cropModeToggle.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.cropModeToggleBtn') : null;
    if (!btn) return;
    setManualMode(btn.dataset.mode);
  });

  function clientToCanvasLocal(clientX, clientY) {
    var rect = cropManualCanvas.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }
  function canvasLocalToImage(lx, ly) {
    return { x: (lx - manualOffsetX) / manualScale, y: (ly - manualOffsetY) / manualScale };
  }
  function imageToCanvasLocal(ix, iy) {
    return { x: manualOffsetX + ix * manualScale, y: manualOffsetY + iy * manualScale };
  }

  function zoomAroundCanvasCenter(factor) {
    var cw = cropManualCanvas.clientWidth, ch = cropManualCanvas.clientHeight;
    var centerImg = canvasLocalToImage(cw / 2, ch / 2);
    manualScale = Math.max(0.2, Math.min(14, manualScale * factor));
    manualOffsetX = cw / 2 - centerImg.x * manualScale;
    manualOffsetY = ch / 2 - centerImg.y * manualScale;
  }
  cropZoomInBtn.addEventListener('click', function () { zoomAroundCanvasCenter(1.3); });
  cropZoomOutBtn.addEventListener('click', function () { zoomAroundCanvasCenter(1 / 1.3); });
  cropZoomResetBtn.addEventListener('click', resetManualView);
  cropUndoBtn.addEventListener('click', function () {
    manualStrokes = [];
    manualActiveStroke = null;
    rebuildManualMask();
  });

  cropManualBackBtn.addEventListener('click', backToCropEntryFromManual);

  cropManualDoneBtn.addEventListener('click', function () {
    if (!manualStrokes.some(function (s) { return s.mode === 'add'; })) {
      window.alert('切り抜きたい範囲を指でなぞって(追加モードで)選択してください');
      return;
    }
    if (!manualMaskCanvas) return;
    var iw = manualSourceCanvas.width, ih = manualSourceCanvas.height;
    var out = document.createElement('canvas');
    out.width = iw; out.height = ih;
    var octx = out.getContext('2d');
    octx.drawImage(manualSourceCanvas, 0, 0);
    octx.globalCompositeOperation = 'destination-in';
    octx.drawImage(manualMaskCanvas, 0, 0);
    finishCutout(out, 'cutout_manual.png');
  });

  function drawStrokePath(ctx2, pts) {
    ctx2.beginPath();
    ctx2.moveTo(pts[0].x, pts[0].y);
    for (var i = 1; i < pts.length; i++) ctx2.lineTo(pts[i].x, pts[i].y);
    ctx2.closePath();
  }

  function rebuildManualMask() {
    if (!manualSourceCanvas) return;
    var w = manualSourceCanvas.width, h = manualSourceCanvas.height;
    if (!manualMaskCanvas) {
      manualMaskCanvas = document.createElement('canvas');
      manualMaskCanvas.width = w;
      manualMaskCanvas.height = h;
    }
    var mctx = manualMaskCanvas.getContext('2d');
    mctx.clearRect(0, 0, w, h);
    mctx.fillStyle = '#fff';
    mctx.globalCompositeOperation = 'source-over';
    manualStrokes.forEach(function (s) {
      if (s.mode !== 'add' || s.pts.length < 3) return;
      drawStrokePath(mctx, s.pts);
      mctx.fill();
    });
    mctx.globalCompositeOperation = 'destination-out';
    manualStrokes.forEach(function (s) {
      if (s.mode !== 'subtract' || s.pts.length < 3) return;
      drawStrokePath(mctx, s.pts);
      mctx.fill();
    });
    mctx.globalCompositeOperation = 'source-over';

    if (!manualMaskTintCanvas) {
      manualMaskTintCanvas = document.createElement('canvas');
      manualMaskTintCanvas.width = w;
      manualMaskTintCanvas.height = h;
    }
    var tctx = manualMaskTintCanvas.getContext('2d');
    tctx.clearRect(0, 0, w, h);
    tctx.fillStyle = 'rgba(70,165,255,1)';
    tctx.fillRect(0, 0, w, h);
    tctx.globalCompositeOperation = 'destination-in';
    tctx.drawImage(manualMaskCanvas, 0, 0);
    tctx.globalCompositeOperation = 'source-over';
  }

  // ---- ポインター操作(1本指=描画/移動、2本指=ピンチズーム) ----
  function pointerCount() { return manualPointerOrder.length; }

  cropManualCanvas.addEventListener('pointerdown', function (e) {
    if (!manualRunning) return;
    cropManualCanvas.setPointerCapture(e.pointerId);
    manualPointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    manualPointerOrder.push(e.pointerId);

    if (pointerCount() === 1) {
      if (manualMode === 'pan') {
        manualPanLast = { x: e.clientX, y: e.clientY };
      } else {
        var lp = clientToCanvasLocal(e.clientX, e.clientY);
        var ip = canvasLocalToImage(lp.x, lp.y);
        manualActiveStroke = { mode: manualMode, pts: [ip] };
      }
    } else if (pointerCount() === 2) {
      manualActiveStroke = null; // 2本目が触れたら描画中のストロークは破棄してピンチへ切り替え
      manualPinch = beginPinch();
    }
  });

  cropManualCanvas.addEventListener('pointermove', function (e) {
    if (!manualPointers[e.pointerId]) return;
    manualPointers[e.pointerId] = { x: e.clientX, y: e.clientY };

    if (pointerCount() >= 2) {
      applyPinch();
    } else if (pointerCount() === 1) {
      if (manualMode === 'pan' && manualPanLast) {
        var dx = e.clientX - manualPanLast.x, dy = e.clientY - manualPanLast.y;
        manualOffsetX += dx; manualOffsetY += dy;
        manualPanLast = { x: e.clientX, y: e.clientY };
      } else if (manualActiveStroke) {
        var lp = clientToCanvasLocal(e.clientX, e.clientY);
        var ip = canvasLocalToImage(lp.x, lp.y);
        var pts = manualActiveStroke.pts;
        var last = pts[pts.length - 1];
        if (Math.hypot(ip.x - last.x, ip.y - last.y) > 0.6) pts.push(ip);
      }
    }
  });

  function endPointer(e) {
    delete manualPointers[e.pointerId];
    var idx = manualPointerOrder.indexOf(e.pointerId);
    if (idx !== -1) manualPointerOrder.splice(idx, 1);

    if (pointerCount() < 2) manualPinch = null;
    if (pointerCount() === 0) {
      if (manualActiveStroke && manualActiveStroke.pts.length >= 3) {
        manualStrokes.push(manualActiveStroke);
        rebuildManualMask();
      }
      manualActiveStroke = null;
      manualPanLast = null;
    }
  }
  cropManualCanvas.addEventListener('pointerup', endPointer);
  cropManualCanvas.addEventListener('pointercancel', endPointer);

  function activePointerPair() {
    var ids = manualPointerOrder.slice(0, 2);
    return [manualPointers[ids[0]], manualPointers[ids[1]]];
  }
  function beginPinch() {
    var pair = activePointerPair();
    var a = pair[0], b = pair[1];
    var d0 = Math.hypot(a.x - b.x, a.y - b.y);
    var midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
    var lp = clientToCanvasLocal(midX, midY);
    var ip = canvasLocalToImage(lp.x, lp.y);
    return { d0: Math.max(1, d0), scale0: manualScale, imgX: ip.x, imgY: ip.y };
  }
  function applyPinch() {
    if (!manualPinch) { manualPinch = beginPinch(); return; }
    var pair = activePointerPair();
    var a = pair[0], b = pair[1];
    var d1 = Math.hypot(a.x - b.x, a.y - b.y);
    var midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
    manualScale = Math.max(0.2, Math.min(14, manualPinch.scale0 * (d1 / manualPinch.d0)));
    var lp = clientToCanvasLocal(midX, midY);
    manualOffsetX = lp.x - manualPinch.imgX * manualScale;
    manualOffsetY = lp.y - manualPinch.imgY * manualScale;
  }

  function manualFrame() {
    if (!manualRunning) return;
    var ctx = cropManualCanvas.getContext('2d');
    var cw = cropManualCanvas.clientWidth, ch = cropManualCanvas.clientHeight;
    ctx.clearRect(0, 0, cw, ch);

    if (manualSourceCanvas) {
      ctx.save();
      ctx.translate(manualOffsetX, manualOffsetY);
      ctx.scale(manualScale, manualScale);
      ctx.drawImage(manualSourceCanvas, 0, 0);
      if (manualMaskTintCanvas) {
        ctx.globalAlpha = 0.45;
        ctx.drawImage(manualMaskTintCanvas, 0, 0);
        ctx.globalAlpha = 1;
      }
      ctx.restore();
    }

    if (manualActiveStroke && manualActiveStroke.pts.length > 1) {
      ctx.save();
      ctx.strokeStyle = manualActiveStroke.mode === 'subtract' ? 'rgba(255,90,90,0.95)' : 'rgba(90,190,255,0.95)';
      ctx.lineWidth = 2.5;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      var pts = manualActiveStroke.pts;
      var s0 = imageToCanvasLocal(pts[0].x, pts[0].y);
      ctx.moveTo(s0.x, s0.y);
      for (var i = 1; i < pts.length; i++) {
        var s = imageToCanvasLocal(pts[i].x, pts[i].y);
        ctx.lineTo(s.x, s.y);
      }
      ctx.stroke();
      ctx.restore();
    }

    requestAnimationFrame(manualFrame);
  }

  // ==== 画面リサイズ対応 ====
  window.addEventListener('resize', function () {
    if (autoRunning) {
      setupCanvasDPR(cropAutoCanvas);
      renderAutoPreview();
    }
    if (manualRunning) {
      setupCanvasDPR(cropManualCanvas);
      if (!manualViewInit) resetManualView();
    }
  });
})();
