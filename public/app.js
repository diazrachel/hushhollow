/* Hush Hollow client. Talks to the server over one WebSocket and renders whatever the server says this player may see. */
(() => {
  const { CRITTERS, COLORS, HATS, EMOTES, ROLES, TEAM_NAMES, HANDBOOK } = window.HH;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- local storage (safe) ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  };
  const randToken = () => (crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''));
  let token = store.get('hh-token', null);
  if (!token || !/^[a-zA-Z0-9-]{16,64}$/.test(token)) { token = randToken(); store.set('hh-token', token); }
  const NAMES = ['Mossy', 'Button', 'Pudding', 'Sorrel', 'Kiwi', 'Bluebell', 'Toffee', 'Pebbles', 'Sage', 'Waffle'];
  const profile = Object.assign({
    name: '', critter: 'fox', color: 'honey', hat: 'none', games: 0, tutorialDone: false, hints: true, sound: true, motion: true, theme: 'auto',
  }, store.get('hh-profile', {}));
  if (!profile.name) profile.name = NAMES[Math.floor(Math.random() * NAMES.length)];
  const pubProfile = () => ({ name: profile.name, critter: profile.critter, color: profile.color, hat: profile.hat, games: profile.games });
  function saveProfile() { store.set('hh-profile', profile); send({ t: 'profile', profile: pubProfile() }); }

  // ---------- light / dark ----------
  const darkQuery = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
  const isDark = () => profile.theme === 'dark' || (profile.theme === 'auto' && !!(darkQuery && darkQuery.matches));
  function applyTheme() {
    const dark = isDark();
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.content = dark ? '#211B38' : '#BFE6F5';
    const g = document.getElementById('g-theme-btn'); if (g) { g.textContent = dark ? '☀️' : '🌙'; g.title = dark ? 'Switch to light mode' : 'Switch to dark mode'; }
    const h = document.getElementById('home-theme-btn'); if (h) h.textContent = dark ? '☀️ Light mode' : '🌙 Dark mode';
  }
  function toggleTheme() { profile.theme = isDark() ? 'light' : 'dark'; saveProfile(); applyTheme(); }
  if (darkQuery) { const onChange = () => { if (profile.theme === 'auto') applyTheme(); }; if (darkQuery.addEventListener) darkQuery.addEventListener('change', onChange); else if (darkQuery.addListener) darkQuery.addListener(onChange); }

  // ---------- connection ----------
  let ws = null, S = null, offset = 0, retry = 0;
  const ui = {
    tab: 'board', chatCh: 'day', composer: 'hint', muted: new Set(), phaseKey: '', phaseStart: 0,
    hints: {}, overShown: null, seenChat: 0, lastDeaths: 0, built: { lobby: false },
  };
  let retryTimer = 0;
  function connect() {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss://' : 'ws://'}${location.host}/ws`);
    ws.onopen = () => { retry = 0; $('#conn').classList.add('hidden'); send({ t: 'hello', token, profile: pubProfile() }); };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } onMsg(m); };
    ws.onclose = () => { $('#conn').classList.remove('hidden'); clearTimeout(retryTimer); retryTimer = setTimeout(connect, Math.min(8000, 500 * 2 ** retry++)); };
  }
  function showRejoin(r) {
    let el = $('#rejoin-card');
    if (!r) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('section'); el.id = 'rejoin-card'; el.className = 'card rejoin-card'; $('#home').insertBefore(el, $('#home').children[1]); }
    el.innerHTML = `<div><b>🔙 Your game is still going!</b><p class="small muted" style="margin:.2rem 0 0">An AI critter is keeping ${esc(r.name)}'s seat warm in burrow <b>${esc(r.code)}</b>.</p></div>
      <button class="btn primary" id="rejoin-btn">Rejoin game</button>`;
    $('#rejoin-btn').onclick = () => { send({ t: 'rejoin' }); el.remove(); };
  }
  function reconnectNow() { if (ws && (ws.readyState === 0 || ws.readyState === 1)) return; clearTimeout(retryTimer); retry = 0; connect(); }
  window.addEventListener('online', reconnectNow);
  document.getElementById('conn-retry').addEventListener('click', reconnectNow);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reconnectNow(); });
  function send(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }

  function onMsg(m) {
    if (m.t === 'state') { offset = m.now - Date.now(); const prev = S; S = m; onState(prev); }
    else if (m.t === 'home') { S = null; showScreen('home'); closeAllModals(); showRejoin(m.rejoin); urlJoin(); }
    else if (m.t === 'error') toast(m.text);
    else if (m.t === 'kicked') { toast('The host removed you from the burrow.'); S = null; showScreen('home'); }
    else if (m.t === 'nf') { if (window.HHNight) window.HHNight.onFrame(m); }
    else if (m.t === 'emote') floatEmote(m.id, m.e);
    else if (m.t === 'typing') showTyping(m.id);
    else if (m.t === 'gameover') { profile.games = (profile.games || 0) + 1; store.set('hh-profile', profile); sound('win'); }
  }
  function urlJoin() {
    const code = new URLSearchParams(location.search).get('r');
    if (!code) return;
    history.replaceState(null, '', location.pathname);
    send({ t: 'join', code });
  }

  // ---------- helpers ----------
  const P = (id) => S && S.players.find((p) => p.id === id);
  const nm = (id) => esc((P(id) || {}).name || 'someone');
  function avatar(p, cls = '') {
    if (!p) return '';
    const c = CRITTERS[p.critter] || CRITTERS.fox;
    const hat = HATS[p.hat] ? `<span class="hat">${HATS[p.hat]}</span>` : '';
    return `<span class="avatar ${cls}" style="--c:${(COLORS[p.color] || COLORS.honey).hex}" aria-hidden="true">${c.e}${hat}</span>`;
  }
  const now = () => Date.now() + offset;
  function showScreen(id) {
    const was = ['home', 'lobby', 'game'].find((s) => !$(`#${s}`).classList.contains('hidden'));
    ['home', 'lobby', 'game'].forEach((s) => $(`#${s}`).classList.toggle('hidden', s !== id));
    if (was !== id) window.scrollTo(0, 0);
    if (id === 'home') setPhaseClass('home');
    if (id !== 'lobby') ui.built.lobby = false;
  }
  function setPhaseClass(ph) {
    document.body.className = document.body.className.replace(/phase-\S+/g, '').trim();
    document.body.classList.add(`phase-${ph}`);
    document.body.classList.toggle('reduce-motion', !profile.motion);
  }
  function toast(text, tip = false) {
    const el = document.createElement('div');
    el.className = `toast${tip ? ' tip' : ''}`; el.textContent = text;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), tip ? 6500 : 3800);
  }
  function hint(key, text) {
    if (!profile.hints || profile.games >= 3 || ui.hints[key]) return;
    ui.hints[key] = true; toast(`Tip: ${text}`, true);
  }
  let actx = null;
  function sound(kind) {
    if (!profile.sound) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const seqs = { pop: [[660, 0.06]], chime: [[523, 0.12], [659, 0.12], [784, 0.22]], splash: [[320, 0.08], [200, 0.22]],
        night: [[392, 0.18], [330, 0.3]], win: [[523, 0.1], [659, 0.1], [784, 0.1], [1046, 0.3]] };
      let t = actx.currentTime;
      for (const [f, d] of seqs[kind] || seqs.pop) {
        const o = actx.createOscillator(), g = actx.createGain();
        o.type = 'triangle'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.18, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
        o.connect(g).connect(actx.destination); o.start(t); o.stop(t + d + 0.02); t += d * 0.8;
      }
    } catch { /* no audio */ }
  }
  const modalQueue = [];
  function modal(html, cls = '', kind = '') {
    const ov = $('#overlay');
    ov.innerHTML = `<div class="modal ${cls}"><button class="icon-btn close" data-close aria-label="Close">✕</button>${html}</div>`;
    ov.dataset.kind = kind;
    ov.classList.remove('hidden');
    const first = ov.querySelector('button:not([data-close]), input, select'); if (first) first.focus();
    return ov.firstElementChild;
  }
  function closeModal() {
    const ov = $('#overlay');
    ov.classList.add('hidden'); ov.innerHTML = ''; ov.dataset.kind = '';
    const next = modalQueue.shift();
    if (next) setTimeout(next, 180);
  }
  function queueModal(fn) { if ($('#overlay').classList.contains('hidden')) fn(); else modalQueue.push(fn); }
  function closeAllModals() { modalQueue.length = 0; const ov = $('#overlay'); ov.classList.add('hidden'); ov.innerHTML = ''; ov.dataset.kind = ''; }
  $('#overlay').addEventListener('click', (e) => { if (e.target.id === 'overlay' || e.target.closest('[data-close]')) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#overlay').classList.contains('hidden')) closeModal(); });

  // ================= HOME =================
  function buildHome() {
    const nameIn = $('#name-input');
    nameIn.value = profile.name;
    nameIn.addEventListener('input', () => { profile.name = nameIn.value.slice(0, 16); saveProfile(); updatePreview(); });
    const cp = $('#critter-picker'), co = $('#color-picker'), hp = $('#hat-picker');
    cp.innerHTML = Object.entries(CRITTERS).map(([k, v]) => `<button class="pick" role="radio" data-critter="${k}" aria-label="${k}">${v.e}</button>`).join('');
    co.innerHTML = Object.entries(COLORS).map(([k, v]) => `<button class="pick" role="radio" data-color="${k}" aria-label="${v.name}" style="background:${v.hex}"></button>`).join('');
    renderHats();
    cp.addEventListener('click', (e) => { const b = e.target.closest('[data-critter]'); if (b) { profile.critter = b.dataset.critter; saveProfile(); updatePreview(); } });
    co.addEventListener('click', (e) => { const b = e.target.closest('[data-color]'); if (b) { profile.color = b.dataset.color; saveProfile(); updatePreview(); } });
    hp.addEventListener('click', (e) => {
      const b = e.target.closest('[data-hat]'); if (!b) return;
      if (b.classList.contains('locked')) return toast('Finish the First Night tutorial to unlock the Sprout Leaf.');
      profile.hat = b.dataset.hat; saveProfile(); updatePreview();
    });
    $('#sprout-check').checked = profile.games < 5;
    $('#quick-btn').onclick = () => { if (!profile.name.trim()) return toast('Pick a nickname first.'); send({ t: 'quick', lang: $('#lang-select').value, sprout: $('#sprout-check').checked }); };
    $('#create-btn').onclick = () => send({ t: 'create' });
    $('#join-btn').onclick = () => { const c = $('#code-input').value.trim(); if (c.length !== 4) return toast('Burrow codes are 4 letters.'); send({ t: 'join', code: c }); };
    $('#code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#join-btn').click(); });
    $('#tutorial-btn').onclick = openTutorial;
    $('#practice-btn').onclick = openPractice;
    $('#handbook-btn').onclick = () => openHandbook();
    $('#settings-btn').onclick = openSettings;
    $('#home-theme-btn').onclick = toggleTheme;
    applyTheme();
    const heroCast = [['bunny', 'berry', 'flower'], ['fox', 'honey', 'none'], ['frog', 'mint', 'mushroom'], ['bear', 'sky', 'cap']];
    $('#hero-village').innerHTML = heroCast.map(([critter, color, hat], i) => `${i === 2 ? '<div class="pond-mini"></div>' : ''}<div class="hv" style="--i:${i}">${cottage({ color })}${avatar({ critter, color, hat })}</div>`).join('');
    updatePreview();
  }
  function renderHats() {
    $('#hat-picker').innerHTML = Object.entries(HATS).map(([k, v]) => {
      const locked = k === 'sprout' && !profile.tutorialDone;
      return `<button class="pick${locked ? ' locked' : ''}" role="radio" data-hat="${k}" aria-label="${k}${locked ? ' (locked)' : ''}">${v || '✖️'}</button>`;
    }).join('');
  }
  function updatePreview() {
    $('#profile-preview').outerHTML = `<div id="profile-preview">${avatar(profile, 'big')}</div>`;
    $$('#critter-picker .pick').forEach((b) => b.setAttribute('aria-checked', b.dataset.critter === profile.critter));
    $$('#color-picker .pick').forEach((b) => b.setAttribute('aria-checked', b.dataset.color === profile.color));
    $$('#hat-picker .pick').forEach((b) => b.setAttribute('aria-checked', b.dataset.hat === profile.hat));
  }

  function openPractice() {
    const opts = Object.entries(ROLES).map(([k, r]) => `<option value="${k}">${r.icon} ${r.name}</option>`).join('');
    const m = modal(`<h2>Practice Burrow</h2>
      <p>A solo game with 7 AI critters, slower timers, and tips turned on. Pick a role to try.</p>
      <label class="field">Role<select id="pr-role"><option value="">Random</option>${opts}</select></label>
      <p class="muted small" id="pr-desc"></p>
      <button class="btn primary" id="pr-go">Start practicing</button>`);
    const sel = $('#pr-role', m), desc = $('#pr-desc', m);
    const upd = () => { desc.textContent = sel.value ? ROLES[sel.value].ability : 'You will get a random role, like a real game.'; };
    sel.onchange = upd; upd();
    $('#pr-go', m).onclick = () => { closeModal(); send({ t: 'create', practice: true, forcedRole: sel.value || null }); };
  }

  function openSettings() {
    const code = btoa(unescape(encodeURIComponent(JSON.stringify({ c: profile.critter, o: profile.color, h: profile.hat, g: profile.games, t: profile.tutorialDone }))));
    const m = modal(`<h2>Settings</h2>
      <div class="settings-grid">
        <div><div class="small muted" style="font-weight:800">Look</div><div class="seg" id="st-theme">${[['auto', '💻 Match my device'], ['light', '☀️ Light'], ['dark', '🌙 Dark']].map(([v, l]) => `<button data-theme-v="${v}" class="${profile.theme === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
        <label class="check"><input type="checkbox" id="st-sound" ${profile.sound ? 'checked' : ''}> Sound effects</label>
        <label class="check"><input type="checkbox" id="st-hints" ${profile.hints ? 'checked' : ''}> Beginner tips during your first 3 games</label>
        <label class="check"><input type="checkbox" id="st-motion" ${profile.motion ? 'checked' : ''}> Animations</label>
      </div>
      <h3 style="margin-top:1rem">Carry code</h3>
      <p class="muted small">Copy this code to move your critter, hat, and unlocks to another device. It holds no personal data.</p>
      <div class="row"><input id="st-code" readonly value="${esc(code)}" class="grow"><button class="btn small" id="st-copy">Copy</button></div>
      <div class="row" style="margin-top:.6rem"><input id="st-import" placeholder="Paste a carry code" class="grow"><button class="btn small" id="st-load">Load</button></div>`);
    $('#st-theme', m).onclick = (e) => {
      const b = e.target.closest('[data-theme-v]'); if (!b) return;
      profile.theme = b.dataset.themeV; saveProfile(); applyTheme();
      $$('#st-theme button', m).forEach((x) => x.classList.toggle('on', x === b));
    };
    $('#st-sound', m).onchange = (e) => { profile.sound = e.target.checked; saveProfile(); };
    $('#st-hints', m).onchange = (e) => { profile.hints = e.target.checked; saveProfile(); };
    $('#st-motion', m).onchange = (e) => { profile.motion = e.target.checked; saveProfile(); setPhaseClass(document.body.className.match(/phase-(\S+)/)?.[1] || 'home'); };
    $('#st-copy', m).onclick = () => { navigator.clipboard?.writeText(code); toast('Carry code copied.'); };
    $('#st-load', m).onclick = () => {
      try {
        const d = JSON.parse(decodeURIComponent(escape(atob($('#st-import', m).value.trim()))));
        if (CRITTERS[d.c]) profile.critter = d.c; if (COLORS[d.o]) profile.color = d.o; if (d.h in HATS) profile.hat = d.h;
        profile.games = Math.max(profile.games, Number(d.g) || 0); profile.tutorialDone = profile.tutorialDone || !!d.t;
        saveProfile(); renderHats(); updatePreview(); closeModal(); toast('Carry code loaded.');
      } catch { toast("That carry code didn't work. Copy the whole code and try again."); }
    };
  }

  function openHandbook(tab = 'rules') {
    const tabs = [['rules', 'Rules in 60 seconds'], ['roles', 'Role guide'], ['hints', 'Reading hints'], ['etiquette', 'Etiquette']];
    let body = '';
    if (tab === 'rules') body = `<div class="hb-grid">${HANDBOOK.rules.map(([ic, t, d]) => `<div class="hb-card"><div class="ic">${ic}</div><h3>${t}</h3><p>${d}</p></div>`).join('')}</div>`;
    else if (tab === 'roles') {
      body = `<p class="muted">Villagers are always the most common role. There are 1 or 2 Owls, up to 3 Sneaks (each a different type, picked at random), and every other role appears at most once. Cozy uses the Owl, Hedgehog, Gossip Bunny, and Lantern Keeper. Classic adds the Elder Turtle. Chaos adds the solo roles.</p>
      <div class="hb-grid">${Object.values(ROLES).map((r) => `<div class="hb-card ${r.team === 'sneaks' ? 'sneaks' : ''}"><div class="ic">${r.icon}</div><h3>${r.name}</h3><p class="small"><b>${TEAM_NAMES[r.team]}.</b> ${r.ability}</p><p class="small muted">${r.tip}</p></div>`).join('')}</div>`;
    } else if (tab === 'hints') {
      body = `<div class="hb-grid">${HANDBOOK.hints.map(([t, d]) => `<div class="hb-card"><h3>${t}</h3><p>${d}</p></div>`).join('')}</div>
      <h3 style="margin-top:1rem">Worked example</h3>
      <p>Night 1, the Owl learns: <b>at least one of Pip, Bramble, and Fig is a Sneak.</b> Night 2: <b>at least one of Bramble, Mochi, and Juniper is a Sneak.</b> Bramble is in both groups, so Bramble looks bad. Then a Gossip Bunny posts that Bramble visited the house of the critter who vanished. Now Bramble looks bad… unless the Trickster meddled with the Bunny. Line up every card before you vote.</p>`;
    } else body = `<ul>${HANDBOOK.etiquette.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`;
    const m = modal(`<h2>Hollow Handbook</h2>
      <nav class="tabs">${tabs.map(([k, l]) => `<button data-hb="${k}" class="${k === tab ? 'active' : ''}">${l}</button>`).join('')}</nav>${body}`, 'wide');
    m.addEventListener('click', (e) => { const b = e.target.closest('[data-hb]'); if (b) openHandbook(b.dataset.hb); });
  }

  function openTutorial() {
    window.HHTutorial.open({
      profile, modal, closeModal, avatar, cottage,
      onDone() {
        if (!profile.tutorialDone) { profile.tutorialDone = true; profile.hat = 'sprout'; saveProfile(); renderHats(); updatePreview(); toast('You unlocked the Sprout Leaf hat 🌱'); }
      },
      onPractice() { closeModal(); send({ t: 'create', practice: true, forcedRole: 'owl' }); },
    });
  }

  // ================= LOBBY =================
  function buildLobby() {
    $('#lobby').innerHTML = `
      <div class="lobby-top" id="lb-head"></div>
      <div class="lobby-grid">
        <section class="card"><div id="lb-players"></div><div id="lb-controls"></div></section>
        <section class="card lobby-chat">
          <div id="lb-settings"></div>
          <h3>Lobby chat</h3>
          <div class="chat-list" id="lb-chat"></div>
          <form id="lb-chat-form" class="row"><input id="lb-chat-input" maxlength="240" placeholder="Say hi…" autocomplete="off" class="grow"><button class="btn small">Send</button></form>
        </section>
      </div>`;
    $('#lb-chat-form').onsubmit = (e) => { e.preventDefault(); const i = $('#lb-chat-input'); if (i.value.trim()) send({ t: 'chat', text: i.value }); i.value = ''; };
    $('#lobby').onclick = (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const a = b.dataset.act;
      if (a === 'copy') { navigator.clipboard?.writeText(`${location.origin}/?r=${S.code}`); toast('Invite link copied. Send it to your friends.'); }
      else if (a === 'leave') { send({ t: 'leave' }); }
      else if (a === 'start') send({ t: 'start' });
      else if (a === 'addAI') send({ t: 'addAI', level: $('#ai-level').value });
      else if (a === 'fill') send({ t: 'fillTo', n: Number($('#fill-n').value), level: $('#ai-level').value });
      else if (a === 'rmai') send({ t: 'removeAI', id: b.dataset.id });
      else if (a === 'kick') { if (confirm(`Remove ${P(b.dataset.id)?.name} from the burrow?`)) send({ t: 'kick', id: b.dataset.id }); }
      else if (a === 'set') send({ t: 'settings', [b.dataset.k]: b.dataset.v });
    };
    $('#lobby').onchange = (e) => { if (e.target.id === 'pr-forced') send({ t: 'settings', forcedRole: e.target.value || null }); };
    ui.built.lobby = true;
  }
  function renderLobby() {
    showScreen('lobby'); setPhaseClass('lobby');
    if (!ui.built.lobby) buildLobby();
    if ($('#overlay .gameover')) closeAllModals();
    const host = S.hostId === S.me, n = S.players.length;
    const title = S.practice ? 'Practice Burrow' : S.isPublic ? (S.sprout ? 'Beginner lobby' : 'Public lobby') : 'Your burrow';
    const sub = S.practice ? 'Just you and the AI critters. Take your time.'
      : S.isPublic ? 'Games start automatically. Say hi while you wait.' : 'Share the link so friends can join. No account needed.';
    $('#lb-head').innerHTML = `<div><h1 class="title" style="font-size:2.4rem;text-shadow:none">${title}</h1><p class="muted">${sub}</p></div>
      ${!S.isPublic && !S.practice ? `<div class="row"><span class="code-box" aria-label="Burrow code">${esc(S.code)}</span><button class="btn" data-act="copy">Copy invite link</button></div>` : ''}
      <button class="btn ghost" data-act="leave">Leave</button>`;
    const tiles = S.players.map((p) => {
      const tags = [p.id === S.hostId ? 'Host' : '', p.isAI ? `AI · ${p.aiLevel}` : '', p.sprout ? '🌱 Sprout' : '', !p.connected ? 'away' : ''].filter(Boolean).join(' · ');
      const x = host && !S.game ? (p.isAI ? `<button class="x" data-act="rmai" data-id="${p.id}" aria-label="Remove ${esc(p.name)}">✕</button>`
        : p.id !== S.me ? `<button class="x" data-act="kick" data-id="${p.id}" aria-label="Remove ${esc(p.name)}">✕</button>` : '') : '';
      return `<div class="p-tile">${avatar(p)}<div style="min-width:0"><div class="nm">${esc(p.name)}${p.id === S.me ? ' (you)' : ''}</div><div class="tags">${esc(tags)}</div></div>${x}</div>`;
    }).join('');
    const empties = Array.from({ length: Math.max(0, 4 - n) }, () => '<div class="p-tile empty">Empty seat</div>').join('');
    $('#lb-players').innerHTML = `<div class="card-head"><h2>Critters (${n}/14)</h2>${S.autoStartAt ? `<span class="autostart" data-countdown="${S.autoStartAt}">Starting soon</span>` : ''}</div>
      <div class="player-grid">${tiles}${empties}</div>`;
    const fillOpts = Array.from({ length: 11 }, (_, i) => i + 4).filter((k) => k > n).map((k) => `<option ${k === Math.max(8, n + 1) ? 'selected' : ''}>${k}</option>`).join('');
    $('#lb-controls').innerHTML = host ? `
      <div class="row" style="margin-bottom:.8rem">
        <select id="ai-level" aria-label="AI level"><option value="sleepy">Sleepy AI</option><option value="clever" selected>Clever AI</option><option value="cunning">Cunning AI</option></select>
        <button class="btn small" data-act="addAI" ${n >= 14 ? 'disabled' : ''}>Add AI critter</button>
        ${fillOpts ? `<span class="row"><button class="btn small" data-act="fill">Fill to</button><select id="fill-n" aria-label="Fill to">${fillOpts}</select></span>` : ''}
      </div>
      <div class="row"><button class="btn primary" data-act="start" ${n < 4 ? 'disabled' : ''}>Start game</button>
      <span class="muted small">${n < 4 ? 'You need at least 4 critters. Add AI critters to fill seats.' : `Roles will be balanced for ${n} players.`}</span></div>`
      : `<p class="muted">${S.isPublic ? 'The game starts on its own once enough critters arrive.' : 'Waiting for the host to start…'}</p>`;
    const seg = (k, opts, cur) => `<div class="seg">${opts.map(([v, l]) => `<button data-act="set" data-k="${k}" data-v="${v}" class="${cur === v ? 'on' : ''}" ${host && !S.sprout ? '' : 'disabled'}>${l}</button>`).join('')}</div>`;
    const st = S.settings;
    $('#lb-settings').innerHTML = `<h3>Settings</h3><div class="settings-grid">
      <div><div class="small muted">Spice</div>${seg('spice', [['cozy', 'Cozy'], ['classic', 'Classic'], ['chaos', 'Chaos']], st.spice)}</div>
      <div><div class="small muted">Timer speed</div>${seg('speed', [['relaxed', 'Relaxed'], ['normal', 'Normal'], ['fast', 'Fast']], st.speed)}</div>
      <div><div class="small muted">If someone disconnects</div>${seg('dropAI', [['sleepy', 'Sleepy AI'], ['clever', 'Clever AI']], st.dropAI)}</div>
      ${S.practice ? `<label class="field">Your role<select id="pr-forced"><option value="">Random</option>${Object.entries(ROLES).map(([k, r]) => `<option value="${k}" ${st.forcedRole === k ? 'selected' : ''}>${r.icon} ${r.name}</option>`).join('')}</select></label>` : ''}
      <p class="small muted" style="margin:0">${{ cozy: 'Cozy: Owl, Hedgehog, Gossip Bunny, Lantern Keeper, and Villagers. Best for new players.', classic: 'Classic: adds the Elder Turtle.', chaos: 'Chaos: adds the solo roles (Pond Frog, Wandering Moth) for experienced groups.' }[st.spice]}</p>
      </div>`;
    const list = $('#lb-chat');
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    list.innerHTML = S.lobbyChat.map((m) => m.sys ? `<div class="msg sys">${esc(m.text)}</div>`
      : ui.muted.has(m.by) ? '' : `<div class="msg ${m.by === S.me ? 'mine' : ''}">${avatar(P(m.by), 'xs')}<div class="bubble-txt"><b>${nm(m.by)}</b>${esc(m.text)}</div></div>`).join('');
    if (atBottom) list.scrollTop = list.scrollHeight;
  }

  // ================= STATE → RENDER =================
  const GOALS = {
    village: 'Find the Sneaks and vote them into the Pond.',
    sneaks: "Spirit critters away until the Sneaks equal everyone else. Don't get caught!",
    frog: 'Get yourself voted into the Pond. That is your win!',
    moth: 'Stay alive until the very end, whoever wins.',
  };
  const teamClass = (team) => (team === 'sneaks' ? 'sneaks' : team === 'village' ? 'village' : 'solo');

  function onState(prev) {
    if (!S.game) { if (ui.gameId) closeAllModals(); ui.gameId = null; renderLobby(); return; }
    const g = S.game;
    const gameId = S.code + g.houses.join('');
    if (ui.gameId !== gameId) {
      ui.gameId = gameId; ui.overShown = false; ui.phaseKey = ''; ui.hints = {}; ui.lastDeaths = g.deaths.length;
      ui.seenEvent = g.events.length ? Math.max(...g.events.map((e) => e.id)) : 0;
      ui.bubbleTs = S.now; ui.seenChat = 0; ui.tab = 'board';
      closeAllModals();
      if (g.phase !== 'over') queueModal(showRoleReveal);
    }
    const key = `${g.phase}-${g.day}-${g.defenseIdx}`;
    if (key !== ui.phaseKey) {
      const first = !ui.phaseKey;
      ui.phaseKey = key; ui.phaseStart = Date.now(); ui.phaseTotal = Math.max(1, g.endsAt - now());
      if (!first) phaseBanner(g);
      if (g.phase === 'night') sound('night'); else if (g.phase === 'dawn') sound('chime'); else if (g.phase === 'vote') sound('pop');
      const alive = g.alive.includes(S.me);
      if (!alive && ui.chatCh !== 'wisp') ui.chatCh = 'wisp';
      if (g.phase === 'night' && alive) hint(`walk${g.day}`, 'walk with WASD / arrows (or press and drag). Hold E by a lamp to light it. Notice who you meet!');
      if (g.phase === 'day') hint(`day${g.day}`, 'talk it out in Chat or pin a note on the Board. You decide how much to reveal!');
      if (g.phase === 'vote') hint('vote', "tap a house to vote, or Skip if you're unsure.");
    }
    renderGame();
    for (const e of g.events) {
      if (e.id <= ui.seenEvent) continue;
      ui.seenEvent = e.id;
      if (e.type === 'dawn') queueModal(() => showDawn(e));
      if (e.type === 'pond') { if (e.out) splashPond(e.out); queueModal(() => showPond(e)); }
    }
    showSpeech(g);
    if (g.phase === 'over' && !ui.overShown) { ui.overShown = true; queueModal(showGameOver); }
  }

  // ================= GAME =================
  let gameBuilt = false;
  function buildGame() {
    $('#emote-bar').innerHTML = EMOTES.map((e) => `<button data-emote="${e}" aria-label="Send ${e}">${e}</button>`).join('');
    $('#emote-bar').onclick = (e) => { const b = e.target.closest('[data-emote]'); if (b) send({ t: 'emote', e: b.dataset.emote }); };
    $('#map').innerHTML = `<div class="path-ring"></div><svg class="yarn" viewBox="0 0 100 100" preserveAspectRatio="none" id="yarn"></svg>
      <div class="pond" id="pond"><span class="lily" style="left:14%;top:30%">🪷</span><span class="lily" style="right:16%;bottom:22%">🍃</span><span class="pond-icon" id="pond-icon">🌙</span></div>
      <canvas id="tracks-canvas" class="tracks-canvas"></canvas><div id="houses"></div><div id="floaters"></div>`;
    $('#map').onclick = (e) => {
      const sp = e.target.closest('.signpost');
      if (sp) {
        const g = S.game;
        if (g.phase !== 'night' || !g.alive.includes(S.me)) return toast(`The ${sp.title}. Night walks happen at night 🌙`);
        send({ t: 'night', kind: 'walk', place: sp.dataset.place }); sound('pop'); return;
      }
      const h = e.target.closest('.house'); if (h) onHouse(h.dataset.id);
    };
    $('#tabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) { ui.tab = b.dataset.tab; renderTabs(); } };
    $('#note-form').onsubmit = (e) => { e.preventDefault(); const i = $('#note-input'); if (i.value.trim()) { send({ t: 'note', text: i.value }); i.value = ''; } };
    $('#note-chips').onclick = (e) => { const c = e.target.closest('[data-ins]'); if (c) insert($('#note-input'), c.dataset.ins); };
    $('#chat-form').onsubmit = (e) => { e.preventDefault(); const i = $('#chat-input'); if (i.value.trim()) { send({ t: 'chat', text: i.value, channel: ui.chatCh }); i.value = ''; } };
    $('#chat-channels').onclick = (e) => { const b = e.target.closest('[data-ch]'); if (b) { ui.chatCh = b.dataset.ch; renderChat(); } };
    $('#quick-asks').onclick = (e) => {
      const b = e.target.closest('[data-ask]'); if (!b) return;
      const who = $('#ask-who') ? $('#ask-who').value : '';
      const q = b.dataset.ask;
      send({ t: 'chat', text: who ? `${who}, ${q}` : q.charAt(0).toUpperCase() + q.slice(1), channel: ui.chatCh });
    };
    $('#tracks-toggle').onclick = () => { ui.showTracks = ui.showTracks === false; renderTracks(); };
    $('#tracks-time').oninput = () => { ui.showTracks = true; renderTracks(); };
    window.addEventListener('resize', () => { if (S && S.game && S.game.phase !== 'night') renderTracks(); });
    $('#role-chip').onclick = () => queueModal(() => showRoleReveal(true));
    $('#g-handbook-btn').onclick = () => openHandbook();
    $('#g-theme-btn').onclick = toggleTheme; applyTheme();
    $('#sound-btn').onclick = () => { profile.sound = !profile.sound; saveProfile(); $('#sound-btn').textContent = profile.sound ? '🔔' : '🔕'; };
    $('#sound-btn').textContent = profile.sound ? '🔔' : '🔕';
    $('#leave-btn').onclick = () => {
      const over = S && S.game && S.game.phase === 'over';
      if (over || confirm('Leave this game? An AI critter will keep your seat, and you can rejoin from the home screen.')) send({ t: 'leave' });
    };
    $('#action-card').addEventListener('click', onActionClick);
    $('#action-card').addEventListener('change', (e) => { if (e.target.id === 'meddle-sel') send({ t: 'night', kind: 'meddle', target: e.target.value || null }); });
    $('#secrets').addEventListener('click', (e) => {
      const b = e.target.closest('[data-jot]'); if (!b) return;
      send({ t: 'note', text: b.dataset.jot }); toast('Saved to your Notepad 📝');
    });
    $('#tab-board').innerHTML = `<div class="composer" id="composer"></div><div id="claim-list" style="display:flex;flex-direction:column;gap:.5rem"></div>`;
    $('#tab-board').addEventListener('click', onBoardClick);
    $('#tab-board').addEventListener('input', (e) => { if (e.target.id === 'cp-text') { const c = $('#cp-count'); if (c) c.textContent = `${e.target.value.length}/140`; } });
    gameBuilt = true;
  }
  function setHTML(el, html) { if (el.__html !== html) { el.innerHTML = html; el.__html = html; } }
  function insert(input, text) { input.value = (input.value ? `${input.value.trim()} ` : '') + text; input.focus(); }
  function cottage(p) {
    const roof = (COLORS[p.color] || COLORS.honey).hex;
    return `<svg class="cottage" viewBox="0 0 64 56" aria-hidden="true">
      <rect class="chim" x="43" y="7" width="7" height="13" rx="1.5"/>
      <path class="roof" d="M4 29 L32 5 L60 29 Z" fill="${roof}"/>
      <rect class="wall" x="10" y="27" width="44" height="26" rx="3"/>
      <rect class="win" x="15" y="33" width="12" height="10" rx="2"/><path class="pane" d="M15 38 H27 M21 33 V43"/>
      <rect class="door" x="35" y="35" width="12" height="18" rx="6"/></svg>`;
  }

  function hasNight(g) {
    const r = ROLES[g.myRole];
    return r.team === 'sneaks' ? !g.settling : !!r.verb;
  }
  function phaseInfo(g) {
    const r = ROLES[g.myRole], meAlive = g.alive.includes(S.me), onTeam = r.team === 'sneaks';
    const picked = g.mySneakVote || (g.myAction && g.myAction.target);
    const map = {
      night: ['🌙', g.settling ? 'Quiet night' : `Night ${g.day}`,
        !meAlive ? 'You\'re a Wisp: watch the whole village' : onTeam && !g.settling ? (g.attempted ? 'Slip away and relight your lantern' : 'Go dark (Q), touch someone, press F')
          : 'Walk the village with your lantern 🏮'],
      dawn: ['🌅', 'Morning', 'Read the morning report'],
      day: ['☀️', `Day ${g.day}`, !meAlive ? 'Wisps watch from the mist' : g.bigGame ? 'Nominate a suspect, then press Ready' : 'Talk it out, then press Ready'],
      defense: ['🎤', 'Defense', `Listen to ${P(g.nominees[g.defenseIdx])?.name || 'the nominee'}`],
      vote: ['🗳️', 'Vote!', !meAlive ? 'The living are voting' : g.votes[S.me] ? '✓ Voted! Waiting for others…' : 'Tap a house to vote'],
      over: ['🏆', 'Game over', g.over && g.over.winner === 'village' ? 'The village wins!' : 'The Sneaks win!'],
    };
    return map[g.phase] || ['', '', ''];
  }
  function phaseBanner(g) {
    const subs = {
      night: g.settling ? 'A quiet night. Nobody vanishes.' : 'The Sneaks are on the prowl…',
      dawn: 'Who made it through the night?', day: 'Talk, share hints, find the Sneaks',
      defense: `${P(g.nominees[g.defenseIdx])?.name || 'A nominee'} has 15 seconds`, vote: 'Tap a house to cast your vote',
    };
    const [emoji, title] = phaseInfo(g);
    if (!subs[g.phase]) return;
    const b = $('#banner');
    b.innerHTML = `<span class="b-emoji">${emoji}</span><span class="b-title">${esc(title)}</span><span class="b-sub">${esc(subs[g.phase])}</span>`;
    b.classList.remove('show'); void b.offsetWidth; b.classList.add('show');
  }

  function renderGame() {
    showScreen('game');
    if (!gameBuilt) buildGame();
    const g = S.game;
    setPhaseClass(g.phase === 'night' ? 'night' : g.phase === 'dawn' ? 'dawn' : (g.phase === 'vote' || g.phase === 'defense') ? 'vote' : 'day');
    const [emoji, title, goal] = phaseInfo(g);
    $('#hud-emblem').textContent = emoji; $('#phase-name').textContent = title; $('#hud-goal').textContent = goal;
    const r = ROLES[g.myRole];
    $('#role-chip').textContent = `${r.icon} ${r.name}`;
    $('#role-chip').className = `role-chip ${teamClass(r.team)}`;
    $('#pond-icon').textContent = { night: '🌙', dawn: '🌅', day: '☀️', defense: '🎤', vote: '🗳️', over: '🏆' }[g.phase] || '🌙';
    const isNight = g.phase === 'night';
    $('#night-wrap').classList.toggle('hidden', !isNight);
    $('#map').classList.toggle('hidden', isNight);
    $('#emote-bar').classList.toggle('hidden', isNight);
    if (isNight && window.HHNight && !window.HHNight.running()) setTimeout(() => {
      const r = $('#night-wrap').getBoundingClientRect();
      if (r.top < 0 || r.bottom > innerHeight) $('#night-wrap').scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 60);
    if (isNight && window.HHNight) {
      window.HHNight.start({ send, game: () => S && S.game, P, me: () => S.me, role: (r) => ROLES[r], sound, onTasks: () => renderAction() });
      if (g.nightTasks) window.HHNight.setTasks(g.nightTasks);
    } else if (window.HHNight) window.HHNight.stop();
    renderMap(); renderAction(); renderSecrets(); renderTabs(); renderTracks();
  }
  // Footprints from last night, drawn over the day map, with a replay slider
  function renderTracks() {
    const g = S.game, bar = $('#tracks-bar');
    const has = g.phase !== 'night' && (g.tracks || []).length > 0;
    bar.classList.toggle('hidden', !has);
    const cv = $('#tracks-canvas'); if (!cv) return;
    const show = has && ui.showTracks !== false;
    cv.classList.toggle('hidden', !show);
    $('#tracks-toggle').classList.toggle('on', show);
    const r = $('#tracks-time'); r.max = Math.round(g.nightDur || 70);
    if (ui.tracksKey !== `${S.code}-${g.day}`) { ui.tracksKey = `${S.code}-${g.day}`; r.value = r.max; }
    const v = Number(r.value), full = v >= Number(r.max);
    const dur = Number(r.max) || 70;
    $('#tracks-label').textContent = full ? 'All night' : v < dur / 3 ? `Early (${v}s)` : v < (2 * dur) / 3 ? `Around midnight (${v}s)` : `Late (${v}s)`;
    if (show) requestAnimationFrame(() => window.HHNight.drawTracks(cv, g, full ? null : v));
  }

  function housePos(i, n) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n, rad = n > 10 ? 40 : 38;
    return [50 + rad * Math.cos(a), 50 + rad * Math.sin(a)];
  }
  function renderMap() {
    const g = S.game, me = S.me, alive = new Set(g.alive), meAlive = alive.has(me);
    const pos = {}; g.houses.forEach((id, i) => { pos[id] = housePos(i, g.houses.length); });
    const team = new Set(g.team || []), onTeam = team.has(me), lit = new Set(g.lit);
    const voteCount = {};
    if (g.phase === 'vote') Object.entries(g.votes).forEach(([v, t]) => { if (t !== 'skip') voteCount[t] = (voteCount[t] || 0) + (g.turtles.includes(v) ? 2 : 1); });
    const nomCount = {}; Object.values(g.noms || {}).forEach((t) => { nomCount[t] = (nomCount[t] || 0) + 1; });
    const teamPick = {}; if (g.teamVotes) Object.values(g.teamVotes).forEach((t) => { teamPick[t] = (teamPick[t] || 0) + 1; });
    const myPick = g.phase === 'night' ? (meAlive ? (g.mySneakVote || (g.myAction && g.myAction.target)) : null) : g.phase === 'vote' ? g.votes[me] : null;
    const speaking = g.phase === 'defense' ? g.nominees[g.defenseIdx] : null;
    const targetable = (id) => {
      if (g.phase === 'night') return meAlive && hasNight(g) && !myPick && id !== me && alive.has(id) && !(onTeam && !g.settling && (team.has(id) || (lit.has(id) && !g.moleAlive)))
        && !(g.myRole === 'hedgehog' && g.lastProtect === id) && !(g.myRole === 'lantern' && g.lastLight === id);
      if (g.phase === 'vote') return meAlive && !g.votes[me] && g.nominees.includes(id) && id !== me;
      return false;
    };
    setHTML($('#houses'), g.houses.map((id) => {
      const p = P(id) || { name: '?' };
      const [x, y] = pos[id];
      const cls = ['house', id === me && 'me', !alive.has(id) && 'dead', lit.has(id) && 'lit', team.has(id) && onTeam && id !== me && 'teammate',
        myPick === id && 'picked', targetable(id) && 'target', g.bigGame && g.nominees.includes(id) && 'nominee', speaking === id && 'speaking'].filter(Boolean).join(' ');
      const badges = [
        p.isAI ? '<span title="AI critter">🌰</span>' : '', g.turtles.includes(id) ? '<span title="Revealed Elder Turtle">🐢</span>' : '',
        lit.has(id) ? '<span title="Lantern">🏮</span>' : '', teamPick[id] ? `<span title="Sneak team picks">🎯${teamPick[id]}</span>` : '',
        g.myMeddle === id ? '<span title="You are meddling here">🎭</span>' : '',
        g.bigGame && nomCount[id] && g.phase === 'day' ? `<span title="Nominations">📌${nomCount[id]}</span>` : '',
      ].join('');
      return `<button class="${cls}" data-id="${id}" style="left:${x}%;top:${y}%" aria-label="${esc(p.name)}${alive.has(id) ? '' : ' (Wisp)'}">
        ${voteCount[id] ? `<span class="votes">${voteCount[id]}</span>` : ''}<span class="badges">${badges}</span>
        ${cottage(p)}<span class="critter sz-${(CRITTERS[p.critter] || {}).size || 'medium'}">${avatar(p)}</span><span class="nameplate">${esc(p.name)}${id === me ? ' (you)' : ''}</span></button>`;
    }).join(''));
    setHTML($('#yarn'), Object.entries(g.yarn || {}).filter(([a, b]) => pos[a] && pos[b])
      .map(([a, b]) => `<line class="${a === me ? 'mine' : ''}" x1="${pos[a][0]}" y1="${pos[a][1]}" x2="${pos[b][0]}" y2="${pos[b][1]}"/>`).join(''));
  }

  function onHouse(id) {
    const g = S.game, meAlive = g.alive.includes(S.me);
    if (g.phase === 'over') return;
    if (g.phase === 'night') {
      if (!meAlive) return toast("Wisps can't act at night. Peek at the Den in Chat!");
      if (!hasNight(g)) return toast("You're asleep 💤 You don't have a night ability.");
      if (id === S.me) return toast("Pick someone else's house.");
      if (!g.alive.includes(id)) return toast('That critter is already a Wisp.');
      if (g.myRole === 'hedgehog' && g.lastProtect === id) return toast("You can't protect the same critter two nights in a row.");
      if (g.myRole === 'lantern' && g.lastLight === id) return toast("You can't light the same house two nights in a row.");
      const onTeam = (g.team || []).includes(S.me) && !g.settling;
      if (onTeam && g.team.includes(id)) return toast("That's your teammate!");
      if (onTeam && g.lit.includes(id) && !g.moleAlive) return toast('A lantern glows there. Only a Shadow Mole could tunnel in.');
      send({ t: 'night', target: id }); sound('pop'); return;
    }
    if (g.phase === 'vote') {
      if (!meAlive) return;
      if (id === S.me) return toast("You can't vote for yourself.");
      if (!g.nominees.includes(id)) return toast('Only nominees can be voted on today.');
      send({ t: 'vote', target: g.votes[S.me] === id ? null : id }); sound('pop'); return;
    }
    openPlayerMenu(id);
  }
  function openPlayerMenu(id) {
    const g = S.game, p = P(id); if (!p) return;
    const meAlive = g.alive.includes(S.me), alive = g.alive.includes(id), self = id === S.me;
    const tied = g.yarn[S.me] === id, nominated = g.noms && g.noms[S.me] === id;
    const death = g.deaths.find((d) => d.id === id);
    const m = modal(`<div class="row" style="gap:.9rem">${avatar(p, 'big')}<div><h2 style="margin:0">${esc(p.name)}</h2>
      <div class="row" style="gap:.3rem;margin-top:.3rem">${p.isAI ? `<span class="tag ai">🌰 AI · ${p.aiLevel}</span>` : ''}${p.sprout ? '<span class="tag sprout">🌱 Sprout</span>' : ''}
      ${!alive ? '<span class="tag">👻 Wisp</span>' : ''}${(g.team || []).includes(id) && (g.team || []).includes(S.me) ? '<span class="tag sneak">🌑 Teammate</span>' : ''}</div></div></div>
      <div class="row" style="margin-top:1.1rem">
        ${meAlive && alive && !self && g.bigGame && g.phase === 'day' ? `<button class="btn small honey" data-pm="nom">${nominated ? 'Withdraw nomination' : '📌 Nominate'}</button>` : ''}
        ${meAlive && alive && !self ? `<button class="btn small" data-pm="yarn">${tied ? '✂️ Untie yarn' : '🧶 Tie yarn (I suspect them)'}</button>` : ''}
        ${meAlive && alive && !self ? '<button class="btn small" data-pm="accuse">🧶 Post "I suspect"</button>' : ''}
        ${meAlive && alive && !self && P(id).isAI !== undefined && g.phase !== 'night' ? '<button class="btn small leaf" data-pm="ask">💬 Ask them…</button>' : ''}
        <button class="btn small" data-pm="note">📝 Add to notes</button>
        ${!self && !p.isAI ? `<button class="btn small ghost" data-pm="mute">${ui.muted.has(id) ? 'Unmute' : 'Mute'} chat</button>` : ''}
      </div>
      ${death ? `<div class="behind" style="margin-top:1rem"><b>👻 Left behind</b>${notesHTML(death.notes)}</div>` : ''}`, '', 'menu');
    m.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pm]'); if (!b) return;
      const a = b.dataset.pm;
      if (a === 'yarn') send({ t: 'yarn', target: tied ? null : id });
      else if (a === 'nom') send({ t: 'nominate', target: nominated ? null : id });
      else if (a === 'accuse') { ui.tab = 'board'; ui.sticker = 'accuse'; ui.tags = [id]; ui.compKey = null; renderTabs(); $('#cp-text')?.focus(); }
      else if (a === 'note') { ui.tab = 'notes'; renderTabs(); insert($('#note-input'), p.name); }
      else if (a === 'ask') { ui.tab = 'chat'; ui.chatCh = 'day'; ui.askWho = p.name; renderTabs(); const i = $('#chat-input'); i.value = `${p.name}, `; i.focus(); }
      else if (a === 'mute') { if (ui.muted.has(id)) ui.muted.delete(id); else ui.muted.add(id); renderChat(); }
      closeModal();
    });
  }

  // ----- role + task panel -----
  function renderAction() {
    const g = S.game, r = ROLES[g.myRole], meAlive = g.alive.includes(S.me);
    const team = g.team || [], onTeam = r.team === 'sneaks';
    let label = '', text = '', who = null, done = false, actions = '';
    if (g.phase === 'night') {
      label = 'Tonight';
      if (!meAlive) text = "You're a Wisp 👻 Float around the village as a ghost (WASD or drag) and watch everything. Only other Wisps can see you, and you can float right through houses.";
      else {
        const steps = [];
        if (onTeam && !g.settling) {
          steps.push(g.attempted ? '✓ The deed is done. Get away and light your lantern.' : 'Find a critter alone in the dark.', 'Snuff your lantern (<b>Q</b>) so nobody can see you.', 'Get close enough to <b>touch</b> them and press <b>F</b>. Not inside lamplight!');
          if (team.length > 1) steps.push(`Plan in the 🌑 Den. Name a target and AI teammates go after them.`);
          done = !!g.attempted;
        } else if (onTeam) steps.push('Quiet night: nobody vanishes. Walk around and look normal.', 'Scout who goes where. Plan in the 🌑 Den.');
        else if (hasNight(g)) {
          who = g.myAction && g.myAction.target; done = !!who;
          steps.push(who ? `✓ Done: ${r.verb.split(' ')[0].toLowerCase()} ${nm(who)}` : `Walk to someone's door and <b>hold E</b> to ${r.verb.split(' ')[0].toLowerCase()} them.`);
          if (g.myRole === 'hedgehog' && g.lastProtect) steps.push(`Can't protect ${nm(g.lastProtect)} twice in a row.`);
        }
        if (!onTeam || g.settling) steps.push('Light street lamps (<b>hold E</b> by a lamp). Sneaks can\'t strike in lamplight.', 'Notice who you meet, and where. Lanterns going dark are suspicious 👀');
        if (g.myRole === 'trickster' && !g.settling) steps.push(g.myMeddle ? `✓ Meddled with ${nm(g.myMeddle)}` : '🎭 Hold E at a door to meddle with that critter\'s night.');
        text = `<ol>${steps.map((x) => `<li>${x}</li>`).join('')}</ol>`;
        const tl = window.HHNight && window.HHNight.tasks ? window.HHNight.tasks() : [];
        if (tl.length) {
          const esc2 = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
          const main = tl.find((t) => !t.errand && t.k !== 'info');
          if (main) { done = main.done; who = null; }
          text = `<ul class="task-list">${tl.map((t) => t.k === 'info' ? `<li class="info"><span class="tk-e">${t.e}</span><span>${esc2(t.text)}</span></li>`
            : `<li class="${t.done ? 'done' : ''} ${t.errand ? '' : 'main'}"><span class="tk-box">${t.done ? '✓' : ''}</span><span class="tk-e">${t.e}</span><span>${esc2(t.text)}</span></li>`).join('')}</ul>
            <p class="small muted" style="margin:.5rem 0 0;font-weight:700">Errands: stand on the glowing spot (✨ on your map). Finish all of them and your lantern burns brighter. Light dark street lamps with <b>E</b>: Sneaks can't strike in lamplight. Watch who goes dark 👀</p>`;
        }
      }
    } else if (g.phase === 'dawn') { label = 'Morning'; text = 'Check the morning report and what you learned last night.'; }
    else if (g.phase === 'day') {
      label = 'Today';
      if (!meAlive) text = "You're a Wisp. Watch, read the notepads, chat with other Wisps.";
      else {
        text = g.bigGame && g.noms[S.me] ? 'You nominated:'
          : `<ol><li>Read the Board and Chat</li><li>Question people, push on stories</li>${g.bigGame ? '<li>Tap a critter → Nominate</li>' : ''}<li>Press Ready to vote</li></ol>`;
        if (g.bigGame) { who = g.noms[S.me]; done = !!who; }
        actions += `<button class="btn small ${g.iReady ? 'on' : 'honey'}" data-a="ready" ${g.iReady ? 'disabled' : ''}>${g.iReady ? '✓ Ready' : '🙋 Ready to vote'}</button>
          <span class="small muted" style="font-weight:800">${g.readyCount}/${g.alive.length} ready</span>`;
      }
    } else if (g.phase === 'defense') { label = 'Defense'; text = `${nm(g.nominees[g.defenseIdx])} is defending. Nominees:`; actions = `<div class="team-list">${g.nominees.map((id) => `<span class="tag">${nm(id)}</span>`).join('')}</div>`; }
    else if (g.phase === 'vote') {
      label = 'Vote';
      if (!meAlive) text = 'The living are voting.';
      else {
        const v = g.votes[S.me];
        done = !!v; who = v && v !== 'skip' ? v : null;
        text = v ? (v === 'skip' ? 'You voted to skip.' : 'You voted for:') : 'Tap the house of who you think is a Sneak.';
        actions += `<button class="btn small ${v === 'skip' ? 'on' : ''}" data-a="skip">${v === 'skip' ? '✓ Skipped' : '🤷 Skip'}</button>${v ? '<span class="small muted">Tap again to change</span>' : ''}`;
        if (g.turtles.includes(S.me)) actions += '<span class="small muted">🐢 Your vote counts double.</span>';
      }
    } else if (g.phase === 'over') { label = 'Game over'; text = g.over && g.over.winners.includes(S.me) ? 'You won! 🎉' : 'Better luck next time!'; }
    if (g.myRole === 'turtle' && meAlive && !g.turtles.includes(S.me) && ['day', 'dawn', 'defense', 'vote'].includes(g.phase)) {
      actions += `<button class="btn small lilac" data-a="reveal">🐢 Reveal myself</button>`;
    }
    const teamTags = onTeam && team.length > 1 ? `<div class="team-list"><span class="small" style="font-weight:800">Your team:</span>${team.filter((id) => id !== S.me).map((id) => `<span class="tag sneak">${ROLES[(g.teamRoles || {})[id]]?.icon || '🌑'} ${nm(id)}${g.alive.includes(id) ? '' : ' 👻'}</span>`).join('')}</div>` : '';
    const whoHTML = who ? `<div class="pick-who">${avatar(P(who), 'sm')} ${nm(who)}</div>` : '';
    setHTML($('#action-card'), `<div class="role-head"><div class="role-art ${teamClass(r.team)}">${r.icon}</div>
      <div><div class="role-name">${r.name}</div><span class="tag ${teamClass(r.team)}">Team ${TEAM_NAMES[r.team]}</span></div></div>
      <p class="goal">🎯 ${GOALS[r.team]}</p>${teamTags}
      <div class="task ${done ? 'done' : ''}"><div class="task-label">${label}</div><div class="task-text">${text}</div>${whoHTML}</div>
      <div class="role-actions">${actions}</div>
      <button class="link small" data-a="role" style="margin-top:.6rem">How does my role work?</button>`);
  }
  function onActionClick(e) {
    const b = e.target.closest('[data-a]'); if (!b) return;
    const a = b.dataset.a;
    if (a === 'ready') send({ t: 'ready' });
    else if (a === 'skip') send({ t: 'vote', target: S.game.votes[S.me] === 'skip' ? null : 'skip' });
    else if (a === 'reveal') { if (confirm('Reveal yourself as the Elder Turtle? Everyone will know, and your vote will count double.')) send({ t: 'reveal' }); }
    else if (a === 'role') queueModal(() => showRoleReveal(true));
    else if (a === 'walk') { send({ t: 'night', kind: 'walk', place: b.dataset.place }); sound('pop'); }
  }

  // ----- what you know -----
  function renderSecrets() {
    const g = S.game;
    const items = g.myLog.filter((l) => /^Night \d+:/.test(l.text)).reverse();
    const latest = g.phase === 'night' ? g.day - 1 : g.day;
    setHTML($('#secrets'), items.map((l) => {
      const n = l.text.match(/^Night (\d+):/)[1];
      const body = l.text.replace(/^Night \d+: /, '');
      const clean = body.replace(/^you /, '');
      return `<div class="secret ${Number(n) === latest ? 'new' : ''}"><span class="when">N${n}</span><span>${esc(body.charAt(0).toUpperCase() + body.slice(1))}</span>
        ${g.alive.includes(S.me) ? `<button class="jot" data-jot="${esc(clean)}" title="Copy to Notepad" aria-label="Copy to Notepad">📝</button>` : ''}</div>`;
    }).join('') || '<div class="empty-hint"><span class="big">🔮</span>Your night results show up here each morning.</div>');
  }

  // ----- notepad -----
  function notesHTML(notes) {
    if (!notes || !notes.length) return '<p class="small muted" style="margin:.3rem 0 0">Their notepad was empty. Suspicious?</p>';
    return `<ol>${notes.map((n) => `<li><span class="stamp">${esc(n.stamp)}</span>${esc(n.text)}</li>`).join('')}</ol>`;
  }
  function renderNotes() {
    const g = S.game, notes = g.myNotes || [];
    const used = notes.reduce((s, n) => s + n.text.length, 0);
    $('#note-count').textContent = `${used}/500 characters`;
    setHTML($('#note-list'), notes.map((n) => `<li><span class="stamp">${esc(n.stamp)}</span>${esc(n.text)}</li>`).join('') || '<li class="muted">No notes yet. Tap 📝 next to anything in "What you know" to save it here.</li>');
    const meAlive = g.alive.includes(S.me);
    $('#note-input').disabled = !meAlive || g.phase === 'over';
    $('#note-input').placeholder = meAlive ? 'Write a note…' : 'Your notepad is public now.';
    setHTML($('#note-chips'), meAlive ? g.alive.filter((id) => id !== S.me).map((id) => `<button class="chip" type="button" data-ins="${nm(id)}">${nm(id)}</button>`).join('')
      + ['is a Sneak?', 'seems safe', 'visited'].map((w) => `<button class="chip" type="button" data-ins="${w}">${w}</button>`).join('') : '');
  }

  // ----- tabs -----
  function renderTabs() {
    $$('#tabs [data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === ui.tab));
    ['board', 'chat', 'notes', 'behind', 'log'].forEach((t) => $(`#tab-${t}`).classList.toggle('hidden', t !== ui.tab));
    renderBoard(); renderChat(); renderNotes(); renderBehind(); renderLog();
  }
  const STICKERS = [['theory', '🤔', 'Theory'], ['accuse', '🚨', 'Accuse'], ['defend', '🛡️', 'Defend'], ['question', '❓', 'Question']];
  const STICKER = Object.fromEntries(STICKERS.map(([k, e, l]) => [k, { e, l }]));
  function renderBoard() {
    const g = S.game, meAlive = g.alive.includes(S.me);
    const canPost = meAlive && ['dawn', 'day', 'defense', 'vote'].includes(g.phase);
    ui.sticker = ui.sticker || 'theory'; ui.tags = (ui.tags || []).filter((id) => g.houses.includes(id));
    const comp = $('#composer');
    const draft = $('#cp-text') ? $('#cp-text').value : '';
    const compKey = [canPost, ui.sticker, ui.tags.join(), g.houses.join(), g.alive.join()].join('|');
    if (ui.compKey !== compKey || !comp.firstChild) {
      ui.compKey = compKey;
      comp.innerHTML = canPost ? `<div class="composer-title">📌 Pin a note</div>
        <div class="stickers">${STICKERS.map(([k, e, l]) => `<button class="sticker ${ui.sticker === k ? 'on' : ''}" data-st="${k}">${e} ${l}</button>`).join('')}</div>
        <textarea id="cp-text" maxlength="140" rows="2" placeholder="Theories, hunches, accusations…">${esc(draft)}</textarea>
        <div class="tagrow"><span class="small" style="font-weight:800">Tag:</span>${g.houses.filter((id) => id !== S.me).map((id) => `<button class="chip ${ui.tags.includes(id) ? 'on' : ''} ${g.alive.includes(id) ? '' : 'gone'}" data-tag="${id}">${nm(id)}</button>`).join('')}</div>
        <div class="row"><button class="btn small primary" data-post>Pin it</button><span class="small muted" id="cp-count">${draft.length}/140</span></div>`
        : `<div class="small muted" style="font-weight:700">${meAlive ? '📌 The Board opens at dawn.' : '👻 Wisps can read the Board but not pin notes.'}</div>`;
    }
    const days = [...new Set(g.board.map((c) => c.day))].sort((a, b) => b - a);
    setHTML($('#claim-list'), days.map((d) => `<div class="day-head">Day ${d}</div>` + g.board.filter((c) => c.day === d).reverse().map((c) => {
      const st = STICKER[c.sticker] || STICKER.theory;
      return `<div class="note-card ${c.sticker} ${d < g.day ? 'old' : ''}"><div class="note-top">${avatar(P(c.by), 'xs')}<b>${nm(c.by)}</b>${g.alive.includes(c.by) ? '' : ' 👻'}<span class="note-st">${st.e} ${st.l}</span></div>
        <div class="note-text">${esc(c.text)}</div>
        ${c.tags.length ? `<div class="note-tags">${c.tags.map((t) => `<span class="tag">${nm(t)}</span>`).join('')}</div>` : ''}
        <div class="react"><button data-react="trust" data-id="${c.id}" class="${c.trust.includes(S.me) ? 'on' : ''}" aria-label="Agree">👍 ${c.trust.length}</button>
        <button data-react="doubt" data-id="${c.id}" class="${c.doubt.includes(S.me) ? 'on' : ''}" aria-label="Disagree">👎 ${c.doubt.length}</button></div></div>`;
    }).join('')).join('') || '<div class="empty-hint"><span class="big">📌</span>Nothing pinned yet. Pin a theory, an accusation, or a question. Anyone can say anything… and Sneaks lie!</div>');
  }
  function onBoardClick(e) {
    const st = e.target.closest('[data-st]');
    if (st) { ui.sticker = st.dataset.st; ui.compKey = null; renderBoard(); return; }
    const tg = e.target.closest('[data-tag]');
    if (tg) {
      const id = tg.dataset.tag;
      ui.tags = ui.tags.includes(id) ? ui.tags.filter((x) => x !== id) : [...ui.tags, id].slice(-3);
      ui.compKey = null; renderBoard(); return;
    }
    if (e.target.closest('[data-post]')) {
      const i = $('#cp-text'), text = i.value.trim();
      if (!text) return toast('Write something first ✏️');
      send({ t: 'post', sticker: ui.sticker, text, tags: ui.tags });
      i.value = ''; ui.tags = []; ui.compKey = null; sound('pop'); renderBoard(); return;
    }
    const r = e.target.closest('[data-react]');
    if (r) {
      const c = S.game.board.find((x) => String(x.id) === r.dataset.id);
      const on = c && c[r.dataset.react].includes(S.me);
      send({ t: 'react', id: Number(r.dataset.id), v: on ? null : r.dataset.react });
    }
  }
  function renderChat() {
    const g = S.game, meAlive = g.alive.includes(S.me), onTeam = ROLES[g.myRole].team === 'sneaks', over = g.phase === 'over';
    const chans = [['day', '🏡 Village']];
    if (onTeam || !meAlive || over) chans.push(['den', '🌑 Den']);
    if (!meAlive || over) chans.push(['wisp', '👻 Wisps']);
    if (!chans.some(([k]) => k === ui.chatCh)) ui.chatCh = chans[0][0];
    setHTML($('#chat-channels'), chans.length > 1 ? chans.map(([k, l]) => `<button class="chip ${ui.chatCh === k ? 'on' : ''}" data-ch="${k}">${l}</button>`).join('') : '');
    const list = $('#chat-list');
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 50;
    const msgs = g.chat[ui.chatCh] || [];
    setHTML(list, msgs.filter((m) => !ui.muted.has(m.by)).map((m) => `<div class="msg ${m.by === S.me ? 'mine' : ''}">${avatar(P(m.by), 'xs')}<div class="bubble-txt"><b>${nm(m.by)}</b>${esc(m.text)}</div></div>`).join('')
      || `<div class="empty-hint"><span class="big">💬</span>${ui.chatCh === 'den' ? 'Only the Sneak team can read this.' : ui.chatCh === 'wisp' ? 'Only Wisps can read this.' : 'Say hi! Chat opens during the day.'}</div>`);
    if (atBottom) list.scrollTop = list.scrollHeight;
    const myChanOk = over ? ui.chatCh === 'day' : !meAlive ? ui.chatCh === 'wisp' : ui.chatCh !== 'wisp';
    const askable = !over && meAlive && ui.chatCh === 'day' && g.phase !== 'night';
    const qs = [['who do you suspect?', '🤔 Who\'s sus?'], ["what's your role?", '🎭 Your role?'], ['what did you learn last night?', '🔮 Any info?'], ['why?', '❓ Why?']];
    const denQs = [['who should we get tonight?', '🎯 Who tonight?']];
    const others = g.alive.filter((id) => id !== S.me);
    const askKey = [askable, ui.chatCh, others.join(), ui.askWho || ''].join('|');
    if (ui.askKey !== askKey) {
      ui.askKey = askKey;
      $('#quick-asks').innerHTML = askable ? `<select id="ask-who" aria-label="Ask who"><option value="">Everyone</option>${others.map((id) => `<option ${P(id).name === ui.askWho ? 'selected' : ''}>${esc(P(id).name)}</option>`).join('')}</select>${qs.map(([q, l]) => `<button class="chip" data-ask="${esc(q)}">${l}</button>`).join('')}`
        : ui.chatCh === 'den' && meAlive && !over ? denQs.map(([q, l]) => `<button class="chip" data-ask="${esc(q)}">${l}</button>`).join('') + '<span class="small muted">Name a target and your AI teammates will follow.</span>' : '';
    }
    const canType = over || !meAlive || ui.chatCh === 'den' || g.phase !== 'night';
    $('#chat-input').disabled = !(canType && myChanOk);
    $('#chat-input').placeholder = !myChanOk ? (meAlive ? 'Switch channels to talk.' : 'Wisps talk in the Wisps channel.') : !canType ? 'The village is asleep 💤' : 'Talk to anyone, e.g. "Mochi, who do you suspect?"';
    const total = g.chat.day.length + g.chat.den.length + g.chat.wisp.length;
    if (ui.tab === 'chat') ui.seenChat = total;
    $('#chat-dot').classList.toggle('hidden', ui.tab === 'chat' || total <= ui.seenChat);
  }
  function renderBehind() {
    const g = S.game;
    setHTML($('#tab-behind'), [...g.deaths].reverse().map((d) => `<div class="behind"><div class="row">${avatar(P(d.id), 'sm')}<b>${nm(d.id)}</b>
      <span class="small muted">${d.how === 'pond' ? `💦 voted into the Pond, day ${d.day}` : `🌙 vanished on night ${d.day}`}</span></div>${(() => { const sc = (g.scenes || []).find((x) => x.victim === d.id); return sc ? `<div class="scene-box small">📍 Vanished near <b>${esc(sc.zone)}</b>${sc.mole ? ' (no footprints, just dirt 🕳️)' : ''}</div>` : ''; })()}${notesHTML(d.notes)}</div>`).join('')
      || '<div class="empty-hint"><span class="big">👻</span>Nobody is gone yet. When a critter is eliminated, their role stays secret but their notepad shows up here.</div>');
  }
  function renderLog() {
    const g = S.game;
    setHTML($('#tab-log'), [...g.log].reverse().map((l) => `<div class="log-item">${esc(l.text)}</div>`).join(''));
  }

  // ----- speech bubbles, emotes, splash -----
  function houseXY(id) { const h = $(`.house[data-id="${id}"]`); return h ? [h.style.left, h.style.top] : null; }
  function showSpeech(g) {
    const chans = ['day']; if ((g.team || []).includes(S.me) || !g.alive.includes(S.me)) chans.push('den');
    for (const ch of chans) for (const m of g.chat[ch] || []) {
      if (m.ts <= (ui.bubbleTs || 0) || ui.muted.has(m.by)) continue;
      const xy = houseXY(m.by); if (!xy) continue;
      const el = document.createElement('div');
      el.className = 'speech'; el.textContent = m.text.length > 70 ? `${m.text.slice(0, 68)}…` : m.text;
      el.style.left = xy[0]; el.style.top = xy[1];
      $('#floaters').appendChild(el); setTimeout(() => el.remove(), 3700);
    }
    const all = chans.flatMap((c) => g.chat[c] || []);
    if (all.length) ui.bubbleTs = Math.max(ui.bubbleTs || 0, ...all.map((m) => m.ts));
  }
  function showTyping(id) {
    const xy = houseXY(id), layer = $('#floaters');
    if (xy && layer) {
      const el = document.createElement('div');
      el.className = 'speech typing'; el.innerHTML = '<i></i><i></i><i></i>';
      el.style.left = xy[0]; el.style.top = xy[1];
      layer.appendChild(el); setTimeout(() => el.remove(), 1500);
    }
    const line = $('#typing-line'); if (!line) return;
    line.textContent = `${P(id)?.name || 'Someone'} is typing…`;
    clearTimeout(ui.typingT); ui.typingT = setTimeout(() => { line.textContent = ''; }, 1600);
  }
  function floatEmote(id, e) {
    const xy = houseXY(id), layer = $('#floaters'); if (!xy || !layer) return;
    const f = document.createElement('div');
    f.className = 'floater'; f.textContent = e; f.style.left = xy[0]; f.style.top = xy[1];
    layer.appendChild(f); setTimeout(() => f.remove(), 1900);
  }
  function splashPond(id) {
    const h = $(`.house[data-id="${id}"]`); if (h) h.classList.add('splash');
    const pond = $('#pond'); if (pond) { pond.classList.remove('splash'); void pond.offsetWidth; pond.classList.add('splash'); }
    sound('splash');
  }

  // ================= OVERLAYS =================
  function showRoleReveal(again = false) {
    const g = S.game; if (!g) return closeModal();
    const r = ROLES[g.myRole], tc = teamClass(r.team);
    const mates = (g.team || []).filter((id) => id !== S.me);
    const m = modal(`<div class="modal-hero">
      <div style="font-weight:800" class="muted">${again ? 'Your role' : 'Your secret role is…'}</div>
      <div class="flip ${again ? 'flipped' : ''}" id="flip"><div class="flip-inner">
        <div class="flip-face flip-front">❓</div>
        <div class="flip-face flip-back ${tc}"><span class="icon">${r.icon}</span><span class="nm">${r.name}</span><span class="tm">Team ${TEAM_NAMES[r.team]}</span></div>
      </div></div></div>
      <div class="howto">
        <div><span>🎯</span><span>${GOALS[r.team]}</span></div>
        <div><span>${r.verb || r.team === 'sneaks' ? '🌙' : '🗣️'}</span><span>${r.ability}</span></div>
        ${mates.length ? `<div><span>🌑</span><span>Your teammates: <b>${mates.map((id) => nm(id)).join(', ')}</b>. Plot together in the Den chat.</span></div>` : ''}
        <div><span>💡</span><span>${r.tip}</span></div>
        ${again ? '' : '<div><span>🤫</span><span>Keep it secret! Roles are only revealed when the game ends.</span></div>'}
      </div>
      <div style="text-align:center"><button class="btn primary big" data-close>${again ? 'Got it' : "Let's go!"}</button></div>`, '', 'role');
    if (!again) { setTimeout(() => $('#flip', m)?.classList.add('flipped'), 600); setTimeout(() => sound('chime'), 700); }
  }
  function showDawn(e) {
    const g = S.game; if (!g) return closeModal();
    const died = e.died || [];
    const mine = died.includes(S.me);
    const learned = g.myLog.filter((l) => l.text.startsWith(`Night ${e.night}:`));
    let body;
    if (died.length) {
      body = died.map((id) => {
        const d = g.deaths.find((x) => x.id === id);
        return `<div class="victim">${avatar(P(id), 'big')}<div class="splash-txt">${nm(id)} vanished!</div></div>
          <p style="text-align:center">${mine ? "That's you! You're a Wisp now. You can read every chat, even the Sneaks' Den." : 'Their role stays secret, but they left their notepad behind:'}</p>
          ${mine ? '' : `<div class="behind">${notesHTML(d && d.notes)}</div>`}`;
      }).join('');
    } else body = `<div class="splash-txt" style="margin:.6rem 0">${e.night <= 1 || (e.saved === false && !died.length && g.day <= 2 && e.night === 1) ? '🌼 A quiet night in the Hollow.' : e.saved ? '🦔 Everyone is safe! Someone was protected.' : '🌼 Everyone woke up safe.'}</div>`;
    const outs = (e.outs || []).length ? `<li>🌑 Lanterns went dark near ${e.outs.map((o) => `${esc(o.zone)} (${o.when})`).join(', ')}</li>` : '';
    const lampOuts = (e.lampOuts || []).length ? `<li>💨 A street lamp was blown out near ${e.lampOuts.map((o) => esc(o.zone)).join(', ')}</li>` : '';
    const b = e.bell;
    const bellLi = b && !b.victim ? `<li>🔔 <b>${nm(b.by)}</b> rang the bell before anyone went missing, so the night ended early. <span class="muted">${b.left} ring${b.left === 1 ? '' : 's'} left this game.</span></li>`
      : b ? `<li>🔔 <b>${nm(b.by)}</b> rang the bell after ${nm(b.victim)} went missing. ${b.near.length ? `When it rang, closest to the tombstone: ${b.near.map((x) => `<b>${nm(x.id)}</b> (${esc(x.how)})`).join(', ')}.` : 'Nobody was near the tombstone when it rang.'} <span class="muted">${b.left} ring${b.left === 1 ? '' : 's'} left this game.</span></li>` : '';
    const clues = e.zone || outs || lampOuts || bellLi ? `<div class="scene-box"><b>🔍 What the village noticed</b><ul>${bellLi}
      ${e.zone ? `<li>🪦 A tombstone stands near <b>${esc(e.zone)}</b>${(g.scenes || []).some((x) => x.night === e.night && x.mole) ? ' and there were no footprints, just fresh dirt 🕳️' : ''}</li>` : ''}${outs}${lampOuts}</ul>
      <p class="small muted" style="margin:.3rem 0 0">👣 Last night's footprints are on the village map. Drag the slider to replay who walked where, and when.</p></div>` : '';
    const lit = (e.lit || []).length ? `<p class="small" style="text-align:center">🏮 A lantern now glows at ${e.lit.map((x) => `${nm(x)}'s house`).join(' and ')} for tonight.</p>` : '';
    const learnedHTML = learned.length && g.alive.includes(S.me) ? `<h3 style="margin-top:1rem">🔮 What you learned</h3>${learned.map((l) => { const t = l.text.replace(/^Night \d+: /, ''); return `<div class="secret new"><span>${esc(t.charAt(0).toUpperCase() + t.slice(1))}</span></div>`; }).join('')}` : '';
    const m = modal(`<div class="modal-hero"><span class="big-emoji">🌅</span><h2>Morning in the Hollow</h2></div>${body}${clues}${lit}${learnedHTML}
      <div style="text-align:center;margin-top:1rem"><button class="btn primary big" data-close>Start the day ☀️</button></div>`, '', `dawn${e.id}`);
    setTimeout(() => { if ($('#overlay').dataset.kind === `dawn${e.id}`) closeModal(); }, 13000);
    return m;
  }
  function showPond(e) {
    const g = S.game; if (!g) return closeModal();
    const entries = Object.entries(e.tally || {}).sort((a, b) => b[1] - a[1]);
    const max = Math.max(1, e.skip || 0, ...entries.map(([, v]) => v));
    const bars = entries.map(([id, v]) => `<div class="bar">${avatar(P(id), 'sm')}<span class="bn">${nm(id)}</span><div class="track"><div class="fill" style="--w:${(v / max) * 100}%"></div></div><span>${v}</span></div>`).join('')
      + (e.skip ? `<div class="bar skip"><span style="text-align:center">🤷</span><span class="bn">Skip</span><div class="track"><div class="fill" style="--w:${(e.skip / max) * 100}%"></div></div><span>${e.skip}</span></div>` : '');
    const result = e.out ? `<div class="victim">${avatar(P(e.out), 'big')}<div class="splash-txt">💦 Splash! ${nm(e.out)} goes into the Pond.</div></div>
      <p style="text-align:center">${e.out === S.me ? "That's you! You're a Wisp now." : 'Their role stays secret. Read their notepad in 👻 Gone.'}</p>`
      : '<div class="splash-txt" style="margin:.6rem 0">🤝 No clear majority. Nobody goes in today.</div>';
    modal(`<div class="modal-hero"><span class="big-emoji">🗳️</span><h2>The votes are in!</h2></div>
      <div class="bars">${bars || '<p class="muted" style="text-align:center">Nobody voted.</p>'}</div>${result}
      <div style="text-align:center;margin-top:1rem"><button class="btn primary big" data-close>Continue</button></div>`, '', `pond${e.id}`);
    setTimeout(() => { if ($('#overlay').dataset.kind === `pond${e.id}`) closeModal(); }, 7000);
  }
  function confetti() {
    if (!profile.motion) return;
    const c = document.createElement('div'); c.className = 'confetti';
    const cols = ['#FF6B8B', '#FFC94D', '#6CC17A', '#B69CFF', '#8FD3F4'];
    c.innerHTML = Array.from({ length: 70 }, () => `<i style="left:${Math.random() * 100}%;background:${cols[Math.floor(Math.random() * cols.length)]};animation-delay:${Math.random() * 1.2}s;animation-duration:${2.4 + Math.random() * 1.6}s"></i>`).join('');
    document.body.appendChild(c); setTimeout(() => c.remove(), 5000);
  }
  function showGameOver() {
    const g = S.game; if (!g || !g.over) return closeModal();
    const o = g.over, me = S.me, host = S.hostId === me, won = o.winners.includes(me);
    if (won) confetti();
    const reveal = g.houses.map((id, i) => {
      const r = ROLES[o.roles[id]];
      return `<div class="reveal ${o.winners.includes(id) ? 'won' : ''}" style="animation-delay:${i * 0.07}s">${avatar(P(id), 'sm')}<div><b>${nm(id)}</b>${g.alive.includes(id) ? '' : ' 👻'}<br>
        <span class="${r.team === 'sneaks' ? 'r-sneak' : ''}">${r.icon} ${r.name}</span>${o.winners.includes(id) ? ' 🏆' : ''}</div></div>`;
    }).join('');
    const recap = o.history.map((h) => {
      const items = h.visits.map((v) => {
        const verb = { kill: '🌑 went after', check: '🦉 watched', protect: '🦔 protected', gossip: '🐇 watched', peek: '👀 peeked at' }[v.kind] || 'visited';
        return `<li>${nm(v.from)} ${verb} ${nm(v.to)}${v.hidden ? ' (underground 🕳️)' : ''}</li>`;
      }).join('');
      const placeName = (id) => (id === 'home' ? '🏠 home' : (() => { const pl = g.places.find((x) => x.id === id); return pl ? `${pl.e} ${pl.name}` : id; })());
      const walkLine = '';
      const sceneLine = h.scene ? `<li>🔍 ${h.scene.map(esc).join(' ')}</li>` : '';
      const extra = walkLine + sceneLine + (h.meddles || []).map((m) => `<li>🎭 ${nm(m.by)} meddled with ${nm(m.target)}</li>`).join('')
        + (h.lit || []).map((x) => `<li>🏮 A lantern glowed at ${nm(x)}'s house</li>`).join('')
        + (h.bell ? `<li>🔔 ${nm(h.bell.by)} rang the bell${h.bell.victim ? '' : ' early'}${h.bell.near.length ? `; closest: ${h.bell.near.map((x) => nm(x.id)).join(', ')}` : ''}</li>` : '');
      return `<div class="recap-night"><b>Night ${h.night}</b>${h.kill ? ` · Sneaks targeted ${nm(h.kill)}${h.saved ? ' (saved! 🦔)' : ''}` : ''}<ul>${items || '<li>Nobody went out.</li>'}${extra}</ul></div>`;
    }).join('');
    const m = modal(`<div class="gameover"><p class="winner ${o.winner}">${o.winner === 'village' ? '🏡 Village wins!' : '🌑 Sneaks win!'}</p>
      <span class="you-badge ${won ? '' : 'lost'}">${won ? '🎉 You won!' : '💤 Not your win this time'}</span>
      <h3>Who was who</h3><div class="reveal-grid">${reveal}</div>
      <details class="recap"><summary>📜 What really happened each night</summary>${recap}</details>
      <div class="row" style="justify-content:center;margin-top:1.2rem">
        <button class="btn primary big" data-go="again">🔁 Play again</button>
        <button class="btn" data-go="map">View the map</button><button class="btn" data-go="leave">Leave</button></div></div>`, 'wide', 'over');
    m.addEventListener('click', (e) => {
      const b = e.target.closest('[data-go]'); if (!b) return;
      if (b.dataset.go === 'again') send({ t: 'again' });
      if (b.dataset.go === 'leave') send({ t: 'leave' });
      closeModal();
    });
  }

  // ----- ticker: timer ring, countdowns, coach hints -----
  setInterval(() => {
    $$('[data-countdown]').forEach((el) => { const s = Math.max(0, Math.ceil((Number(el.dataset.countdown) - now()) / 1000)); el.textContent = `Starting in ${s}s`; });
    if (!S || !S.game) return;
    const g = S.game, t = $('#timer'), wrap = t.parentElement, ring = $('#timer-ring');
    if (g.phase === 'over' || !g.endsAt) { t.textContent = '—'; wrap.classList.remove('low'); ring.style.strokeDashoffset = 0; return; }
    const ms = Math.max(0, g.endsAt - now()), s = Math.ceil(ms / 1000);
    t.textContent = s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s}`;
    wrap.classList.toggle('low', s <= 10);
    ring.style.strokeDashoffset = 113.1 * (1 - Math.min(1, ms / (ui.phaseTotal || 1)));
    const meAlive = g.alive.includes(S.me);
    if (g.phase === 'night' && meAlive && hasNight(g) && Date.now() - ui.phaseStart > 9000 && !g.mySneakVote && !g.myAction && !(window.HHNight && window.HHNight.tasks().some((t) => t.k === 'role' && t.done))) hint(`night${g.day}`, 'walk to a critter\'s door and hold E to use your ability!');
  }, 250);

  buildHome();
  connect();
})();
