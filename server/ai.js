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
  // ---- Night walks, alibis and crime scenes ----
  const { walks: walks0 } = intel(g, me); const walks = walks0;
  const myWalk = (night) => walks.find((w) => w.night === night);
  const claimedAt = (id, night) => { const c = [...g.claims].reverse().find((x) => x.kind === 'at' && x.by === id && x.night === night); return c ? c.place : null; };
  for (const w of walks) {
    // Alibi checks: someone says they were where I was, but I didn't see anyone like them
    for (const id of others) {
      const said = claimedAt(id, w.night);
      const sawClearly = w.seen.some((x) => x.id === id);
      if (said === w.place) {
        if (sawClearly) add(id, -1.2);
        else if (!w.seen.some((x) => !x.id && looksLike(room, id, x))) add(id, 4); // lied about being there
      } else if (said && sawClearly) add(id, 4); // I saw them somewhere else
    }
    // Someone slipped away from my spot
    if (w.slip) for (const id of others) {
      if (w.seen.some((x) => x.id === id)) add(id, 3);
      else if (w.seen.some((x) => !x.id && looksLike(room, id, x))) add(id, 1.2);
      if (claimedAt(id, w.night) === w.place) add(id, 1.5);
    }
  }
  for (const sc of g.scenes || []) {
    const f = sc.facts || {};
    for (const id of others) {
      const q = room.get(id); if (!q) continue;
      if (f.size && SIZE[q.critter] === f.size) add(id, 1);
      if (f.size && SIZE[q.critter] !== f.size) add(id, -0.6);
      if (f.sizeNot) add(id, SIZE[q.critter] === f.sizeNot ? -0.6 : 0.4);
      if (f.color && FUR[q.color] === f.color) add(id, 2.5);
      if (f.from) {
        const said = claimedAt(id, sc.night), w = myWalk(sc.night);
        if (f.from === 'home') { if (said === 'home') add(id, 1.5); else if (!said) add(id, 0.4); }
        else {
          if (said === f.from) add(id, 2);
          if (w && w.place === f.from) {
            if (w.seen.some((x) => x.id === id)) add(id, 2.5);
            else if (w.seen.some((x) => !x.id && looksLike(room, id, x))) add(id, 1);
          }
        }
      }
    }
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
function night(room, p) {
  const g = room.game, me = p.id;
  if (!g.alive.has(me) || g.phase !== 'night') return;
  const role = g.roles[me], level = p.aiLevel;
  const others = [...g.alive].filter((id) => id !== me);
  if (!others.length) return;
  const send = (target, extra = {}) => target && room.act(me, { t: 'night', target, ...extra });
  if (!(me in g.walks)) {
    const home = level === 'sleepy' ? 0.25 : isSneakTeam(role) ? 0.15 : 0.08;
    room.act(me, { t: 'night', kind: 'walk', place: Math.random() < home ? 'home' : pick(g.places) });
  }
  const claimedPower = (id) => g.claims.some((c) => c.by === id && ((c.kind === 'role' && c.role !== 'villager') || c.kind === 'hint' || c.kind === 'saw'));

  if (isSneakTeam(role) && !g.settling) {
    const mole = [...g.alive].some((id) => g.roles[id] === 'mole');
    const cands = others.filter((id) => !isSneakTeam(g.roles[id]) && (!g.lit.has(id) || mole));
    if (cands.length) {
      let t;
      if (level === 'sleepy') t = pick(cands);
      else {
        const teamPicks = Object.values(g.sneakVotes).filter((x) => cands.includes(x));
        if (teamPicks.length && Math.random() < 0.75) t = pick(teamPicks);
        else {
          const score = {};
          cands.forEach((id) => {
            score[id] = Math.random() * 2 + (g.turtles.has(id) ? 3 : 0) + (claimedPower(id) ? 5 : 0);
            if (accusedBy(g, id).length) score[id] -= 1; // let the village waste a vote on them
            for (const c of g.claims) if (c.by === id && c.kind === 'accuse' && isSneakTeam(g.roles[c.target])) score[id] += 4;
          });
          t = top(score);
        }
      }
      send(t);
      const team = [...g.alive].filter((id) => isSneakTeam(g.roles[id]));
      if (t && team.length > 1 && level !== 'sleepy' && Math.random() < 0.6) setTimeout(() => {
        if (room.game === g && g.phase === 'night' && g.alive.has(me)) say(room, p, 'den', { t: room.name(t) }, 'den');
      }, 400 + Math.random() * 1500);
    }
    if (role === 'trickster' && level !== 'sleepy') {
      const pool = others.filter((id) => id !== g.lastMeddle[me] && !isSneakTeam(g.roles[id]));
      const info = pool.filter((id) => claimedPower(id));
      const target = pick(info.length ? info : pool);
      if (target && Math.random() < 0.8) room.act(me, { t: 'night', kind: 'meddle', target });
    }
    return;
  }

  if (isSneakTeam(role)) return; // quiet night
  const kind = ROLES[role].night;
  if (!kind) return; // Villagers and other no-ability roles sleep
  const legal = others.filter((id) => !(kind === 'protect' && id === g.lastProtect[me]) && !(kind === 'light' && id === g.lastLight[me]));
  if (level === 'sleepy') return send(pick(legal.length ? legal : others));
  const s = suspicion(room, p);
  const victimScore = (pool) => {
    const sc = {};
    pool.forEach((id) => { sc[id] = Math.random() * 2 - Math.max(0, s[id] || 0) * 0.3 + (claimedPower(id) ? 4 : 0) + (g.turtles.has(id) ? 2 : 0); });
    return top(sc);
  };
  let t;
  if (kind === 'check') t = top(s, (id) => legal.includes(id) && s[id] > -5) || pick(legal);
  else if (kind === 'protect' || kind === 'light') t = victimScore(legal);
  else if (kind === 'gossip') t = Math.random() < 0.65 ? victimScore(legal) : top(s);
  else t = Math.random() < 0.5 ? top(s) : pick(legal);
  send(t || pick(legal));
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
  const g = room.game, me = p.id, sneak = isSneakTeam(g.roles[me]);
  const night = g.day;
  const w = intel(g, me).walks.find((x) => x.night === night);
  const rec = g.history.find((h) => h.night === night) || {};
  const sc = (g.scenes || []).find((x) => x.night === night);
  let place = w ? w.place : (rec.walks && rec.walks[me]) || 'home';
  let seen = w ? w.seen : [];
  let slip = w ? w.slip : false;
  if (sneak && rec.culprit === me && sc && sc.facts && sc.facts.from === place) {
    // cover story: "home" can't be checked by anyone, so it's the safer lie
    place = Math.random() < (p.aiLevel === 'cunning' ? 0.8 : 0.6) ? 'home' : pick(g.places.filter((x) => x !== place)); seen = []; slip = false;
  }
  if (sneak && rec.culprit === me && sc && sc.facts && sc.facts.from === 'home' && place === 'home' && p.aiLevel !== 'sleepy') {
    // pick the spot fewest critters admitted to visiting
    const counts = {}; g.places.forEach((x) => { counts[x] = 0; });
    g.claims.filter((c) => c.kind === 'at' && c.night === night && counts[c.place] !== undefined).forEach((c) => { counts[c.place]++; });
    place = Object.entries(counts).sort((x, y) => x[1] - y[1])[0][0];
  }
  const M = mem(g, me); M.alibi = M.alibi || {}; M.alibi[night] = place;
  if (place === 'home') return pick(['I stayed home last night 🏠', 'I was home all night, honestly.', 'stayed home last night, too spooky out 😬']);
  const pl = PLACES[place];
  const who = seen.map((x) => (x.id ? room.name(x.id) : x.size ? `a ${x.size} critter` : `someone with ${x.color} fur`));
  const list = who.length < 2 ? who.join('') : `${who.slice(0, -1).join(', ')} and ${who[who.length - 1]}`;
  return `I was at the ${pl.name} ${pl.e} last night. ${who.length ? `saw ${list}.` : 'nobody else was there.'}${slip ? ' and someone slipped away partway through 👀' : ''}`;
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

module.exports = { night, notes, dayTalk, dayLate, ready, vote, suspicion, mem, alibiLine };
