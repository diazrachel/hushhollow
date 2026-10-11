// AI critters during Lantern Night: they walk, run errands, use abilities at houses,
// and Sneak bots stalk, go dark, check for witnesses, and strike.
// Bots only use what they could see with their own lantern (Night.recognizes), never hidden info.

const { isSneakTeam, ROLES, pick } = require('./roles');

function N() { return require('./night'); }
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function initBot(room, p) {
  const g = room.game, n = g.night, AI = require('./ai');
  const plan = AI.nightPlan(room, p);
  const sneak = isSneakTeam(g.roles[p.id]);
  const humanSneak = sneak && room.players.some((q) => !q.isAI && g.alive.has(q.id) && isSneakTeam(g.roles[q.id]) && n.pos[q.id]);
  // every AI Sneak hunts (the team still only gets one strike a night); they give a human teammate a head start
  // one AI Sneak hunts at a time (the team only gets one strike a night); the other acts normal
  const aiSneaks = room.players.filter((q) => q.isAI && g.alive.has(q.id) && isSneakTeam(g.roles[q.id]) && n.pos[q.id]);
  const hunter = sneak && !g.settling && aiSneaks[0] && aiSneaks[0].id === p.id;
  const dur = g.nightDur || 70;
  return {
    plan, hunter, goal: null, wait: Math.random() * 1.5, stuck: 0, attempts: 0, fleeUntil: 0, dur,
    stalkAt: dur * (humanSneak ? 0.35 + Math.random() * 0.1 : g.n >= 11 ? 0.25 + Math.random() * 0.2 : 0.06 + Math.random() * 0.16),
    // some villagers go dark for a while too (to spy, hide, or just be weird), so "lantern off" is a hint, not proof
    spyAt: !sneak && Math.random() < ({ 4: 0.15, 5: 0, 6: 0.15, 7: 0.25, 8: 0.6, 9: 0.65, 10: 0.7 }[g.n] ?? 0) ? dur * (0.15 + Math.random() * 0.6) : Infinity, spyFor: 6 + Math.random() * 10,
  };
}

function steer(room, id, b) {
  const g = room.game, n = g.night, me = n.pos[id];
  if (!b.goal) { me.dx = 0; me.dy = 0; return; }
  const dx = b.goal.x - me.x, dy = b.goal.y - me.y, d = Math.hypot(dx, dy);
  if (d < 1.2) { me.dx = 0; me.dy = 0; return; }
  const base = Math.atan2(dy, dx);
  for (const off of [0, 0.5, -0.5, 1, -1, 1.5, -1.5, 2.2, -2.2]) {
    const a = base + off * (b.turnBias || 1);
    if (!N().blocked(g.world, me.x + Math.cos(a) * 2.6, me.y + Math.sin(a) * 2.6)) { me.dx = Math.cos(a); me.dy = Math.sin(a); return; }
  }
  me.dx = Math.cos(base); me.dy = Math.sin(base);
}

function errand(room, p, b) {
  const g = room.game, n = g.night, me = n.pos[p.id], sneak = isSneakTeam(g.roles[p.id]);
  // tonight's own errand list first (most of the time), so bots roam like real players
  const todo = (n.tasks[p.id] || []).filter((t) => t.errand && !t.done);
  if (todo.length && Math.random() < 0.75) {
    const t = todo.sort((a, c) => dist(me, a) - dist(me, c))[0];
    if (t.k === 'lamp' && !n.lamps[t.i].lit) { b.goal = { x: t.x, y: t.y }; b.task = { kind: 'lamp', i: t.i }; return; }
    if (t.k === 'spot') { b.goal = { x: t.x, y: t.y }; b.task = { kind: 'spot' }; return; }
  }
  const dark = n.lamps.map((l, i) => ({ ...l, i })).filter((l) => !l.lit);
  const r = Math.random();
  if (dark.length && !sneak && r < 0.55) {
    const l = dark.sort((a, c) => dist(me, a) - dist(me, c))[Math.random() < 0.7 ? 0 : Math.min(1, dark.length - 1)];
    b.goal = { x: l.x, y: l.y }; b.task = { kind: 'lamp', i: l.i };
  } else if (r < 0.8) {
    const lm = pick(g.world.landmarks);
    b.goal = { x: lm.x + (lm.x < 50 ? 6 : -6), y: lm.y + (lm.y < 50 ? 6 : -6) }; b.task = null;
  } else {
    const h = pick(g.world.homes);
    b.goal = { x: h.door.x, y: h.door.y }; b.task = null;
  }
}

function safeToStrike(room, id, target) {
  const g = room.game, n = g.night;
  if (N().inStaticLight(g, n.pos[target])) return false;
  for (const q of Object.keys(n.pos)) {
    if (q === id || q === target || n.gone.has(q) || isSneakTeam(g.roles[q])) continue;
    if (N().recognizes(g, q, id)) return false; // someone would see me
  }
  return true;
}

// Who's the easiest critter to catch right now? Close, alone, and out of the lamplight.
function pickPrey(room, id, b) {
  const g = room.game, n = g.night, me = n.pos[id], Night = N();
  const prey = Object.keys(n.pos).filter((q) => q !== id && !n.gone.has(q) && g.alive.has(q) && !isSneakTeam(g.roles[q]));
  if (!prey.length) return null;
  if (n.teamOrder && n.teamTarget && prey.includes(n.teamTarget)) return n.teamTarget; // a human teammate named a target in the Den
  let best = null, bs = Infinity;
  for (const q of prey) {
    const qp = n.pos[q];
    const crowd = prey.filter((o) => o !== q && dist(n.pos[o], qp) < 11).length;
    const score = dist(me, qp) + crowd * 14 + (Night.inStaticLight(g, qp) ? 25 : 0) + (q === b.plan.strike ? -6 : 0) + Math.random() * 4;
    if (score < bs) { bs = score; best = q; }
  }
  return best;
}
function velocity(q) {
  const h = q.hist || []; if (h.length < 5) return { x: 0, y: 0 };
  const a = h[h.length - 5], c = h[h.length - 1], dt = Math.max(0.05, c[0] - a[0]);
  return { x: (c[1] - a[1]) / dt, y: (c[2] - a[2]) / dt };
}
function watchers(room, id, target) {
  const g = room.game, n = g.night; let k = 0;
  for (const q of Object.keys(n.pos)) {
    if (q === id || q === target || n.gone.has(q) || isSneakTeam(g.roles[q])) continue;
    if (N().recognizes(g, q, id)) k++;
  }
  return k;
}

function think(room, p, b, dt) {
  const g = room.game, n = g.night, id = p.id, me = n.pos[id];
  const Night = N();
  if (me.hold) { me.dx = 0; me.dy = 0; return; }
  if (b.wait > 0) { b.wait -= dt; me.dx = 0; me.dy = 0; return; }
  const careless = p.aiLevel === 'sleepy';

  // ---- Sneaks on the hunt ----
  if (b.hunter && !n.attempted && n.t >= b.stalkAt) {
    if (!b.prey || n.gone.has(b.prey) || !n.pos[b.prey] || n.t >= (b.reTarget || 0)) { b.prey = pickPrey(room, id, b); b.reTarget = n.t + 1.5 + Math.random(); }
    const t = b.prey;
    if (t) {
      b.hunting = true;
      if (me.lit) Night.input(room, id, { t: 'lantern', on: false });
      const tp = n.pos[t], d = dist(me, tp), reach = Night.touchDist(room, id, t);
      const late = n.t > b.dur * 0.7;
      if (d <= reach) {
        // close enough: one quick strike (same rule as players pressing F)
        const ok = careless || safeToStrike(room, id, t) || (late && !Night.inStaticLight(g, tp) && watchers(room, id, t) <= 1 && Math.random() < 0.4);
        if (ok && Night.strike(room, id, t)) { me.dx = 0; me.dy = 0; return; }
        // someone's watching: hang back in the dark, then try again (or find someone easier)
        b.attempts++; if (b.attempts % 4 === 0) b.reTarget = 0;
        const a = Math.atan2(me.y - tp.y, me.x - tp.x);
        b.goal = { x: tp.x + Math.cos(a) * (reach + 3), y: tp.y + Math.sin(a) * (reach + 3) }; b.task = null;
        steer(room, id, b); return;
      }
      // cut them off: head to where they're going, not where they are
      const v = velocity(tp), lead = Math.min(1.1, d / Night.SPEED);
      b.goal = { x: Math.max(3, Math.min(97, tp.x + v.x * lead)), y: Math.max(3, Math.min(97, tp.y + v.y * lead)) }; b.task = null;
      steer(room, id, b); return;
    }
  }
  if (b.hunting && n.attempted && !b.fled) {
    b.fled = true; b.fleeUntil = n.t + 2.5 + Math.random() * 2;
    const far = g.world.landmarks.slice().sort((a, c) => dist(c, me) - dist(a, me))[0];
    b.goal = { x: far.x + (far.x < 50 ? 6 : -6), y: far.y + (far.y < 50 ? 6 : -6) }; b.task = null;
  }
  if (b.fled && !me.lit && n.t >= b.fleeUntil) Night.input(room, id, { t: 'lantern', on: true });

  if (b.spyAt !== Infinity) {
    if (n.t >= b.spyAt && n.t < b.spyAt + b.spyFor && me.lit) Night.input(room, id, { t: 'lantern', on: false });
    else if (n.t >= b.spyAt + b.spyFor && !me.lit) { Night.input(room, id, { t: 'lantern', on: true }); b.spyAt = Infinity; }
  }
  // ---- heard a squeak? go and look (unless already busy with something important) ----
  if (n.heard && n.heard[id] && !b.investigated && !n.found.has(id)) {
    b.investigated = true;
    if (Math.random() < (careless ? 0.4 : 0.8)) { b.goal = { x: n.heard[id].x, y: n.heard[id].y }; b.task = null; b.wait = 0; }
  }
  // ---- found a tombstone? run and ring the bell (Sneaks sometimes do it too, to look innocent) ----
  const role = g.roles[id];
  if (n.tomb && n.found.has(id) && !n.bell && g.bellsLeft > 0) {
    if (b.ring === undefined) {
      const sneak = isSneakTeam(role);
      b.ring = Math.random() < (sneak ? (n.strike && n.strike.by === id ? 0.2 : 0.3) : careless ? 0.5 : 0.85);
      b.ringAfter = n.t + (sneak ? 3 + Math.random() * 5 : 0.4 + Math.random() * 1.2);
    }
    if (b.ring && n.t >= b.ringAfter) {
      const bell = Night.bellSpot(g.world);
      if (dist(me, bell) <= Night.BELL_RANGE - 1.5) {
        const ht = Night.holdTarget(room, id);
        if (ht && ht.kind === 'bell') { me.dx = 0; me.dy = 0; Night.input(room, id, { t: 'hold', on: true }); return; }
      }
      b.goal = { x: bell.x, y: bell.y }; b.task = null; steer(room, id, b); return;
    }
  }
  // ---- abilities: walk to the target's door and hold ----
  const wantsHouse = (b.plan.ability && !(id in g.actions)) || (b.plan.meddle && !(id in g.meddles) && !g.settling);
  const houseTarget = b.plan.ability || b.plan.meddle;
  if (wantsHouse && houseTarget && g.alive.has(houseTarget) && !n.gone.has(houseTarget) && n.t > 2) {
    const h = g.world.homes.find((x) => x.id === houseTarget);
    if (dist(me, h.door) <= Night.HOUSE_RANGE - 1.5) {
      const ht = Night.holdTarget(room, id);
      if (ht && ht.kind === 'house' && ht.target === houseTarget) { me.dx = 0; me.dy = 0; Night.input(room, id, { t: 'hold', on: true }); return; }
    }
    b.goal = { x: h.door.x, y: h.door.y }; b.task = null;
    steer(room, id, b); return;
  }

  // ---- errands: light lamps, wander between landmarks ----
  // fixing a lamp's wires takes a few seconds of standing still (same as players doing the minigame)
  if (b.wiring) {
    const l = n.lamps[b.wiring.i];
    if (l.lit || dist(me, l) > Night.LAMP_RANGE + 1) b.wiring = null;
    else if (n.t >= b.wiring.until) { Night.lightLamp(room, id, b.wiring.i); b.wiring = null; b.task = null; b.goal = null; }
    else { me.dx = 0; me.dy = 0; return; }
  }
  if (b.task && b.task.kind === 'lamp') {
    const l = n.lamps[b.task.i];
    if (l.lit || isSneakTeam(role)) { b.task = null; b.goal = null; }
    else if (dist(me, l) <= Night.LAMP_RANGE - 0.8) { me.dx = 0; me.dy = 0; b.wiring = { i: b.task.i, until: n.t + (careless ? 3.5 : 2) + Math.random() * 2.5 }; b.task = null; b.goal = null; return; }
  }
  if (!b.goal || dist(me, b.goal) < 1.6) {
    if (b.goal) b.wait = (b.task && b.task.kind === 'spot' ? Night.ERRAND_TIME + 0.2 : 0) + 0.4 + Math.random() * (careless ? 3 : 1.6);
    if (b.task && b.task.kind === 'spot') b.task = null;
    errand(room, p, b);
  }
  // stuck? pick somewhere else
  b.stuck = (Math.hypot(me.dx, me.dy) > 0 && b.lastX !== undefined && Math.hypot(me.x - b.lastX, me.y - b.lastY) < 0.01) ? b.stuck + dt : 0;
  b.lastX = me.x; b.lastY = me.y;
  if (b.stuck > 1) { b.stuck = 0; b.turnBias = -(b.turnBias || 1); errand(room, p, b); }
  steer(room, id, b);
}

function tick(room, dt) {
  const g = room.game, n = g.night;
  for (const p of room.players) {
    if (!p.isAI || !n.pos[p.id] || n.gone.has(p.id) || !g.alive.has(p.id)) continue;
    const b = n.bot[p.id] || (n.bot[p.id] = initBot(room, p));
    try { think(room, p, b, dt); } catch (e) { console.error('[bot]', e); }
  }
}

module.exports = { tick };
