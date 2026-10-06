// Role definitions + auto-balancing for 4–14 players.
// `night` is the kind of action the role takes at night.

const ROLES = {
  villager: { name: 'Villager', team: 'village', points: 1, night: 'peek' },
  owl:      { name: 'Owl', team: 'village', points: 7, night: 'check' },
  hedgehog: { name: 'Hedgehog', team: 'village', points: 5, night: 'protect' },
  bunny:    { name: 'Gossip Bunny', team: 'village', points: 5, night: 'gossip' },
  turtle:   { name: 'Elder Turtle', team: 'village', points: 4, night: 'peek' },
  lantern:  { name: 'Lantern Keeper', team: 'village', points: 6, night: 'light' },
  sneak:    { name: 'Sneak', team: 'sneaks', points: -6, night: 'kill' },
  trickster:{ name: 'Trickster', team: 'sneaks', points: -8, night: 'kill' },
  mole:     { name: 'Shadow Mole', team: 'sneaks', points: -7, night: 'kill' },
  frog:     { name: 'Pond Frog', team: 'frog', points: -3, night: 'peek' },
  moth:     { name: 'Wandering Moth', team: 'moth', points: -2, night: 'peek' },
};

const isSneakTeam = (role) => ROLES[role] && ROLES[role].team === 'sneaks';

function sneakCount(n) { if (n <= 7) return 1; if (n <= 12) return 2; return 3; }
function powerRange(n) {
  const table = { 4: [1, 1], 5: [1, 1], 6: [2, 2], 7: [1, 1], 8: [5, 5], 9: [4, 5], 10: [4, 5], 11: [3, 4], 12: [3, 3], 13: [6, 7], 14: [6, 6] };
  return table[n] || [5, 6];
}
function soloRange(n, spice) {
  if (spice !== 'chaos' || n < 6) return [0, 0];
  if (n <= 9) return [0, 1];
  return [1, 1];
}
const POWER_POOLS = {
  cozy:    { owl: 3, hedgehog: 2 },
  classic: { owl: 2, hedgehog: 2, bunny: 1, turtle: 1, lantern: 1 },
  chaos:   { owl: 2, hedgehog: 2, bunny: 1, turtle: 1, lantern: 1 },
};

const rint = (a, b, rng) => a + Math.floor(rng() * (b - a + 1));
const pick = (arr, rng = Math.random) => arr[Math.floor(rng() * arr.length)];
function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function oneSetup(n, spice, rng) {
  const roles = [];
  // Sneak team
  const s = sneakCount(n);
  roles.push('sneak');
  const extras = spice === 'cozy' ? [] : spice === 'classic' ? ['trickster'] : shuffle(['trickster', 'mole'], rng);
  for (let i = 1; i < s; i++) {
    if (extras.length && rng() < 0.6) roles.push(extras.shift()); else roles.push('sneak');
  }
  // Solo
  const [smin, smax] = soloRange(n, spice);
  const solos = rint(smin, smax, rng);
  for (let i = 0; i < solos; i++) roles.push(pick(['frog', 'moth'], rng));
  // Village power roles (Owl always first, Hedgehog second)
  const pool = { ...POWER_POOLS[spice] || POWER_POOLS.cozy };
  const [pmin, pmax] = powerRange(n);
  const room = n - roles.length;
  let power = Math.min(rint(pmin, pmax, rng), room);
  const chosen = [];
  const take = (r) => { if (pool[r] > 0 && chosen.length < power) { chosen.push(r); pool[r]--; } };
  take('owl'); take('hedgehog');
  while (chosen.length < power) {
    const left = Object.keys(pool).filter((k) => pool[k] > 0);
    if (!left.length) break;
    // Prefer roles not yet used before doubling up
    const fresh = left.filter((k) => !chosen.includes(k));
    take(pick(fresh.length ? fresh : left, rng));
  }
  roles.push(...chosen);
  while (roles.length < n) roles.push('villager');
  return roles;
}

// Builds a balanced role list: samples many legal setups for this size and
// keeps the one whose point total is closest to 0 (target window: -2..+2).
function generateSetup(n, spice = 'cozy', rng = Math.random) {
  let best = null, bestScore = Infinity;
  for (let i = 0; i < 300; i++) {
    const roles = oneSetup(n, spice, rng);
    const total = roles.reduce((sum, r) => sum + ROLES[r].points, 0);
    const score = Math.abs(total) + rng() * 0.5;
    if (score < bestScore) { best = roles; bestScore = score; }
  }
  return shuffle(best, rng);
}

module.exports = { ROLES, isSneakTeam, generateSetup, shuffle, pick };
