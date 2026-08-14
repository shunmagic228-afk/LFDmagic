(function () {
  'use strict';

  // ---- 設定値 ----
  var SCHEDULE_DELAY_MS = 3000;   // ダブルタップ認識から発動までの待機
  var DOUBLE_TAP_MAX_INTERVAL = 300; // ダブルタップとみなす最大間隔(ms)
  var TAP_MAX_DURATION  = 250;    // タップとみなす最大接触時間(ms) これを超えたら長押し扱い
  var TAP_MAX_MOVEMENT  = 18;     // タップとみなす最大移動量(px) これを超えたらスワイプ扱い
  var ORB_HIT_RADIUS    = 70;     // 光球にタップで触れたと判定する半径(px)
  var BOUNDARY_MARGIN   = 120;    // 画面端からこの距離より内側に留めるソフト境界
  var BURST_PHASE_MS    = 550;    // 飛び込みの勢いを残す時間
  var TILT_STRENGTH     = 20;     // 端末の傾き1度あたりの加速度の強さ

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

  function rand(a, b) { return a + Math.random() * (b - a); }

  // ---- 状態管理 ----
  // 'idle' | 'waiting'(3秒待機中) | 'active'(光球が画面内に存在)
  var state = 'idle';
  var orb = null;
  var sparkles = [];

  // ---- 端末の傾き(ジャイロ)----
  var tiltAX = 0, tiltAY = 0;
  var tiltRequested = false;

  function onOrientation(e) {
    if (e.beta === null || e.gamma === null) return;
    // gamma: 左右の傾き(-90〜90) / beta: 縦持ち時の前後の傾き(90が自然な直立)
    tiltAX = Math.max(-35, Math.min(35, e.gamma));
    tiltAY = Math.max(-35, Math.min(35, e.beta - 90));
  }

  function enableTilt() {
    if (tiltRequested) return;
    tiltRequested = true;
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      DeviceOrientationEvent.requestPermission().then(function (res) {
        if (res === 'granted') window.addEventListener('deviceorientation', onOrientation);
      }).catch(function () {});
    } else {
      window.addEventListener('deviceorientation', onOrientation);
    }
  }

  // ---- タップ検出(誤作動防止つき) ----
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

    handleTap(e.clientX, e.clientY, performance.now());
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

  function handleTap(x, y, now) {
    if (state === 'active') {
      // 光球そのものに触れた場合のみカットアウトで消す
      if (orb && Math.hypot(x - orb.x, y - orb.y) <= ORB_HIT_RADIUS) {
        cutOutOrb();
      }
      lastTapTime = 0;
      return;
    }

    if (state !== 'idle') { lastTapTime = 0; return; } // 待機中は一切無視

    if (lastTapTime !== 0 && (now - lastTapTime) <= DOUBLE_TAP_MAX_INTERVAL) {
      // ダブルタップ成立(このタップ位置から光が入る)
      lastTapTime = 0;
      onDoubleTap(x, y);
    } else {
      lastTapTime = now;
    }
  }

  function onDoubleTap(x, y) {
    enableTilt(); // ユーザー操作の中で呼ぶ必要があるためここで許可を求める
    state = 'waiting';
    setTimeout(function () {
      if (state !== 'waiting') return;
      spawnOrb(x, y);
      state = 'active';
    }, SCHEDULE_DELAY_MS);
  }

  function cutOutOrb() {
    orb = null;
    sparkles.length = 0;
    state = 'idle';
  }

  // ---- キラキラ粒子 ----
  function addSparkle(x, y, vx, vy, life) {
    sparkles.push({ x: x, y: y, vx: vx, vy: vy, born: performance.now(), life: life, size: rand(1.4, 3.2) });
  }

  function spawnBurstSparkles(x, y) {
    var n = 26;
    for (var i = 0; i < n; i++) {
      var a = rand(0, Math.PI * 2);
      var sp = rand(60, 320);
      addSparkle(x, y, Math.cos(a) * sp, Math.sin(a) * sp, rand(400, 900));
    }
  }

  function updateSparkles(now, dt) {
    for (var i = sparkles.length - 1; i >= 0; i--) {
      var s = sparkles[i];
      if (now - s.born >= s.life) { sparkles.splice(i, 1); continue; }
      s.vx *= (1 - Math.min(1, dt * 1.5));
      s.vy *= (1 - Math.min(1, dt * 1.5));
      s.x += s.vx * dt;
      s.y += s.vy * dt;
    }
  }

  function drawSparkle(s, now) {
    var t = (now - s.born) / s.life;
    if (t >= 1) return;
    var alpha = (1 - t) * (1 - t); // ふんわり減衰(イーズアウト)
    var r = s.size * 4;
    var g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, r);
    g.addColorStop(0, 'rgba(255,255,255,' + (0.9 * alpha) + ')');
    g.addColorStop(0.4, 'rgba(190,220,255,' + (0.5 * alpha) + ')');
    g.addColorStop(1, 'rgba(190,220,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2); ctx.fill();
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
      nextWanderAt: 0,
      wanderAngle: angle,
      flickerSeed: Math.random() * 1000,
      spikeAngleOffset: rand(0, Math.PI / 4)
    };
    spawnBurstSparkles(x, y);
  }

  function updateOrb(now, dt) {
    var elapsed = now - orb.bornAt;
    var curAngle = Math.atan2(orb.vy, orb.vx);
    var speed = Math.hypot(orb.vx, orb.vy);

    if (elapsed < BURST_PHASE_MS) {
      // 投げ込んだ勢いを残しながら自然に失速
      speed *= Math.max(0, 1 - dt * 2.0);
      orb.vx = Math.cos(curAngle) * speed;
      orb.vy = Math.sin(curAngle) * speed;
    } else {
      // 有機的な漂い + 端末の傾きに追従
      if (now > orb.nextWanderAt) {
        orb.wanderAngle = curAngle + rand(-1.2, 1.2);
        orb.nextWanderAt = now + rand(500, 1000);
      }
      var diff = orb.wanderAngle - curAngle;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      curAngle += diff * Math.min(1, dt * 1.6);

      var wanderSpeed = rand(50, 85);
      speed += (wanderSpeed - speed) * Math.min(1, dt * 1.1);

      orb.vx = Math.cos(curAngle) * speed;
      orb.vy = Math.sin(curAngle) * speed;

      orb.vx += tiltAX * TILT_STRENGTH * dt;
      orb.vy += tiltAY * TILT_STRENGTH * dt;

      var damp = Math.max(0, 1 - 1.4 * dt);
      orb.vx *= damp;
      orb.vy *= damp;
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

    // 軌跡に沿ってキラキラを残す(速度が出ているほど多く発生)
    var sp = Math.hypot(orb.vx, orb.vy);
    if (Math.random() < Math.min(0.85, sp / 700)) {
      addSparkle(orb.x, orb.y, -orb.vx * 0.06 + rand(-25, 25), -orb.vy * 0.06 + rand(-25, 25), rand(300, 600));
    }
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
    ctx.filter = 'blur(28px)';
    var r1 = 100 * pulse;
    var g1 = ctx.createRadialGradient(x, y, 0, x, y, r1);
    g1.addColorStop(0, 'rgba(130,180,255,' + 0.55 * flicker + ')');
    g1.addColorStop(1, 'rgba(130,180,255,0)');
    ctx.fillStyle = g1;
    ctx.beginPath(); ctx.arc(x, y, r1, 0, Math.PI * 2); ctx.fill();

    // 中間のグロー
    ctx.filter = 'blur(10px)';
    var g2 = ctx.createRadialGradient(x, y, 0, x, y, 44);
    g2.addColorStop(0, 'rgba(205,228,255,' + 0.88 * flicker + ')');
    g2.addColorStop(1, 'rgba(205,228,255,0)');
    ctx.fillStyle = g2;
    ctx.beginPath(); ctx.arc(x, y, 44, 0, Math.PI * 2); ctx.fill();

    // 星形・十字状の光芒(6方向 + 斜め6方向で華やかに)
    ctx.filter = 'blur(1.5px)';
    var baseAngle = orb.spikeAngleOffset + now * 0.00006; // ごくゆっくり回転して華やかさを出す
    var mainLen = 50 * flicker;
    var subLen = 26 * flicker;
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
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    if (state === 'active' && orb) {
      updateOrb(now, dt);
    }
    updateSparkles(now, dt);

    if (sparkles.length) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (var i = 0; i < sparkles.length; i++) drawSparkle(sparkles[i], now);
      ctx.restore();
    }
    if (state === 'active' && orb) {
      drawOrb(now);
    }

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
