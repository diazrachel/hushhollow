// Rule-based AI critters. They act through room.act() exactly like humans do,
// so they can't see anything a human in their seat couldn't.
//   sleepy  – random abilities, follows the crowd
//   clever  – reasons from hints and claims, votes on evidence, fakes claims as a Sneak
//   cunning – clever + counter-claims, bluffs, reads voting patterns

const { isSneakTeam, ROLES, pick } = require('./roles');

// ---------------- chat ----------------
const LINES = {
  mourn: ['Poor {v} 😢', 'Not {v}!! They were so nice…', 'RIP {v}. We HAVE to find who did this.', 'Noooo {v} 😭', '{v} is gone… okay, think everyone.'],
  safe: ['Phew, everyone made it!', 'Nobody vanished? Someone got protected 🦔', 'A quiet night… suspicious.'],
  accuse: ["I really think it's {t}.", '{t} has been acting weird 🤔', 'My gut says {t}.', 'Anyone else side-eyeing {t}? 👀', "{t}, explain yourself."],
  defend: ["It's not me, I promise!", "Why me?? I'm on your side 😤", "Look somewhere else, I'm innocent!", "You're wasting a vote on me.", 'I swear I was home all night 🏡'],
  saw: ["I saw {t} at {v}'s house last night 👀", "{t} visited {v} the night they vanished. Just saying."],
  vote: ['Voting {t}.', 'Going with {t}.', 'My vote is on {t}.', '{t}. Sorry not sorry.'],
  skip: ["I'm not sure yet, skipping.", 'Skipping, not enough info.'],
  den: ["Let's get {t} tonight.", '{t} is getting too close. Them?', 'I say {t} 🌑', '{t} talks too much. Bye bye.'],
  hello: ['hi everyone!', 'good luck all 🍀', 'hiii', "let's find these Sneaks"],
};
function say(room, p, key, vars = {}, channel) {
  const g = room.game, M = mem(g, p.id);
  M.spoke = M.spoke || {};
  const slot = `${g.day}-${g.phase}`;
  if ((M.spoke[slot] || 0) >= 2) return;
  M.spoke[slot] = (M.spoke[slot] || 0) + 1;
  const text = pick(LINES[key]).replace(/\{(\w)\}/g, (_, k) => vars[k] || '');
  room.act(p.id, { t: 'chat', text, channel });
}
const shared = (g) => (g.ai._shared = g.ai._shared || { mourned: new Set(), greeted: false });

const { SIZE, FUR, PLACES } = require('./world');
const looksLike = (room, id, d) => { const q = room.get(id); return !!q && ((d.size && SIZE[q.critter] === d.size) || (d.color && FUR[q.color] === d.color)); };

function mem(g, id) {
  if (!g.ai[id]) g.ai[id] = { claimedRole: false, posted: new Set(), notedIdx: 0, fakeNights: new Set() };
  return g.ai[id];
}
const top = (s, filter = () => true) => {
  const e = Object.entries(s).filter(([id]) => filter(id)).sort((a, b) => b[1] - a[1]);
  return e.length ? e[0][0] : null;
};
const accusedBy = (g, id) => g.claims.filter((c) => (c.kind === 'accuse' && c.target === id)
  || (c.kind === 'hint' && c.result === 'sneak' && c.targets.length === 1 && c.targets[0] === id)
  || (c.kind === 'saw' && c.target === id)).map((c) => c.by);
const diedAtNight = (g, house, night) => g.deaths.some((d) => d.id === house && d.how === 'night' && d.day === night);

// What this AI privately learned: Owl hints and Bunny sightings
function intel(g, id) {
  const out = { hints: [], saw: [], walks: [] };
  for (const e of g.priv[id] || []) {
    if (e.walk) out.walks.push(e.walk);
    if (e.hint) out.hints.push(e.hint);
    if (e.saw) out.saw.push({ ...e.saw, night: e.day });
  }
  return out;
}

function suspicion(room, p) {
  const g = room.game, me = p.id, sneak = isSneakTeam(g.roles[me]);
  const others = [...g.alive].filter((id) => id !== me);
  const s = {};
  others.forEach((id) => { s[id] = Math.random() * (p.aiLevel === 'sleepy' ? 10 : 1.2); });
  if (p.aiLevel === 'sleepy') return s;
  const add = (id, v) => { if (id in s) s[id] += v; };

  // My own hints
  const { hints, saw } = intel(g, me);
  const cleared = new Set([...g.turtles]);
  for (const h of hints) {
    if (!h.yes) h.group.forEach((x) => add(x, -0.8)); // "at least one is NOT a Sneak" is weak evidence
    else {
      const left = h.group.filter((x) => !cleared.has(x) && g.alive.has(x));
      left.forEach((x) => add(x, left.length === 1 ? 40 : 6 / left.length + 1));
    }
  }
  for (const v of saw) {
    if (diedAtNight(g, v.house, v.night)) v.visitors.forEach((x) => add(x, 7));
    else v.visitors.forEach((x) => add(x, 0.4));
  }
  for (const id of others) if (g.turtles.has(id)) s[id] -= 30;

  // Cards on the Board
  const roleClaims = {};
  for (const c of g.claims) {
    if (c.kind === 'role') (roleClaims[c.role] = roleClaims[c.role] || new Set()).add(c.by);
    const w = cleared.has(c.by) ? 1.5 : 1;
    if (c.kind === 'hint') {
      if (c.result === 'not') c.targets.forEach((x) => add(x, -0.6 * w));
      else c.targets.forEach((x) => add(x, (c.targets.length === 1 ? 4 : 1.5) * w));
    }
    if (c.kind === 'saw') add(c.target, (diedAtNight(g, c.at, c.day) ? 4 : 0.5) * w);
    if (c.kind === 'accuse') add(c.target, 0.8 * w);
    // Someone lying about me (I know I'm village)
    if (!sneak && c.by !== me && ((c.kind === 'saw' && c.target === me) || (c.kind === 'accuse' && c.target === me))) add(c.by, c.kind === 'saw' ? 5 : 1);
  }
  for (const [r, set] of Object.entries(roleClaims)) {
    const limit = r === 'villager' ? 99 : r === 'owl' || r === 'hedgehog' ? 2 : 1;
    if (set.size > limit) set.forEach((id) => add(id, cleared.has(id) ? 0 : 4));
    if (!sneak && r === g.roles[me] && ['bunny', 'turtle', 'lantern'].includes(r)) set.forEach((id) => add(id, 10));
  }
  // ---- Lantern Night: what I saw with my own lantern, where the Sneak struck, the tracks ----
  const myPriv = g.priv[me] || [];
  const sights = myPriv.filter((e) => e.sight).map((e) => e.sight);
  for (const e of myPriv) if (e.witness && e.witness.by in s) add(e.witness.by, 100);
  // the bell: whoever was hanging around the tombstone when it rang looks shady
  for (const h of g.history || []) if (h.bell) h.bell.near.forEach((x) => { if (x.id !== me && x.id in s) add(x.id, x.how === 'right next to it' ? 3 : x.how === 'close by' ? 2 : 1); });
  const claimedAt = (id, night) => { const c = [...g.claims].reverse().find((x) => x.kind === 'at' && x.by === id && x.night === night); return c ? c.place : null; };
  for (const sc of g.scenes || []) {
    const mine = sights.find((x) => x.night === sc.night);
    if (mine) for (const sg of mine.seen) {
      if (!(sg.id in s)) continue;
      const around = sg.pts.filter((pt) => Math.abs(pt[0] - sc.t) <= 7);
      if (!around.length) continue;
      const dmin = Math.min(...around.map((pt) => Math.hypot(pt[1] - sc.x, pt[2] - sc.y)));
      if (dmin <= 10) add(sg.id, 3); else if (dmin >= 28) add(sg.id, -3); // near the scene / a solid alibi
      // sneaking around in the dark right before it happened
      if (sg.pts.some((pt) => pt[3] === 0 && pt[0] <= sc.t + 2 && pt[0] >= sc.t - 20)) add(sg.id, 4);
    }
    // footprint shapes near the scene, around the time it happened
    const tr = ((g.trackLog || {})[sc.night] || []).filter((f) => Math.hypot(f.x - sc.x, f.y - sc.y) <= 7 && Math.abs(f.t - sc.t) <= 9);
    const sizes = new Set(tr.map((f) => f.s));
    if (sizes.size && !sc.mole) for (const id of others) { const q = room.get(id); if (q) add(id, sizes.has(SIZE[q.critter]) ? 0.8 : -0.4); }
  }
  for (const sg of sights) for (const x of sg.seen) if (x.dark && x.id in s) add(x.id, 2); // why was their lantern off?
  // Alibis people SAID vs. where I actually saw them
  for (const sg of sights) for (const x of sg.seen) {
    const said = claimedAt(x.id, sg.night);
    if (!said || !(x.id in s)) continue;
    const pl = said === 'home' ? null : PLACES[said];
    const matched = pl ? (x.zone || '').includes(pl.name) : /house/.test(x.zone || '');
    add(x.id, matched ? -1 : 1.5);
  }
  for (const c of g.claims) {
    if (c.kind !== 'seenAt' || c.by === me) continue;
    for (const t of c.targets) {
      if (!(t in s)) continue;
      const said = claimedAt(t, c.night);
      if (said === c.place) add(t, -0.6);
      else if (said) { add(t, 1.5); add(c.by, 0.5); } // stories don't match: one of them is lying
    }
  }
  // Notepads left behind
  for (const d of g.deaths) {
    for (const n of g.notes[d.id] || []) {
      for (const id of others) {
        if (!n.text.includes(room.name(id))) continue;
        if (/not a sneak/i.test(n.text)) add(id, -0.5); else if (/is a sneak/i.test(n.text)) add(id, 1.2); else if (/visited/i.test(n.text)) add(id, 0.5);
      }
    }
  }
  if (p.aiLevel === 'cunning') {
    for (const [voter, t] of Object.entries(g.votes)) if (cleared.has(t)) add(voter, 1.5);
    for (const [from, to] of Object.entries(g.yarn)) if (cleared.has(to)) add(from, 1);
  }
  if (sneak) for (const id of others) if (isSneakTeam(g.roles[id])) s[id] = -1000;
  return s;
}

// ---------------- night ----------------
// Decide tonight's targets (the bot then walks there): an ability target, a Sneak target, a Trickster target
function nightPlan(room, p) {
  const g = room.game, me = p.id, role = g.roles[me], level = p.aiLevel;
  const out = { ability: null, strike: null, meddle: null };
  const others = [...g.alive].filter((id) => id !== me);
  if (!others.length) return out;
  const claimedPower = (id) => g.claims.some((c) => c.by === id && ((c.kind === 'role' && c.role !== 'villager') || c.kind === 'hint' || c.kind === 'saw'));
  if (isSneakTeam(role)) {
    if (g.settling) return out;
    const cands = others.filter((id) => !isSneakTeam(g.roles[id]));
    if (cands.length) {
      if (level === 'sleepy') out.strike = pick(cands);
      else {
        const score = {};
        cands.forEach((id) => {
          score[id] = Math.random() * 2 + (g.turtles.has(id) ? 3 : 0) + (claimedPower(id) ? 5 : 0);
          if (accusedBy(g, id).length) score[id] -= 1; // let the village waste a vote on them
          for (const c of g.claims) if (c.by === id && c.kind === 'accuse' && isSneakTeam(g.roles[c.target])) score[id] += 4;
        });
        out.strike = top(score);
      }
    }
    if (role === 'trickster' && level !== 'sleepy') {
      const pool = others.filter((id) => id !== g.lastMeddle[me] && !isSneakTeam(g.roles[id]));
      const info = pool.filter((id) => claimedPower(id));
      if (Math.random() < 0.8) out.meddle = pick(info.length ? info : pool) || null;
    }
    return out;
  }
  const kind = ROLES[role].night;
  if (!kind) return out;
  const legal = others.filter((id) => !(kind === 'protect' && id === g.lastProtect[me]));
  if (level === 'sleepy') { out.ability = pick(legal.length ? legal : others); return out; }
  const s = suspicion(room, p);
  const victimScore = (pool) => {
    const sc = {};
    pool.forEach((id) => { sc[id] = Math.random() * 2 - Math.max(0, s[id] || 0) * 0.3 + (claimedPower(id) ? 4 : 0) + (g.turtles.has(id) ? 2 : 0); });
    return top(sc);
  };
  if (kind === 'check') out.ability = top(s, (id) => legal.includes(id) && s[id] > -5) || pick(legal);
  else if (kind === 'protect' || kind === 'light') out.ability = victimScore(legal);
  else if (kind === 'gossip') out.ability = Math.random() < 0.65 ? victimScore(legal) : top(s);
  else out.ability = Math.random() < 0.5 ? top(s) : pick(legal);
  if (!out.ability) out.ability = pick(legal);
  return out;
}

// ---------------- notepad ----------------
function notes(room, p) {
  const g = room.game, me = p.id, M = mem(g, me), sneak = isSneakTeam(g.roles[me]);
  if (p.aiLevel === 'sleepy' || !g.alive.has(me)) return;
  const log = g.priv[me] || [];
  const fresh = log.slice(M.notedIdx); M.notedIdx = log.length;
  for (const e of fresh) {
    if (!/^Night \d+:/.test(e.text)) continue;
    if (sneak && !/peeked/.test(e.text)) continue; // never write the real plan down
    room.act(me, { t: 'note', text: e.text.replace(/\byou\b /, '') });
  }
  if (sneak && !M.fakeNights.has(g.day) && g.day >= 2) {
    M.fakeNights.add(g.day);
    const t = pick([...g.alive].filter((id) => id !== me));
    if (t) room.act(me, { t: 'note', text: `Day ${g.day}: ${pick([`${room.name(t)} is acting off.`, `keeping an eye on ${room.name(t)}.`, `not sure about ${room.name(t)} yet.`])}` });
  }
}

// ---------------- day ----------------
// AIs share information by SAYING it, in their own words, like a real Mafia player.
// The game "hears" it the same way it hears humans (see hear.js).
const ROLE_SAY = { villager: 'a Villager', owl: 'the Owl', hedgehog: 'the Hedgehog', bunny: 'the Gossip Bunny', turtle: 'the Elder Turtle', lantern: 'the Lantern Keeper' };
const and = (a) => (a.length < 3 ? a.join(' and ') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
function speak(room, me, data) {
  const n = (id) => room.name(id);
  let text;
  if (data.kind === 'role') text = pick([`ok fine, I'm ${ROLE_SAY[data.role]}.`, `I'm ${ROLE_SAY[data.role]}, I promise.`, `for the record I'm ${ROLE_SAY[data.role]}.`]);
  else if (data.kind === 'hint') {
    const who = and(data.targets.map(n));
    text = data.result === 'sneak'
      ? pick([`trust me: at least one of ${who} is a Sneak.`, `I have info. at least one of ${who} is a Sneak 👀`, `not saying how I know, but at least one of ${who} is a Sneak.`])
      : pick([`fwiw, at least one of ${who} is not a Sneak.`, `I know at least one of ${who} is NOT a Sneak.`]);
  } else if (data.kind === 'saw') text = pick([`I saw ${n(data.target)} visit ${n(data.at)}'s house last night.`, `${n(data.target)}, why were you at ${n(data.at)}'s house? I saw you.`]);
  else return;
  room.act(me, { t: 'chat', text });
}
// Sometimes pin a short note on the Board too
function pin(room, me, sticker, text, tags) { room.act(me, { t: 'post', sticker, text, tags }); }

// What this critter says about its night walk. Village critters tell the truth;
// a Sneak who did the deed lies if the crime scene points at where they really were.
function alibiLine(room, p) {
  const g = room.game, me = p.id, sneak = isSneakTeam(g.roles[me]), night = g.day;
  const sg = (g.priv[me] || []).filter((e) => e.sight && e.sight.night === night).pop();
  const sc = (g.scenes || []).find((x) => x.night === night);
  const rec = g.history.find((h) => h.night === night) || {};
  let zones = sg ? sg.sight.zones.slice(0, 2) : [];
  let seen = sg ? sg.sight.seen : [];
  if (sneak && rec.culprit === me && sc) {
    // cover story: leave out the scene and anyone who might place me there
    zones = zones.filter((z) => z !== sc.zone).slice(0, 1);
    if (!zones.length) zones = [`the ${pick(g.world.landmarks).name}`];
    seen = seen.filter((x) => x.id !== sc.victim && x.zone !== sc.zone);
  }
  const M = mem(g, me); M.alibi = M.alibi || {}; M.alibi[night] = zones[0] || 'home';
  if (!zones.length) return pick(['I stayed close to home last night 🏠', 'I was home most of the night, honestly.']);
  const who = seen.map((x) => room.name(x.id));
  const list = who.length < 2 ? who.join('') : `${who.slice(0, -1).join(', ')} and ${who[who.length - 1]}`;
  return `I was around ${zones.join(' and ')} last night. ${who.length ? `crossed paths with ${list}.` : "didn't run into anyone."}`;
}

function dayTalk(room, p) {
  const g = room.game, me = p.id;
  if (!g.alive.has(me) || g.phase !== 'day') return;
  const role = g.roles[me], level = p.aiLevel, M = mem(g, me);
  if (level === 'sleepy') { if (Math.random() < 0.35) room.act(me, { t: 'emote', e: pick(['🤔', '👀', '🙏']) }); return; }
  const s = suspicion(room, p), sneak = isSneakTeam(role);
  const accusers = accusedBy(g, me).filter((id) => g.alive.has(id));
  const { hints, saw } = intel(g, me);
  const sh = shared(g);
  const lastDawn = [...g.events].reverse().find((e) => e.type === 'dawn');
  if (lastDawn && !sh.mourned.has(lastDawn.id) && Math.random() < 0.7) {
    sh.mourned.add(lastDawn.id);
    if (lastDawn.died.length) say(room, p, 'mourn', { v: room.name(lastDawn.died[0]) }); else if (lastDawn.night > 1) say(room, p, 'safe');
    else if (!sh.greeted) { sh.greeted = true; say(room, p, 'hello'); }
  }
  if (!M.posted.has(`alibi${g.day}`) && Math.random() < (level === 'cunning' ? 0.85 : 0.7)) {
    M.posted.add(`alibi${g.day}`);
    room.act(me, { t: 'chat', text: alibiLine(room, p) });
  }
  if (accusers.length && Math.random() < 0.8) say(room, p, 'defend');
  if (accusers.length >= 2 && !M.posted.has(`def${g.day}`) && Math.random() < 0.45) {
    M.posted.add(`def${g.day}`);
    pin(room, me, 'defend', pick(["It's not me! Look at the actual evidence 😤", "I've been helping all game. Wrong critter!", 'Voting me wastes a whole day. Think about it.']), []);
  }
  const claimRole = (r) => { if (!M.claimedRole) { speak(room, me, { kind: 'role', role: r }); M.claimedRole = true; } };
  const underFire = accusers.length >= 2;

  if (!sneak) {
    if (role === 'owl') {
      // Owls stay hidden. They only share a strong hint (sometimes), without saying they're the Owl,
      // and only out themselves when they're about to be voted out anyway.
      const strong = hints.map((h, i) => [h, i]).filter(([h, i]) => h.yes && !M.posted.has(`h${i}`)).pop();
      if (strong && (underFire || (g.day >= 2 && Math.random() < 0.35))) {
        M.posted.add(`h${strong[1]}`);
        if (underFire) claimRole('owl');
        speak(room, me, { kind: 'hint', targets: strong[0].group, result: 'sneak' });
      }
    } else if (role === 'bunny') {
      saw.forEach((v, i) => {
        if (M.posted.has(`s${i}`) || !diedAtNight(g, v.house, v.night) || !v.visitors.length) return;
        if (!underFire && Math.random() < 0.4) return; // sometimes keep it to themselves
        M.posted.add(`s${i}`);
        v.visitors.slice(0, 1).forEach((x) => speak(room, me, { kind: 'saw', target: x, at: v.house }));
      });
    } else if (role === 'turtle' && !g.turtles.has(me) && g.day >= 2 && (underFire || Math.random() < 0.3)) {
      room.act(me, { t: 'reveal' });
    }
    if (underFire && accusers.length >= 3 && !M.claimedRole && role !== 'frog') claimRole(role === 'moth' ? 'villager' : role);
    if (role === 'frog' && accusers.length && Math.random() < 0.5) room.act(me, { t: 'emote', e: '😱' });
  } else {
    if (underFire && !M.claimedRole) {
      const fake = level === 'cunning' && Math.random() < 0.5 ? 'owl' : pick(['villager', 'villager', 'hedgehog']);
      M.fakeRole = fake;
      claimRole(fake);
      if (fake === 'owl') {
        const acc = accusers.find((id) => !isSneakTeam(g.roles[id]));
        const filler = [...g.alive].filter((x) => x !== me && x !== acc && !isSneakTeam(g.roles[x]));
        if (acc) speak(room, me, { kind: 'hint', targets: [acc, pick(filler)].filter(Boolean), result: 'sneak' });
      }
    }
    if (level === 'cunning') {
      // Someone's "hint" points at a teammate: counter with a fake hint of our own
      for (const c of g.claims) {
        if (c.kind === 'hint' && c.result === 'sneak' && c.targets.some((x) => isSneakTeam(g.roles[x])) && g.alive.has(c.by)
          && !isSneakTeam(g.roles[c.by]) && !M.posted.has(`ctr${c.id}`)) {
          M.posted.add(`ctr${c.id}`);
          const filler = [...g.alive].filter((x) => x !== me && x !== c.by && !isSneakTeam(g.roles[x]));
          speak(room, me, { kind: 'hint', targets: [c.by, pick(filler)].filter(Boolean), result: 'sneak' });
          break;
        }
      }
      // Invent a sighting at the victim's house
      const lastDeath = g.deaths.filter((d) => d.how === 'night' && d.day === g.day).pop();
      if (lastDeath && !M.posted.has(`fs${g.day}`) && Math.random() < 0.3) {
        M.posted.add(`fs${g.day}`);
        const scapegoat = top(s);
        if (scapegoat) speak(room, me, { kind: 'saw', target: scapegoat, at: lastDeath.id });
      }
    }
  }
  const t = top(s);
  if (t && s[t] >= (sneak ? 0.8 : 3) && !M.posted.has(`day${g.day}`) && (!sneak || Math.random() < 0.5)) {
    M.posted.add(`day${g.day}`);
    if (Math.random() < 0.45) {
      const tn = room.name(t);
      pin(room, me, 'accuse', pick([`${tn} feels off to me.`, `Keep an eye on ${tn}.`, `${tn} keeps dodging questions.`, `My vote is leaning ${tn}.`]), [t]);
    } else say(room, p, 'accuse', { t: room.name(t) });
  }
  if (g.day >= 2 && !M.posted.has(`q${g.day}`) && Math.random() < 0.12) {
    M.posted.add(`q${g.day}`);
    const quiet = [...g.alive].filter((id) => id !== me && !g.chat.day.some((m) => m.by === id && m.ts > Date.now() - 90000));
    const q = pick(quiet);
    if (q) pin(room, me, 'question', pick([`Why is ${room.name(q)} so quiet today? 🤔`, `${room.name(q)}, what do you think happened last night?`, `Has anyone heard from ${room.name(q)}?`]), [q]);
  }
  if (t) room.act(me, { t: 'yarn', target: t });
  for (const c of g.board.slice(-8)) {
    if (c.by === me) continue;
    let v = null;
    if (c.tags.includes(me) && c.sticker !== 'defend') v = 'doubt';
    else if (c.sticker === 'accuse' && c.tags.length) v = (s[c.tags[0]] ?? 0) > 2 ? 'trust' : (s[c.tags[0]] ?? 0) < -5 ? 'doubt' : null;
    if (sneak && c.sticker === 'accuse' && c.tags.some((x) => isSneakTeam(g.roles[x]))) v = 'doubt';
    if (v) room.act(me, { t: 'react', id: c.id, v });
  }
}

function dayLate(room, p) {
  const g = room.game;
  if (!g.alive.has(p.id) || g.phase !== 'day') return;
  if (g.bigGame) room.act(p.id, { t: 'nominate', target: top(suspicion(room, p)) });
  if (p.aiLevel !== 'sleepy') notes(room, p);
}

function ready(room, p) { room.act(p.id, { t: 'ready' }); }

function vote(room, p) {
  const g = room.game, me = p.id;
  if (!g.alive.has(me) || g.phase !== 'vote') return;
  const cands = g.nominees.filter((id) => id !== me && g.alive.has(id));
  if (!cands.length) return room.act(me, { t: 'vote', target: 'skip' });
  const tally = {};
  Object.values(g.votes).forEach((t) => { if (t !== 'skip') tally[t] = (tally[t] || 0) + 1; });
  const lead = (f = () => true) => top(tally, (id) => cands.includes(id) && f(id));
  if (p.aiLevel === 'sleepy') return room.act(me, { t: 'vote', target: lead() || (Math.random() < 0.6 ? pick(cands) : 'skip') });
  const s = suspicion(room, p), sneak = isSneakTeam(g.roles[me]);
  let t = top(s, (id) => cands.includes(id));
  if (sneak) { const l = lead((id) => !isSneakTeam(g.roles[id])); if (l && Math.random() < 0.6) t = l; }
  else if (t && s[t] < 1.5) t = lead() || t;
  room.act(me, { t: 'vote', target: t || 'skip' });
  if (Math.random() < 0.35) say(room, p, t && t !== 'skip' ? 'vote' : 'skip', { t: t && t !== 'skip' ? room.name(t) : '' });
}

module.exports = { nightPlan, notes, dayTalk, dayLate, ready, vote, suspicion, mem, alibiLine };
