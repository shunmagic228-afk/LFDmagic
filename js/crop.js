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
  var cropSliderRow = document.getElementById('cropSliderRow');
  var cropAutoStatus = document.getElementById('cropAutoStatus');

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
  var AUTO_WORK_MAX_SIDE = 640; // 自動切り抜き(フォールバックの境界フラッドフィル)の計算用の縮小サイズ

  // ==== AIによる自動切り抜き(端末上で完結。写真をどこにも送信しない) ====
  // U^2-Netp(軽量版)をONNX Runtime Web上で動かし、被写体を認識して背景を判定する。
  // 出典: U^2-Net (Qin et al., Apache License 2.0) / モデル配布元 rembg (MIT License)。
  // ライブラリ・モデル本体はこのアプリの起動時には一切読み込まず、「切り抜き」→「自動切り抜き」を
  // 実際に開いた時にだけ読み込む(本番で使う光球演出の起動の軽さには影響しない)。
  var ORT_JS_URL = 'js/vendor/ort.min.js';
  var ORT_WASM_DIR = 'js/vendor/';
  var AI_MODEL_URL = 'models/u2netp.onnx';
  var AI_INPUT_SIZE = 320;
  var AI_INPUT_NAME = 'input.1';
  var AI_MEAN = [0.485, 0.456, 0.406];
  var AI_STD = [0.229, 0.224, 0.225];

  var ortLoadPromise = null;
  var aiSessionPromise = null;

  function loadOrtLibrary() {
    if (window.ort) return Promise.resolve(window.ort);
    if (ortLoadPromise) return ortLoadPromise;
    ortLoadPromise = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = ORT_JS_URL;
      script.onload = function () {
        if (window.ort) resolve(window.ort);
        else reject(new Error('ort not found after load'));
      };
      script.onerror = function () { reject(new Error('failed to load ort.min.js')); };
      document.head.appendChild(script);
    });
    return ortLoadPromise;
  }

  function loadAiSession() {
    if (aiSessionPromise) return aiSessionPromise;
    aiSessionPromise = loadOrtLibrary().then(function (ort) {
      ort.env.wasm.wasmPaths = new URL(ORT_WASM_DIR, document.baseURI).href;
      return ort.InferenceSession.create(AI_MODEL_URL, { executionProviders: ['wasm'] });
    });
    return aiSessionPromise;
  }

  // sourceCanvas(切り抜き対象の写真)からAIモデル用の入力テンソルを作る。
  // rembgのU^2-Net前処理と同じ手順: 320x320にリサイズ→ (画素値/画像内の最大値) →
  // チャンネルごとに正規化 → CHW配列化。
  function buildAiInputTensor(ort, sourceCanvas) {
    var size = AI_INPUT_SIZE;
    var off = document.createElement('canvas');
    off.width = size;
    off.height = size;
    var octx = off.getContext('2d');
    octx.drawImage(sourceCanvas, 0, 0, size, size);
    var data = octx.getImageData(0, 0, size, size).data;

    var maxVal = 1;
    var n = size * size;
    for (var p = 0; p < n; p++) {
      var idx = p * 4;
      if (data[idx] > maxVal) maxVal = data[idx];
      if (data[idx + 1] > maxVal) maxVal = data[idx + 1];
      if (data[idx + 2] > maxVal) maxVal = data[idx + 2];
    }

    var chw = new Float32Array(3 * n);
    for (var i = 0; i < n; i++) {
      var di = i * 4;
      chw[i] = ((data[di] / maxVal) - AI_MEAN[0]) / AI_STD[0];
      chw[n + i] = ((data[di + 1] / maxVal) - AI_MEAN[1]) / AI_STD[1];
      chw[2 * n + i] = ((data[di + 2] / maxVal) - AI_MEAN[2]) / AI_STD[2];
    }
    return new ort.Tensor('float32', chw, [1, 3, size, size]);
  }

  // モデルの出力(320x320・値の範囲は不定)を0-1に正規化し、指定した解像度のアルファマスクcanvasにする。
  function aiOutputToMaskCanvas(outputTensor, targetW, targetH) {
    var size = AI_INPUT_SIZE;
    var src = outputTensor.data;
    var n = size * size;
    var mn = Infinity, mx = -Infinity;
    for (var i = 0; i < n; i++) {
      var v = src[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    var range = Math.max(1e-6, mx - mn);

    var small = document.createElement('canvas');
    small.width = size;
    small.height = size;
    var sctx = small.getContext('2d');
    var imgData = sctx.createImageData(size, size);
    var d = imgData.data;
    for (var p = 0; p < n; p++) {
      var norm = (src[p] - mn) / range;
      if (norm < 0) norm = 0; else if (norm > 1) norm = 1;
      var di = p * 4;
      d[di] = 255; d[di + 1] = 255; d[di + 2] = 255; d[di + 3] = Math.round(norm * 255);
    }
    sctx.putImageData(imgData, 0, 0);

    var out = document.createElement('canvas');
    out.width = targetW;
    out.height = targetH;
    out.getContext('2d').drawImage(small, 0, 0, targetW, targetH);
    return out;
  }

  // AIで被写体マスクを作る。処理中の状態(準備中/解析中)をコールバックで知らせる。
  function runAiAutoMask(sourceCanvas, targetW, targetH, onStatus) {
    var needsInit = !aiSessionPromise;
    if (onStatus) onStatus(needsInit ? 'AIを準備中…\n(初回のみ数秒〜十数秒かかります)' : 'AIで解析中…');
    var ortLib;
    return loadOrtLibrary().then(function (ort) {
      ortLib = ort;
      return loadAiSession();
    }).then(function (session) {
      if (onStatus) onStatus('AIで解析中…');
      var input = buildAiInputTensor(ortLib, sourceCanvas);
      var feeds = {};
      feeds[AI_INPUT_NAME] = input;
      return session.run(feeds).then(function (results) {
        var outputTensor = results[session.outputNames[0]];
        return aiOutputToMaskCanvas(outputTensor, targetW, targetH);
      });
    });
  }

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
  // 第一候補: AIによる被写体認識(runAiAutoMask、端末上で完結)。
  // AIが使えない場合(読み込み失敗・非対応ブラウザ等)だけ、画像の外周から色をたどる
  // 「境界フラッドフィル」方式にフォールバックする(この場合のみ識別範囲スライダーを表示)。
  var autoSourceCanvas = null;
  var autoWorkCanvas = null;   // フォールバック判定用の縮小コピー
  var autoMaskCanvas = null;   // アルファマスク(白=残す/透明=切り抜く。解像度は問わずプレビュー時に伸縮する)
  var autoRunning = false;
  var autoRenderScheduled = false;
  var autoEngine = null; // 'ai' | 'classical'

  function setAutoStatus(text) {
    if (!text) {
      cropAutoStatus.classList.add('hidden');
      cropAutoStatus.textContent = '';
    } else {
      cropAutoStatus.textContent = text;
      cropAutoStatus.classList.remove('hidden');
    }
  }

  function startAutoScreen(sourceCanvas) {
    autoSourceCanvas = sourceCanvas;
    autoMaskCanvas = null;
    autoEngine = null;
    cropSliderRow.classList.add('hidden');
    cropAutoDoneBtn.disabled = true;

    cropAutoScreen.classList.remove('hidden');
    autoRunning = true;
    requestAnimationFrame(function () {
      setupCanvasDPR(cropAutoCanvas);
      renderAutoPreview();
    });

    var maskW = Math.max(1, Math.round(sourceCanvas.width * Math.min(1, AUTO_WORK_MAX_SIDE / Math.max(sourceCanvas.width, sourceCanvas.height))));
    var maskH = Math.max(1, Math.round(sourceCanvas.height * Math.min(1, AUTO_WORK_MAX_SIDE / Math.max(sourceCanvas.width, sourceCanvas.height))));

    runAiAutoMask(sourceCanvas, maskW, maskH, setAutoStatus).then(function (maskCanvas) {
      if (!autoRunning || autoSourceCanvas !== sourceCanvas) return; // 待っている間に画面を離れた/やり直した場合は捨てる
      autoEngine = 'ai';
      autoMaskCanvas = maskCanvas;
      setAutoStatus(null);
      cropAutoDoneBtn.disabled = false;
      renderAutoPreview();
    }).catch(function (err) {
      if (!autoRunning || autoSourceCanvas !== sourceCanvas) return;
      // AIが使えない環境(読み込み失敗・WebAssembly非対応など)は、これまでの色ベース方式へ自動的に切り替える
      autoEngine = 'classical';
      setupClassicalWorkCanvas(sourceCanvas);
      cropSliderRow.classList.remove('hidden');
      recomputeAutoMask();
      setAutoStatus(null);
      cropAutoDoneBtn.disabled = false;
      renderAutoPreview();
    });
  }

  function setupClassicalWorkCanvas(sourceCanvas) {
    autoWorkCanvas = document.createElement('canvas');
    var wScale = Math.min(1, AUTO_WORK_MAX_SIDE / Math.max(sourceCanvas.width, sourceCanvas.height));
    autoWorkCanvas.width = Math.max(1, Math.round(sourceCanvas.width * wScale));
    autoWorkCanvas.height = Math.max(1, Math.round(sourceCanvas.height * wScale));
    var wctx = autoWorkCanvas.getContext('2d');
    wctx.drawImage(sourceCanvas, 0, 0, autoWorkCanvas.width, autoWorkCanvas.height);

    // 実写真は圧縮ノイズや反射で隣接ピクセルの色が細かくジャンプしやすく、それが下の
    // 境界フラッドフィルの「連鎖」を途中で断ち切ってノイズの孤立点を生む原因になる。
    // ぼかし(blur)は物体内部の均一な色と背景をなだらかに繋いでしまい、塗りつぶしが
    // 物体の中まで漏れ出す事故につながるため使わない。代わりに「メディアンフィルタ」で、
    // 本物の境界(急な色の変化)は保ったまま、孤立したノイズ画素だけを取り除く(1回だけ実行)。
    var wImageData = wctx.getImageData(0, 0, autoWorkCanvas.width, autoWorkCanvas.height);
    var denoised = medianFilter3x3(wImageData.data, autoWorkCanvas.width, autoWorkCanvas.height);
    wctx.putImageData(new ImageData(denoised, autoWorkCanvas.width, autoWorkCanvas.height), 0, 0);
  }

  function teardownAuto() {
    autoRunning = false;
    autoSourceCanvas = null;
    autoWorkCanvas = null;
    autoMaskCanvas = null;
    autoEngine = null;
    setAutoStatus(null);
    cropSliderRow.classList.add('hidden');
    cropAutoDoneBtn.disabled = false;
  }

  // 3x3のメディアン(中央値)フィルタ。平均化(ぼかし)と違って本物の境界を鈍らせずに、
  // 周囲から浮いた1ピクセル単位のノイズだけを取り除ける(エッジ保存型のノイズ除去)。
  function medianFilter3x3(data, w, h) {
    var out = new Uint8ClampedArray(data.length);
    var wr = new Uint8Array(9), wg = new Uint8Array(9), wb = new Uint8Array(9);

    function insertionSort9(arr, n) {
      for (var i = 1; i < n; i++) {
        var v = arr[i], j = i - 1;
        while (j >= 0 && arr[j] > v) { arr[j + 1] = arr[j]; j--; }
        arr[j + 1] = v;
      }
    }

    for (var y = 0; y < h; y++) {
      var y0 = y > 0 ? y - 1 : 0, y1 = y < h - 1 ? y + 1 : h - 1;
      for (var x = 0; x < w; x++) {
        var x0 = x > 0 ? x - 1 : 0, x1 = x < w - 1 ? x + 1 : w - 1;
        var n = 0;
        for (var ny = y0; ny <= y1; ny++) {
          var rowBase = ny * w;
          for (var nx = x0; nx <= x1; nx++) {
            var idx = (rowBase + nx) * 4;
            wr[n] = data[idx]; wg[n] = data[idx + 1]; wb[n] = data[idx + 2];
            n++;
          }
        }
        insertionSort9(wr, n);
        insertionSort9(wg, n);
        insertionSort9(wb, n);
        var mid = n >> 1;
        var oi = (y * w + x) * 4;
        out[oi] = wr[mid];
        out[oi + 1] = wg[mid];
        out[oi + 2] = wb[mid];
        out[oi + 3] = 255;
      }
    }
    return out;
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

    // フラッドフィルの連鎖が局所的なノイズで途切れて残った孤立点(背景中の消し残し/被写体中の
    // 誤消去)を、3x3の多数決フィルタで2回かけて掃除する(いわゆるモルフォロジー的なオープニング)
    var cleaned = majorityFilter(visited, w, h);
    cleaned = majorityFilter(cleaned, w, h);

    var rawMaskCanvas = document.createElement('canvas');
    rawMaskCanvas.width = w;
    rawMaskCanvas.height = h;
    var rawCtx = rawMaskCanvas.getContext('2d');
    var maskData = rawCtx.createImageData(w, h);
    var md = maskData.data;
    for (var p = 0; p < w * h; p++) {
      var a = cleaned[p] === 1 ? 0 : 255;
      md[p * 4] = 255; md[p * 4 + 1] = 255; md[p * 4 + 2] = 255; md[p * 4 + 3] = a;
    }
    rawCtx.putImageData(maskData, 0, 0);

    // マスクの境界を1pxだけぼかし、ギザギザした輪郭を滑らかにする
    var maskCanvas = document.createElement('canvas');
    maskCanvas.width = w;
    maskCanvas.height = h;
    var maskCtx = maskCanvas.getContext('2d');
    maskCtx.filter = 'blur(1px)';
    maskCtx.drawImage(rawMaskCanvas, 0, 0);
    return maskCanvas;
  }

  // 3x3近傍の多数決で0/1を塗り替え、周囲から浮いた孤立ピクセルを消す(背景/被写体どちらの誤判定にも効く)
  function majorityFilter(src, w, h) {
    var out = new Uint8Array(w * h);
    for (var y = 0; y < h; y++) {
      var y0 = y > 0 ? y - 1 : 0, y1 = y < h - 1 ? y + 1 : h - 1;
      for (var x = 0; x < w; x++) {
        var x0 = x > 0 ? x - 1 : 0, x1 = x < w - 1 ? x + 1 : w - 1;
        var bgCount = 0;
        for (var ny = y0; ny <= y1; ny++) {
          var rowBase = ny * w;
          for (var nx = x0; nx <= x1; nx++) {
            if (src[rowBase + nx] === 1) bgCount++;
          }
        }
        var total = (y1 - y0 + 1) * (x1 - x0 + 1);
        out[y * w + x] = (bgCount > total / 2) ? 1 : 0;
      }
    }
    return out;
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
