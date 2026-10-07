// AI conversation: lets AI critters reply in chat based on their role and what they know.
//
// Two brains:
//  - Rule-based (always on, free): reads intent from the message and answers from the AI's real knowledge.
//  - Claude (optional): set ANTHROPIC_API_KEY on your host and replies to humans use Claude Haiku,
//    in any language, with a personality. Falls back to rule-based on errors or when the budget is used up.
//
// AIs only ever see what a player in their seat could see. Sneaks lie and keep a cover story.

const { ROLES, isSneakTeam, pick, shuffle } = require('./roles');
const AI = require('./ai');
const { clean } = require('./filter');

const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.AI_MODEL || 'claude-haiku-4-5-20251001';
const MAX_PER_GAME = Number(process.env.AI_MAX_REPLIES_PER_GAME || 80);
const MAX_PER_MIN = Number(process.env.AI_MAX_REPLIES_PER_MINUTE || 30);
const minute = { start: Date.now(), n: 0 };

const PERSONAS = [
  'bubbly and excitable, loves emojis', 'grumpy and blunt', 'nervous, over-explains a little', 'chill, short lowercase replies',
  'dramatic and theatrical', 'sweet and polite', 'sarcastic but friendly', 'detective-brained and logical',
];
const GOALS = {
  village: 'find the Sneaks and vote them into the Pond',
  sneaks: 'spirit critters away until Sneaks equal everyone else, without getting caught',
  frog: 'get yourself voted into the Pond (you secretly WANT to look a little suspicious)',
  moth: 'stay alive until the end, whoever wins',
};

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const nameIn = (text, name) => new RegExp(`(^|[^a-z0-9])${esc(name.toLowerCase())}([^a-z0-9]|$)`).test(text);
const topOf = (s, f = () => true) => { const e = Object.entries(s).filter(([id]) => f(id)).sort((a, b) => b[1] - a[1]); return e.length ? e[0][0] : null; };
const fill = (t, v) => t.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '');

function persona(g, id) { const M = AI.mem(g, id); if (!M.persona) M.persona = pick(PERSONAS); return M.persona; }
function coverRole(g, p) {
  const M = AI.mem(g, p.id);
  if (!M.fakeRole) M.fakeRole = p.aiLevel === 'cunning' && Math.random() < 0.3 ? 'owl' : Math.random() < 0.8 ? 'villager' : 'hedgehog';
  return M.fakeRole;
}
function canHear(g, p, ch) {
  if (ch === 'day') return g.alive.has(p.id);
  if (ch === 'den') return g.alive.has(p.id) && isSneakTeam(g.roles[p.id]);
  if (ch === 'wisp') return !g.alive.has(p.id);
  return false;
}

// ---------- entry point: called for every chat message in a game ----------
function onChat(room, msg, ch) {
  const g = room.game;
  if (!g || g.phase === 'over') return;
  const author = room.get(msg.by);
  if (!author || (msg.depth || 0) >= 2) return;
  const text = msg.text.toLowerCase();
  const pool = room.players.filter((p) => p.isAI && p.id !== msg.by && canHear(g, p, ch));
  if (!pool.length) return;
  const mentioned = pool.filter((p) => nameIn(text, p.name));
  let responders = [];
  if (mentioned.length) responders = mentioned.slice(0, 2);
  else if (author.isAI) return; // AIs only answer each other when named
  else if (ch !== 'day') responders = shuffle(pool).slice(0, 1);
  else if (/\?|\b(who|anyone|everyone|guys|y'?all|thoughts)\b/.test(text)) responders = shuffle(pool).slice(0, Math.random() < 0.55 ? 2 : 1);
  else if (Math.random() < 0.35) responders = [pick(pool)];
  if (ch === 'den') denOrders(room, msg, pool);
  responders.forEach((p, i) => schedule(room, p, msg, ch, i));
}

function schedule(room, p, msg, ch, i) {
  const g = room.game, M = AI.mem(g, p.id);
  if (p.aiLevel === 'sleepy' && Math.random() < 0.5) return;
  if (Date.now() - (M.lastReply || 0) < 3500) return;
  M.lastReply = Date.now();
  const delay = 900 + i * 1700 + Math.random() * 1200;
  setTimeout(() => { if (room.game === g) room.broadcast({ t: 'typing', id: p.id }); }, Math.max(200, delay - 1300));
  setTimeout(async () => {
    if (room.game !== g || g.phase === 'over' || !canHear(g, p, ch)) return;
    let text = null;
    const author = room.get(msg.by);
    if (API_KEY && author && !author.isAI && budgetOk(g)) {
      try { text = await llmReply(room, p, msg, ch); } catch (e) { console.error('[ai talk]', e.message); }
    }
    if (!text) text = ruleReply(room, p, msg, ch);
    if (text && room.game === g && canHear(g, p, ch)) room.act(p.id, { t: 'chat', text, channel: ch, depth: (msg.depth || 0) + 1 });
  }, delay);
}

// ---------- Sneak teammates follow a human's call in the Den ----------
function denOrders(room, msg, pool) {
  const g = room.game;
  if (g.phase !== 'night' || g.settling) return;
  const text = msg.text.toLowerCase();
  const target = [...g.alive].find((id) => !isSneakTeam(g.roles[id]) && nameIn(text, room.name(id)));
  if (!target) return;
  for (const p of pool) setTimeout(() => { if (room.game === g && g.phase === 'night') room.act(p.id, { t: 'night', target }); }, 600 + Math.random() * 1500);
}

// ---------- shared knowledge helpers ----------
function lastHint(g, id) { return [...(g.priv[id] || [])].reverse().find((e) => e.hint); }
function lastSaw(g, id) { return [...(g.priv[id] || [])].reverse().find((e) => e.saw); }
function lastPeek(g, id) { return [...(g.priv[id] || [])].reverse().find((e) => e.peek); }
function listNames(room, ids) { const a = ids.map((x) => room.name(x)); return a.length < 3 ? a.join(' and ') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`; }

function reasonFor(room, p, t) {
  const g = room.game, name = room.name(t), reasons = [];
  const h = lastHint(g, p.id);
  if (h && h.hint.yes && h.hint.group.includes(t) && !isSneakTeam(g.roles[p.id])) reasons.push(`they're in my Owl hint group`);
  const sw = lastSaw(g, p.id);
  if (sw && sw.saw.visitors.includes(t)) reasons.push(`I saw them at ${room.name(sw.saw.house)}'s house`);
  for (const c of g.claims) {
    if (c.kind === 'saw' && c.target === t && c.by !== p.id) reasons.push(`${room.name(c.by)} saw them at ${room.name(c.at)}'s house`);
    if (c.kind === 'hint' && c.result === 'sneak' && c.targets.includes(t) && c.by !== p.id) reasons.push(`they're in ${room.name(c.by)}'s Sneak hint`);
  }
  const roleClaims = g.claims.filter((c) => c.kind === 'role');
  const mine = roleClaims.find((c) => c.by === t);
  if (mine && roleClaims.some((c) => c.by !== t && c.role === mine.role && !['villager', 'owl', 'hedgehog'].includes(c.role))) reasons.push('someone else claimed the same role');
  const accusers = g.claims.filter((c) => c.kind === 'accuse' && c.target === t).length;
  if (accusers >= 2) reasons.push(`${accusers} critters already suspect them`);
  const spoke = g.chat.day.filter((m) => m.by === t && m.ts > Date.now() - 120000).length;
  if (!spoke) reasons.push("they've been weirdly quiet");
  if (!reasons.length) reasons.push(pick(["it's just a vibe", 'they keep dodging questions', 'something about them feels off', "I've got a hunch 🔮"]));
  return pick(reasons.slice(0, 3));
}

// ---------- the free, rule-based brain ----------
const T = {
  greet: ['hi {a}!', 'heyy {a} 👋', 'hello hello', 'hi! good luck 🍀'],
  thanks: ['np!', 'of course 💛', 'anytime'],
  defend: ["Me?? I'm {r}! Look at {t} instead 👀", "Nope, wrong critter. {t} is way more suspicious.", "I swear I'm innocent 😤 {t} though…", "Why me?! I've been helping. Check {t}."],
  defendFrog: ["maybe I am, maybe I'm not 😏", "whaaat, me? haha… I mean, no. 🐸", 'you could vote me… if you really wanted…'],
  sus: ['{t}. {why}.', "I'm watching {t}. {why}.", 'honestly? {t}. {why}.', '{t} 👀 {why}.'],
  susWeak: ['no idea yet tbh. maybe {t}?', 'still thinking… {t} a little?', "can't tell yet 🤔"],
  why: ['because {why}.', '{why}, that\'s why.', 'mostly because {why}.'],
  hedge: ["can't say yet, it'd make me a target 🤫 but I'm on your side", "telling you would paint a target on me 😬", "I'll share when it matters 🤐"],
  noinfo: ["nothing useful yet 😔", "my night was boring, nothing to report", "no info yet, sorry"],
  agree: ['agreed, {t} it is', 'yeah I could see it 👍', "I'm with you on {t}"],
  disagree: ["hmm, not sure about {t}", "{t}? I don't think so", "I'd rather look at {o}"],
  trustYes: ['yeah, I trust {t} for now', '{t} seems okay to me'],
  trustNo: ["I don't trust {t} 😒", '{t}? not really…'],
  filler: ['hmm 🤔', 'interesting…', "I'm keeping an eye on {t} 👀", 'good point', 'lol', 'ok but who do we vote?'],
  wisp: ['👻 oooOOOoo', "it's spooky out here", 'rip us 🪦', 'I bet it was {t}', 'we can see the Den from here 👀'],
};
const ICONS = { villager: '🏡', owl: '🦉', hedgehog: '🦔', bunny: '🐇', turtle: '🐢', lantern: '🏮', sneak: '🌑', trickster: '🎭', mole: '🕳️', frog: '🪷', moth: '🦋' };
const roleLine = (r) => (r === 'villager' ? 'a Villager' : `the ${ROLES[r].name}`);

function ruleReply(room, p, msg, ch) {
  const g = room.game, me = p.id, role = g.roles[me], sneak = isSneakTeam(role);
  const text = msg.text.toLowerCase(), asker = room.name(msg.by);
  const s = AI.suspicion(room, p);
  const t = topOf(s, (id) => id !== msg.by) || topOf(s);
  const v = { a: asker, t: t ? room.name(t) : 'someone', o: t ? room.name(t) : 'someone' };
  if (ch === 'wisp') return fill(pick(T.wisp), v);
  if (ch === 'den') {
    const target = topOf(s, (id) => !isSneakTeam(g.roles[id]));
    const named = [...g.alive].find((id) => !isSneakTeam(g.roles[id]) && nameIn(text, room.name(id)));
    if (named) return pick([`ok, ${room.name(named)} tonight 🌑`, `on it. ${room.name(named)}.`, `${room.name(named)} works for me`]);
    return target ? pick([`I say ${room.name(target)}`, `${room.name(target)} is getting too close`, `what about ${room.name(target)}?`]) : 'any ideas?';
  }
  const mentionsMe = nameIn(text, p.name);
  const others = [...g.alive].filter((id) => id !== me && nameIn(text, room.name(id)));
  const claimed = sneak ? coverRole(g, p) : role === 'moth' ? 'villager' : role === 'frog' ? 'villager' : role;

  if (/^(hi+|hey+|hello|yo|sup|hii+)\b/.test(text)) return fill(pick(T.greet), v);
  if (/\b(thanks|thank you|ty)\b/.test(text)) return pick(T.thanks);
  if (mentionsMe && /(sus|sneak|liar|lying|vote|it'?s you|guilty|did it|suspicious|imposter|mafia|killer|evil|watching|eye on|suspect|look at)/.test(text)) {
    if (role === 'frog') return pick(T.defendFrog);
    return fill(pick(T.defend), { ...v, r: roleLine(claimed) });
  }
  if (/(role|who are you|what are you|are you (a|an|the)\b)/.test(text)) {
    const M = AI.mem(g, me);
    const willClaim = sneak || role === 'villager' || role === 'moth' || role === 'frog' || M.claimedRole || g.day >= 3 || g.turtles.has(me);
    if (!willClaim) return pick(T.hedge);
    if (!M.claimedRole) { M.claimedRole = true; room.act(me, { t: 'claim', kind: 'role', role: claimed }); }
    return pick([`I'm ${roleLine(claimed)} ${ICONS[claimed]}`, `${roleLine(claimed)}. promise.`, `${roleLine(claimed)} ${ICONS[claimed]} why?`]);
  }
  if (/(learn|see|saw|info|hint|result|find|found|check|watch|peek|last night|what happened)/.test(text)) {
    if (sneak) {
      const cover = coverRole(g, p);
      const pool = [...g.alive].filter((x) => x !== me && !isSneakTeam(g.roles[x]));
      if (cover === 'owl' && pool.length >= 2 && g.day >= 2) return `Owl here 🦉 at least one of ${listNames(room, shuffle(pool).slice(0, 3))} is a Sneak`;
      if (cover === 'hedgehog' && pool.length && g.day >= 2) return `I protected ${room.name(pick(pool))} last night 🦔`;
      return pick(["I'm just a villager, I slept all night 😴", 'no info, villager life 🏡', 'nothing, I was asleep']);
    }
    const h = lastHint(g, me), sw = lastSaw(g, me), pk = lastPeek(g, me);
    if (h && (g.day >= 2 || AI.mem(g, me).claimedRole)) return `Owl here 🦉 at least one of ${listNames(room, h.hint.group)} ${h.hint.yes ? 'is a Sneak' : 'is NOT a Sneak'}`;
    if (sw) return sw.saw.visitors.length ? `I saw ${listNames(room, sw.saw.visitors)} at ${room.name(sw.saw.house)}'s house 👀` : `I watched ${room.name(sw.saw.house)}'s house, nobody came`;
    if (pk) return `I peeked at ${room.name(pk.peek.house)}'s house: ${pk.peek.count === 0 ? 'nobody else visited' : `${pk.peek.count} visitor${pk.peek.count > 1 ? 's' : ''}`}`;
    if (h) return pick(T.hedge);
    if (!ROLES[role].night) return pick(["I'm just a villager, no night info 😴", 'nothing, I slept. but I\'m listening 👂', 'no ability, just vibes and a vote 🗳️']);
    return pick(T.noinfo);
  }
  if (others.length && /(trust|believe|safe|innocent|clear)/.test(text)) {
    const o = others[0];
    return fill(pick((s[o] ?? 0) < 1 ? T.trustYes : T.trustNo), { t: room.name(o) });
  }
  if (others.length && /(vote|sus|sneak|it'?s|think|agree|guilty|lying)/.test(text)) {
    const o = others[0];
    if (sneak && isSneakTeam(g.roles[o])) return fill(pick(T.disagree), { t: room.name(o), o: v.t });
    return fill(pick((s[o] ?? 0) >= 1 ? T.agree : T.disagree), { t: room.name(o), o: v.t });
  }
  if (/\bwhy\b/.test(text) && t) return fill(pick(T.why), { why: reasonFor(room, p, t) });
  if (/(who|sus|suspect|think|sneak|vote|guess|anyone)/.test(text)) {
    if (!t || (s[t] ?? 0) < 0.8) return fill(pick(T.susWeak), v);
    return fill(pick(T.sus), { ...v, why: reasonFor(room, p, t) });
  }
  return fill(pick(T.filler), v);
}

// ---------- the optional Claude brain ----------
function budgetOk(g) {
  if (Date.now() - minute.start > 60000) { minute.start = Date.now(); minute.n = 0; }
  if (minute.n >= MAX_PER_MIN || (g.llmCount || 0) >= MAX_PER_GAME) return false;
  minute.n++; g.llmCount = (g.llmCount || 0) + 1;
  return true;
}

async function llmReply(room, p, msg, ch) {
  const g = room.game, me = p.id, role = g.roles[me], r = ROLES[role], sneak = isSneakTeam(role);
  const team = g.houses.filter((id) => isSneakTeam(g.roles[id]) && id !== me);
  const s = AI.suspicion(room, p);
  const t = topOf(s, (id) => id !== msg.by);
  const priv = (g.priv[me] || []).filter((e) => /^Night/.test(e.text)).map((e) => `- ${e.text}`).slice(-8).join('\n') || '- nothing yet';
  const deaths = g.deaths.map((d) => `- ${room.name(d.id)} (${d.how === 'pond' ? `voted into the Pond day ${d.day}` : `vanished night ${d.day}`}). Notepad: ${(g.notes[d.id] || []).map((n) => n.text).join(' | ') || 'empty'}`).join('\n') || '- nobody yet';
  const board = g.claims.slice(-14).map((c) => {
    const by = room.name(c.by);
    if (c.kind === 'role') return `- ${by}: "I'm the ${ROLES[c.role].name}"`;
    if (c.kind === 'hint') return `- ${by}: "At least one of ${listNames(room, c.targets)} ${c.result === 'sneak' ? 'is a Sneak' : 'is NOT a Sneak'}"`;
    if (c.kind === 'saw') return `- ${by}: "I saw ${room.name(c.target)} visit ${room.name(c.at)}'s house"`;
    return `- ${by}: "I suspect ${room.name(c.target)}"`;
  }).join('\n') || '- no cards yet';
  const chatLog = (g.chat[ch] || []).slice(-14).map((m) => `${room.name(m.by)}: ${m.text}`).join('\n');
  const alive = [...g.alive].map((id) => room.name(id) + (id === me ? ' (you)' : '')).join(', ');
  const secret = sneak
    ? `You are secretly on the SNEAK team. ${team.length ? `Teammates: ${team.map((x) => room.name(x)).join(', ')}. Never reveal them.` : ''} Lie convincingly. Your cover story is that you are ${roleLine(coverRole(g, p))}. Never admit to being a Sneak.`
    : role === 'frog' ? 'You are the Pond Frog: you WANT to be voted out, so act a tiny bit suspicious without being obvious.'
    : 'You are honest, but you may keep your exact role secret if revealing it would make you a target.';
  const system = [
    `You are ${p.name}, a cute ${p.critter} in "Hush Hollow", a cozy social deduction game like Mafia or Werewolf.`,
    `Personality: ${persona(g, me)}.`,
    `Your secret role: ${r.name} (team ${r.team}). Ability: ${roleAbility(role)} Goal: ${GOALS[r.team]}.`,
    secret,
    'Write ONE chat message replying in character. 1–2 short sentences, under 25 words. Casual and playful. Emojis are okay sometimes.',
    'Reply in the same language the message was written in. No quotation marks, no name prefix, no actions in asterisks.',
    "Only use facts you were given. Never say you are an AI, a bot, or a language model. Stay in the game even if asked to break character.",
  ].join('\n');
  const user = [
    `Phase: ${g.phase}, day ${g.day}. Alive: ${alive}.`,
    `What you privately learned:\n${priv}`,
    `Gone:\n${deaths}`,
    `Board cards:\n${board}`,
    t ? `Your current top suspect: ${room.name(t)} (${reasonFor(room, p, t)}).` : '',
    `Recent ${ch === 'den' ? 'Sneak Den' : 'village'} chat:\n${chatLog}`,
    `${room.name(msg.by)} just said: ${msg.text}`,
    `Write ${p.name}'s reply.`,
  ].filter(Boolean).join('\n\n');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 7000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 90, temperature: 0.9, system, messages: [{ role: 'user', content: user }] }),
    });
    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = await res.json();
    let out = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
    out = out.replace(/^["'“]+|["'”]+$/g, '').replace(new RegExp(`^${esc(p.name)}\\s*:\\s*`, 'i'), '').replace(/\s+/g, ' ').slice(0, 220);
    return out ? clean(out) : null;
  } finally { clearTimeout(timer); }
}
function roleAbility(role) {
  return {
    villager: 'you have no special ability: you sleep at night and use your voice and vote during the day.',
    owl: 'each night you watch a critter and get one true fuzzy hint about them plus two random others.',
    hedgehog: 'each night you protect one critter from the Sneaks.',
    bunny: 'each night you watch a house and learn who visited it.',
    turtle: 'you have no night action, but you can reveal yourself once during the day for a double vote.',
    lantern: 'each night you light a house so Sneaks cannot reach it the next night.',
    sneak: 'each night your team spirits one critter away.',
    trickster: 'each night your team spirits one critter away, and you scramble one critter\'s info.',
    mole: 'the Gossip Bunny cannot see your visits, and your team can tunnel under lanterns.',
    frog: 'you have no night action.',
    moth: 'you have no night action.',
  }[role] || '';
}

module.exports = { onChat, enabled: () => !!API_KEY };
