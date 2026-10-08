/* Lantern Night client: draws the live night (darkness, lanterns, lamps, critters) and the
   morning footprint map. The server decides what you can see; this file only draws it.

   Smoothness tricks:
   - Your own critter moves right here in the browser (no waiting for the server). The server
     double-checks every step and only corrects you if something is off.
   - Everyone else is drawn a moment in the past and slid smoothly between server updates.
   - The village itself is painted once into a hidden canvas and reused every frame. */
(() => {
  const { CRITTERS, COLORS, HATS } = window.HH;
  const SIZE_R = { small: 1.55, medium: 1.95, large: 2.4 };
  const BODY = 1.3;
  const INTERP_DELAY = 0.16;       // seconds: how far in the past other critters are drawn
  const SEND_EVERY = 66;           // ms between position updates (15 a second)
  const cottageCache = {};

  let api = null, canvas = null, ctx = null, dark = null, dctx = null, mini = null, mctx = null;
  let running = false, raf = 0, lastT = 0;
  let frame = null, buf = [], clockOff = null;
  let me = null;                   // { x, y } your critter, simulated locally
  let litLocal = true, litPendingUntil = 0;
  let lastSent = { x: -1, y: -1 }, lastSendAt = 0;
  const keys = new Set();
  let touchDir = null, holding = false, localHold = null, lastHoldSend = 0;
  let tasks = [], tasksOpen = null, mark = null, lastBells;
  let worldCv = null, worldKey = '', miniKey = '', miniStatic = null;

  // ---------- helpers ----------
  const $ = (s) => document.querySelector(s);
  const P = (id) => api && api.P(id);
  const G = () => api && api.game();
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const DPR = () => Math.min(window.devicePixelRatio || 1, 1.5); // full retina is too heavy for a live canvas
  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function cottage(color) {
    if (cottageCache[color]) return cottageCache[color];
    const roof = (COLORS[color] || COLORS.honey).hex;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 56"><g stroke="#2B2233" stroke-width="3" stroke-linejoin="round">
      <rect x="43" y="7" width="7" height="13" rx="1.5" fill="#C98B5E"/><path d="M4 29 L32 5 L60 29 Z" fill="${roof}"/>
      <rect x="10" y="27" width="44" height="26" rx="3" fill="#FFF8EC"/><rect x="15" y="33" width="12" height="10" rx="2" fill="#FFD66B"/>
      <rect x="35" y="35" width="12" height="18" rx="6" fill="#B7845A"/></g></svg>`;
    const img = new Image(); img.onload = () => { worldKey = ''; }; img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    cottageCache[color] = img; return img;
  }

  // Same collision rules as the server, so your local walking matches what it accepts
  function collide(W, p) {
    p.x = clamp(p.x, 2, 98); p.y = clamp(p.y, 2, 98);
    for (const s of W.homes.concat(W.landmarks)) {
      const r = s.r || 4, d = Math.hypot(p.x - s.x, p.y - s.y), min = r + BODY;
      if (d < min) { const k = (min - d) / (d || 1); p.x += (p.x - s.x) * k; p.y += (p.y - s.y) * k; }
    }
    const P0 = W.pond, ex = (p.x - P0.x) / (P0.rx + BODY), ey = (p.y - P0.y) / (P0.ry + BODY), e = Math.hypot(ex, ey);
    if (e < 1) { const k = 1 / (e || 1); p.x = P0.x + (p.x - P0.x) * k; p.y = P0.y + (p.y - P0.y) * k; }
  }

  // ---------- setup ----------
  function mount() {
    canvas = $('#night-canvas'); ctx = canvas.getContext('2d');
    dark = document.createElement('canvas'); dctx = dark.getContext('2d');
    mini = $('#night-mini'); mctx = mini.getContext('2d');
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('blur', () => { keys.clear(); setHold(false); });
    canvas.addEventListener('pointerdown', onPointer);
    canvas.addEventListener('pointermove', onPointer);
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((e) => canvas.addEventListener(e, () => { touchDir = null; }));
    const act = $('#nb-act');
    act.addEventListener('pointerdown', (e) => { e.preventDefault(); if (lastPrompt && lastPrompt.kind === 'strike') tryStrike(); else setHold(true); });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((e) => act.addEventListener(e, () => setHold(false)));
    $('#nb-lantern').addEventListener('click', toggleLantern);
    $('#nb-tasks').addEventListener('click', () => { tasksOpen = !isTasksOpen(); renderTasks(); });
  }
  function typing() { const a = document.activeElement; return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT'); }
  function onKey(e) {
    if (!running || typing()) return;
    const k = e.key.toLowerCase();
    const move = ['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd'];
    if (move.includes(k)) { e.preventDefault(); if (e.type === 'keydown') keys.add(k); else keys.delete(k); }
    if (k === 'e' || k === ' ') { e.preventDefault(); if (e.type === 'keydown' && !e.repeat) setHold(true); if (e.type === 'keyup') setHold(false); }
    if ((k === 'q' || k === 'l') && e.type === 'keydown' && !e.repeat) toggleLantern();
    if (k === 'f' && e.type === 'keydown' && !e.repeat) { e.preventDefault(); tryStrike(); }
    if (k === 't' && e.type === 'keydown' && !e.repeat) { tasksOpen = !isTasksOpen(); renderTasks(); }
  }
  function onPointer(e) {
    if (!running || !me) return;
    if (e.type === 'pointermove' && !(e.buttons & 1) && e.pointerType === 'mouse') return;
    if (e.type === 'pointermove' && e.pointerType !== 'mouse' && !touchDir) return;
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const [mx, my] = toScreen(me.x, me.y, true);
    const dx = sx - mx, dy = sy - my, d = Math.hypot(dx, dy);
    touchDir = d < 14 ? { x: 0, y: 0 } : { x: dx / d, y: dy / d };
  }
  function toggleLantern() {
    if (!frame || !frame.me) return;
    litLocal = !litLocal; litPendingUntil = performance.now() + 800;
    api.send({ t: 'lantern', on: litLocal });
    localHold = null; hudKey = '';
  }
  function setHold(on) {
    if (holding === on) return;
    holding = on;
    flushPos(true); // make sure the server knows exactly where you are before it checks the target
    api.send({ t: 'hold', on }); lastHoldSend = performance.now();
    localHold = null;
    if (on) startLocalHold();
  }
  let lastPrompt = null, lastStrikeAt = 0;
  function tryStrike() {
    const g = G(); if (!g || !frame) return;
    const pr = prompt(g, lastSeen, lastLamps);
    if (!pr || pr.kind !== 'strike' || performance.now() - lastStrikeAt < 400) return;
    lastStrikeAt = performance.now();
    flushPos(true); // the server checks from exactly where you are
    api.send({ t: 'strike', target: pr.target });
  }
  function startLocalHold() {
    const g = G(); const pr = g && frame && prompt(g, lastSeen, lastLamps);
    if (pr && pr.kind) localHold = { kind: pr.kind, start: performance.now() };
  }
  function dir() {
    if (touchDir) return touchDir;
    let x = 0, y = 0;
    if (keys.has('arrowleft') || keys.has('a')) x -= 1;
    if (keys.has('arrowright') || keys.has('d')) x += 1;
    if (keys.has('arrowup') || keys.has('w')) y -= 1;
    if (keys.has('arrowdown') || keys.has('s')) y += 1;
    const l = Math.hypot(x, y); return l ? { x: x / l, y: y / l } : { x: 0, y: 0 };
  }
  function flushPos(force) {
    if (!me || !frame || !frame.me) return;
    const now = performance.now();
    if (!force && now - lastSendAt < SEND_EVERY) return;
    if (Math.abs(me.x - lastSent.x) < 0.01 && Math.abs(me.y - lastSent.y) < 0.01) return;
    api.send({ t: 'pos', x: +me.x.toFixed(2), y: +me.y.toFixed(2) });
    lastSent = { x: me.x, y: me.y }; lastSendAt = now;
  }

  // ---------- frames from the server ----------
  function onFrame(f) {
    const now = performance.now() / 1000;
    // a smoothed estimate of "server night time" on our clock, for interpolation
    const off = now - f.nt;
    clockOff = clockOff === null || Math.abs(off - clockOff) > 1 ? off : clockOff + (off - clockOff) * (off < clockOff ? 0.3 : 0.05);
    frame = f;
    buf.push({ nt: f.nt, see: new Map(f.see.map((x) => [x[0], x])) });
    while (buf.length > 12) buf.shift();
    if (f.me) {
      const sx = f.me[0], sy = f.me[1];
      if (!me || f.fix || Math.hypot(me.x - sx, me.y - sy) > 9) me = { x: sx, y: sy };
      if (performance.now() > litPendingUntil) litLocal = !!f.me[2];
      // the server dropped your hold (moved, target left, already done)? stop the fake progress ring
      if (f.me[3]) localHold && (localHold.seen = true);
      else if (localHold && (localHold.seen || performance.now() - localHold.start > 1200)) localHold = null;
    } else me = null;
    if (f.bells !== lastBells) { lastBells = f.bells; if (!f.tasks) renderTasks(); }
    if (f.tasks) { tasks = f.tasks; renderTasks(); api.onTasks && api.onTasks(tasks); }
    if (f.ev) for (const e of f.ev) {
      showBanner(e);
      if (e.target) mark = e.target;
      localHold = null;
    }
  }
  function setTasks(t) { if (t && (!tasks.length || t.length !== tasks.length || t.some((x, i) => x.done !== tasks[i].done))) { tasks = t; renderTasks(); } }

  // ---------- camera ----------
  const cam = { x: 50, y: 50, scale: 10 };
  function toScreen(x, y, css) {
    const w = css ? canvas.clientWidth : canvas.width, h = css ? canvas.clientHeight : canvas.height;
    const s = css ? cam.scale / DPR() : cam.scale;
    return [(x - cam.x) * s + w / 2, (y - cam.y) * s + h / 2];
  }

  // ---------- main loop ----------
  function start(a) {
    api = a;
    if (!canvas) mount();
    if (running) return;
    running = true; frame = null; buf = []; clockOff = null; me = null; holding = false; localHold = null; keys.clear(); touchDir = null;
    tasks = []; mark = null; litLocal = true; litPendingUntil = 0; lastSent = { x: -1, y: -1 }; hudKey = ''; bannerQ = [];
    const g = G(); if (g && g.nightTasks) { tasks = g.nightTasks; }
    if (g && g.myAction) mark = g.myAction.target;
    renderTasks();
    lastT = performance.now();
    raf = requestAnimationFrame(loop);
  }
  function stop() {
    if (!running) return;
    running = false; cancelAnimationFrame(raf); keys.clear(); touchDir = null;
    if (holding) { holding = false; try { api.send({ t: 'hold', on: false }); } catch (e) { /* ignore */ } }
    $('#nb-banner') && ($('#nb-banner').className = 'nb-banner');
  }
  function loop(now) {
    if (!running) return;
    const dt = Math.min(0.1, (now - lastT) / 1000); lastT = now;
    const g = G();
    if (me && g && g.world && frame && frame.me) {
      const d = dir(), speed = (g.nightConst && g.nightConst.speed) || 13;
      if (d.x || d.y) {
        me.x += d.x * speed * dt; me.y += d.y * speed * dt; collide(g.world, me);
        if (localHold) localHold = null; // walking cancels a hold, same as on the server
      }
      flushPos(false);
      // still holding E, but the server isn't doing anything (you walked up to a door while holding)? ask again
      if (holding && !frame.me[3] && !localHold && now - lastHoldSend > 700) { flushPos(true); api.send({ t: 'hold', on: true }); lastHoldSend = now; startLocalHold(); }
    }
    try { draw(now); } catch (e) { console.error(e); }
    raf = requestAnimationFrame(loop);
  }

  function resize() {
    const dpr = DPR();
    const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const dw = Math.ceil(w / 2), dh = Math.ceil(h / 2); // the darkness layer is soft anyway: half resolution is plenty
    if (dark.width !== dw || dark.height !== dh) { dark.width = dw; dark.height = dh; }
  }

  // ---------- the village, painted once ----------
  function worldCanvas(g, s) {
    const ws = Math.min(s, 22); // pixels per world unit in the cached picture
    const key = [ws.toFixed(1), g.houses.join(','), g.alive.join(','), g.houses.map((h) => (P(h) || {}).color).join(',')].join('|');
    if (worldCv && key === worldKey) return { cv: worldCv, ws };
    worldKey = key;
    worldCv = worldCv || document.createElement('canvas');
    worldCv.width = Math.round(104 * ws); worldCv.height = Math.round(104 * ws);
    const c = worldCv.getContext('2d');
    c.fillStyle = '#0B0918'; c.fillRect(0, 0, worldCv.width, worldCv.height);
    drawWorld(c, g, ws, (x, y) => [(x + 2) * ws, (y + 2) * ws]);
    return { cv: worldCv, ws };
  }
  function drawWorld(c, g, s, sc) {
    const W = g.world;
    c.fillStyle = '#7DBE6A'; c.fillRect(sc(0, 0)[0], sc(0, 0)[1], 100 * s, 100 * s);
    const ringR = (W.homes.length > 10 ? 40 : 38) - 5.5;
    c.strokeStyle = '#E3CC98'; c.lineWidth = 4.2 * s; c.lineCap = 'round';
    c.beginPath(); const [cx, cy] = sc(50, 50); c.arc(cx, cy, ringR * s, 0, Math.PI * 2); c.stroke();
    for (const l of W.landmarks) {
      const a = Math.atan2(l.y - 50, l.x - 50);
      c.beginPath(); c.moveTo(...sc(50 + Math.cos(a) * ringR, 50 + Math.sin(a) * ringR)); c.lineTo(...sc(l.x, l.y)); c.stroke();
    }
    c.fillStyle = 'rgba(46,96,52,.35)';
    for (let i = 0; i < 90; i++) { const x = (i * 37.3) % 100, y = (i * 61.7 + 13) % 100; c.beginPath(); c.arc(...sc(x, y), 0.35 * s, 0, 7); c.fill(); }
    c.fillStyle = '#4C94D6'; c.strokeStyle = '#2B2233'; c.lineWidth = 0.45 * s;
    c.beginPath(); c.ellipse(cx, cy, W.pond.rx * s, W.pond.ry * s, 0, 0, Math.PI * 2); c.fill(); c.stroke();
    c.fillStyle = 'rgba(255,255,255,.35)'; c.beginPath(); c.ellipse(cx - 6 * s, cy - 5 * s, 3 * s, 1.6 * s, -0.3, 0, 7); c.fill();
    c.textAlign = 'center'; c.textBaseline = 'middle';
    for (const l of W.landmarks) {
      const [x, y] = sc(l.x, l.y);
      c.fillStyle = '#F2DDB6'; c.strokeStyle = '#2B2233'; c.lineWidth = 0.45 * s;
      roundRect(c, x - 5 * s, y - 3.6 * s, 10 * s, 7.4 * s, 1.2 * s); c.fill(); c.stroke();
      c.fillStyle = '#C0675A'; c.beginPath(); c.moveTo(x - 6 * s, y - 3.2 * s); c.lineTo(x, y - 7.4 * s); c.lineTo(x + 6 * s, y - 3.2 * s); c.closePath(); c.fill(); c.stroke();
      c.font = `${3.6 * s}px system-ui, "Apple Color Emoji", "Segoe UI Emoji"`; c.fillText(l.e, x, y + 0.2 * s);
      label(c, l.name, x, y + 5.4 * s, s, '#2B2233', '#FFF8EC');
    }
    for (const h of W.homes) {
      const p = P(h.id) || {}; const [x, y] = sc(h.x, h.y);
      const img = cottage(p.color || 'honey');
      if (img.complete) c.drawImage(img, x - 4.8 * s, y - 4.6 * s, 9.6 * s, 8.4 * s);
      label(c, `${p.name || '?'}`, x, y + 5.2 * s, s, '#2B2233', g.alive.includes(h.id) ? '#FFF8EC' : '#C9C2D6');
    }
    // the village bell
    if (W.bell) {
      const [bx, by] = sc(W.bell.x, W.bell.y);
      c.fillStyle = '#8A5A3C'; c.strokeStyle = '#2B2233'; c.lineWidth = 0.35 * s;
      c.fillRect(bx - 2.2 * s, by - 4.6 * s, 0.6 * s, 4.8 * s); c.strokeRect(bx - 2.2 * s, by - 4.6 * s, 0.6 * s, 4.8 * s);
      c.fillRect(bx + 1.6 * s, by - 4.6 * s, 0.6 * s, 4.8 * s); c.strokeRect(bx + 1.6 * s, by - 4.6 * s, 0.6 * s, 4.8 * s);
      c.beginPath(); c.moveTo(bx - 3 * s, by - 4.4 * s); c.lineTo(bx, by - 6.4 * s); c.lineTo(bx + 3 * s, by - 4.4 * s); c.closePath(); c.fillStyle = '#C0675A'; c.fill(); c.stroke();
      c.font = `${2.4 * s}px system-ui, "Apple Color Emoji", "Segoe UI Emoji"`; c.fillText('🔔', bx, by - 2.6 * s);
      label(c, 'Village bell', bx, by + 1.6 * s, s, '#2B2233', '#FFE9A8');
    }
    // street lamp posts (the bulbs are drawn live, since they turn on and off)
    for (const l of W.lamps) { const [x, y] = sc(l.x, l.y); c.fillStyle = '#4A3A30'; c.fillRect(x - 0.25 * s, y - 3.2 * s, 0.5 * s, 3.4 * s); }
  }
  function roundRect(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
  function label(c, text, x, y, s, ink, bg) {
    c.font = `800 ${1.55 * s}px Nunito, system-ui, sans-serif`;
    const w = c.measureText(text).width + 1.4 * s;
    c.fillStyle = bg; c.strokeStyle = ink; c.lineWidth = 0.28 * s;
    roundRect(c, x - w / 2, y - 1.1 * s, w, 2.2 * s, 1.1 * s); c.fill(); c.stroke();
    c.fillStyle = ink; c.fillText(text, x, y + 0.08 * s);
  }
  function critter(c, p, x, y, s, opts = {}) {
    if (!p) return;
    const cr = CRITTERS[p.critter] || CRITTERS.fox, r = SIZE_R[cr.size] * s;
    c.fillStyle = 'rgba(0,0,0,.25)'; c.beginPath(); c.ellipse(x, y + r * 0.9, r * 0.9, r * 0.35, 0, 0, 7); c.fill();
    c.fillStyle = (COLORS[p.color] || COLORS.honey).hex; c.strokeStyle = '#2B2233'; c.lineWidth = 0.38 * s;
    c.beginPath(); c.arc(x, y, r, 0, 7); c.fill(); c.stroke();
    c.font = `${r * 1.25}px system-ui, "Apple Color Emoji", "Segoe UI Emoji"`; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(cr.e, x, y + r * 0.08);
    if (HATS[p.hat]) { c.font = `${r * 0.8}px system-ui, "Apple Color Emoji"`; c.fillText(HATS[p.hat], x + r * 0.7, y - r * 0.85); }
    if (opts.lantern) { c.fillStyle = '#FFD66B'; c.strokeStyle = '#2B2233'; c.lineWidth = 0.25 * s; c.beginPath(); c.arc(x + r * 1.05, y + r * 0.35, 0.55 * s, 0, 7); c.fill(); c.stroke(); }
    label(c, p.name + (opts.me ? ' (you)' : ''), x, y - r - 1.7 * s, s, '#2B2233', opts.me ? '#FFB3C4' : '#FFF8EC');
    if (opts.progress) {
      c.strokeStyle = 'rgba(43,34,51,.55)'; c.lineWidth = 0.75 * s; c.beginPath(); c.arc(x, y, r + 0.9 * s, 0, 7); c.stroke();
      c.strokeStyle = opts.progressColor || '#FFD66B'; c.lineWidth = 0.6 * s;
      c.beginPath(); c.arc(x, y, r + 0.9 * s, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, opts.progress)); c.stroke();
    }
  }

  // Other critters, drawn INTERP_DELAY seconds in the past and slid between server updates
  function others() {
    if (!buf.length) return [];
    const target = performance.now() / 1000 - clockOff - INTERP_DELAY;
    let a = buf[0], b = buf[buf.length - 1];
    for (let i = buf.length - 1; i > 0; i--) { if (buf[i - 1].nt <= target) { a = buf[i - 1]; b = buf[i]; break; } }
    if (target >= b.nt) a = b;
    const k = a === b ? 1 : clamp((target - a.nt) / Math.max(0.01, b.nt - a.nt), 0, 1);
    const out = [];
    for (const [id, cur] of b.see) {
      const old = a.see.get(id);
      if (!old) { out.push({ id, x: cur[1], y: cur[2], lit: cur[3], hold: cur[4] }); continue; }
      const jump = Math.hypot(cur[1] - old[1], cur[2] - old[2]) > 8; // just appeared somewhere else: don't slide across the map
      out.push({ id, x: jump ? cur[1] : old[1] + (cur[1] - old[1]) * k, y: jump ? cur[2] : old[2] + (cur[2] - old[2]) * k, lit: cur[3], hold: cur[4] });
    }
    // only show critters the server says you can see right now
    const latest = frame ? new Set(frame.see.map((x) => x[0])) : null;
    return latest ? out.filter((q) => latest.has(q.id)) : out;
  }

  let lastSeen = [], lastLamps = [];
  function draw(now) {
    resize();
    const g = G(); if (!g || !g.world || !frame) { ctx.fillStyle = '#0B0918'; ctx.fillRect(0, 0, canvas.width, canvas.height); return; }
    const k = g.nightConst || {};
    const wisp = frame.wisp || !frame.me || !me;
    const narrow = canvas.clientWidth < 520;
    const viewW = wisp ? 104 : narrow ? 34 : 46;
    cam.scale = canvas.width / viewW;
    const viewH = canvas.height / cam.scale;
    const focus = wisp ? { x: 50, y: 50 } : me;
    cam.x = wisp ? 50 : clamp(focus.x, viewW / 2 - 2, 102 - viewW / 2);
    cam.y = wisp ? 50 : clamp(focus.y, viewH / 2 - 2, 102 - viewH / 2);
    const s = cam.scale, sc = (x, y) => toScreen(x, y);
    ctx.fillStyle = '#0B0918'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    // the cached village picture, cropped to what the camera sees
    const { cv, ws } = worldCanvas(g, s);
    const x0 = cam.x - canvas.width / (2 * s), y0 = cam.y - canvas.height / (2 * s);
    const sx = (x0 + 2) * ws, sy = (y0 + 2) * ws, sw = (canvas.width / s) * ws, sh = (canvas.height / s) * ws;
    const cx0 = Math.max(0, sx), cy0 = Math.max(0, sy), cx1 = Math.min(cv.width, sx + sw), cy1 = Math.min(cv.height, sy + sh);
    if (cx1 > cx0 && cy1 > cy0) ctx.drawImage(cv, cx0, cy0, cx1 - cx0, cy1 - cy0, (cx0 - sx) * s / ws, (cy0 - sy) * s / ws, (cx1 - cx0) * s / ws, (cy1 - cy0) * s / ws);

    const lamps = g.world.lamps.map((l, i) => ({ ...l, lit: frame.lamps[i] === '1' }));
    for (const l of lamps) {
      const [x, y] = sc(l.x, l.y);
      ctx.fillStyle = l.lit ? '#FFE07A' : '#6C6A78'; ctx.strokeStyle = '#2B2233'; ctx.lineWidth = 0.3 * s;
      ctx.beginPath(); ctx.arc(x, y - 3.6 * s, 0.9 * s, 0, 7); ctx.fill(); ctx.stroke();
    }
    // your ability target tonight
    if (mark && !wisp) {
      const h = g.world.homes.find((x) => x.id === mark);
      if (h) { const [x, y] = sc(h.x, h.y - 6.2); ctx.font = `${2.6 * s}px system-ui, "Apple Color Emoji"`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(roleIcon(g), x, y + Math.sin(now / 300) * 0.3 * s); }
    }
    // your errand spots
    if (!wisp) for (const t of tasks) {
      if (t.done || !t.errand || t.x === undefined || t.k === 'lamp') continue;
      const [x, y] = sc(t.x, t.y), pulse = 1 + Math.sin(now / 250) * 0.12;
      ctx.strokeStyle = 'rgba(255,224,122,.9)'; ctx.lineWidth = 0.35 * s; ctx.setLineDash([0.8 * s, 0.6 * s]);
      ctx.beginPath(); ctx.arc(x, y, (k.errand || 2.8) * s * pulse, 0, 7); ctx.stroke(); ctx.setLineDash([]);
      ctx.font = `${2.2 * s}px system-ui, "Apple Color Emoji"`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(t.e, x, y);
    }
    // you heard a squeak: a pulsing ❗ where it came from
    if (frame.ping && !wisp) {
      const [px, py] = sc(frame.ping[0], frame.ping[1]), pulse = 1 + Math.sin(now / 120) * 0.15;
      ctx.strokeStyle = 'rgba(255,79,122,.85)'; ctx.lineWidth = 0.45 * s; ctx.beginPath(); ctx.arc(px, py, 3.2 * s * pulse, 0, 7); ctx.stroke();
      ctx.font = `${3 * s}px system-ui, "Apple Color Emoji"`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('❗', px, py);
    }
    // a tombstone, once you've found it (Wisps see it right away)
    if (frame.tomb) {
      const [tx, ty] = sc(frame.tomb[0], frame.tomb[1]);
      ctx.fillStyle = 'rgba(70,52,40,.55)'; ctx.beginPath(); ctx.ellipse(tx, ty + 1.2 * s, 2.4 * s, 0.9 * s, 0, 0, 7); ctx.fill();
      ctx.fillStyle = '#B8B3C7'; ctx.strokeStyle = '#2B2233'; ctx.lineWidth = 0.35 * s;
      roundRect(ctx, tx - 1.4 * s, ty - 2.2 * s, 2.8 * s, 3.4 * s, 1.2 * s); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = '#6C6A78'; ctx.lineWidth = 0.3 * s; ctx.beginPath(); ctx.moveTo(tx, ty - 1.6 * s); ctx.lineTo(tx, ty + 0.2 * s); ctx.moveTo(tx - 0.7 * s, ty - 1 * s); ctx.lineTo(tx + 0.7 * s, ty - 1 * s); ctx.stroke();
      label(ctx, `${(P(frame.tomb[2]) || {}).name || '?'}`, tx, ty + 3 * s, s, '#2B2233', '#C9C2D6');
    }
    const team = new Set(g.team || []);
    const seen = others();
    lastSeen = seen; lastLamps = lamps;
    for (const q of seen) { const [x, y] = sc(q.x, q.y); critter(ctx, P(q.id), x, y, s, { lantern: q.lit }); }
    const lit = frame.me ? litLocal : false, keen = frame.me && frame.me[5];
    let prog = 0, progColor = null;
    if (!wisp) {
      const serverProg = frame.me[4] || 0;
      const lh = localHold && k.hold ? Math.min(0.97, (now - localHold.start) / 1000 / (k.hold[localHold.kind] || 1.4)) : 0;
      prog = Math.max(serverProg, lh);
      if (!prog && frame.me[6]) { prog = frame.me[6]; progColor = '#9BE37B'; }
      const [x, y] = sc(me.x, me.y);
      critter(ctx, P(api.me()), x, y, s, { me: true, lantern: lit, progress: prog, progressColor: progColor });
      // arrow toward your nearest unfinished errand when it's off screen
      const next = nextTask(); if (next) arrowTo(next, s, sc);
    }

    // darkness with holes cut out for every light (drawn at half resolution)
    const night = wisp ? 0.45 : 0.93, hs = 0.5;
    dctx.globalCompositeOperation = 'source-over';
    dctx.clearRect(0, 0, dark.width, dark.height);
    dctx.fillStyle = `rgba(7,6,24,${night})`; dctx.fillRect(0, 0, dark.width, dark.height);
    dctx.globalCompositeOperation = 'destination-out';
    const hole = (x, y, r, a = 1) => {
      const [hx0, hy0] = sc(x, y), hx = hx0 * hs, hy = hy0 * hs, rr = r * s * hs;
      if (hx + rr < 0 || hy + rr < 0 || hx - rr > dark.width || hy - rr > dark.height) return;
      const gr = dctx.createRadialGradient(hx, hy, 0, hx, hy, rr);
      gr.addColorStop(0, `rgba(0,0,0,${a})`); gr.addColorStop(0.6, `rgba(0,0,0,${a * 0.85})`); gr.addColorStop(1, 'rgba(0,0,0,0)');
      dctx.fillStyle = gr; dctx.beginPath(); dctx.arc(hx, hy, rr, 0, 7); dctx.fill();
    };
    const myLight = lit ? (keen ? k.keen || 11 : k.light || 9) : k.dark || 3.2;
    if (!wisp) hole(me.x, me.y, myLight, lit ? 1 : 0.75);
    for (const l of lamps) if (l.lit) hole(l.x, l.y - 2, k.lamp || 8);
    for (const hid of frame.porches || []) { const h = g.world.homes.find((x) => x.id === hid); if (h) hole(h.door.x, h.door.y, k.porch || 11); }
    for (const q of seen) if (q.lit) hole(q.x, q.y, (k.light || 9) * 0.85, 0.9);
    for (const [gx, gy] of frame.glows) hole(gx, gy, 2.2, 0.7);
    ctx.drawImage(dark, 0, 0, canvas.width, canvas.height);

    // warm glows on top
    ctx.globalCompositeOperation = 'lighter';
    const glow = (x, y, r, a, c1 = '255,200,90') => {
      const [hx, hy] = sc(x, y), rr = r * s;
      if (hx + rr < 0 || hy + rr < 0 || hx - rr > canvas.width || hy - rr > canvas.height) return;
      const gr = ctx.createRadialGradient(hx, hy, 0, hx, hy, rr);
      gr.addColorStop(0, `rgba(${c1},${a})`); gr.addColorStop(1, `rgba(${c1},0)`);
      ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(hx, hy, rr, 0, 7); ctx.fill();
    };
    if (!wisp && lit) glow(me.x, me.y, myLight, 0.16, '255,170,60');
    for (const l of lamps) if (l.lit) { glow(l.x, l.y - 2, k.lamp || 8, 0.14, '255,170,60'); glow(l.x, l.y - 3.6, 4, 0.35); }
    for (const q of seen) if (q.lit) { glow(q.x, q.y, (k.light || 9) * 0.8, 0.1, '255,170,60'); glow(q.x, q.y, 3, 0.18); }
    for (const [gx, gy] of frame.glows) glow(gx, gy, 1.6, 0.85);
    if (!wisp && lit) glow(me.x, me.y, 3, 0.2);
    ctx.globalCompositeOperation = 'source-over';

    drawMini(g, lamps);
    updateHud(g, seen, lamps, prog);
  }
  function inLight(g, q, lamps) {
    const k = g.nightConst || {};
    if (lamps.some((l) => l.lit && dist(l, q) <= (k.lamp || 8))) return true;
    return (frame.porches || []).some((hid) => { const h = g.world.homes.find((x) => x.id === hid); return h && dist(h.door, q) <= (k.porch || 11); });
  }
  function roleIcon(g) { const r = api.role(g.myRole); return (r && r.icon) || '✅'; }
  function nextTask() {
    if (!me) return null;
    const bell = tasks.find((t) => t.k === 'bell' && !t.done);
    if (bell && !(frame && frame.rung)) return bell;
    return tasks.filter((t) => !t.done && t.errand && t.x !== undefined).sort((a, b) => dist(me, a) - dist(me, b))[0] || null;
  }
  function arrowTo(t, s, sc) {
    const [tx, ty] = sc(t.x, t.y), m = 34 * DPR();
    if (tx > m && ty > m && tx < canvas.width - m && ty < canvas.height - m) return;
    const [mx, my] = sc(me.x, me.y), a = Math.atan2(ty - my, tx - mx);
    const cx = canvas.width / 2, cy = canvas.height / 2;
    const R = Math.min(cx, cy) - m;
    const ax = cx + Math.cos(a) * R, ay = cy + Math.sin(a) * R;
    ctx.save(); ctx.translate(ax, ay); ctx.rotate(a);
    ctx.fillStyle = '#FFD66B'; ctx.strokeStyle = '#2B2233'; ctx.lineWidth = 0.3 * s;
    ctx.beginPath(); ctx.moveTo(1.6 * s, 0); ctx.lineTo(-0.9 * s, -1.2 * s); ctx.lineTo(-0.4 * s, 0); ctx.lineTo(-0.9 * s, 1.2 * s); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
    ctx.font = `${1.9 * s}px system-ui, "Apple Color Emoji"`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(t.e, ax - Math.cos(a) * 2.6 * s, ay - Math.sin(a) * 2.6 * s);
  }

  function drawMini(g, lamps) {
    const w = Math.round(mini.clientWidth * DPR());
    if (mini.width !== w) { mini.width = w; mini.height = w; miniKey = ''; }
    const s = w / 100, c = mctx;
    const key = w + g.houses.join(',');
    if (key !== miniKey) {
      miniKey = key; miniStatic = miniStatic || document.createElement('canvas'); miniStatic.width = w; miniStatic.height = w;
      const m = miniStatic.getContext('2d');
      m.fillStyle = 'rgba(20,16,40,.88)'; m.fillRect(0, 0, w, w);
      m.fillStyle = '#3B5C9E'; m.beginPath(); m.ellipse(50 * s, 50 * s, 19 * s, 15 * s, 0, 0, 7); m.fill();
      m.font = `${9 * s}px system-ui, "Apple Color Emoji"`; m.textAlign = 'center'; m.textBaseline = 'middle';
      for (const l of g.world.landmarks) m.fillText(l.e, l.x * s, l.y * s);
      for (const h of g.world.homes) { m.fillStyle = h.id === api.me() ? '#FF6B8B' : '#E9DFC9'; m.fillRect((h.x - 2) * s, (h.y - 2) * s, 4 * s, 4 * s); }
      if (g.world.bell) { m.font = `${7 * s}px system-ui, "Apple Color Emoji"`; m.fillText('🔔', g.world.bell.x * s, g.world.bell.y * s); }
    }
    c.clearRect(0, 0, w, w); c.drawImage(miniStatic, 0, 0);
    for (const l of lamps) { c.fillStyle = l.lit ? '#FFD66B' : '#6C6A78'; c.beginPath(); c.arc(l.x * s, l.y * s, 1.6 * s, 0, 7); c.fill(); }
    if (frame.me) for (const t of tasks) {
      if (t.done || !t.errand || t.x === undefined) continue;
      c.fillStyle = '#9BE37B'; c.strokeStyle = '#2B2233'; c.lineWidth = 0.8 * s;
      c.beginPath(); c.arc(t.x * s, t.y * s, 2.2 * s, 0, 7); c.fill(); c.stroke();
    }
    if (frame.tomb) { c.font = `${8 * s}px system-ui, "Apple Color Emoji"`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('🪦', frame.tomb[0] * s, frame.tomb[1] * s); }
    if (me && frame.me) { c.fillStyle = '#fff'; c.strokeStyle = '#FF6B8B'; c.lineWidth = 1.4 * s; c.beginPath(); c.arc(me.x * s, me.y * s, 2.6 * s, 0, 7); c.fill(); c.stroke(); }
  }

  // What the action button would do right now (the server double-checks everything)
  function prompt(g, seen, lamps) {
    if (!frame || !frame.me || !me) return null;
    const k = g.nightConst || {};
    const role = api.role(g.myRole), sneak = role.team === 'sneaks', lit = litLocal;
    const team = new Set(g.team || []);
    const tk = (kk) => tasks.find((t) => t.k === kk);
    const struck = frame.struck || (tk('strike') && tk('strike').done);
    if (sneak && !g.settling && !struck) {
      const rad = (id) => SIZE_R[(CRITTERS[(P(id) || {}).critter] || CRITTERS.fox).size] || 1.95;
      const near = seen.filter((q) => !team.has(q.id)).map((q) => ({ q, d: dist(me, q), touch: rad(api.me()) + rad(q.id) - 0.35 }))
        .sort((a, b) => a.d - b.d)[0];
      if (near && near.d <= near.touch + 3) {
        const name = P(near.q.id)?.name;
        if (lit) return { text: `Snuff your lantern (Q) to strike ${name}`, hint: true };
        if (inLight(g, near.q, lamps)) return { text: `${name} is in the lamplight: too bright to strike`, hint: true };
        if (near.d <= near.touch + 0.25) return { kind: 'strike', target: near.q.id, key: 'F', text: `Press F to spirit away ${name}`, danger: true };
        return { text: `Get closer: you have to touch ${name}`, hint: true };
      }
    }
    const roleDone = tk('role') ? tk('role').done : !!g.myAction;
    const meddleDone = tk('meddle') ? tk('meddle').done : !!g.myMeddle;
    const canHouse = (role.verb && !sneak && !roleDone) || (g.myRole === 'trickster' && !meddleDone && !g.settling);
    if (canHouse) {
      const h = g.world.homes.filter((x) => x.id !== api.me() && g.alive.includes(x.id) && !(g.myRole === 'hedgehog' && g.lastProtect === x.id))
        .map((x) => ({ x, d: dist(me, x.door) })).filter((x) => x.d <= (k.house || 6)).sort((a, b) => a.d - b.d)[0];
      if (h) return { kind: 'house', text: `${g.myRole === 'trickster' ? 'Meddle with' : role.verb.split(' ')[0]} ${P(h.x.id)?.name}` };
    }
    if (frame.tomb && !frame.rung && frame.bells > 0 && g.world.bell && dist(me, g.world.bell) <= 3.6)
      return { kind: 'bell', text: `Ring the bell (${frame.bells} ring${frame.bells === 1 ? '' : 's'} left this game)` };
    const l = lamps.map((x) => ({ ...x, d: dist(me, x) })).filter((x) => x.d <= (k.lampR || 3.4)).sort((a, b) => a.d - b.d)[0];
    if (l && !l.lit) return { kind: 'lamp', text: 'Light the lamp' };
    if (l && l.lit && sneak) return { kind: 'blow', text: 'Blow out the lamp', danger: true };
    const t = tasks.find((x) => !x.done && x.errand && x.k === 'spot' && dist(me, x) <= (k.errand || 2.8));
    if (t) return { errand: true, text: `${t.e} ${t.text}…` };
    return null;
  }

  let hudKey = '';
  function updateHud(g, seen, lamps, prog) {
    const pr = frame.wisp ? null : prompt(g, seen, lamps);
    lastPrompt = pr;
    const lit = frame.me ? litLocal : false;
    const key = [pr && pr.text, pr && pr.danger, lit, frame.wisp, Math.round(prog * 20)].join('|');
    if (key === hudKey) return; hudKey = key;
    const box = $('#nb-prompt'), act = $('#nb-act'), lan = $('#nb-lantern');
    lan.textContent = lit ? '🏮 Lantern on' : '🌑 Lantern off';
    lan.classList.toggle('off', !lit); lan.classList.toggle('hidden', !!frame.wisp || !frame.me);
    if (frame.wisp || !frame.me) { box.innerHTML = '👻 You are a Wisp. You can see everyone tonight, but you can\'t touch anything.'; box.className = 'nb-prompt show'; act.classList.add('hidden'); return; }
    if (pr && pr.errand) {
      box.innerHTML = `${esc(pr.text)}<span class="bar"><i style="width:${Math.round(prog * 100)}%;background:#9BE37B"></i></span>`;
      box.className = 'nb-prompt show errand'; act.classList.add('hidden');
    } else if (pr) {
      const strikeNow = pr.kind === 'strike';
      box.innerHTML = pr.hint ? `🌑 ${esc(pr.text)}` : strikeNow ? `<span class="kbd">F</span> ${esc(pr.text.replace(/^Press F to /, ''))}`
        : `<span class="kbd">E</span> Hold to ${esc(pr.text)}${prog ? `<span class="bar"><i style="width:${Math.round(prog * 100)}%"></i></span>` : ''}`;
      box.className = `nb-prompt show ${pr.danger ? 'danger' : ''} ${pr.hint ? 'hint' : ''}`;
      act.classList.toggle('hidden', !!pr.hint); act.classList.toggle('danger', !!pr.danger);
      act.textContent = strikeNow ? '🌑 Strike!' : pr.danger ? '🌑 Hold' : '✋ Hold';
    } else { box.className = 'nb-prompt'; act.classList.add('hidden'); }
  }

  // ---------- task list + confirmation banners ----------
  function isTasksOpen() { return tasksOpen === null ? canvas && canvas.clientWidth >= 520 : tasksOpen; }
  function taskLi(t) {
    if (t.k === 'info') return `<li class="info"><span class="tk-e">${t.e}</span><span>${esc(t.text)}</span></li>`;
    return `<li class="${t.done ? 'done' : ''} ${t.errand ? '' : 'main'}"><span class="tk-box">${t.done ? '✓' : ''}</span><span class="tk-e">${t.e}</span><span>${esc(t.text)}</span></li>`;
  }
  function renderTasks() {
    const el = $('#nb-tasks'); if (!el) return;
    if (!tasks.length) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const real = tasks.filter((t) => t.k !== 'info'), done = real.filter((t) => t.done).length;
    const open = isTasksOpen();
    const next = tasks.find((t) => !t.done && t.k !== 'info');
    el.classList.toggle('open', open);
    const bells = frame && frame.bells !== undefined ? frame.bells : (G() && G().bellsLeft);
    el.innerHTML = `<div class="tk-head">📝 Tonight <b>${done}/${real.length}</b>${bells !== undefined ? `<span class="tk-bell" title="Bell rings left this game">🔔 ${bells}</span>` : ''}<span class="tk-tog">${open ? '▲' : '▼'}</span></div>`
      + (open ? `<ul>${tasks.map(taskLi).join('')}</ul><div class="tk-foot">Errands: stand on the glowing ✨ spot. Finish them all for a brighter lantern.</div>`
        : next ? `<div class="tk-next">${next.e} ${esc(next.text)}</div>` : '<div class="tk-next">✨ All done! Keep your eyes open.</div>');
  }
  let bannerQ = [], bannerTimer = 0;
  function showBanner(e) {
    bannerQ.push(e);
    if (!bannerTimer) nextBanner();
    if (e.big && api.sound) api.sound('chime');
  }
  function nextBanner() {
    const el = $('#nb-banner'); const e = bannerQ.shift();
    if (!el || !e) { bannerTimer = 0; if (el) el.className = 'nb-banner'; return; }
    el.innerHTML = `<span class="bn-e">${esc(e.e || '✅')}</span><span>${esc(e.text.replace(/^\S+\s/, (m) => (/\p{Extended_Pictographic}/u.test(m) ? '' : m)))}</span>`;
    el.className = `nb-banner show ${e.big ? 'big' : ''}`;
    bannerTimer = setTimeout(() => { el.className = 'nb-banner'; bannerTimer = setTimeout(nextBanner, 220); }, e.big ? 2800 : 1700);
  }
  function getTasks() { return running ? tasks : []; }

  // ---------- the morning: footprints on the day map ----------
  function paw(c, x, y, a, size, s, alpha) {
    c.save(); c.translate(x, y); c.rotate(a + Math.PI / 2); c.fillStyle = `rgba(70,42,24,${alpha})`;
    if (size === 'small') {
      for (const [dx, dy] of [[-0.35, -0.3], [0, -0.45], [0.35, -0.3]]) { c.beginPath(); c.arc(dx * s, dy * s, 0.16 * s, 0, 7); c.fill(); }
      c.beginPath(); c.arc(0, 0.1 * s, 0.2 * s, 0, 7); c.fill();
    } else if (size === 'medium') {
      c.beginPath(); c.ellipse(0, 0.15 * s, 0.38 * s, 0.32 * s, 0, 0, 7); c.fill();
      for (const [dx, dy] of [[-0.42, -0.35], [0, -0.55], [0.42, -0.35]]) { c.beginPath(); c.arc(dx * s, dy * s, 0.16 * s, 0, 7); c.fill(); }
    } else {
      c.beginPath(); c.ellipse(0, 0.2 * s, 0.6 * s, 0.48 * s, 0, 0, 7); c.fill();
      for (const [dx, dy] of [[-0.7, -0.35], [-0.25, -0.75], [0.25, -0.75], [0.7, -0.35]]) { c.beginPath(); c.arc(dx * s, dy * s, 0.22 * s, 0, 7); c.fill(); }
    }
    c.restore();
  }
  function drawTracks(cv, g, until) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const c = cv.getContext('2d'); c.clearRect(0, 0, w, h);
    const s = w / 100, tr = g.tracks || [];
    const dur = g.nightDur || 70;
    const full = until === null || until === undefined;
    let side = 1;
    for (const f of tr) {
      if (!full && (f.t > until || f.t < until - 14)) continue;
      const age = full ? 0.5 + 0.45 * (f.t / dur) : 0.35 + 0.6 * (1 - (until - f.t) / 14);
      side = -side;
      const ox = Math.cos(f.a + Math.PI / 2) * 0.45 * side, oy = Math.sin(f.a + Math.PI / 2) * 0.45 * side;
      paw(c, (f.x + ox) * s, (f.y + oy) * s, f.a, f.s, s * 1.5 * (f.s === 'large' ? 1.2 : f.s === 'small' ? 0.85 : 1), age);
    }
    const sc = (g.scenes || []).filter((x) => x.night === g.day).pop() || (g.scenes || []).filter((x) => x.night === g.day - 1 && g.phase === 'night').pop();
    if (sc && (full || Math.abs(until - sc.t) < 14)) {
      const x = sc.x * s, y = sc.y * s;
      c.strokeStyle = '#FF4F7A'; c.lineWidth = 0.7 * s; c.setLineDash([1.2 * s, 0.8 * s]);
      c.beginPath(); c.arc(x, y, 3.2 * s, 0, 7); c.stroke(); c.setLineDash([]);
      c.font = `${3 * s}px system-ui, "Apple Color Emoji"`; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText('🪦', x, y);
      if (sc.mole) { c.font = `${2 * s}px system-ui, "Apple Color Emoji"`; c.fillText('🕳️', x + 2.4 * s, y + 1.6 * s); }
    }
    for (const o of g.outs || []) {
      if (!full && Math.abs(until - o.t) > 14) continue;
      c.font = `${2.2 * s}px system-ui, "Apple Color Emoji"`; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.globalAlpha = 0.85; c.fillText('🌑', o.x * s, o.y * s); c.globalAlpha = 1;
    }
  }

  window.HHNight = { start, stop, onFrame, drawTracks, setTasks, tasks: getTasks, running: () => running,
    _dbg: () => ({ me: me && { ...me }, tasks, hold: !!localHold, lit: litLocal, frames: buf.length, seen: lastSeen.map((q) => ({ id: q.id, x: q.x, y: q.y })), team: (G() || {}).team || [], tomb: frame && frame.tomb, bell: G() && G().world && G().world.bell }) };
})();
