(function () {
  'use strict';

  // ---- 設定値 ----
  var SCHEDULE_DELAY_MS = 3000;   // ダブルタップ認識から発動までの待機
  var ORB_LIFETIME_MS   = 5300;   // 光球が出てから消えるまでの合計時間(飛び込み含む)
  var CONVERGE_START_T  = 0.62;   // このタイミング(0-1)から中央収束を開始
  var DOUBLE_TAP_MAX_INTERVAL = 300; // ダブルタップとみなす最大間隔(ms)
  var TAP_MAX_DURATION  = 250;    // タップとみなす最大接触時間(ms) これを超えたら長押し扱い
  var TAP_MAX_MOVEMENT  = 18;     // タップとみなす最大移動量(px) これを超えたらスワイプ扱い

  var canvas = document.getElementById('stage');
  var ctx = canvas.getContext('2d');

  var dpr = 1;
  var W = 0, H = 0; // CSSピクセル単位の論理サイズ

  function resize() {
    dpr = Math.max(1, window.devicePixelRatio || 1);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);
  resize();

  // ---- 状態管理 ----
  // 'idle' | 'waiting'(3秒待機中) | 'playing'(光球アニメ中)
  var state = 'idle';
  var orb = null;

  // ---- ダブルタップ検出(誤作動防止つき) ----
  var lastTapTime = 0;
  var activePointerId = null;
  var pointerStartX = 0, pointerStartY = 0, pointerStartT = 0;
  var pointerMoved = false;

  function onPointerDown(e) {
    // 同時に複数の指が触れている場合は誤作動防止のため一切無視する
    if (activePointerId !== null) {
      activePointerId = null;
      lastTapTime = 0;
      return;
    }
    if (e.button !== undefined && e.button !== 0) return; // 右クリック等は無視

    activePointerId = e.pointerId;
    pointerStartX = e.clientX;
    pointerStartY = e.clientY;
    pointerStartT = performance.now();
    pointerMoved = false;
  }

  function onPointerMove(e) {
    if (e.pointerId !== activePointerId) return;
    var dx = e.clientX - pointerStartX;
    var dy = e.clientY - pointerStartY;
    if (Math.sqrt(dx * dx + dy * dy) > TAP_MAX_MOVEMENT) {
      pointerMoved = true;
    }
  }

  function onPointerUp(e) {
    if (e.pointerId !== activePointerId) return;
    activePointerId = null;

    var duration = performance.now() - pointerStartT;
    var isValidTap = !pointerMoved && duration <= TAP_MAX_DURATION;

    if (!isValidTap) {
      // 長押し・スワイプ・その他 → 何もしない。連続タップの流れも破棄する
      lastTapTime = 0;
      return;
    }

    var now = performance.now();
    if (lastTapTime !== 0 && (now - lastTapTime) <= DOUBLE_TAP_MAX_INTERVAL) {
      // ダブルタップ成立
      lastTapTime = 0;
      onDoubleTap();
    } else {
      lastTapTime = now;
    }
  }

  function onPointerCancel(e) {
    if (e.pointerId === activePointerId) {
      activePointerId = null;
    }
    lastTapTime = 0;
  }

  canvas.addEventListener('pointerdown', onPointerDown, { passive: true });
  canvas.addEventListener('pointermove', onPointerMove, { passive: true });
  canvas.addEventListener('pointerup', onPointerUp, { passive: true });
  canvas.addEventListener('pointercancel', onPointerCancel, { passive: true });
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  document.addEventListener('gesturestart', function (e) { e.preventDefault(); });

  function onDoubleTap() {
    if (state !== 'idle') return; // 待機中・再生中は無視(見た目上の変化は起こさない)
    state = 'waiting';
    setTimeout(function () {
      if (state !== 'waiting') return;
      spawnOrb();
      state = 'playing';
    }, SCHEDULE_DELAY_MS);
  }

  // ---- 光球の物理・見た目 ----
  function rand(a, b) { return a + Math.random() * (b - a); }

  function spawnOrb() {
    var margin = 70;
    var edge = Math.floor(Math.random() * 4); // 0:左 1:右 2:上 3:下
    var x, y;
    if (edge === 0) { x = -margin; y = rand(H * 0.15, H * 0.85); }
    else if (edge === 1) { x = W + margin; y = rand(H * 0.15, H * 0.85); }
    else if (edge === 2) { x = rand(W * 0.15, W * 0.85); y = -margin; }
    else { x = rand(W * 0.15, W * 0.85); y = H + margin; }

    // 画面内のどこか(中心付近ではないランダムな一点)へ勢いよく飛び込む初速
    var targetX = rand(W * 0.28, W * 0.72);
    var targetY = rand(H * 0.28, H * 0.72);
    var dx = targetX - x, dy = targetY - y;
    var dist = Math.hypot(dx, dy) || 1;
    var speed = rand(1500, 1900); // px/s の初速(勢いよく飛び込む)

    orb = {
      x: x, y: y,
      vx: (dx / dist) * speed,
      vy: (dy / dist) * speed,
      spawnTime: performance.now(),
      nextWanderAt: 0,
      wanderAngle: Math.atan2(dy, dx),
      flickerSeed: Math.random() * 1000,
      spikeAngleOffset: rand(0, Math.PI / 4)
    };
  }

  function updateOrb(now, dt) {
    var elapsed = now - orb.spawnTime;
    var t = elapsed / ORB_LIFETIME_MS;
    if (t >= 1) {
      orb = null;
      state = 'idle';
      return;
    }

    var curAngle = Math.atan2(orb.vy, orb.vx);
    var speed = Math.hypot(orb.vx, orb.vy);

    // 一定間隔で「ふわっと」方向を揺らす目標角度を更新(有機的な漂い)
    if (now > orb.nextWanderAt) {
      orb.wanderAngle = curAngle + rand(-1.3, 1.3);
      orb.nextWanderAt = now + rand(450, 900);
    }

    // 角度をなめらかに目標へ寄せる(慣性を感じる動き)
    var diff = orb.wanderAngle - curAngle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    curAngle += diff * Math.min(1, dt * 1.8);

    // 速度は徐々に「漂う速さ」へ減衰し、勢いを自然に残しながら失速していく
    var wanderSpeed = rand(70, 110);
    var speedBlend = Math.min(1, dt * 1.1);
    speed += (wanderSpeed - speed) * speedBlend;

    orb.vx = Math.cos(curAngle) * speed;
    orb.vy = Math.sin(curAngle) * speed;

    // ソフトな画面端の反発(漂い中に画面外へ出過ぎないように)
    var margin = 90;
    if (orb.x < margin) orb.vx += (margin - orb.x) * 6 * dt;
    if (orb.x > W - margin) orb.vx -= (orb.x - (W - margin)) * 6 * dt;
    if (orb.y < margin) orb.vy += (margin - orb.y) * 6 * dt;
    if (orb.y > H - margin) orb.vy -= (orb.y - (H - margin)) * 6 * dt;

    // 終盤は中央へゆるやかに収束
    if (t > CONVERGE_START_T) {
      var ct = (t - CONVERGE_START_T) / (1 - CONVERGE_START_T); // 0-1
      var cx = W / 2, cy = H / 2;
      var pull = ct * ct * 3.2;
      orb.vx += (cx - orb.x) * pull * dt;
      orb.vy += (cy - orb.y) * pull * dt;
      var damp = 1 - Math.min(0.9, ct * dt * 2.5);
      orb.vx *= damp;
      orb.vy *= damp;
    }

    orb.x += orb.vx * dt;
    orb.y += orb.vy * dt;
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

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    // 外側のやわらかい青白いグロー(大きくぼかす)
    ctx.filter = 'blur(26px)';
    var g1 = ctx.createRadialGradient(x, y, 0, x, y, 95);
    g1.addColorStop(0, 'rgba(130,180,255,' + 0.5 * flicker + ')');
    g1.addColorStop(1, 'rgba(130,180,255,0)');
    ctx.fillStyle = g1;
    ctx.beginPath(); ctx.arc(x, y, 95, 0, Math.PI * 2); ctx.fill();

    // 中間のグロー
    ctx.filter = 'blur(10px)';
    var g2 = ctx.createRadialGradient(x, y, 0, x, y, 42);
    g2.addColorStop(0, 'rgba(205,228,255,' + 0.85 * flicker + ')');
    g2.addColorStop(1, 'rgba(205,228,255,0)');
    ctx.fillStyle = g2;
    ctx.beginPath(); ctx.arc(x, y, 42, 0, Math.PI * 2); ctx.fill();

    // 星形・十字状の光芒(4方向 + 斜め4方向、長さをずらして自然に)
    ctx.filter = 'blur(1.5px)';
    var baseAngle = orb.spikeAngleOffset;
    var mainLen = 46 * flicker;
    var subLen = 24 * flicker;
    for (var i = 0; i < 4; i++) {
      drawSpike(x, y, baseAngle + (Math.PI / 2) * i, mainLen, 2.4, 1);
    }
    for (var j = 0; j < 4; j++) {
      drawSpike(x, y, baseAngle + Math.PI / 4 + (Math.PI / 2) * j, subLen, 1.6, 0.6);
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
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    if (state === 'playing' && orb) {
      updateOrb(now, dt);
      if (orb) drawOrb(now); // updateOrb内で寿命終了時にorb=nullになる(カットアウト)
    }

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
