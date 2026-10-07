/* Lantern Night client: draws the live night (darkness, lanterns, lamps, critters) and the
   morning footprint map. The server decides what you can see; this file only draws it. */
(() => {
  const { CRITTERS, COLORS, HATS } = window.HH;
  const SIZE_R = { small: 1.55, medium: 1.95, large: 2.4 };
  const cottageCache = {};

  let api = null, canvas = null, ctx = null, dark = null, dctx = null, mini = null, mctx = null;
  let running = false, raf = 0, lastT = 0;
  let frame = null, prev = null, frameAt = 0, prevAt = 0;
  let meDraw = null;
  const keys = new Set();
  let touchDir = null, holding = false, lastDir = { x: 0, y: 0 }, lastSendAt = 0;

  // ---------- helpers ----------
  const $ = (s) => document.querySelector(s);
  const P = (id) => api && api.P(id);
  const G = () => api && api.game();
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  function cottage(color) {
    if (cottageCache[color]) return cottageCache[color];
    const roof = (COLORS[color] || COLORS.honey).hex;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 56"><g stroke="#2B2233" stroke-width="3" stroke-linejoin="round">
      <rect x="43" y="7" width="7" height="13" rx="1.5" fill="#C98B5E"/><path d="M4 29 L32 5 L60 29 Z" fill="${roof}"/>
      <rect x="10" y="27" width="44" height="26" rx="3" fill="#FFF8EC"/><rect x="15" y="33" width="12" height="10" rx="2" fill="#FFD66B"/>
      <rect x="35" y="35" width="12" height="18" rx="6" fill="#B7845A"/></g></svg>`;
    const img = new Image(); img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    cottageCache[color] = img; return img;
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
    act.addEventListener('pointerdown', (e) => { e.preventDefault(); setHold(true); });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((e) => act.addEventListener(e, () => setHold(false)));
    $('#nb-lantern').addEventListener('click', () => api.send({ t: 'lantern' }));
  }
  function typing() { const a = document.activeElement; return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT'); }
  function onKey(e) {
    if (!running || typing()) return;
    const k = e.key.toLowerCase();
    const move = ['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd'];
    if (move.includes(k)) { e.preventDefault(); if (e.type === 'keydown') keys.add(k); else keys.delete(k); }
    if (k === 'e' || k === ' ') { e.preventDefault(); if (e.type === 'keydown' && !e.repeat) setHold(true); if (e.type === 'keyup') setHold(false); }
    if ((k === 'q' || k === 'l') && e.type === 'keydown' && !e.repeat) api.send({ t: 'lantern' });
  }
  function onPointer(e) {
    if (!running || !meDraw) return;
    if (e.type === 'pointermove' && !(e.buttons & 1) && e.pointerType === 'mouse') return;
    if (e.type === 'pointermove' && e.pointerType !== 'mouse' && !touchDir) return;
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const [mx, my] = toScreen(meDraw.x, meDraw.y, true);
    const dx = sx - mx, dy = sy - my, d = Math.hypot(dx, dy);
    touchDir = d < 14 ? { x: 0, y: 0 } : { x: dx / d, y: dy / d };
  }
  function setHold(on) {
    if (holding === on) return;
    holding = on; api.send({ t: 'hold', on });
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

  // ---------- frames from the server ----------
  function onFrame(f) {
    prev = frame; prevAt = frameAt; frame = f; frameAt = performance.now();
    if (f.me && !meDraw) meDraw = { x: f.me[0], y: f.me[1] };
    if (f.me && f.me[3] === 0 && holding && !keys.has('e') && !keys.has(' ')) { /* hold finished or cancelled server-side */ }
  }

  // ---------- camera ----------
  let cam = { x: 50, y: 50, scale: 10 };
  function toScreen(x, y, css) {
    const w = css ? canvas.clientWidth : canvas.width, h = css ? canvas.clientHeight : canvas.height;
    const s = css ? cam.scale / (window.devicePixelRatio || 1) : cam.scale;
    return [(x - cam.x) * s + w / 2, (y - cam.y) * s + h / 2];
  }

  // ---------- main loop ----------
  function start(a) {
    api = a;
    if (!canvas) mount();
    if (running) return;
    running = true; frame = null; prev = null; meDraw = null; holding = false; keys.clear(); touchDir = null;
    lastT = performance.now();
    raf = requestAnimationFrame(loop);
  }
  function stop() {
    if (!running) return;
    running = false; cancelAnimationFrame(raf); keys.clear(); touchDir = null;
    if (holding) { holding = false; try { api.send({ t: 'hold', on: false }); } catch (e) { /* ignore */ } }
    try { api.send({ t: 'move', dx: 0, dy: 0 }); } catch (e) { /* ignore */ }
  }
  function loop(now) {
    if (!running) return;
    const dt = Math.min(0.1, (now - lastT) / 1000); lastT = now;
    // send movement when it changes
    const d = dir();
    if ((Math.abs(d.x - lastDir.x) > 0.05 || Math.abs(d.y - lastDir.y) > 0.05 || now - lastSendAt > 600) && now - lastSendAt > 45) {
      api.send({ t: 'move', dx: +d.x.toFixed(2), dy: +d.y.toFixed(2) }); lastDir = d; lastSendAt = now;
    }
    const g = G();
    if (frame && frame.me) {
      // show your critter where the server says, nudged forward by your own input so it feels instant
      const speed = (g && g.nightConst && g.nightConst.speed) || 13;
      const since = Math.min(0.12, (now - frameAt) / 1000);
      const tx = frame.me[0] + d.x * speed * since, ty = frame.me[1] + d.y * speed * since;
      meDraw = meDraw ? { x: meDraw.x + (tx - meDraw.x) * Math.min(1, dt * 18), y: meDraw.y + (ty - meDraw.y) * Math.min(1, dt * 18) } : { x: tx, y: ty };
    }
    try { draw(now); } catch (e) { console.error(e); }
    raf = requestAnimationFrame(loop);
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; dark.width = w; dark.height = h; }
  }

  // ---------- drawing the world ----------
  function drawWorld(c, g, s, sc) {
    const W = g.world;
    // grass
    c.fillStyle = '#7DBE6A'; c.fillRect(sc(0, 0)[0], sc(0, 0)[1], 100 * s, 100 * s);
    // paths: a ring through the doors + lanes to the landmarks
    const ringR = (W.homes.length > 10 ? 40 : 38) - 5.5;
    c.strokeStyle = '#E3CC98'; c.lineWidth = 4.2 * s; c.lineCap = 'round';
    c.beginPath(); const [cx, cy] = sc(50, 50); c.arc(cx, cy, ringR * s, 0, Math.PI * 2); c.stroke();
    for (const l of W.landmarks) {
      const a = Math.atan2(l.y - 50, l.x - 50);
      c.beginPath(); c.moveTo(...sc(50 + Math.cos(a) * ringR, 50 + Math.sin(a) * ringR)); c.lineTo(...sc(l.x, l.y)); c.stroke();
    }
    // flowers and tufts (deterministic)
    c.fillStyle = 'rgba(46,96,52,.35)';
    for (let i = 0; i < 90; i++) { const x = (i * 37.3) % 100, y = (i * 61.7 + 13) % 100; c.beginPath(); c.arc(...sc(x, y), 0.35 * s, 0, 7); c.fill(); }
    // pond
    c.fillStyle = '#4C94D6'; c.strokeStyle = '#2B2233'; c.lineWidth = 0.45 * s;
    c.beginPath(); c.ellipse(cx, cy, W.pond.rx * s, W.pond.ry * s, 0, 0, Math.PI * 2); c.fill(); c.stroke();
    c.fillStyle = 'rgba(255,255,255,.35)'; c.beginPath(); c.ellipse(cx - 6 * s, cy - 5 * s, 3 * s, 1.6 * s, -0.3, 0, 7); c.fill();
    // landmarks
    c.textAlign = 'center'; c.textBaseline = 'middle';
    for (const l of W.landmarks) {
      const [x, y] = sc(l.x, l.y);
      c.fillStyle = '#F2DDB6'; c.strokeStyle = '#2B2233'; c.lineWidth = 0.45 * s;
      roundRect(c, x - 5 * s, y - 3.6 * s, 10 * s, 7.4 * s, 1.2 * s); c.fill(); c.stroke();
      c.fillStyle = '#C0675A'; c.beginPath(); c.moveTo(x - 6 * s, y - 3.2 * s); c.lineTo(x, y - 7.4 * s); c.lineTo(x + 6 * s, y - 3.2 * s); c.closePath(); c.fill(); c.stroke();
      c.font = `${3.6 * s}px system-ui, "Apple Color Emoji", "Segoe UI Emoji"`; c.fillText(l.e, x, y + 0.2 * s);
      label(c, l.name, x, y + 5.4 * s, s, '#2B2233', '#FFF8EC');
    }
    // houses
    for (const h of W.homes) {
      const p = P(h.id) || {}; const [x, y] = sc(h.x, h.y);
      const img = cottage(p.color || 'honey');
      if (img.complete) c.drawImage(img, x - 4.8 * s, y - 4.6 * s, 9.6 * s, 8.4 * s);
      label(c, `${p.name || '?'}`, x, y + 5.2 * s, s, '#2B2233', g.alive.includes(h.id) ? '#FFF8EC' : '#C9C2D6');
    }
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
      c.strokeStyle = '#FFD66B'; c.lineWidth = 0.6 * s;
      c.beginPath(); c.arc(x, y, r + 0.9 * s, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * opts.progress); c.stroke();
    }
  }

  function interp(id) {
    const cur = frame && frame.see.find((x) => x[0] === id);
    if (!cur) return null;
    const old = prev && prev.see.find((x) => x[0] === id);
    if (!old) return { x: cur[1], y: cur[2], lit: cur[3], hold: cur[4] };
    const k = Math.min(1, (performance.now() - frameAt) / Math.max(60, frameAt - prevAt));
    return { x: old[1] + (cur[1] - old[1]) * k, y: old[2] + (cur[2] - old[2]) * k, lit: cur[3], hold: cur[4] };
  }

  function draw() {
    resize();
    const g = G(); if (!g || !g.world || !frame) { ctx.fillStyle = '#0B0918'; ctx.fillRect(0, 0, canvas.width, canvas.height); return; }
    const k = g.nightConst || {};
    const wisp = frame.wisp || !frame.me;
    const narrow = canvas.clientWidth < 520;
    const viewW = wisp ? 104 : narrow ? 34 : 46;
    cam.scale = canvas.width / viewW;
    const viewH = canvas.height / cam.scale;
    const focus = wisp ? { x: 50, y: 50 } : meDraw;
    cam.x = wisp ? 50 : Math.max(viewW / 2 - 2, Math.min(102 - viewW / 2, focus.x));
    cam.y = wisp ? 50 : Math.max(viewH / 2 - 2, Math.min(102 - viewH / 2, focus.y));
    const s = cam.scale, sc = (x, y) => toScreen(x, y);
    ctx.fillStyle = '#0B0918'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    drawWorld(ctx, g, s, sc);

    // lamps
    const lamps = g.world.lamps.map((l, i) => ({ ...l, lit: frame.lamps[i] === '1' }));
    for (const l of lamps) {
      const [x, y] = sc(l.x, l.y);
      ctx.fillStyle = '#4A3A30'; ctx.fillRect(x - 0.25 * s, y - 3.2 * s, 0.5 * s, 3.4 * s);
      ctx.fillStyle = l.lit ? '#FFE07A' : '#6C6A78'; ctx.strokeStyle = '#2B2233'; ctx.lineWidth = 0.3 * s;
      ctx.beginPath(); ctx.arc(x, y - 3.6 * s, 0.9 * s, 0, 7); ctx.fill(); ctx.stroke();
    }
    // critters you can see
    const team = new Set(g.team || []);
    const seen = frame.see.map((x) => ({ id: x[0], ...interp(x[0]) })).filter((x) => x.x !== undefined);
    for (const q of seen) {
      const [x, y] = sc(q.x, q.y);
      critter(ctx, P(q.id), x, y, s, { lantern: q.lit });
      if (team.has(q.id) && !team.has(api.me())) { /* never true: you only know your own team */ }
    }
    if (!wisp && meDraw) {
      const [x, y] = sc(meDraw.x, meDraw.y);
      critter(ctx, P(api.me()), x, y, s, { me: true, lantern: frame.me[2], progress: frame.me[4] });
    }

    // darkness with holes cut out for every light
    const night = wisp ? 0.45 : 0.93;
    dctx.globalCompositeOperation = 'source-over';
    dctx.clearRect(0, 0, dark.width, dark.height);
    dctx.fillStyle = `rgba(7,6,24,${night})`; dctx.fillRect(0, 0, dark.width, dark.height);
    dctx.globalCompositeOperation = 'destination-out';
    const hole = (x, y, r, a = 1) => {
      const [hx, hy] = sc(x, y); const gr = dctx.createRadialGradient(hx, hy, 0, hx, hy, r * s);
      gr.addColorStop(0, `rgba(0,0,0,${a})`); gr.addColorStop(0.6, `rgba(0,0,0,${a * 0.85})`); gr.addColorStop(1, 'rgba(0,0,0,0)');
      dctx.fillStyle = gr; dctx.beginPath(); dctx.arc(hx, hy, r * s, 0, 7); dctx.fill();
    };
    if (!wisp && meDraw) hole(meDraw.x, meDraw.y, frame.me[2] ? k.light || 9 : k.dark || 3.2, frame.me[2] ? 1 : 0.75);
    for (const l of lamps) if (l.lit) hole(l.x, l.y - 2, k.lamp || 8);
    for (const hid of frame.porches || []) { const h = g.world.homes.find((x) => x.id === hid); if (h) hole(h.door.x, h.door.y, k.porch || 11); }
    for (const q of seen) if (q.lit) hole(q.x, q.y, (k.light || 9) * 0.85, 0.9);
    for (const [gx, gy] of frame.glows) hole(gx, gy, 2.2, 0.7);
    ctx.drawImage(dark, 0, 0);

    // warm glows on top
    ctx.globalCompositeOperation = 'lighter';
    const glow = (x, y, r, a) => {
      const [hx, hy] = sc(x, y); const gr = ctx.createRadialGradient(hx, hy, 0, hx, hy, r * s);
      gr.addColorStop(0, `rgba(255,200,90,${a})`); gr.addColorStop(1, 'rgba(255,200,90,0)');
      ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(hx, hy, r * s, 0, 7); ctx.fill();
    };
    // warm the lit areas so lantern light looks like candlelight, not daylight
    const warm = (x, y, r, a) => {
      const [hx, hy] = sc(x, y); const gr = ctx.createRadialGradient(hx, hy, 0, hx, hy, r * s);
      gr.addColorStop(0, `rgba(255,170,60,${a})`); gr.addColorStop(1, 'rgba(255,140,40,0)');
      ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(hx, hy, r * s, 0, 7); ctx.fill();
    };
    if (!wisp && meDraw && frame.me[2]) warm(meDraw.x, meDraw.y, k.light || 9, 0.16);
    for (const l of lamps) if (l.lit) warm(l.x, l.y - 2, k.lamp || 8, 0.14);
    for (const q of seen) if (q.lit) warm(q.x, q.y, (k.light || 9) * 0.8, 0.1);
    for (const l of lamps) if (l.lit) glow(l.x, l.y - 3.6, 4, 0.35);
    for (const [gx, gy] of frame.glows) glow(gx, gy, 1.6, 0.85);
    for (const q of seen) if (q.lit) glow(q.x, q.y, 3, 0.18);
    if (!wisp && meDraw && frame.me[2]) glow(meDraw.x, meDraw.y, 3, 0.2);
    ctx.globalCompositeOperation = 'source-over';

    drawMini(g, lamps);
    updateHud(g, seen, lamps);
  }

  function drawMini(g, lamps) {
    const w = mini.width = mini.clientWidth * (window.devicePixelRatio || 1); mini.height = w;
    const s = w / 100, c = mctx;
    c.fillStyle = 'rgba(20,16,40,.88)'; c.fillRect(0, 0, w, w);
    c.fillStyle = '#3B5C9E'; c.beginPath(); c.ellipse(50 * s, 50 * s, 19 * s, 15 * s, 0, 0, 7); c.fill();
    c.font = `${9 * s}px system-ui, "Apple Color Emoji"`; c.textAlign = 'center'; c.textBaseline = 'middle';
    for (const l of g.world.landmarks) c.fillText(l.e, l.x * s, l.y * s);
    for (const h of g.world.homes) { c.fillStyle = h.id === api.me() ? '#FF6B8B' : '#E9DFC9'; c.fillRect((h.x - 2) * s, (h.y - 2) * s, 4 * s, 4 * s); }
    for (const l of lamps) { c.fillStyle = l.lit ? '#FFD66B' : '#6C6A78'; c.beginPath(); c.arc(l.x * s, l.y * s, 1.6 * s, 0, 7); c.fill(); }
    if (meDraw && frame.me) { c.fillStyle = '#fff'; c.strokeStyle = '#FF6B8B'; c.lineWidth = 1.4 * s; c.beginPath(); c.arc(meDraw.x * s, meDraw.y * s, 2.6 * s, 0, 7); c.fill(); c.stroke(); }
  }

  // What the action button would do right now (the server double-checks everything)
  function prompt(g, seen, lamps) {
    if (!frame.me) return null;
    const me = { x: meDraw.x, y: meDraw.y }, k = g.nightConst || {};
    const role = api.role(g.myRole), sneak = role.team === 'sneaks', lit = !!frame.me[2];
    const team = new Set(g.team || []);
    if (sneak && !g.settling && !frame.struck && !lit) {
      const v = seen.filter((q) => !team.has(q.id)).find((q) => dist(me, q) <= (k.strike || 3.4));
      if (v) return { text: `Spirit away ${P(v.id)?.name}`, danger: true };
    } else if (sneak && !g.settling && !frame.struck && lit) {
      const v = seen.filter((q) => !team.has(q.id)).find((q) => dist(me, q) <= (k.strike || 3.4) + 2);
      if (v) return { text: 'Snuff your lantern (Q) to strike', hint: true };
    }
    const canHouse = (role.verb && !sneak && !g.myAction) || (g.myRole === 'trickster' && !g.myMeddle && !g.settling);
    if (canHouse) {
      const h = g.world.homes.filter((x) => x.id !== api.me() && g.alive.includes(x.id) && !(g.myRole === 'hedgehog' && g.lastProtect === x.id))
        .map((x) => ({ x, d: dist(me, x.door) })).filter((x) => x.d <= (k.house || 6)).sort((a, b) => a.d - b.d)[0];
      if (h) return { text: `${g.myRole === 'trickster' ? 'Meddle with' : role.verb.split(' ')[0]} ${P(h.x.id)?.name}` };
    }
    const l = lamps.map((x) => ({ ...x, d: dist(me, x) })).filter((x) => x.d <= (k.lampR || 3.4)).sort((a, b) => a.d - b.d)[0];
    if (l && !l.lit) return { text: 'Light the lamp' };
    if (l && l.lit && sneak) return { text: 'Blow out the lamp', danger: true };
    return null;
  }

  let hudKey = '';
  function updateHud(g, seen, lamps) {
    const pr = frame.wisp ? null : prompt(g, seen, lamps);
    const lit = frame.me ? !!frame.me[2] : false;
    const prog = frame.me ? frame.me[4] : 0;
    const key = [pr && pr.text, pr && pr.danger, lit, frame.wisp, Math.round(prog * 20)].join('|');
    if (key === hudKey) return; hudKey = key;
    const box = $('#nb-prompt'), act = $('#nb-act'), lan = $('#nb-lantern');
    lan.textContent = lit ? '🏮 Lantern on' : '🌑 Lantern off';
    lan.classList.toggle('off', !lit); lan.classList.toggle('hidden', !!frame.wisp);
    if (frame.wisp) { box.innerHTML = '👻 You are a Wisp. You can see everyone tonight, but you can\'t touch anything.'; box.className = 'nb-prompt show'; act.classList.add('hidden'); return; }
    if (pr) {
      box.innerHTML = `<span class="kbd">E</span> ${pr.hint ? '' : 'Hold to '}${pr.text}${prog ? `<span class="bar"><i style="width:${Math.round(prog * 100)}%"></i></span>` : ''}`;
      box.className = `nb-prompt show ${pr.danger ? 'danger' : ''} ${pr.hint ? 'hint' : ''}`;
      act.classList.toggle('hidden', !!pr.hint); act.classList.toggle('danger', !!pr.danger);
      act.textContent = pr.danger ? '🌑 Hold' : '✋ Hold';
    } else { box.className = 'nb-prompt'; act.classList.add('hidden'); }
  }

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
    // last night's scene
    const sc = (g.scenes || []).filter((x) => x.night === g.day).pop() || (g.scenes || []).filter((x) => x.night === g.day - 1 && g.phase === 'night').pop();
    if (sc && (full || Math.abs(until - sc.t) < 14)) {
      const x = sc.x * s, y = sc.y * s;
      c.strokeStyle = '#FF4F7A'; c.lineWidth = 0.7 * s; c.setLineDash([1.2 * s, 0.8 * s]);
      c.beginPath(); c.arc(x, y, 3.2 * s, 0, 7); c.stroke(); c.setLineDash([]);
      c.font = `${3 * s}px system-ui, "Apple Color Emoji"`; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(sc.mole ? '🕳️' : '💨', x, y);
    }
    for (const o of g.outs || []) {
      if (!full && Math.abs(until - o.t) > 14) continue;
      c.font = `${2.2 * s}px system-ui, "Apple Color Emoji"`; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.globalAlpha = 0.85; c.fillText('🌑', o.x * s, o.y * s); c.globalAlpha = 1;
    }
  }

  window.HHNight = { start, stop, onFrame, drawTracks, running: () => running };
})();
