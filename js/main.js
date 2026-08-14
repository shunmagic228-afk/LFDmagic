(function () {
  'use strict';

  // ---- 設定値 ----
  var DOUBLE_TAP_MAX_INTERVAL = 300; // ダブルタップとみなす最大間隔(ms)
  var TAP_MAX_DURATION  = 250;    // タップとみなす最大接触時間(ms) これを超えたら長押し扱い
  var TAP_MAX_MOVEMENT  = 18;     // タップとみなす最大移動量(px) これを超えたらスワイプ扱い
  var ORB_HIT_RADIUS    = 70;     // 光球にタップで触れたと判定する半径(px)
  var BOUNDARY_MARGIN   = 90;     // 画面端からこの距離より内側に留めるソフト境界
  var BURST_PHASE_MS    = 550;    // 飛び込みの勢いを残す時間

  var TILT_STRENGTH  = 42;   // 傾き1度あたりの加速度の強さ(重力の強さ。画面全体を動かす主動力)
  var TILT_DRAG      = 1.1;  // 傾き反映後の速度減衰(大きいほど追従が機敏で止まりやすい)
  var TILT_MAX_SPEED = 760;  // 傾きによる速度の上限(px/s、暴走防止)
  var JITTER_MAG      = 18;  // ふわふわとした有機的な揺らぎの強さ

  var TRAIL_FADE_ALPHA = 0.15; // 光球が存在する間、画面を完全な黒ではなく薄い黒で塗って光跡を残す

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
  // 'idle' | 'active'(光球が画面内に存在)
  var state = 'idle';
  var orb = null;
  var sparkles = [];

  // ---- 端末の傾き(ジャイロ)----
  // 注意: iOSの仕様上、モーションセンサーの許可はページの読み込みごとに
  // 必要で、Webアプリでは許可状態を恒久的に保存する手段がない(全サイト共通の制約)。
  var tiltAX = 0, tiltAY = 0;
  var tiltRequested = false;
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

    if (lastTapTime !== 0 && (now - lastTapTime) <= DOUBLE_TAP_MAX_INTERVAL) {
      // ダブルタップ成立 → 2タップ目と同時にこの位置から光が入る
      lastTapTime = 0;
      onDoubleTap(x, y);
    } else {
      lastTapTime = now;
    }
  }

  function onDoubleTap(x, y) {
    enableTilt(); // ユーザー操作の中で呼ぶ必要があるためここで許可を求める
    resetTiltBaseline(); // 今この瞬間に構えている持ち方を新しい基準にする
    spawnOrb(x, y);
    state = 'active';
  }

  function cutOutOrb() {
    orb = null;
    sparkles.length = 0;
    state = 'idle';
  }

  // ---- キラキラ粒子 ----
  function addSparkle(x, y, vx, vy, life) {
    sparkles.push({ x: x, y: y, vx: vx, vy: vy, born: performance.now(), life: life, size: rand(1.0, 4.2) });
  }

  function spawnBurstSparkles(x, y) {
    var n = 100;
    for (var i = 0; i < n; i++) {
      var a = rand(0, Math.PI * 2);
      var sp = rand(40, 460);
      addSparkle(x, y, Math.cos(a) * sp, Math.sin(a) * sp, rand(450, 1400));
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
    var g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, r);
    g.addColorStop(0, 'rgba(255,255,255,' + (0.9 * alpha) + ')');
    g.addColorStop(0.4, 'rgba(190,220,255,' + (0.5 * alpha) + ')');
    g.addColorStop(1, 'rgba(190,220,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2); ctx.fill();
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

    // 軌跡に沿ってキラキラを残す(しつこく多めに)
    var sp = Math.hypot(orb.vx, orb.vy);
    var rate = Math.min(0.98, 0.32 + sp / 450);
    if (Math.random() < rate) {
      addSparkle(orb.x, orb.y, -orb.vx * 0.05 + rand(-35, 35), -orb.vy * 0.05 + rand(-35, 35), rand(500, 1300));
    }
    if (Math.random() < rate * 0.6) {
      addSparkle(orb.x + rand(-6, 6), orb.y + rand(-6, 6), -orb.vx * 0.03 + rand(-45, 45), -orb.vy * 0.03 + rand(-45, 45), rand(400, 900));
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
    if (state === 'active') {
      // 完全な黒ではなく薄い黒で塗ることで、光の軌跡がふんわり残る
      ctx.fillStyle = 'rgba(0,0,0,' + TRAIL_FADE_ALPHA + ')';
    } else {
      ctx.fillStyle = '#000';
    }
    ctx.fillRect(0, 0, W, H);

    if (state === 'active' && orb) {
      updateOrb(now, dt);
    }
    updateSparkles(now, dt);

    if (state === 'active' && orb) {
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
    }

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
