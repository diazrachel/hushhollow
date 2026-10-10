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
  // one AI Sneak per night takes the job; it waits longer if a human teammate might do it
  const aiSneaks = room.players.filter((q) => q.isAI && g.alive.has(q.id) && isSneakTeam(g.roles[q.id]) && n.pos[q.id]);
  const striker = sneak && !g.settling && aiSneaks[0] && aiSneaks[0].id === p.id;
  if (striker && plan.strike && !n.teamTarget) n.teamTarget = plan.strike;
  const dur = g.nightDur || 70;
  return {
    plan, striker, goal: null, wait: Math.random() * 1.5, stuck: 0, attempts: 0, fleeUntil: 0,
    stalkAt: dur * (humanSneak ? 0.6 : 0.2 + Math.random() * 0.25),
    // some villagers go dark for a while too (to spy, hide, or just be weird), so "lantern off" is a hint, not proof
    spyAt: !sneak && Math.random() < ({ 4: 0.15, 5: 0.15, 6: 0.15, 7: 0.25 }[g.n] ?? 0) ? dur * (0.15 + Math.random() * 0.6) : Infinity, spyFor: 6 + Math.random() * 10,
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
  if (dark.length && r < (sneak ? 0.3 : 0.55)) {
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

function think(room, p, b, dt) {
  const g = room.game, n = g.night, id = p.id, me = n.pos[id];
  const Night = N();
  if (me.hold) { me.dx = 0; me.dy = 0; return; }
  if (b.wait > 0) { b.wait -= dt; me.dx = 0; me.dy = 0; return; }
  const careless = p.aiLevel === 'sleepy';

  // ---- the Sneak who does tonight's job ----
  if (b.striker && !n.attempted && n.t >= b.stalkAt) {
    let t = n.teamTarget;
    if (!t || n.gone.has(t) || !n.pos[t]) { t = n.teamTarget = (require('./ai').nightPlan(room, p).strike); }
    if (t && n.pos[t]) {
      if (me.lit) Night.input(room, id, { t: 'lantern', on: false });
      const tp = n.pos[t];
      if (dist(me, tp) <= Night.touchDist(room, id, t)) {
        // touching: one quick strike (same rule as players pressing F)
        if ((careless || safeToStrike(room, id, t)) && Night.strike(room, id, t)) { me.dx = 0; me.dy = 0; return; }
        // someone's looking: back off and try again later
        b.attempts++; b.stalkAt = n.t + 4 + Math.random() * 4;
        if (b.attempts >= 3) n.teamTarget = null;
        Night.input(room, id, { t: 'lantern', on: true });
        errand(room, p, b); steer(room, id, b); return;
      }
      b.goal = { x: tp.x, y: tp.y }; b.task = null;
      steer(room, id, b); return;
    }
  }
  if (b.striker && n.attempted && !b.fled) {
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
      b.ring = Math.random() < (sneak ? (b.striker ? 0.2 : 0.3) : careless ? 0.5 : 0.85);
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
  if (b.task && b.task.kind === 'lamp') {
    const l = n.lamps[b.task.i];
    if (l.lit) { b.task = null; b.goal = null; }
    else if (dist(me, l) <= Night.LAMP_RANGE - 0.8) { me.dx = 0; me.dy = 0; Night.input(room, id, { t: 'hold', on: true }); b.task = null; b.goal = null; return; }
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
