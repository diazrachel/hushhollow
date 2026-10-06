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
    name: '', critter: 'fox', color: 'honey', hat: 'none', games: 0, tutorialDone: false, hints: true, sound: true, motion: true,
  }, store.get('hh-profile', {}));
  if (!profile.name) profile.name = NAMES[Math.floor(Math.random() * NAMES.length)];
  const pubProfile = () => ({ name: profile.name, critter: profile.critter, color: profile.color, hat: profile.hat, games: profile.games });
  function saveProfile() { store.set('hh-profile', profile); send({ t: 'profile', profile: pubProfile() }); }

  // ---------- connection ----------
  let ws = null, S = null, offset = 0, retry = 0;
  const ui = {
    tab: 'board', chatCh: 'day', composer: 'role', muted: new Set(), phaseKey: '', phaseStart: 0,
    hints: {}, overShown: null, seenChat: 0, lastDeaths: 0, built: { lobby: false },
  };
  function connect() {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss://' : 'ws://'}${location.host}/ws`);
    ws.onopen = () => { retry = 0; $('#conn').classList.add('hidden'); send({ t: 'hello', token, profile: pubProfile() }); };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } onMsg(m); };
    ws.onclose = () => { $('#conn').classList.remove('hidden'); setTimeout(connect, Math.min(8000, 500 * 2 ** retry++)); };
  }
  function send(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }

  function onMsg(m) {
    if (m.t === 'state') { offset = m.now - Date.now(); const prev = S; S = m; onState(prev); }
    else if (m.t === 'home') { S = null; showScreen('home'); urlJoin(); }
    else if (m.t === 'error') toast(m.text);
    else if (m.t === 'kicked') { toast('The host removed you from the burrow.'); S = null; showScreen('home'); }
    else if (m.t === 'emote') floatEmote(m.id, m.e);
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
    ['home', 'lobby', 'game'].forEach((s) => $(`#${s}`).classList.toggle('hidden', s !== id));
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
  function modal(html, cls = '') {
    const ov = $('#overlay');
    ov.innerHTML = `<div class="modal ${cls}"><button class="icon-btn close" data-close aria-label="Close">✕</button>${html}</div>`;
    ov.classList.remove('hidden');
    const first = ov.querySelector('button:not([data-close]), input, select'); if (first) first.focus();
    return ov.firstElementChild;
  }
  function closeModal() { $('#overlay').classList.add('hidden'); $('#overlay').innerHTML = ''; }
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
        <label class="check"><input type="checkbox" id="st-sound" ${profile.sound ? 'checked' : ''}> Sound effects</label>
        <label class="check"><input type="checkbox" id="st-hints" ${profile.hints ? 'checked' : ''}> Beginner tips during your first 3 games</label>
        <label class="check"><input type="checkbox" id="st-motion" ${profile.motion ? 'checked' : ''}> Animations</label>
      </div>
      <h3 style="margin-top:1rem">Carry code</h3>
      <p class="muted small">Copy this code to move your critter, hat, and unlocks to another device. It holds no personal data.</p>
      <div class="row"><input id="st-code" readonly value="${esc(code)}" class="grow"><button class="btn small" id="st-copy">Copy</button></div>
      <div class="row" style="margin-top:.6rem"><input id="st-import" placeholder="Paste a carry code" class="grow"><button class="btn small" id="st-load">Load</button></div>`);
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
      body = `<p class="muted">Cozy games use the Owl, Hedgehog, Villager, and Sneak. Classic adds the Gossip Bunny, Elder Turtle, Lantern Keeper, and Trickster. Chaos adds the Shadow Mole and the solo roles.</p>
      <div class="hb-grid">${Object.values(ROLES).map((r) => `<div class="hb-card ${r.team === 'sneaks' ? 'sneaks' : ''}"><div class="ic">${r.icon}</div><h3>${r.name}</h3><p class="small"><b>${TEAM_NAMES[r.team]}.</b> ${r.ability}</p><p class="small muted">${r.tip}</p></div>`).join('')}</div>`;
    } else if (tab === 'hints') {
      body = `<div class="hb-grid">${HANDBOOK.hints.map(([t, d]) => `<div class="hb-card"><h3>${t}</h3><p>${d}</p></div>`).join('')}</div>
      <h3 style="margin-top:1rem">Worked example</h3>
      <p>Night 1, the Owl learns: <b>at least one of Pip, Bramble, and Fig is a Sneak.</b> Night 2: <b>none of Pip, Mochi, and Juniper is a Sneak.</b> Pip is cleared, so the Sneak from night 1 is Bramble or Fig. Then a Gossip Bunny posts that Bramble visited the house of the critter who vanished. Now Bramble looks bad… unless the Trickster meddled with the Bunny. Line up every card before you vote.</p>`;
    } else body = `<ul>${HANDBOOK.etiquette.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`;
    const m = modal(`<h2>Hollow Handbook</h2>
      <nav class="tabs">${tabs.map(([k, l]) => `<button data-hb="${k}" class="${k === tab ? 'active' : ''}">${l}</button>`).join('')}</nav>${body}`, 'wide');
    m.addEventListener('click', (e) => { const b = e.target.closest('[data-hb]'); if (b) openHandbook(b.dataset.hb); });
  }

  function openTutorial() {
    window.HHTutorial.open({
      profile, modal, closeModal, avatar,
      onDone() {
        if (!profile.tutorialDone) { profile.tutorialDone = true; profile.hat = 'sprout'; saveProfile(); renderHats(); updatePreview(); toast('You unlocked the Sprout Leaf hat 🌱'); }
      },
      onPractice() { closeModal(); send({ t: 'create', practice: true, forcedRole: 'owl' }); },
    });
  }

  // ================= STATE → RENDER =================
  function onState(prev) {
    if (!S.game) { renderLobby(); return; }
    const g = S.game;
    const key = `${g.phase}-${g.day}-${g.defenseIdx}`;
    if (key !== ui.phaseKey) {
      ui.phaseKey = key; ui.phaseStart = Date.now();
      if (g.phase === 'night') sound('night'); else if (g.phase === 'dawn') sound('chime'); else if (g.phase === 'vote') sound('pop');
      const alive = g.alive.includes(S.me);
      if (alive && !S.game.chat.den.length && ui.chatCh === 'den' && g.phase !== 'night') ui.chatCh = 'day';
      if (!alive && ui.chatCh !== 'wisp') ui.chatCh = 'wisp';
      if (g.phase === 'day') hint(`day${g.day}`, 'post a claim card on the Board. Cards read the same in every language.');
      if (g.phase === 'vote') hint('vote', "tap a highlighted house to vote, or press Skip if you're unsure.");
      if (g.phase === 'dawn' && g.deaths.length) hint('behind', 'open Left Behind to read the notepad of whoever vanished.');
    }
    renderGame();
    if (g.deaths.length > ui.lastDeaths && prev && prev.game) {
      const d = g.deaths[g.deaths.length - 1];
      const el = $(`.house[data-id="${d.id}"]`);
      if (el && d.how === 'pond') { el.classList.add('splash'); sound('splash'); }
    }
    ui.lastDeaths = g.deaths.length;
    if (g.phase === 'over' && ui.overShown !== `${S.code}-${g.day}`) { ui.overShown = `${S.code}-${g.day}`; setTimeout(showGameOver, 600); }
    if (g.phase !== 'over' && ui.overShown && $('#overlay .gameover')) closeModal();
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
    ui.overShown = null; ui.lastDeaths = 0; ui.hints = {};
    if ($('#overlay .gameover')) closeModal();
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
      <p class="small muted" style="margin:0">${{ cozy: 'Cozy: Owl, Hedgehog, Villagers, and Sneaks. Best for new players.', classic: 'Classic: adds the Gossip Bunny, Elder Turtle, Lantern Keeper, and Trickster.', chaos: 'Chaos: adds the Shadow Mole and solo roles for experienced groups.' }[st.spice]}</p>
      </div>`;
    const list = $('#lb-chat');
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    list.innerHTML = S.lobbyChat.map((m) => m.sys ? `<div class="msg sys">${esc(m.text)}</div>`
      : ui.muted.has(m.by) ? '' : `<div class="msg">${avatar(P(m.by), 'xs')}<div><b>${nm(m.by)}</b> ${esc(m.text)}</div></div>`).join('');
    if (atBottom) list.scrollTop = list.scrollHeight;
  }

  // ================= GAME =================
  let gameBuilt = false;
  function buildGame() {
    $('#emote-bar').innerHTML = EMOTES.map((e) => `<button data-emote="${e}" aria-label="Send ${e}">${e}</button>`).join('');
    $('#emote-bar').onclick = (e) => { const b = e.target.closest('[data-emote]'); if (b) send({ t: 'emote', e: b.dataset.emote }); };
    $('#map').innerHTML = `<svg class="yarn" viewBox="0 0 100 100" preserveAspectRatio="none" id="yarn"></svg><div class="pond" id="pond"><div class="pond-text" id="pond-text"></div></div><div id="houses"></div><div id="floaters"></div>`;
    $('#map').onclick = (e) => { const h = e.target.closest('.house'); if (h) onHouse(h.dataset.id); };
    $('#tabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) { ui.tab = b.dataset.tab; renderTabs(); } };
    $('#note-form').onsubmit = (e) => { e.preventDefault(); const i = $('#note-input'); if (i.value.trim()) { send({ t: 'note', text: i.value }); i.value = ''; } };
    $('#note-chips').onclick = (e) => { const c = e.target.closest('[data-ins]'); if (c) insert($('#note-input'), c.dataset.ins); };
    $('#chat-form').onsubmit = (e) => { e.preventDefault(); const i = $('#chat-input'); if (i.value.trim()) { send({ t: 'chat', text: i.value, channel: ui.chatCh }); i.value = ''; } };
    $('#chat-channels').onclick = (e) => { const b = e.target.closest('[data-ch]'); if (b) { ui.chatCh = b.dataset.ch; renderChat(); } };
    $('#role-chip').onclick = openRoleCard;
    $('#g-handbook-btn').onclick = () => openHandbook();
    $('#sound-btn').onclick = () => { profile.sound = !profile.sound; saveProfile(); $('#sound-btn').textContent = profile.sound ? '🔔' : '🔕'; };
    $('#sound-btn').textContent = profile.sound ? '🔔' : '🔕';
    $('#leave-btn').onclick = () => {
      const over = S && S.game && S.game.phase === 'over';
      if (over || confirm('Leave this game? An AI critter will take your seat.')) send({ t: 'leave' });
    };
    $('#action-card').addEventListener('click', onActionClick);
    $('#action-card').addEventListener('change', (e) => { if (e.target.id === 'meddle-sel') send({ t: 'night', kind: 'meddle', target: e.target.value || null }); });
    $('#tab-board').innerHTML = `<div class="composer" id="composer"></div><div id="claim-list" style="display:flex;flex-direction:column;gap:.4rem"></div>`;
    $('#tab-board').addEventListener('click', onBoardClick);
    gameBuilt = true;
  }
  function setHTML(el, html) { if (el.__html !== html) { el.innerHTML = html; el.__html = html; } }
  function insert(input, text) { input.value = (input.value ? `${input.value.trim()} ` : '') + text; input.focus(); }

  function renderGame() {
    showScreen('game');
    if (!gameBuilt) buildGame();
    const g = S.game;
    setPhaseClass(g.phase === 'night' ? 'night' : g.phase === 'dawn' ? 'dawn' : 'day');
    const phaseNames = { night: g.settling ? 'Settling-in night' : `Night ${g.day}`, dawn: 'Dawn', day: `Day ${g.day}`, defense: 'Defense', vote: `Vote · Day ${g.day}`, over: 'Game over' };
    $('#phase-name').textContent = phaseNames[g.phase] || '';
    const r = ROLES[g.myRole];
    $('#role-chip').textContent = `${r.icon} ${r.name}`;
    $('#role-chip').classList.toggle('sneaks', r.team === 'sneaks');
    renderMap(); renderAction(); renderNotes(); renderTabs();
  }

  function housePos(i, n, radius = 40) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return [50 + radius * Math.cos(a), 50 + radius * Math.sin(a)];
  }
  function renderMap() {
    const g = S.game, me = S.me, alive = new Set(g.alive), meAlive = alive.has(me);
    const n = g.houses.length;
    const pos = {}; g.houses.forEach((id, i) => { pos[id] = housePos(i, n, n > 10 ? 41 : 39); });
    const team = new Set(g.team || []);
    const lit = new Set(g.lit);
    const voteCount = {};
    if (g.phase === 'vote' || g.phase === 'over') Object.entries(g.votes).forEach(([v, t]) => { if (t !== 'skip') voteCount[t] = (voteCount[t] || 0) + (g.turtles.includes(v) ? 2 : 1); });
    const nomCount = {}; Object.values(g.noms || {}).forEach((t) => { nomCount[t] = (nomCount[t] || 0) + 1; });
    const teamPick = {}; if (g.teamVotes) Object.values(g.teamVotes).forEach((t) => { teamPick[t] = (teamPick[t] || 0) + 1; });
    const myPick = g.phase === 'night' ? (meAlive ? (g.mySneakVote || (g.myAction && g.myAction.target)) : null) : g.phase === 'vote' ? g.votes[me] : null;
    const onTeam = team.has(me);
    const speaking = g.phase === 'defense' ? g.nominees[g.defenseIdx] : null;
    const targetable = (id) => {
      if (g.phase === 'night') return meAlive && id !== me && alive.has(id) && !(onTeam && !g.settling && (team.has(id) || (lit.has(id) && !g.moleAlive)));
      if (g.phase === 'vote') return meAlive && g.nominees.includes(id) && id !== me;
      return false;
    };
    setHTML($('#houses'), g.houses.map((id) => {
      const p = P(id) || { name: '?' };
      const [x, y] = pos[id];
      const cls = ['house', id === me && 'me', !alive.has(id) && 'dead', lit.has(id) && 'lit', team.has(id) && team.has(me) && 'teammate',
        myPick === id && 'picked', targetable(id) && 'target', g.nominees.includes(id) && g.phase !== 'vote' && g.bigGame && 'nominee',
        g.phase === 'vote' && g.bigGame && g.nominees.includes(id) && 'nominee', speaking === id && 'speaking'].filter(Boolean).join(' ');
      const badges = [
        p.isAI ? '<span title="AI critter">🌰</span>' : '', g.turtles.includes(id) ? '<span title="Revealed Elder Turtle">🐢</span>' : '',
        lit.has(id) ? '<span title="Lantern">🏮</span>' : '', team.has(id) && team.has(me) ? '<span title="Sneak team">🌑</span>' : '',
        teamPick[id] ? `<span title="Team picks">🎯${teamPick[id]}</span>` : '', g.myMeddle === id ? '<span title="You are meddling here">🎭</span>' : '',
        g.bigGame && nomCount[id] && g.phase === 'day' ? `<span title="Nominations">📌${nomCount[id]}</span>` : '',
      ].join('');
      return `<button class="${cls}" data-id="${id}" style="left:${x}%;top:${y}%" aria-label="${esc(p.name)}${alive.has(id) ? '' : ' (Wisp)'}">
        ${voteCount[id] ? `<span class="votes">${voteCount[id]}</span>` : ''}
        ${avatar(p)}<span class="nm">${esc(p.name)}</span><span class="badges">${badges}</span></button>`;
    }).join(''));
    $('#yarn').innerHTML = Object.entries(g.yarn || {}).filter(([a, b]) => pos[a] && pos[b])
      .map(([a, b]) => `<line class="${a === me ? 'mine' : ''}" x1="${pos[a][0]}" y1="${pos[a][1]}" x2="${pos[b][0]}" y2="${pos[b][1]}"/>`).join('');
    $('#pond-text').innerHTML = pondText();
  }
  function pondText() {
    const g = S.game, meAlive = g.alive.includes(S.me), r = ROLES[g.myRole];
    const sneakTurn = r.team === 'sneaks' && !g.settling;
    switch (g.phase) {
      case 'night': return meAlive ? `${g.settling ? 'Settling in' : 'The village sleeps'}<small>${sneakTurn ? 'Pick who to spirit away' : (g.settling && r.team === 'sneaks' ? 'Peek at a house' : r.verb)}</small>`
        : 'You are a Wisp<small>Read every chat, even the Den</small>';
      case 'dawn': { const last = [...g.log].reverse().find((l) => /^Dawn/.test(l.text)); return `Dawn<small>${esc(last ? last.text.replace(/^Dawn\. /, '') : '')}</small>`; }
      case 'day': return `Day ${g.day}<small>${g.bigGame ? 'Tap a critter to nominate or tie yarn' : 'Tap a critter to tie yarn or accuse'}</small>`;
      case 'defense': return `${nm(g.nominees[g.defenseIdx])} speaks<small>15 seconds to defend themselves</small>`;
      case 'vote': return `Vote!<small>${meAlive ? 'Tap a house, or Skip' : 'The living are voting'}</small>`;
      case 'over': return `${g.over.winner === 'village' ? 'Village wins' : 'Sneaks win'}<small>Check the recap</small>`;
      default: return '';
    }
  }

  function onHouse(id) {
    const g = S.game, meAlive = g.alive.includes(S.me);
    if (g.phase === 'over') return;
    if (g.phase === 'night') {
      if (!meAlive) return;
      if (id === S.me) return toast("Pick someone else's house.");
      if (!g.alive.includes(id)) return toast('That critter is already a Wisp.');
      if (g.myRole === 'hedgehog' && g.lastProtect === id) return toast("You can't protect the same critter two nights in a row.");
      if (g.myRole === 'lantern' && g.lastLight === id) return toast("You can't light the same house two nights in a row.");
      const onTeam = (g.team || []).includes(S.me) && !g.settling;
      if (onTeam && g.team.includes(id)) return toast("That's your teammate.");
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
    const m = modal(`<div class="row" style="gap:.8rem">${avatar(p, 'big')}<div><h2 style="margin:0">${esc(p.name)}</h2>
      <div class="row" style="gap:.3rem;margin-top:.2rem">${p.isAI ? `<span class="tag ai">🌰 AI · ${p.aiLevel}</span>` : ''}${p.sprout ? '<span class="tag sprout">🌱 Sprout</span>' : ''}
      ${!alive ? '<span class="tag">✨ Wisp</span>' : ''}</div></div></div>
      <div class="row" style="margin-top:1rem">
        ${meAlive && alive && !self ? `<button class="btn small" data-pm="yarn">${tied ? 'Untie yarn' : '🧶 Tie yarn (I suspect them)'}</button>` : ''}
        ${meAlive && alive && !self && g.bigGame && g.phase === 'day' ? `<button class="btn small" data-pm="nom">${nominated ? 'Withdraw nomination' : '📌 Nominate'}</button>` : ''}
        ${meAlive && alive && !self ? '<button class="btn small" data-pm="accuse">Accuse on the Board</button>' : ''}
        <button class="btn small" data-pm="note">Add name to Notepad</button>
        ${!self && !p.isAI ? `<button class="btn small ghost" data-pm="mute">${ui.muted.has(id) ? 'Unmute' : 'Mute'} chat</button>` : ''}
      </div>
      ${death ? `<div class="behind" style="margin-top:1rem"><b>Left behind</b>${notesHTML(death.notes)}</div>` : ''}`);
    m.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pm]'); if (!b) return;
      const a = b.dataset.pm;
      if (a === 'yarn') send({ t: 'yarn', target: tied ? null : id });
      else if (a === 'nom') send({ t: 'nominate', target: nominated ? null : id });
      else if (a === 'accuse') { ui.composer = 'accuse'; ui.tab = 'board'; ui.prefill = id; ui.compKey = null; renderTabs(); }
      else if (a === 'note') insert($('#note-input'), p.name);
      else if (a === 'mute') { if (ui.muted.has(id)) ui.muted.delete(id); else ui.muted.add(id); renderChat(); }
      closeModal();
    });
  }

  // ----- action card -----
  function renderAction() {
    const g = S.game, r = ROLES[g.myRole], meAlive = g.alive.includes(S.me);
    const team = g.team || [], onTeam = r.team === 'sneaks';
    let prompt = '', done = false, extra = '';
    if (g.phase === 'night') {
      if (!meAlive) prompt = "You're a Wisp. While the village sleeps, read the Den and chat with the other Wisps.";
      else if (onTeam && !g.settling) {
        const picks = Object.entries(g.teamVotes || {}).map(([a, b]) => `${nm(a)} → ${nm(b)}`).join(', ');
        prompt = g.mySneakVote ? `You picked ${nm(g.mySneakVote)}.` : 'Choose who to spirit away tonight.';
        done = !!g.mySneakVote;
        if (team.length > 1) extra += `<p class="small muted">Team picks: ${picks || 'none yet'}. Chat in the Den tab to agree.</p>`;
        if (g.lit.length && !g.moleAlive) extra += '<p class="small muted">Houses with a glowing lantern are off limits tonight.</p>';
        if (g.lit.length && g.moleAlive) extra += '<p class="small muted">Your Mole can tunnel under lanterns.</p>';
      } else {
        const chosen = g.myAction && g.myAction.target;
        prompt = chosen ? `You chose ${nm(chosen)}.` : g.settling && onTeam ? 'Settling-in night: nobody vanishes. Peek at a house to blend in.' : `${r.verb}: tap a house.`;
        done = !!chosen;
        if (g.myRole === 'hedgehog' && g.lastProtect) extra += `<p class="small muted">You can't protect ${nm(g.lastProtect)} again tonight.</p>`;
        if (g.myRole === 'lantern' && g.lastLight) extra += `<p class="small muted">You can't light ${nm(g.lastLight)}'s house again tonight.</p>`;
      }
    } else if (g.phase === 'dawn') prompt = 'Dawn. Check your Log for what you learned last night, and read anything left behind.';
    else if (g.phase === 'day') {
      if (!meAlive) prompt = "You're a Wisp. You can read every chat and talk with other Wisps.";
      else {
        prompt = g.bigGame ? (g.noms[S.me] ? `You nominated ${nm(g.noms[S.me])}.` : 'Talk it over, then tap a critter to nominate them.') : 'Talk it over. Post claims on the Board and tie yarn to your suspect.';
        done = g.bigGame && !!g.noms[S.me];
        extra += `<button class="btn small ${g.iReady ? 'on' : ''}" data-a="ready" ${g.iReady ? 'disabled' : ''}>${g.iReady ? 'Ready ✓' : 'Ready to vote'}</button>
          <span class="small muted"> ${g.readyCount}/${g.alive.length} ready</span>`;
      }
    } else if (g.phase === 'defense') prompt = `${nm(g.nominees[g.defenseIdx])} has 15 seconds to defend themselves. Nominees: ${g.nominees.map(nm).join(', ')}.`;
    else if (g.phase === 'vote') {
      if (!meAlive) prompt = 'The living are voting.';
      else {
        const v = g.votes[S.me];
        prompt = v ? (v === 'skip' ? 'You voted to skip.' : `You voted for ${nm(v)}.`) : 'Tap a highlighted house to vote.';
        done = !!v;
        extra += `<button class="btn small ${v === 'skip' ? 'on' : ''}" data-a="skip">Skip vote</button>`;
        if (g.turtles.includes(S.me)) extra += '<p class="small muted">Your vote counts double.</p>';
      }
    } else if (g.phase === 'over') prompt = 'The game is over.';
    if (g.myRole === 'turtle' && meAlive && !g.turtles.includes(S.me) && ['day', 'dawn', 'defense', 'vote'].includes(g.phase)) {
      extra += `<div style="margin-top:.5rem"><button class="btn small honey" data-a="reveal">🐢 Reveal as Elder Turtle</button></div>`;
    }
    if (g.phase === 'night' && meAlive && g.myRole === 'trickster') {
      const opts = g.alive.filter((id) => id !== S.me && id !== g.lastMeddle).map((id) => `<option value="${id}" ${g.myMeddle === id ? 'selected' : ''}>${nm(id)}</option>`).join('');
      extra += `<label class="field" style="margin-top:.5rem">🎭 Meddle with someone's night<select id="meddle-sel"><option value="">Nobody tonight</option>${opts}</select></label>
        <p class="small muted">If they use an info ability tonight, their result comes out slightly wrong.</p>`;
    }
    const results = g.phase !== 'night' && g.phase !== 'over' && meAlive ? g.myLog.filter((l) => l.text.startsWith(`Night ${g.day}:`)) : [];
    const lastNight = results.length ? `<div class="last-night"><b>Last night you learned</b>${results.map((l) => esc(l.text.replace(/^Night \d+: /, ''))).join('<br>')}
      <br><button class="btn small" data-a="jot">Copy to Notepad</button></div>` : '';
    const teamTags = onTeam && team.length > 1 ? `<div class="team-list">${team.filter((id) => id !== S.me).map((id) => `<span class="tag sneak">${ROLES[(g.teamRoles || {})[id]]?.icon || '🌑'} ${nm(id)}${g.alive.includes(id) ? '' : ' ✨'}</span>`).join('')}</div>` : '';
    setHTML($('#action-card'), `<h3>${r.icon} ${r.name} <span class="tag ${onTeam ? 'sneak' : ''}">${TEAM_NAMES[r.team]}</span></h3>
      <p class="ability muted">${r.ability}</p>${teamTags}
      <div class="prompt ${done ? 'done' : ''}">${prompt}</div>${lastNight}${extra}
      <button class="link small" data-a="role" style="margin-top:.5rem">Read my role card</button>`);
  }
  function onActionClick(e) {
    const b = e.target.closest('[data-a]'); if (!b) return;
    const a = b.dataset.a;
    if (a === 'ready') send({ t: 'ready' });
    else if (a === 'skip') send({ t: 'vote', target: S.game.votes[S.me] === 'skip' ? null : 'skip' });
    else if (a === 'reveal') { if (confirm('Reveal yourself as the Elder Turtle? Everyone will know, and your vote will count double.')) send({ t: 'reveal' }); }
    else if (a === 'role') openRoleCard();
    else if (a === 'jot') {
      const g = S.game;
      g.myLog.filter((l) => l.text.startsWith(`Night ${g.day}:`)).forEach((l) => send({ t: 'note', text: l.text.replace(/^Night \d+: (you )?/, '') }));
      toast('Saved to your Notepad.');
    }
  }
  function openRoleCard() {
    const r = ROLES[S.game.myRole];
    modal(`<div class="role-card"><span class="big-icon">${r.icon}</span><h2>${r.name}</h2><div class="team">Team: ${TEAM_NAMES[r.team]}</div>
      <p style="margin-top:.8rem">${r.ability}</p><p class="muted"><b>Tip:</b> ${r.tip}</p></div>`);
  }

  // ----- notepad -----
  function notesHTML(notes) {
    if (!notes || !notes.length) return '<p class="small muted" style="margin:.3rem 0 0">Their notepad was empty.</p>';
    return `<ol>${notes.map((n) => `<li><span class="stamp">${esc(n.stamp)}</span>${esc(n.text)}</li>`).join('')}</ol>`;
  }
  function renderNotes() {
    const g = S.game, notes = g.myNotes || [];
    const used = notes.reduce((s, n) => s + n.text.length, 0);
    $('#note-count').textContent = `${used}/500`;
    $('#note-list').innerHTML = notes.map((n) => `<li><span class="stamp">${esc(n.stamp)}</span>${esc(n.text)}</li>`).join('') || '<li class="muted">No notes yet. Write down what you learn each night.</li>';
    const meAlive = g.alive.includes(S.me);
    $('#note-input').disabled = !meAlive || g.phase === 'over';
    $('#note-input').placeholder = meAlive ? 'Write a note…' : 'Your notepad is locked. Everyone can read it now.';
    const roleWords = ['at least one is a Sneak', 'none are Sneaks', 'visited', 'Owl', 'Hedgehog', 'Sneak'];
    $('#note-chips').innerHTML = meAlive ? g.alive.filter((id) => id !== S.me).map((id) => `<button class="chip" type="button" data-ins="${nm(id)}">${nm(id)}</button>`).join('')
      + roleWords.map((w) => `<button class="chip" type="button" data-ins="${w}">${w}</button>`).join('') : '';
  }

  // ----- tabs -----
  function renderTabs() {
    $$('#tabs [data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === ui.tab));
    ['board', 'chat', 'behind', 'log'].forEach((t) => $(`#tab-${t}`).classList.toggle('hidden', t !== ui.tab));
    renderBoard(); renderChat(); renderBehind(); renderLog();
  }
  function renderBoard() {
    const g = S.game, meAlive = g.alive.includes(S.me);
    const canPost = meAlive && ['dawn', 'day', 'defense', 'vote'].includes(g.phase);
    const comp = $('#composer');
    const playerOpts = (list, sel) => list.map((id) => `<option value="${id}" ${sel === id ? 'selected' : ''}>${nm(id)}</option>`).join('');
    const v = (id) => $(id)?.value;
    const prev = { role: v('#cp-role'), t1: v('#cp-t1'), t2: v('#cp-t2'), t3: v('#cp-t3'), result: v('#cp-result'), target: v('#cp-target'), at: v('#cp-at') };
    if (ui.prefill) { prev.target = ui.prefill; ui.prefill = null; }
    const others = g.houses.filter((id) => id !== S.me);
    const kinds = [['role', 'My role'], ['hint', 'My hint'], ['saw', 'I saw'], ['accuse', 'Suspect']];
    let fields = '';
    if (ui.composer === 'role') fields = `<select id="cp-role" aria-label="Role">${Object.entries(ROLES).map(([k, r]) => `<option value="${k}" ${prev.role === k ? 'selected' : ''}>${r.icon} I'm the ${r.name}</option>`).join('')}</select>`;
    else if (ui.composer === 'hint') {
      const sel = (idn, cur, blank) => `<select id="${idn}" aria-label="Critter">${blank ? '<option value="">—</option>' : ''}${playerOpts(others, cur)}</select>`;
      fields = `${sel('cp-t1', prev.t1, false)}${sel('cp-t2', prev.t2 ?? '', true)}${sel('cp-t3', prev.t3 ?? '', true)}
      <select id="cp-result" aria-label="Result"><option value="sneak" ${prev.result === 'sneak' ? 'selected' : ''}>at least one is a Sneak</option><option value="clear" ${prev.result === 'clear' ? 'selected' : ''}>none of them are Sneaks</option></select>`;
    } else if (ui.composer === 'saw') fields = `<select id="cp-target" aria-label="Who">${playerOpts(others, prev.target)}</select>
      <span class="small">visited</span><select id="cp-at" aria-label="Whose house">${playerOpts(g.houses, prev.at)}</select><span class="small">'s house</span>`;
    else fields = `<select id="cp-target" aria-label="Suspect">${playerOpts(g.alive.filter((id) => id !== S.me), prev.target)}</select>`;
    const compKey = [ui.composer, others.join(), g.alive.join(), canPost, prev.target, S.players.map((p) => p.name).join()].join('|');
    if (ui.compKey !== compKey || !comp.firstChild) { ui.compKey = compKey; comp.innerHTML = `<div class="seg" role="tablist">${kinds.map(([k, l]) => `<button data-cp="${k}" class="${ui.composer === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="row">${fields}</div>
      <div class="row"><button class="btn small primary" data-post ${canPost ? '' : 'disabled'}>Post card</button>
      <span class="small muted">${canPost ? 'Cards read the same in every language.' : meAlive ? 'You can post cards from dawn until the vote ends.' : 'Wisps can read the Board but not post.'}</span></div>`; }
    const icon = (c) => ({ role: ROLES[c.role]?.icon, hint: c.result === 'sneak' ? '🚨' : '🔍', saw: '👀', accuse: '🧶' }[c.kind]);
    const names = (ids) => { const a = ids.map((x) => `<b>${nm(x)}</b>`); return a.length < 3 ? a.join(' and ') : `${a[0]}, ${a[1]}, and ${a[2]}`; };
    const text = (c) => {
      if (c.kind === 'role') return `I'm the <b>${ROLES[c.role].name}</b>.`;
      if (c.kind === 'hint') return c.result === 'sneak' ? `At least one of ${names(c.targets)} is a Sneak.` : `None of ${names(c.targets)} is a Sneak.`;
      if (c.kind === 'saw') return `I saw <b>${nm(c.target)}</b> visit <b>${nm(c.at)}</b>'s house.`;
      return `I suspect <b>${nm(c.target)}</b>.`;
    };
    const days = [...new Set(g.claims.map((c) => c.day))].sort((a, b) => b - a);
    $('#claim-list').innerHTML = days.map((d) => `<div class="day-head">Day ${d}</div>` + g.claims.filter((c) => c.day === d).reverse().map((c) => `
      <div class="claim ${d < g.day ? 'old' : ''}">${avatar(P(c.by), 'sm')}<div class="body"><b>${nm(c.by)}</b>${g.alive.includes(c.by) ? '' : ' ✨'}<br>${icon(c)} ${text(c)}</div>
      <div class="react"><button data-react="trust" data-id="${c.id}" class="${c.trust.includes(S.me) ? 'on' : ''}" aria-label="Trust">👍 ${c.trust.length}</button>
      <button data-react="doubt" data-id="${c.id}" class="${c.doubt.includes(S.me) ? 'on' : ''}" aria-label="Doubt">👎 ${c.doubt.length}</button></div></div>`).join('')).join('')
      || '<p class="muted small">No cards yet. Claim your role, share a result, or name a suspect.</p>';
  }
  function onBoardClick(e) {
    const cp = e.target.closest('[data-cp]');
    if (cp) { ui.composer = cp.dataset.cp; ui.compKey = null; renderBoard(); return; }
    if (e.target.closest('[data-post]')) {
      if (ui.composer === 'role') send({ t: 'claim', kind: 'role', role: $('#cp-role').value });
      else if (ui.composer === 'hint') send({ t: 'claim', kind: 'hint', targets: ['#cp-t1', '#cp-t2', '#cp-t3'].map((x) => $(x).value).filter(Boolean), result: $('#cp-result').value });
      else if (ui.composer === 'saw') send({ t: 'claim', kind: 'saw', target: $('#cp-target').value, at: $('#cp-at').value });
      else send({ t: 'claim', kind: 'accuse', target: $('#cp-target').value });
      sound('pop'); return;
    }
    const r = e.target.closest('[data-react]');
    if (r) {
      const c = S.game.claims.find((x) => String(x.id) === r.dataset.id);
      const on = c && c[r.dataset.react].includes(S.me);
      send({ t: 'react', id: Number(r.dataset.id), v: on ? null : r.dataset.react });
    }
  }
  function renderChat() {
    const g = S.game, meAlive = g.alive.includes(S.me), onTeam = ROLES[g.myRole].team === 'sneaks', over = g.phase === 'over';
    const chans = [['day', '🏡 Village']];
    if (onTeam || !meAlive || over) chans.push(['den', '🌑 Den']);
    if (!meAlive || over) chans.push(['wisp', '✨ Wisps']);
    if (!chans.some(([k]) => k === ui.chatCh)) ui.chatCh = chans[0][0];
    $('#chat-channels').innerHTML = chans.length > 1 ? chans.map(([k, l]) => `<button class="chip ${ui.chatCh === k ? 'on' : ''}" style="${ui.chatCh === k ? 'background:var(--honey);color:#2E3A2B' : ''}" data-ch="${k}">${l}</button>`).join('') : '';
    const list = $('#chat-list');
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    const msgs = g.chat[ui.chatCh] || [];
    list.innerHTML = msgs.filter((m) => !ui.muted.has(m.by)).map((m) => `<div class="msg">${avatar(P(m.by), 'xs')}<div><b>${nm(m.by)}</b> ${esc(m.text)}</div></div>`).join('')
      || `<p class="muted small">${ui.chatCh === 'den' ? 'Only the Sneak team can read this.' : ui.chatCh === 'wisp' ? 'Only Wisps can read this.' : 'Say hello. Chat is optional: the Board works in every language.'}</p>`;
    if (atBottom) list.scrollTop = list.scrollHeight;
    const canType = over || !meAlive || ui.chatCh === 'den' || g.phase !== 'night';
    const myChanOk = over ? ui.chatCh === 'day' : !meAlive ? ui.chatCh === 'wisp' : ui.chatCh !== 'wisp';
    $('#chat-input').disabled = !(canType && myChanOk);
    $('#chat-input').placeholder = !meAlive && !over ? 'Talk with the other Wisps…' : g.phase === 'night' && ui.chatCh === 'day' && !over ? 'The village is asleep. Chat opens at dawn.' : 'Say something…';
    if (!meAlive && !over && ui.chatCh !== 'wisp') $('#chat-input').placeholder = 'Wisps can only talk in the Wisps channel.';
    const total = g.chat.day.length + g.chat.den.length + g.chat.wisp.length;
    if (ui.tab === 'chat') ui.seenChat = total;
    $('#chat-dot').classList.toggle('hidden', ui.tab === 'chat' || total <= ui.seenChat);
  }
  function renderBehind() {
    const g = S.game;
    $('#tab-behind').innerHTML = [...g.deaths].reverse().map((d) => `<div class="behind"><div class="row">${avatar(P(d.id), 'sm')}<b>${nm(d.id)}</b>
      <span class="small muted">${d.how === 'pond' ? `sent into the Pond on day ${d.day}` : `spirited away on night ${d.day}`}</span></div>${notesHTML(d.notes)}</div>`).join('')
      || "<p class=\"muted small\">Nobody is gone yet. When a critter is eliminated, their role stays secret but their notepad shows up here.</p>";
  }
  function renderLog() {
    const g = S.game;
    $('#tab-log').innerHTML = `<h3>Only you can see</h3>${[...g.myLog].reverse().map((l) => `<div class="log-item private">${esc(l.text)}</div>`).join('')}
      <h3 style="margin-top:.6rem">Village log</h3>${[...g.log].reverse().map((l) => `<div class="log-item">${esc(l.text)}</div>`).join('')}`;
  }

  // ----- game over -----
  function showGameOver() {
    const g = S.game; if (!g || !g.over) return;
    const o = g.over, me = S.me, host = S.hostId === me;
    const won = o.winners.includes(me);
    const reveal = g.houses.map((id) => {
      const r = ROLES[o.roles[id]];
      return `<div class="reveal ${o.winners.includes(id) ? 'won' : ''}">${avatar(P(id), 'sm')}<div><b>${nm(id)}</b>${g.alive.includes(id) ? '' : ' ✨'}<br>${r.icon} ${r.name}${o.winners.includes(id) ? ' 🏆' : ''}</div></div>`;
    }).join('');
    const recap = o.history.map((h) => {
      const items = h.visits.map((v) => {
        const verb = { kill: '🌑 went after', check: '🦉 watched', protect: '🦔 protected', gossip: '🐇 watched', peek: 'peeked at' }[v.kind] || 'visited';
        return `<li>${nm(v.from)} ${verb} ${nm(v.to)}${v.hidden ? ' (underground 🕳️)' : ''}</li>`;
      }).join('');
      const extra = (h.meddles || []).map((m) => `<li>🎭 ${nm(m.by)} meddled with ${nm(m.target)}</li>`).join('')
        + (h.lit || []).map((x) => `<li>🏮 A lantern glowed at ${nm(x)}'s house</li>`).join('');
      return `<div class="recap-night"><b>Night ${h.night}</b>${h.kill ? ` · Sneaks targeted ${nm(h.kill)}${h.saved ? ' (saved!)' : ''}` : ''}
<ul>${items || '<li>Nobody went out.</li>'}${extra}</ul></div>`;
    }).join('');
    const m = modal(`<div class="gameover"><p class="winner">${o.winner === 'village' ? '🏡 The village wins!' : '🌑 The Sneaks win!'}</p>
      <p style="text-align:center">${won ? 'You won this one. Nicely played!' : 'Not your win this time. Read the recap to see how it happened.'}</p>
      <h3>Who was who</h3><div class="reveal-grid">${reveal}</div>
      <h3>What really happened</h3>${recap}
      <div class="row" style="justify-content:center;margin-top:1rem">
        ${host ? '<button class="btn primary" data-go="again">Play again</button>' : '<span class="muted">Waiting for the host to start a new round…</span>'}
        <button class="btn" data-go="map">View the map</button><button class="btn ghost" data-go="leave">Leave</button></div></div>`, 'wide');
    m.addEventListener('click', (e) => {
      const b = e.target.closest('[data-go]'); if (!b) return;
      if (b.dataset.go === 'again') send({ t: 'again' });
      if (b.dataset.go === 'leave') send({ t: 'leave' });
      closeModal();
    });
  }

  // ----- emotes -----
  function floatEmote(id, e) {
    const h = $(`.house[data-id="${id}"]`), layer = $('#floaters');
    if (!h || !layer) return;
    const f = document.createElement('div');
    f.className = 'floater'; f.textContent = e;
    f.style.left = h.style.left; f.style.top = h.style.top;
    layer.appendChild(f); setTimeout(() => f.remove(), 1700);
  }

  // ----- ticker: timers, countdowns, coach hints -----
  setInterval(() => {
    $$('[data-countdown]').forEach((el) => { const s = Math.max(0, Math.ceil((Number(el.dataset.countdown) - now()) / 1000)); el.textContent = `Starting in ${s}s`; });
    if (!S || !S.game) return;
    const g = S.game, t = $('#timer');
    if (g.phase === 'over' || !g.endsAt) { t.textContent = '—'; t.classList.remove('low'); return; }
    const s = Math.max(0, Math.ceil((g.endsAt - now()) / 1000));
    t.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    t.classList.toggle('low', s <= 10);
    const meAlive = g.alive.includes(S.me);
    if (g.phase === 'night' && meAlive && Date.now() - ui.phaseStart > 10000 && !g.mySneakVote && !g.myAction) hint(`night${g.day}`, 'tap a house on the map to use your ability.');
  }, 250);

  buildHome();
  connect();
})();
