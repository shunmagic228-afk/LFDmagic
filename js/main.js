(function () {
  'use strict';

  // ---- 設定の保存(退場までの待機時間 / 選択中アイテムID) ----
  // localStorageには数値やID等の軽い設定のみを保存する。画像本体はIndexedDBへ保存する(後述)。
  var SETTINGS_KEY = 'lfdSettings';
  var DEFAULT_EXIT_DELAY_MS = 6000; // アプリを新しく開いた際の初期値(演者が保存済みの設定があればそちらを優先)
  var DEFAULT_ITEM_ID = 'default';  // 同梱のアイテム画像(img/item.png)を表す固定ID

  function loadSettings() {
    try {
      var raw = localStorage.getItem(SETTINGS_KEY);
      return raw ? (JSON.parse(raw) || {}) : {};
    } catch (e) {
      return {};
    }
  }

  function saveSettings(patch) {
    var cur = loadSettings();
    for (var k in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) cur[k] = patch[k];
    }
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(cur));
    } catch (e) {}
  }

  var savedSettings = loadSettings();
  var selectedItemId = savedSettings.selectedItemId || DEFAULT_ITEM_ID;
  // 同梱のデフォルト画像の表示倍率。saveSettings()はlocalStorageのみ更新しsavedSettingsは
  // 更新しないため、他の設定値と同様にライブな変数として持っておく(1=等倍)。
  var defaultItemScale = (typeof savedSettings.defaultItemScale === 'number') ? savedSettings.defaultItemScale : 1;
  // 選択中アイテムの表示倍率(1=等倍。設定画面の「サイズ調整」で演者が実物と見比べて調整した値)
  var itemScale = defaultItemScale;

  // ---- 設定値 ----
  var DOUBLE_TAP_MAX_INTERVAL = 300; // ダブルタップとみなす最大間隔(ms)
  var TAP_MAX_DURATION  = 380;    // タップとみなす最大接触時間(ms) これを超えたら長押し扱い
  var TAP_MAX_MOVEMENT  = 28;     // タップとみなす最大移動量(px) これを超えたらスワイプ扱い
  var ORB_HIT_RADIUS    = 70;     // 光球にタップで触れたと判定する半径(px)
  var BOUNDARY_MARGIN   = 90;     // 画面端からこの距離より内側に留めるソフト境界
  var BURST_PHASE_MS    = 550;    // 飛び込みの勢いを残す時間

  var TILT_STRENGTH  = 42;   // 傾き1度あたりの加速度の強さ(重力の強さ。画面全体を動かす主動力)
  var TILT_DRAG      = 1.1;  // 傾き反映後の速度減衰(大きいほど追従が機敏で止まりやすい)
  var TILT_MAX_SPEED = 760;  // 傾きによる速度の上限(px/s、暴走防止)
  var JITTER_MAG      = 18;  // ふわふわとした有機的な揺らぎの強さ

  var TRAIL_FADE_ALPHA = 0.15; // 光球が存在する間、画面を完全な黒ではなく薄い黒で塗って光跡を残す

  var TRANSFORM_LOOP_MS      = 2100; // 中央へ渦を巻きながら移動する時間
  var TRANSFORM_LOOPS        = 2.5;  // ぐるっと回る周回数
  var TRANSFORM_CROSSFADE_MS = 2900; // 光がアイテムへ変化しきるまでの時間(演出内容は変えず、ここを伸ばしてゆっくりに)
  var DISSOLVE_PARTICLE_COUNT = 700; // 光が分散する細かい粒子の数
  var ITEM_DISPLAY_HEIGHT    = 420;  // アイテム画像の表示高さ(CSS px)
  var ITEM_HIT_RADIUS        = 170;  // アイテムにタップで触れたと判定する半径(px)
  var ITEM_REST_Y_RATIO      = 0.42; // アイテムの定位置(画面高さに対する比率。中央よりやや上)
  var REVEAL_START_CT        = 0.62; // アイリス状の写し出しを開き始めるタイミング(進行度ct)
  var REVEAL_END_CT          = 0.95; // 完全に開ききるタイミング(進行度ct)

  // アイテムをタップした後の消え方: 'slide'=下へ滑り落ちて退場(既存) / 'cutout'=その場で瞬時に消える(新規)
  var DEFAULT_CUTOUT_DELAY_MS = 3000;
  var exitMode = savedSettings.exitMode === 'cutout' ? 'cutout' : 'slide';
  // アイテムをタップしてから退場を始めるまでの間(設定画面で変更可能。未設定なら6秒がデフォルト)
  var itemExitDelayMs = (typeof savedSettings.exitDelayMs === 'number') ? savedSettings.exitDelayMs : DEFAULT_EXIT_DELAY_MS;
  // アイテムをタップしてからカットアウトで消えるまでの間(カットアウトモード用。未設定なら3秒がデフォルト)
  var itemCutoutDelayMs = (typeof savedSettings.cutoutDelayMs === 'number') ? savedSettings.cutoutDelayMs : DEFAULT_CUTOUT_DELAY_MS;
  var ITEM_EXIT_SLIDE_MS = 1550; // 画面外へ滑り落ちるまでの時間

  var CORNER_SIZE = 90;              // 画面右下のリセット判定エリアの一辺(px)
  var CORNER_TRIPLE_WINDOW_MS = 700; // この時間内に3回タップされたらリセット/設定画面

  function getItemRestY() { return H * ITEM_REST_Y_RATIO; }

  var canvas = document.getElementById('stage');
  var ctx = canvas.getContext('2d');

  var dpr = 1;
  var W = 0, H = 0; // CSSピクセル単位の論理サイズ

  function resize() {
    dpr = Math.max(1, window.devicePixelRatio || 1);
    // window.innerHeightではなく、CSSが実際に描画した大きさ(getBoundingClientRect)を使う。
    // #stageはposition:fixed;inset:0のため、画面の物理的な端まで正しく広がる。
    var rect = canvas.getBoundingClientRect();
    W = rect.width;
    H = rect.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);
  resize();

  // ---- 設定画面(演者用。ダブルタップ・トリプルタップと違いHTMLの通常ボタンで作る) ----
  var ITEM_EXIT_DELAY_OPTIONS_S = [0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  var ITEM_CUTOUT_DELAY_OPTIONS_S = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  var settingsScreen = document.getElementById('settingsScreen');
  var exitModeToggle = document.getElementById('exitModeToggle');
  var exitDelayGrid = document.getElementById('exitDelayGrid');
  var cutoutDelayGrid = document.getElementById('cutoutDelayGrid');
  var closeSettingsBtn = document.getElementById('closeSettingsBtn');
  var itemGrid = document.getElementById('itemGrid');
  var addItemBtn = document.getElementById('addItemBtn');
  var itemFileInput = document.getElementById('itemFileInput');

  ITEM_EXIT_DELAY_OPTIONS_S.forEach(function (sec) {
    var btn = document.createElement('button');
    btn.className = 'durationBtn';
    btn.textContent = sec + '秒';
    btn.dataset.ms = Math.round(sec * 1000);
    btn.addEventListener('click', function () {
      itemExitDelayMs = Number(btn.dataset.ms);
      saveSettings({ exitDelayMs: itemExitDelayMs });
      updateExitDelayButtons();
    });
    exitDelayGrid.appendChild(btn);
  });

  ITEM_CUTOUT_DELAY_OPTIONS_S.forEach(function (sec) {
    var btn = document.createElement('button');
    btn.className = 'durationBtn';
    btn.textContent = sec + '秒';
    btn.dataset.ms = Math.round(sec * 1000);
    btn.addEventListener('click', function () {
      itemCutoutDelayMs = Number(btn.dataset.ms);
      saveSettings({ cutoutDelayMs: itemCutoutDelayMs });
      updateExitDelayButtons();
    });
    cutoutDelayGrid.appendChild(btn);
  });

  function updateExitDelayButtons() {
    var btns = exitDelayGrid.querySelectorAll('.durationBtn');
    for (var i = 0; i < btns.length; i++) {
      var isSelected = Number(btns[i].dataset.ms) === itemExitDelayMs;
      btns[i].classList.toggle('selected', isSelected);
    }
    var cbtns = cutoutDelayGrid.querySelectorAll('.durationBtn');
    for (var j = 0; j < cbtns.length; j++) {
      var cSelected = Number(cbtns[j].dataset.ms) === itemCutoutDelayMs;
      cbtns[j].classList.toggle('selected', cSelected);
    }
  }

  function updateExitModeUI() {
    var mbtns = exitModeToggle.querySelectorAll('.cropModeToggleBtn');
    for (var i = 0; i < mbtns.length; i++) {
      mbtns[i].classList.toggle('selected', mbtns[i].dataset.mode === exitMode);
    }
    exitDelayGrid.classList.toggle('hidden', exitMode !== 'slide');
    cutoutDelayGrid.classList.toggle('hidden', exitMode !== 'cutout');
  }

  exitModeToggle.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.cropModeToggleBtn') : null;
    if (!btn) return;
    exitMode = btn.dataset.mode;
    saveSettings({ exitMode: exitMode });
    updateExitModeUI();
  });

  function openSettings() {
    updateExitDelayButtons();
    updateExitModeUI();
    renderItemGrid();
    settingsScreen.classList.remove('hidden');
  }

  closeSettingsBtn.addEventListener('click', function () {
    settingsScreen.classList.add('hidden');
  });

  addItemBtn.addEventListener('click', function () {
    itemFileInput.value = '';
    itemFileInput.click();
  });

  itemFileInput.addEventListener('change', function () {
    var file = itemFileInput.files && itemFileInput.files[0];
    if (file) addCustomItemFromFile(file);
  });

  // ---- 事前準備画面(アプリを開き直すたびに一度だけ表示) ----
  // モーションセンサーの許可ダイアログは毎回避けられないため、本番前に安全なタイミングで
  // 済ませてもらうための画面。ここでのタップで許可を要求し、以降は本番用の操作に戻る。
  var primeScreen = document.getElementById('primeScreen');
  primeScreen.addEventListener('click', function () {
    enableTilt();
    primeScreen.classList.add('hidden');
  });

  function rand(a, b) { return a + Math.random() * (b - a); }

  // ---- 状態管理 ----
  // 'idle' | 'active'(光球が画面内に存在) | 'transforming'(中央へ集まりアイテム化中) | 'item'(アイテムが浮いている)
  var state = 'idle';
  var orb = null;
  var sparkles = [];
  var transformInfo = null;
  var item = null;

  var itemImg = new Image();
  var itemImgLoaded = false;
  var itemSamplePoints = null; // アイテム画像の不透明部分から間引いた目標座標(表示中心からのオフセット)
  itemImg.onload = function () {
    itemImgLoaded = true;
    buildItemSamplePoints();
  };
  itemImg.src = 'img/item.png';

  function buildItemSamplePoints() {
    var ratio = itemImg.naturalWidth / itemImg.naturalHeight;
    var sampleW = 90;
    var sampleH = Math.max(1, Math.round(sampleW / ratio));
    var off = document.createElement('canvas');
    off.width = sampleW;
    off.height = sampleH;
    var octx = off.getContext('2d');
    octx.drawImage(itemImg, 0, 0, sampleW, sampleH);
    var data = octx.getImageData(0, 0, sampleW, sampleH).data;

    var dispH = ITEM_DISPLAY_HEIGHT * itemScale;
    var dispW = dispH * ratio;
    var pts = [];
    for (var y = 0; y < sampleH; y++) {
      for (var x = 0; x < sampleW; x++) {
        var idx = (y * sampleW + x) * 4;
        if (data[idx + 3] > 120) {
          pts.push([(x / sampleW - 0.5) * dispW, (y / sampleH - 0.5) * dispH]);
        }
      }
    }
    itemSamplePoints = pts;
  }

  // ---- アイテム画像の複数登録・選択(IndexedDBに画像本体を保存し、再起動後も維持する) ----
  // 変化演出そのものは itemImg.src が指す画像を使うだけなので、ここでは
  // 「itemImg.src を差し替える」「差し替えたら形状サンプル点を作り直す」の2点だけを担当する。
  var ITEM_DB_NAME = 'lfdItemsDB';
  var ITEM_DB_VERSION = 1;
  var ITEM_STORE = 'items';
  var customItems = []; // { id, name, blob, thumbUrl }

  function openItemDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(ITEM_DB_NAME, ITEM_DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(ITEM_STORE)) {
          db.createObjectStore(ITEM_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function dbPutItem(record) {
    return openItemDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(ITEM_STORE, 'readwrite');
        tx.objectStore(ITEM_STORE).put({ id: record.id, name: record.name, blob: record.blob });
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function dbGetAllItems() {
    return openItemDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(ITEM_STORE, 'readonly');
        var req = tx.objectStore(ITEM_STORE).getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function dbDeleteItem(id) {
    return openItemDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(ITEM_STORE, 'readwrite');
        tx.objectStore(ITEM_STORE).delete(id);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function findCustomItem(id) {
    for (var i = 0; i < customItems.length; i++) {
      if (customItems[i].id === id) return customItems[i];
    }
    return null;
  }

  function getItemSrcById(id) {
    if (id === DEFAULT_ITEM_ID) return 'img/item.png';
    var rec = findCustomItem(id);
    return rec ? rec.thumbUrl : 'img/item.png';
  }

  // アイテムIDから表示倍率を取得(1=等倍)。同梱のデフォルト画像はlocalStorage、
  // 追加した画像はIndexedDBのレコードにそれぞれ持たせる。
  function getItemScaleById(id) {
    if (id === DEFAULT_ITEM_ID) return defaultItemScale;
    var rec = findCustomItem(id);
    return (rec && typeof rec.scale === 'number') ? rec.scale : 1;
  }

  // アイテムIDを指定して表示倍率を保存する(設定画面の「サイズ調整」から呼ばれる)。
  // 選択中のアイテムであれば、即座に描画へも反映する。
  function setItemScaleById(id, scale) {
    if (id === DEFAULT_ITEM_ID) {
      defaultItemScale = scale;
      saveSettings({ defaultItemScale: scale });
      if (selectedItemId === DEFAULT_ITEM_ID) {
        itemScale = scale;
        if (itemImgLoaded) buildItemSamplePoints();
      }
      renderItemGrid();
      return Promise.resolve();
    }
    var rec = findCustomItem(id);
    if (!rec) return Promise.resolve();
    rec.scale = scale;
    return dbPutItem({ id: rec.id, name: rec.name, blob: rec.blob, scale: scale }).then(function () {
      if (selectedItemId === id) {
        itemScale = scale;
        if (itemImgLoaded) buildItemSamplePoints();
      }
      renderItemGrid();
    });
  }

  // 選択中のアイテムIDに応じて itemImg.src を差し替える。以降は既存の itemImg.onload が
  // 形状サンプル点の再構築(buildItemSamplePoints)を自動で行う。
  function applySelectedItem() {
    itemImgLoaded = false;
    itemSamplePoints = null;
    itemScale = getItemScaleById(selectedItemId);
    itemImg.src = getItemSrcById(selectedItemId);
  }

  function selectItem(id) {
    if (id === selectedItemId) return;
    selectedItemId = id;
    saveSettings({ selectedItemId: id });
    applySelectedItem();
    renderItemGrid();
  }

  function renderItemGrid() {
    if (!itemGrid) return;
    itemGrid.innerHTML = '';

    var entries = [{ id: DEFAULT_ITEM_ID, thumbUrl: 'img/item.png', builtin: true }];
    for (var i = 0; i < customItems.length; i++) {
      entries.push({ id: customItems[i].id, thumbUrl: customItems[i].thumbUrl, builtin: false });
    }

    entries.forEach(function (entry) {
      var wrap = document.createElement('div');
      wrap.className = 'itemThumbWrap';

      var btn = document.createElement('button');
      btn.className = 'itemThumb' + (entry.id === selectedItemId ? ' selected' : '');
      var img = document.createElement('img');
      img.src = entry.thumbUrl;
      btn.appendChild(img);
      btn.addEventListener('click', function () { selectItem(entry.id); });
      wrap.appendChild(btn);

      if (!entry.builtin) {
        var del = document.createElement('button');
        del.className = 'itemDeleteBadge';
        del.textContent = '×';
        del.addEventListener('click', function (e) {
          e.stopPropagation();
          if (window.confirm('この画像を削除しますか？')) {
            deleteCustomItem(entry.id);
          }
        });
        wrap.appendChild(del);
      }

      var sizeBadge = document.createElement('button');
      sizeBadge.className = 'itemSizeBadge';
      sizeBadge.textContent = Math.round(getItemScaleById(entry.id) * 100) + '%';
      sizeBadge.addEventListener('click', function (e) {
        e.stopPropagation();
        if (window.LFDSize) window.LFDSize.openForExistingItem(entry.id);
      });
      wrap.appendChild(sizeBadge);

      itemGrid.appendChild(wrap);
    });
  }

  // アイテムの新規登録(IndexedDBへの保存・選択・一覧更新)本体。
  // 生ファイルの追加(下のaddCustomItemFromFile)だけでなく、切り抜き機能(js/crop.js)や
  // サイズ調整機能(js/size.js)が生成したBlobもここを通して同じ経路で登録する
  // (window.LFDItemsとして公開)。scaleは表示倍率(1=等倍、省略時は1)。
  function addBlobAsItem(blob, name, scale) {
    var id = 'item_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    var record = { id: id, name: name || 'item', blob: blob, scale: (typeof scale === 'number') ? scale : 1 };
    return dbPutItem(record).then(function () {
      record.thumbUrl = URL.createObjectURL(record.blob);
      customItems.push(record);
      selectItem(id); // 追加したその場ですぐ本番へ反映されるよう、追加したアイテムを自動で選択状態にする
      renderItemGrid();
    });
  }

  function addCustomItemFromFile(file) {
    var allowed = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
    if (allowed.indexOf(file.type) === -1) {
      window.alert('対応していない画像形式です(PNG / JPEG / WebPをお使いください)');
      return;
    }
    // 追加する前に、実物と見比べて表示サイズを決める「サイズ調整」画面へ引き継ぐ
    window.LFDSize.openForNewItem(file, file.name);
  }

  function deleteCustomItem(id) {
    dbDeleteItem(id).then(function () {
      var rec = findCustomItem(id);
      if (rec && rec.thumbUrl) URL.revokeObjectURL(rec.thumbUrl);
      customItems = customItems.filter(function (it) { return it.id !== id; });
      if (selectedItemId === id) {
        selectedItemId = DEFAULT_ITEM_ID;
        saveSettings({ selectedItemId: selectedItemId });
        applySelectedItem();
      }
      renderItemGrid();
    }).catch(function () {
      window.alert('画像の削除に失敗しました');
    });
  }

  // 起動時に保存済みのアイテム画像を読み込み、必要なら選択中の画像を差し替える
  dbGetAllItems().then(function (records) {
    customItems = records.map(function (r) {
      r.thumbUrl = URL.createObjectURL(r.blob);
      return r;
    });
    if (selectedItemId !== DEFAULT_ITEM_ID) {
      if (findCustomItem(selectedItemId)) {
        applySelectedItem();
      } else {
        selectedItemId = DEFAULT_ITEM_ID;
        saveSettings({ selectedItemId: selectedItemId });
      }
    }
    renderItemGrid();
  }).catch(function () {
    // IndexedDBが使えない環境では同梱のデフォルト画像のみで動作を続ける
  });

  // 光の粒子を軽く描くための下地スプライト(毎フレームのグラデーション生成コストを避ける)。
  // 中心は必ず白飛びさせ、ベースの白青い光の質感を保ったまま、ごく一部だけ色味を混ぜる。
  function makeParticleSprite(midColor) {
    var c = document.createElement('canvas');
    c.width = 32;
    c.height = 32;
    var sctx = c.getContext('2d');
    var g = sctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, midColor);
    g.addColorStop(1, 'rgba(210,230,255,0)');
    sctx.fillStyle = g;
    sctx.beginPath(); sctx.arc(16, 16, 16, 0, Math.PI * 2); sctx.fill();
    return c;
  }
  var particleSpriteBlue = makeParticleSprite('rgba(210,230,255,0.85)'); // ベースの白青(基本はこれ)
  var particleSpriteGold = makeParticleSprite('rgba(255,205,140,0.85)'); // ごく一部だけ暖色を混ぜる
  var particleSpritePink = makeParticleSprite('rgba(255,175,215,0.8)');  // ごく一部だけ差し色

  function pickParticleSprite() {
    var r = Math.random();
    if (r < 0.72) return particleSpriteBlue;
    if (r < 0.86) return particleSpriteGold;
    return particleSpritePink;
  }

  // 粒子が着地した場所から画像を写し出すためのマスク合成用キャンバス(使い回して負荷を抑える)
  var maskCanvas = document.createElement('canvas');
  var maskCtx = maskCanvas.getContext('2d');
  var revealCanvas = document.createElement('canvas');
  var revealCtx = revealCanvas.getContext('2d');

  // ---- 端末の傾き(ジャイロ)----
  // 注意: iOSの仕様上、モーションセンサーの許可はページの読み込みごとに
  // 必要で、Webアプリでは許可状態を恒久的に保存する手段がない(全サイト共通の制約)。
  var tiltAX = 0, tiltAY = 0;
  var tiltGranted = false;      // 許可が実際に下りたか
  var tiltRequestInFlight = false;
  var tiltBaseline = null; // その場で構えた持ち方を基準(ゼロ点)にする

  function resetTiltBaseline() {
    tiltBaseline = null;
    tiltAX = 0;
    tiltAY = 0;
  }

  function onOrientation(e) {
    if (e.beta === null || e.gamma === null) return;
    // 人によって・その時の構え方によって自然に持つ角度は異なるため、
    // 固定角度(90度)ではなく「今その瞬間に持っている角度」を基準として、
    // そこからの変化分だけを傾きとして扱う。こうしないと、90度より
    // 寝かせ気味に持っているだけで常に一方向へ力がかかり続けてしまう。
    if (tiltBaseline === null) {
      tiltBaseline = { beta: e.beta, gamma: e.gamma };
    }
    var dBeta = e.beta - tiltBaseline.beta;
    var dGamma = e.gamma - tiltBaseline.gamma;
    if (dBeta > 180) dBeta -= 360;
    if (dBeta < -180) dBeta += 360;
    tiltAX = Math.max(-35, Math.min(35, dGamma));
    tiltAY = Math.max(-35, Math.min(35, dBeta));
  }

  function enableTilt() {
    // 許可がまだ下りていなければ、発射のたびに(=ユーザー操作のたびに)再挑戦する。
    // 1回目のダイアログを見逃す/誤ってブロックしてしまった場合でも、次の発射で復帰できるようにするため。
    if (tiltGranted || tiltRequestInFlight) return;
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      tiltRequestInFlight = true;
      DeviceOrientationEvent.requestPermission().then(function (res) {
        tiltRequestInFlight = false;
        if (res === 'granted') {
          tiltGranted = true;
          window.addEventListener('deviceorientation', onOrientation);
        }
      }).catch(function () {
        tiltRequestInFlight = false;
      });
    } else {
      tiltGranted = true;
      window.addEventListener('deviceorientation', onOrientation);
    }
  }

  // ---- タップ検出(誤作動防止つき) ----
  var lastTapTime = 0;
  var cornerTapTimes = []; // 画面右下角への連続タップ(3回でリセット。アイテム出現後のみ有効)
  var activePointerId = null;
  var pointerStartX = 0, pointerStartY = 0, pointerStartT = 0;
  var pointerMoved = false;

  // ---- 光球を指でつまんで動かす ----
  var orbTouchCandidate = false; // 光球の上でポインターダウンした
  var draggingOrb = false;       // 実際に指が動いてドラッグに移行した
  var dragTargetX = 0, dragTargetY = 0;
  var dragVX = 0, dragVY = 0;
  var dragLastX = 0, dragLastY = 0, dragLastT = 0;

  function onPointerDown(e) {
    // 同時に複数の指が触れている場合は誤作動防止のため一切無視する
    if (activePointerId !== null) {
      activePointerId = null;
      lastTapTime = 0;
      draggingOrb = false;
      orbTouchCandidate = false;
      return;
    }
    if (e.button !== undefined && e.button !== 0) return; // 右クリック等は無視

    activePointerId = e.pointerId;
    pointerStartX = e.clientX;
    pointerStartY = e.clientY;
    pointerStartT = performance.now();
    pointerMoved = false;

    if (state === 'active' && orb && Math.hypot(e.clientX - orb.x, e.clientY - orb.y) <= ORB_HIT_RADIUS) {
      orbTouchCandidate = true;
    } else {
      orbTouchCandidate = false;
    }
    draggingOrb = false;
  }

  function onPointerMove(e) {
    if (e.pointerId !== activePointerId) return;
    var dx = e.clientX - pointerStartX;
    var dy = e.clientY - pointerStartY;
    if (Math.sqrt(dx * dx + dy * dy) > TAP_MAX_MOVEMENT) {
      pointerMoved = true;
    }

    if (orbTouchCandidate && pointerMoved && !draggingOrb) {
      draggingOrb = true;
      dragLastX = e.clientX; dragLastY = e.clientY; dragLastT = performance.now();
    }
    if (draggingOrb) {
      dragTargetX = e.clientX;
      dragTargetY = e.clientY;
      var t = performance.now();
      var dtms = Math.max(1, t - dragLastT);
      dragVX = (e.clientX - dragLastX) / (dtms / 1000);
      dragVY = (e.clientY - dragLastY) / (dtms / 1000);
      dragLastX = e.clientX; dragLastY = e.clientY; dragLastT = t;
    }
  }

  function onPointerUp(e) {
    if (e.pointerId !== activePointerId) return;
    activePointerId = null;

    if (draggingOrb) {
      // ドラッグ終了 → 指を離した勢いを引き継いで、以降はジャイロ側の物理へ自然にバトンタッチ
      draggingOrb = false;
      orbTouchCandidate = false;
      if (orb) {
        orb.vx = dragVX * 0.6;
        orb.vy = dragVY * 0.6;
      }
      lastTapTime = 0;
      return;
    }
    orbTouchCandidate = false;

    var duration = performance.now() - pointerStartT;
    var isValidTap = !pointerMoved && duration <= TAP_MAX_DURATION;

    if (!isValidTap) {
      // 長押し・スワイプ・その他 → 何もしない。連続タップの流れも破棄する
      lastTapTime = 0;
      return;
    }

    handleTap(e.clientX, e.clientY, performance.now());
  }

  function onPointerCancel(e) {
    if (e.pointerId === activePointerId) {
      activePointerId = null;
    }
    lastTapTime = 0;
    draggingOrb = false;
    orbTouchCandidate = false;
  }

  canvas.addEventListener('pointerdown', onPointerDown, { passive: true });
  canvas.addEventListener('pointermove', onPointerMove, { passive: true });
  canvas.addEventListener('pointerup', onPointerUp, { passive: true });
  canvas.addEventListener('pointercancel', onPointerCancel, { passive: true });
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  document.addEventListener('gesturestart', function (e) { e.preventDefault(); });

  function handleTap(x, y, now) {
    // 画面右下角への「トリプルタップ」: 何か出ていればリセット、何も出ていなければ設定画面を開く
    if (x > W - CORNER_SIZE && y > H - CORNER_SIZE) {
      cornerTapTimes.push(now);
      while (cornerTapTimes.length && now - cornerTapTimes[0] > CORNER_TRIPLE_WINDOW_MS) {
        cornerTapTimes.shift();
      }
      if (cornerTapTimes.length >= 3) {
        cornerTapTimes.length = 0;
        if (state === 'idle') {
          openSettings();
        } else {
          resetAll();
        }
      }
      lastTapTime = 0;
      return;
    }

    if (state === 'transforming') {
      return; // アイテム化の演出中は一切反応しない
    }

    if (state === 'item') {
      // アイテムへの「シングルタップ」で、0.5秒後に画面下へ滑り落ちて退場
      if (item && !item.exiting && Math.hypot(x - item.x, y - item.y) <= ITEM_HIT_RADIUS * itemScale) {
        scheduleItemExit();
      }
      lastTapTime = 0;
      return;
    }

    if (state === 'active') {
      // 光球への「ダブルタップ」でアイテムへ変化させる。それ以外のタップは無視
      if (orb && Math.hypot(x - orb.x, y - orb.y) <= ORB_HIT_RADIUS) {
        if (lastTapTime !== 0 && (now - lastTapTime) <= DOUBLE_TAP_MAX_INTERVAL) {
          lastTapTime = 0;
          transformToItem();
        } else {
          lastTapTime = now;
        }
      } else {
        lastTapTime = 0;
      }
      return;
    }

    // 待機中はワンタップで即発射
    lastTapTime = 0;
    launchOrb(x, y);
  }

  function transformToItem() {
    if (!orb) return;
    state = 'transforming';
    var cx = W / 2, cy = H / 2;
    var dx = orb.x - cx, dy = orb.y - cy;
    transformInfo = {
      cx: cx, cy: cy,
      r0: Math.max(30, Math.hypot(dx, dy)),
      a0: Math.atan2(dy, dx),
      startedAt: performance.now(),
      crossfadeStarted: null,
      crossfadeT: null
    };
  }

  // アイテムへのタップ後、設定された時間だけ待ってから消す。
  // 'slide'(退場スライド): 画面下へ滑り落として退場。'cutout': その場で瞬時に消える。
  function scheduleItemExit() {
    if (!item || item.exiting) return;
    item.exiting = true;
    if (exitMode === 'cutout') {
      setTimeout(function () {
        if (state !== 'item' || !item) return;
        item = null;
        sparkles.length = 0;
        state = 'idle';
      }, itemCutoutDelayMs);
      return;
    }
    setTimeout(function () {
      if (state !== 'item' || !item) return;
      item.sliding = true;
      item.exitStartAt = performance.now();
      item.exitFromX = item.x;
      item.exitFromY = item.y;
    }, itemExitDelayMs);
  }

  // 実験用の全リセット(右下角トリプルタップ)
  function resetAll() {
    orb = null;
    item = null;
    transformInfo = null;
    sparkles.length = 0;
    draggingOrb = false;
    orbTouchCandidate = false;
    lastTapTime = 0;
    cornerTapTimes.length = 0;
    state = 'idle';
  }

  function launchOrb(x, y) {
    enableTilt(); // ユーザー操作の中で呼ぶ必要があるためここで許可を求める
    resetTiltBaseline(); // 今この瞬間に構えている持ち方を新しい基準にする
    spawnOrb(x, y);
    state = 'active';
  }


  // ---- キラキラ粒子 ----
  function addSparkle(x, y, vx, vy, life) {
    sparkles.push({
      x: x, y: y, vx: vx, vy: vy, born: performance.now(), life: life, size: rand(1.0, 4.2),
      // 真ん丸だと粒立ちが目立つため、粒ごとに縦横をわずかに潰していびつな形にする
      squashX: rand(0.6, 1.15), squashY: rand(0.6, 1.15)
    });
  }

  // 残っているキラキラ粒子を、今から指定ミリ秒以内に消えるよう寿命を縮める(急に消さずふわっと消す)
  function fadeOutSparklesQuickly(now, ms) {
    for (var i = 0; i < sparkles.length; i++) {
      var s = sparkles[i];
      var elapsed = now - s.born;
      if (s.life - elapsed > ms) s.life = elapsed + ms;
    }
  }

  function spawnBurstSparkles(x, y) {
    // 発射点に「跡」として残って見えないよう、個数を絞り・すぐ散る速度にし・寿命も短くする
    // (以前は寿命が最大1.4秒あり、初速を上げても消えるまでの間その場に薄く残って見えていた)
    var n = 55;
    for (var i = 0; i < n; i++) {
      var a = rand(0, Math.PI * 2);
      var sp = rand(260, 560);
      addSparkle(x, y, Math.cos(a) * sp, Math.sin(a) * sp, rand(150, 420));
    }
  }

  function updateSparkles(now, dt) {
    for (var i = sparkles.length - 1; i >= 0; i--) {
      var s = sparkles[i];
      if (now - s.born >= s.life) { sparkles.splice(i, 1); continue; }
      s.vx *= (1 - Math.min(1, dt * 1.4));
      s.vy *= (1 - Math.min(1, dt * 1.4));
      s.x += s.vx * dt;
      s.y += s.vy * dt;
    }
  }

  function drawSparkle(s, now) {
    var t = (now - s.born) / s.life;
    if (t >= 1) return;
    var alpha = (1 - t) * (1 - t); // ふんわり減衰(イーズアウト)
    var r = s.size * 4;
    var g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
    // 以前より控えめな透明度にし、万一残っても薄く感じるようにする
    g.addColorStop(0, 'rgba(255,255,255,' + (0.62 * alpha) + ')');
    g.addColorStop(0.4, 'rgba(190,220,255,' + (0.32 * alpha) + ')');
    g.addColorStop(1, 'rgba(190,220,255,0)');
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.scale(s.squashX, s.squashY); // 真ん丸すぎないよう粒ごとにわずかに潰す
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // ---- 光の軌跡(なめらかな光の尾) ----
  function drawTrail(now) {
    var pts = orb.trail;
    if (pts.length < 2) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.filter = 'blur(3px)';
    ctx.lineCap = 'round';
    for (var i = 1; i < pts.length; i++) {
      var a = pts[i - 1], b = pts[i];
      var age = now - b.t;
      var alpha = Math.max(0, 1 - age / 700);
      if (alpha <= 0) continue;
      ctx.strokeStyle = 'rgba(190,222,255,' + (0.28 * alpha) + ')';
      ctx.lineWidth = 2 * alpha + 0.4;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---- 光球の物理 ----
  function spawnOrb(x, y) {
    var angle = -Math.PI / 2 + rand(-0.3, 0.3); // ほぼ画面の上方向へ
    var speed = rand(1500, 1900); // 勢いよく投げ込む初速
    orb = {
      x: x, y: y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      bornAt: performance.now(),
      jitterAngle: rand(0, Math.PI * 2),
      nextJitterAt: 0,
      flickerSeed: Math.random() * 1000,
      spikeAngleOffset: rand(0, Math.PI / 4),
      trail: []
    };
    spawnBurstSparkles(x, y);
  }

  function updateOrb(now, dt) {
    var elapsed = now - orb.bornAt;

    if (elapsed < BURST_PHASE_MS) {
      // 投げ込んだ勢いを残しながら自然に失速
      var curAngle = Math.atan2(orb.vy, orb.vx);
      var speed = Math.hypot(orb.vx, orb.vy);
      speed *= Math.max(0, 1 - dt * 2.0);
      orb.vx = Math.cos(curAngle) * speed;
      orb.vy = Math.sin(curAngle) * speed;
    } else {
      // ふわふわとした有機的な揺らぎ(方向はゆっくり変化)
      if (now > orb.nextJitterAt) {
        orb.jitterAngle += rand(-1.4, 1.4);
        orb.nextJitterAt = now + rand(350, 700);
      }
      var jax = Math.cos(orb.jitterAngle) * JITTER_MAG;
      var jay = Math.sin(orb.jitterAngle) * JITTER_MAG;

      // 端末の傾きに応じた加速度(画面全体を使って動く主動力)。
      // 速度に直接足し込むことで、傾け続けるほどきちんと加速して届く。
      orb.vx += (tiltAX * TILT_STRENGTH + jax) * dt;
      orb.vy += (tiltAY * TILT_STRENGTH + jay) * dt;

      var drag = Math.max(0, 1 - TILT_DRAG * dt);
      orb.vx *= drag;
      orb.vy *= drag;

      var sp0 = Math.hypot(orb.vx, orb.vy);
      if (sp0 > TILT_MAX_SPEED) {
        var k = TILT_MAX_SPEED / sp0;
        orb.vx *= k; orb.vy *= k;
      }
    }

    // ソフトな画面端の反発(常に画面内に留める)
    var m = BOUNDARY_MARGIN;
    if (orb.x < m) orb.vx += (m - orb.x) * 8 * dt;
    if (orb.x > W - m) orb.vx -= (orb.x - (W - m)) * 8 * dt;
    if (orb.y < m) orb.vy += (m - orb.y) * 8 * dt;
    if (orb.y > H - m) orb.vy -= (orb.y - (H - m)) * 8 * dt;

    orb.x += orb.vx * dt;
    orb.y += orb.vy * dt;

    // 保険としてのハードクランプ(絶対に画面外へ出さない)
    var hardM = m * 0.5;
    orb.x = Math.max(hardM, Math.min(W - hardM, orb.x));
    orb.y = Math.max(hardM, Math.min(H - hardM, orb.y));

    // 軌跡ポイントを記録
    orb.trail.push({ x: orb.x, y: orb.y, t: now });
    while (orb.trail.length && now - orb.trail[0].t > 700) orb.trail.shift();

    // 軌跡に沿ってキラキラを残す(しつこく多めに)。
    // このキラキラはほぼ初速を持たずその場にとどまるため、寿命が軌跡ポイントの保持時間(700ms)より
    // 長いと、発射直後の急加速で球が遠くへ飛び去った後も発射点付近にだけ古い粒が残ってしまう。
    // そのため寿命は軌跡と同程度以下に抑える。
    var sp = Math.hypot(orb.vx, orb.vy);
    var rate = Math.min(0.98, 0.32 + sp / 450);
    if (Math.random() < rate) {
      addSparkle(orb.x, orb.y, -orb.vx * 0.05 + rand(-35, 35), -orb.vy * 0.05 + rand(-35, 35), rand(220, 550));
    }
    if (Math.random() < rate * 0.6) {
      addSparkle(orb.x + rand(-6, 6), orb.y + rand(-6, 6), -orb.vx * 0.03 + rand(-45, 45), -orb.vy * 0.03 + rand(-45, 45), rand(180, 400));
    }
  }

  // 指でつまんで動かしている間の更新(ジャイロの計算はそのまま裏で継続させ、位置だけ指に追従させる)
  function updateOrbDragging(now, dt) {
    var followRate = Math.min(1, dt * 14); // 指にほぼ追従しつつ、わずかに「ついてくる」柔らかさを残す
    orb.x += (dragTargetX - orb.x) * followRate;
    orb.y += (dragTargetY - orb.y) * followRate;

    var hardM = BOUNDARY_MARGIN * 0.5;
    orb.x = Math.max(hardM, Math.min(W - hardM, orb.x));
    orb.y = Math.max(hardM, Math.min(H - hardM, orb.y));

    orb.trail.push({ x: orb.x, y: orb.y, t: now });
    while (orb.trail.length && now - orb.trail[0].t > 700) orb.trail.shift();

    if (Math.random() < 0.5) {
      addSparkle(orb.x, orb.y, rand(-30, 30), rand(-30, 30), rand(400, 900));
    }
  }

  // ---- 光球 → アイテムへの変化(渦を巻きながら中央へ、そしてクロスフェード) ----
  function updateTransforming(now, dt) {
    var elapsed = now - transformInfo.startedAt;

    if (elapsed <= TRANSFORM_LOOP_MS) {
      var t = elapsed / TRANSFORM_LOOP_MS;
      var ease = 1 - Math.pow(1 - t, 2); // 後半ほど速く中心へ収束
      var r = transformInfo.r0 * (1 - ease);
      var ang = transformInfo.a0 + t * Math.PI * 2 * TRANSFORM_LOOPS;
      orb.x = transformInfo.cx + Math.cos(ang) * r;
      orb.y = transformInfo.cy + Math.sin(ang) * r;

      orb.trail.push({ x: orb.x, y: orb.y, t: now });
      while (orb.trail.length && now - orb.trail[0].t > 700) orb.trail.shift();
      if (Math.random() < 0.7) {
        addSparkle(orb.x, orb.y, rand(-40, 40), rand(-40, 40), rand(400, 900));
      }
    } else {
      // 光が超細かい粒子に分散し、それぞれがアイテムの形へ集まっていく
      if (transformInfo.crossfadeStarted === null) {
        transformInfo.crossfadeStarted = now;
        buildDissolveParticles();
      }
      orb.x = transformInfo.cx;
      orb.y = transformInfo.cy;
      var ct = Math.min(1, (now - transformInfo.crossfadeStarted) / TRANSFORM_CROSSFADE_MS);
      transformInfo.crossfadeT = ct;

      if (ct >= 1) {
        item = { x: transformInfo.cx, y: getItemRestY(), bornAt: now };
        orb = null;
        transformInfo = null;
        // 渦を巻く間や仕上げの間に発生させ続けたキラキラ粒子(sparkles)は状態が変わっても
        // 自動では消えないため、そのままだとアイテムの周りに漂って残って見える。
        // かといって配列を即座に空にすると「カクッ」と不自然に消えてしまうため、
        // 残っている分だけ寿命を縮めて短時間でふわっとフェードアウトさせる
        fadeOutSparklesQuickly(now, 180);
        state = 'item';
      }
    }
  }

  // 光の到達点(画面中央)を起点に、アイテムのシルエットへ散らばりながら集まる粒子群を作る
  function buildDissolveParticles() {
    var restY = getItemRestY();
    var pts = itemSamplePoints || [];
    var n = Math.min(DISSOLVE_PARTICLE_COUNT, pts.length);
    var idxs = [];
    for (var k = 0; k < pts.length; k++) idxs.push(k);
    for (var k2 = idxs.length - 1; k2 > 0; k2--) {
      var j = Math.floor(Math.random() * (k2 + 1));
      var tmp = idxs[k2]; idxs[k2] = idxs[j]; idxs[j] = tmp;
    }

    var particles = [];
    for (var i = 0; i < n; i++) {
      var p = pts[idxs[i]];
      var burstAngle = rand(0, Math.PI * 2);
      var burstDist = rand(140, 380); // 大きく広がってから集まる、のダイナミックさを出す
      // 発生位置を中心の一点ではなく光球の輪郭付近に散らし、「光球そのものが砕けて粒子になる」ように見せる
      var startAngle = rand(0, Math.PI * 2);
      var startR = rand(8, 42);
      particles.push({
        startX: transformInfo.cx + Math.cos(startAngle) * startR,
        startY: transformInfo.cy + Math.sin(startAngle) * startR,
        peakX: transformInfo.cx + Math.cos(burstAngle) * burstDist,
        peakY: transformInfo.cy + Math.sin(burstAngle) * burstDist,
        tx: transformInfo.cx + p[0],
        ty: restY + p[1],
        localX: p[0],
        localY: p[1],
        tStart: rand(0, 0.08),
        dur: rand(0.68, 0.82),
        size: rand(2.5, 6.5),
        sprite: pickParticleSprite(),
        // 真ん丸だと粒立ちが目立つため、粒ごとに縦横をわずかに潰していびつな形にする
        squashX: rand(0.6, 1.15), squashY: rand(0.6, 1.15)
      });
    }
    transformInfo.particles = particles;

    // 画像を写し出すマスク用キャンバスを、表示サイズ+光の輪ぶんの余白で用意する
    var ratio = itemImg.naturalWidth / itemImg.naturalHeight;
    var pad = 24;
    var dispH = ITEM_DISPLAY_HEIGHT * itemScale;
    var mw = Math.ceil(dispH * ratio + pad);
    var mh = Math.ceil(dispH + pad);
    maskCanvas.width = mw;
    maskCanvas.height = mh;
    revealCanvas.width = mw;
    revealCanvas.height = mh;
  }

  function easeOutCubic(x) { return 1 - Math.pow(1 - x, 3); }
  function easeInCubic(x) { return x * x * x; }
  function easeInOutCubic(x) { return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; }

  // 粒子1個の、変化の進行度ct(0-1)における位置と不透明度。
  // 「発生点→大きく広がった位置(peak)→アイテムの目標点」の2区間で、分散してから集まる動きを作る。
  function getParticleState(p, ct) {
    var localT = (ct - p.tStart) / p.dur;
    if (localT <= 0) return { x: p.startX, y: p.startY, alpha: 0 };
    if (localT >= 1) {
      var settle = Math.min(1, (localT - 1) * 4); // 到着後すこしで個別にふっと消える
      return { x: p.tx, y: p.ty, alpha: Math.max(0, 1 - settle) };
    }
    var alpha = Math.min(1, localT * 5);
    if (localT < 0.42) {
      // 前半: 光球の輪郭から弾け、大きく広がっていく(分散)
      var e1 = easeOutCubic(localT / 0.42);
      return {
        x: p.startX + (p.peakX - p.startX) * e1,
        y: p.startY + (p.peakY - p.startY) * e1,
        alpha: alpha
      };
    }
    // 後半: アイテムの形へ集まっていく(収束)
    var e2 = easeInOutCubic((localT - 0.42) / 0.58);
    return {
      x: p.peakX + (p.tx - p.peakX) * e2,
      y: p.peakY + (p.ty - p.peakY) * e2,
      alpha: alpha
    };
  }

  // 粒子が集まりきる地点を中心に、光が円形にじわっと開いてアイテムを写し出す(アイリス状の見せ方)
  function renderRevealMask(ct) {
    var mw = maskCanvas.width, mh = maskCanvas.height;
    var mcx = mw / 2, mcy = mh / 2;
    var maxR = Math.hypot(mw, mh) / 2;

    var raw = Math.min(1, Math.max(0, (ct - REVEAL_START_CT) / (REVEAL_END_CT - REVEAL_START_CT)));
    var revealT = easeOutCubic(raw); // 開くほど減速し、自然に静止する
    var r = maxR * revealT;

    maskCtx.clearRect(0, 0, mw, mh);
    if (r <= 0) return 0;
    var g = maskCtx.createRadialGradient(mcx, mcy, Math.max(0, r * 0.8), mcx, mcy, r);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    maskCtx.fillStyle = g;
    maskCtx.beginPath(); maskCtx.arc(mcx, mcy, r, 0, Math.PI * 2); maskCtx.fill();
    return r;
  }

  // 光が集まった場所を起点に、円形に開きながらアイテムを写し出す
  function drawRevealedItem(cx, restY, ct, now) {
    if (!itemImgLoaded) return;
    var r = renderRevealMask(ct);
    if (r <= 0) return;

    var ratio = itemImg.naturalWidth / itemImg.naturalHeight;
    var h = ITEM_DISPLAY_HEIGHT * itemScale, w = h * ratio;
    var ox = revealCanvas.width / 2 - w / 2, oy = revealCanvas.height / 2 - h / 2;

    revealCtx.clearRect(0, 0, revealCanvas.width, revealCanvas.height);
    revealCtx.globalCompositeOperation = 'source-over';
    revealCtx.drawImage(itemImg, ox, oy, w, h);
    revealCtx.globalCompositeOperation = 'destination-in';
    revealCtx.drawImage(maskCanvas, 0, 0);
    revealCtx.globalCompositeOperation = 'source-over';

    ctx.drawImage(revealCanvas, cx - revealCanvas.width / 2, restY - revealCanvas.height / 2);

    // 開いていく縁にほんのり光の輪を添え、光が押し広げているような質感を出す
    var maxR = Math.hypot(revealCanvas.width, revealCanvas.height) / 2;
    if (r < maxR * 0.98) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.filter = 'blur(5px)';
      var ringAlpha = 0.4 * (1 - r / maxR);
      var rg = ctx.createRadialGradient(cx, restY, Math.max(0, r * 0.78), cx, restY, r * 1.06);
      rg.addColorStop(0, 'rgba(210,230,255,0)');
      rg.addColorStop(0.85, 'rgba(220,235,255,' + ringAlpha + ')');
      rg.addColorStop(1, 'rgba(220,235,255,0)');
      ctx.fillStyle = rg;
      ctx.beginPath(); ctx.arc(cx, restY, r * 1.06, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }

  function updateItemFloating(now) {
    if (item.sliding) {
      var et = Math.min(1, (now - item.exitStartAt) / ITEM_EXIT_SLIDE_MS);
      // 漂っている間に左右へ寄っていても、退場が始まったら中心へ寄せてから落としていく
      // (退場のたびに画面中心から出ていったように見せるため)。動き出しも唐突にならないよう、
      // ゆっくり始まってゆっくり終わる、ふんわりとした動きにする
      var centerEase = easeInOutCubic(Math.min(1, et / 0.75));
      item.x = item.exitFromX + (W / 2 - item.exitFromX) * centerEase;

      // 縦の動きは2段階に分ける。前半で画面下端にアイテムの底が触れる位置まで加速しながら落とし、
      // 後半はそこから完全に画面外へ抜けきるまで(=アイテム1個分の高さぶん)を、あえて時間をかけて
      // ゆっくり動かす。こうしないと、画面下端に触れた直後の一瞬で見えなくなってしまい、
      // 「画面を通過して消えていく」様子がほとんど見えないまま(見切れた印象のまま)終わってしまう。
      var dispH = ITEM_DISPLAY_HEIGHT * itemScale;
      var edgeY = Math.max(H - dispH / 2, item.exitFromY + 40); // アイテムの底が画面下端に触れる位置
      var offY = edgeY + dispH; // そこからさらにアイテム1個分落として完全に画面外へ
      var PASS_PHASE_START = 0.6; // 全体の時間のうち、ここまでは通常の落下、残りを通過演出に使う

      if (et < PASS_PHASE_START) {
        var e1 = easeInCubic(et / PASS_PHASE_START); // 序盤は加速しながら落ちる
        item.y = item.exitFromY + (edgeY - item.exitFromY) * e1;
      } else {
        var e2 = easeOutCubic((et - PASS_PHASE_START) / (1 - PASS_PHASE_START)); // 通過中はゆっくり、はっきり見せる
        item.y = edgeY + (offY - edgeY) * e2;
      }

      if (et >= 1) {
        item = null;
        sparkles.length = 0;
        state = 'idle';
      }
      return;
    }

    var t = (now - item.bornAt) / 1000;
    // アイテム出現の瞬間(t=0)は揺らぎゼロから始め、変化演出の最終位置と完全に一致させて段差を無くす
    var floatEase = 1 - Math.exp(-t * 0.8);
    item.x = W / 2 + floatEase * (Math.sin(t * 0.55) * 16 + Math.sin(t * 1.3 + 1.1) * 6);
    item.y = getItemRestY() + floatEase * (Math.sin(t * 0.4 + 0.7) * 12 + Math.sin(t * 1.1 + 2.0) * 5);
  }

  function drawItem(x, y, alpha, scale, now) {
    if (!itemImgLoaded) return;
    var ratio = itemImg.naturalWidth / itemImg.naturalHeight;
    var h = ITEM_DISPLAY_HEIGHT * scale;
    var w = h * ratio;

    ctx.save();
    ctx.globalAlpha = alpha;

    // 背景にほんのり光暈を置き、暗闇に浮いている質感を出す
    ctx.globalCompositeOperation = 'lighter';
    ctx.filter = 'blur(40px)';
    var glowR = Math.max(w, h) * 0.6;
    var glow = ctx.createRadialGradient(x, y, 0, x, y, glowR);
    var breathe = 0.28 + 0.06 * Math.sin(now / 900);
    glow.addColorStop(0, 'rgba(150,190,255,' + breathe + ')');
    glow.addColorStop(1, 'rgba(150,190,255,0)');
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(x, y, glowR, 0, Math.PI * 2); ctx.fill();

    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.drawImage(itemImg, x - w / 2, y - h / 2, w, h);

    ctx.restore();
  }

  function drawSpike(x, y, angle, length, width, alpha) {
    var dx = Math.cos(angle), dy = Math.sin(angle);
    var px = -dy, py = dx;
    var midLen = length * 0.16;

    var grad = ctx.createLinearGradient(x, y, x + dx * length, y + dy * length);
    grad.addColorStop(0, 'rgba(235,245,255,' + (0.85 * alpha) + ')');
    grad.addColorStop(0.35, 'rgba(200,225,255,' + (0.35 * alpha) + ')');
    grad.addColorStop(1, 'rgba(200,225,255,0)');

    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + px * width + dx * midLen, y + py * width + dy * midLen);
    ctx.lineTo(x + dx * length, y + dy * length);
    ctx.lineTo(x - px * width + dx * midLen, y - py * width + dy * midLen);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
  }

  function drawOrb(now) {
    var x = orb.x, y = orb.y;
    var flicker = 0.92 + 0.08 * Math.sin(now / 90 + orb.flickerSeed);
    var pulse = 1 + 0.05 * Math.sin(now / 260 + orb.flickerSeed);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    // 外側のやわらかい青白いグロー(大きくぼかす)
    ctx.filter = 'blur(30px)';
    var r1 = 110 * pulse;
    var g1 = ctx.createRadialGradient(x, y, 0, x, y, r1);
    g1.addColorStop(0, 'rgba(130,180,255,' + 0.58 * flicker + ')');
    g1.addColorStop(1, 'rgba(130,180,255,0)');
    ctx.fillStyle = g1;
    ctx.beginPath(); ctx.arc(x, y, r1, 0, Math.PI * 2); ctx.fill();

    // 中間のグロー
    ctx.filter = 'blur(10px)';
    var g2 = ctx.createRadialGradient(x, y, 0, x, y, 46);
    g2.addColorStop(0, 'rgba(205,228,255,' + 0.9 * flicker + ')');
    g2.addColorStop(1, 'rgba(205,228,255,0)');
    ctx.fillStyle = g2;
    ctx.beginPath(); ctx.arc(x, y, 46, 0, Math.PI * 2); ctx.fill();

    // 星形・十字状の光芒(6方向 + 斜め6方向で華やかに)
    ctx.filter = 'blur(1.5px)';
    var baseAngle = orb.spikeAngleOffset + now * 0.00006; // ごくゆっくり回転して華やかさを出す
    var mainLen = 52 * flicker;
    var subLen = 27 * flicker;
    var mainCount = 6, subCount = 6;
    for (var i = 0; i < mainCount; i++) {
      drawSpike(x, y, baseAngle + (Math.PI * 2 / mainCount) * i, mainLen, 2.2, 1);
    }
    for (var j = 0; j < subCount; j++) {
      drawSpike(x, y, baseAngle + (Math.PI / subCount) + (Math.PI * 2 / subCount) * j, subLen, 1.4, 0.55);
    }

    // 中心の白飛びコア(ほぼぼかさない)
    ctx.filter = 'none';
    var g3 = ctx.createRadialGradient(x, y, 0, x, y, 13);
    g3.addColorStop(0, 'rgba(255,255,255,1)');
    g3.addColorStop(0.55, 'rgba(255,255,255,0.95)');
    g3.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g3;
    ctx.beginPath(); ctx.arc(x, y, 13, 0, Math.PI * 2); ctx.fill();

    ctx.restore();
  }

  // ---- メインループ ----
  var lastFrameTime = performance.now();

  function frame(now) {
    var dt = Math.min(0.05, (now - lastFrameTime) / 1000);
    lastFrameTime = now;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (state === 'active' || state === 'transforming') {
      // 完全な黒ではなく薄い黒で塗ることで、光の軌跡がふんわり残る。
      // TRAIL_FADE_ALPHAは60fps基準の1フレームあたりの値なので、実際のフレーム間隔(dt)に
      // 合わせて補正する。これをしないと、画面収録中など端末の描画が遅くなった時に
      // 「1フレームごとの薄まり方」は同じでもフレーム数自体が減るため、実時間では
      // 消えるまでに何倍も時間がかかってしまう(発射点の跡が長く残って見える主因だった)。
      var fadeAlpha = 1 - Math.pow(1 - TRAIL_FADE_ALPHA, dt * 60);
      ctx.fillStyle = 'rgba(0,0,0,' + fadeAlpha + ')';
    } else {
      ctx.fillStyle = '#000';
    }
    ctx.fillRect(0, 0, W, H);

    if (state === 'active' && orb) {
      if (draggingOrb) {
        updateOrbDragging(now, dt);
      } else {
        updateOrb(now, dt);
      }
    } else if (state === 'transforming' && orb) {
      updateTransforming(now, dt);
    } else if (state === 'item' && item) {
      updateItemFloating(now);
    }
    updateSparkles(now, dt);

    if ((state === 'active' || state === 'transforming') && orb) {
      drawTrail(now);
    }
    if (sparkles.length) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (var i = 0; i < sparkles.length; i++) drawSparkle(sparkles[i], now);
      ctx.restore();
    }
    if (state === 'active' && orb) {
      drawOrb(now);
    } else if (state === 'transforming' && orb) {
      if (transformInfo && transformInfo.crossfadeT != null) {
        var ct = transformInfo.crossfadeT;

        // 光球は縮みながら崩れて消えていく(粒子が受け継ぐので、輪郭が砕ける感覚を残しつつ手早く)
        var orbShrinkT = Math.min(1, ct / 0.26);
        var orbAlpha = Math.max(0, 1 - orbShrinkT);
        if (orbAlpha > 0.001) {
          var orbScale = 1 - 0.45 * orbShrinkT;
          ctx.save();
          ctx.globalAlpha = orbAlpha;
          ctx.translate(orb.x, orb.y);
          ctx.scale(orbScale, orbScale);
          ctx.translate(-orb.x, -orb.y);
          drawOrb(now);
          ctx.restore();
        }

        if (transformInfo.particles) {
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          var plist = transformInfo.particles;
          for (var pi = 0; pi < plist.length; pi++) {
            var ps = getParticleState(plist[pi], ct);
            if (ps.alpha <= 0.01) continue;
            var d = plist[pi].size;
            var dw = d * plist[pi].squashX, dh = d * plist[pi].squashY; // 真ん丸すぎないよう楕円に伸縮
            ctx.globalAlpha = ps.alpha * 0.7; // 以前より控えめな透明度にする
            ctx.drawImage(plist[pi].sprite, ps.x - dw, ps.y - dh, dw * 2, dh * 2);
          }
          ctx.restore();
        }

        // 光が集まった場所から円形に開いて、アイテムを写し出す
        drawRevealedItem(transformInfo.cx, getItemRestY(), ct, now);
      } else {
        drawOrb(now);
      }
    } else if (state === 'item' && item) {
      drawItem(item.x, item.y, 1, itemScale, now);
    }

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // js/crop.js(切り抜き機能)・js/size.js(サイズ調整機能)から呼ぶための最小限の公開窓口
  window.LFDItems = {
    addBlobAsItem: addBlobAsItem,
    getItemSrc: getItemSrcById,
    getItemScale: getItemScaleById,
    setItemScale: setItemScaleById,
    DEFAULT_ITEM_ID: DEFAULT_ITEM_ID
  };

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }
})();
