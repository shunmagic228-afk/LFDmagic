(function () {
  'use strict';

  // このファイルは「サイズ調整」画面専用。アイテムを新規登録する直前(通常アップロード・
  // 切り抜きの両方)と、登録済みアイテムの表示サイズを後から編集する時の、どちらからも
  // 呼ばれる共通の窓口(window.LFDSize)を提供する。実際の登録・保存はwindow.LFDItems経由で行う。

  // 本番の光球演出(js/main.js)のITEM_DISPLAY_HEIGHTと同じ値。ここでのプレビューが
  // 実際の画面表示と同じ大きさになるように合わせる(この値がズレるとサイズ調整の意味がなくなる)。
  var ITEM_DISPLAY_HEIGHT = 420;
  var ITEM_REST_Y_RATIO = 0.42;

  var settingsScreen = document.getElementById('settingsScreen');
  var cropEntryScreen = document.getElementById('cropEntryScreen');
  var cropAutoScreen = document.getElementById('cropAutoScreen');
  var cropManualScreen = document.getElementById('cropManualScreen');

  var sizeScreen = document.getElementById('sizeScreen');
  var sizeCanvas = document.getElementById('sizeCanvas');
  var sizeSlider = document.getElementById('sizeSlider');
  var sizePercentLabel = document.getElementById('sizePercentLabel');
  var sizeBackBtn = document.getElementById('sizeBackBtn');
  var sizeConfirmBtn = document.getElementById('sizeConfirmBtn');

  var currentImg = null;
  var ownedObjectUrl = null; // 自分でcreateObjectURLした場合だけ、閉じる時に解放する
  var pendingBlob = null, pendingName = null;
  var editingItemId = null;
  var screenOpen = false;

  function setupCanvasDPR(canvas) {
    var dpr = Math.max(1, window.devicePixelRatio || 1);
    var cw = canvas.clientWidth, ch = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(cw * dpr));
    canvas.height = Math.max(1, Math.round(ch * dpr));
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  function hideOtherScreens() {
    settingsScreen.classList.add('hidden');
    cropEntryScreen.classList.add('hidden');
    cropAutoScreen.classList.add('hidden');
    cropManualScreen.classList.add('hidden');
  }

  function updatePercentLabel() {
    sizePercentLabel.textContent = sizeSlider.value + '%';
  }

  function renderSizePreview() {
    if (!screenOpen) return;
    var ctx = setupCanvasDPR(sizeCanvas);
    var cw = sizeCanvas.clientWidth, ch = sizeCanvas.clientHeight;
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cw, ch);
    if (!currentImg) return;

    var percent = Number(sizeSlider.value);
    var ratio = currentImg.naturalWidth / currentImg.naturalHeight;
    var h = ITEM_DISPLAY_HEIGHT * (percent / 100);
    var w = h * ratio;
    var cx = cw / 2, cy = ch * ITEM_REST_Y_RATIO;
    ctx.drawImage(currentImg, cx - w / 2, cy - h / 2, w, h);
  }

  function loadImageAndOpen(src, initialScale) {
    var img = new Image();
    img.onload = function () {
      currentImg = img;
      sizeSlider.value = Math.round(initialScale * 100);
      updatePercentLabel();
      sizeScreen.classList.remove('hidden');
      screenOpen = true;
      requestAnimationFrame(renderSizePreview);
    };
    img.onerror = function () {
      window.alert('画像の読み込みに失敗しました');
      cleanupAndReturn();
    };
    img.src = src;
  }

  function openForNewItem(blob, name) {
    hideOtherScreens();
    editingItemId = null;
    pendingBlob = blob;
    pendingName = name;
    var url = URL.createObjectURL(blob);
    ownedObjectUrl = url;
    loadImageAndOpen(url, 1);
  }

  function openForExistingItem(id) {
    hideOtherScreens();
    editingItemId = id;
    pendingBlob = null;
    pendingName = null;
    ownedObjectUrl = null;
    loadImageAndOpen(window.LFDItems.getItemSrc(id), window.LFDItems.getItemScale(id));
  }

  function cleanupAndReturn() {
    screenOpen = false;
    if (ownedObjectUrl) { URL.revokeObjectURL(ownedObjectUrl); ownedObjectUrl = null; }
    currentImg = null;
    pendingBlob = null;
    pendingName = null;
    editingItemId = null;
    sizeScreen.classList.add('hidden');
    settingsScreen.classList.remove('hidden');
  }

  sizeSlider.addEventListener('input', function () {
    updatePercentLabel();
    renderSizePreview();
  });

  sizeBackBtn.addEventListener('click', cleanupAndReturn);

  sizeConfirmBtn.addEventListener('click', function () {
    var percent = Number(sizeSlider.value) / 100;
    if (editingItemId) {
      window.LFDItems.setItemScale(editingItemId, percent);
      cleanupAndReturn();
    } else if (pendingBlob) {
      window.LFDItems.addBlobAsItem(pendingBlob, pendingName, percent).then(function () {
        cleanupAndReturn();
      }).catch(function () {
        window.alert('アイテムの追加に失敗しました');
      });
    }
  });

  window.addEventListener('resize', function () {
    if (screenOpen) renderSizePreview();
  });

  window.LFDSize = {
    openForNewItem: openForNewItem,
    openForExistingItem: openForExistingItem
  };
})();
