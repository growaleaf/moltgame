import * as Crab from './crab.mjs';

const STORAGE_KEY = 'molt_v1';
const SOFT_REAL_SECONDS = 12; // cosmetic pacing for the "sixty defenseless seconds"

const SOFT_LINES = {
  eelgrass: 'You wedge into the eelgrass drift and go still.',
  barnacle: 'You back into the barnacle crack, shell already splitting.',
  mussel: 'You fold yourself between the mussels and wait.',
  sandy: 'You dig shallow into the sandy hollow. Nowhere else to be now.',
  ledge: 'You slide under the ledge, out of the light.',
};

function loadRandomSeed() {
  return Math.floor(Math.random() * 2 ** 31);
}

function safeLoad() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.seed !== 'number') return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

function safeSave(data) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    // ignore — storage may be unavailable (private mode, quota)
  }
}

function safeClear() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    // ignore
  }
}

function freshGame(seed) {
  return {
    seed,
    core: Crab.createState(seed),
    t: 0,
    scoutMemory: {}, // spotId -> { t, present }
  };
}

const app = {
  game: freshGame(loadRandomSeed()),
  screen: 'title',
  pendingMolt: null, // { spotId, t, result }
  softAnim: { running: false, startedAt: 0, remaining: SOFT_REAL_SECONDS },
};

// --- persistence ---

function persist() {
  safeSave({ seed: app.game.seed, core: app.game.core, t: app.game.t, scoutMemory: app.game.scoutMemory });
}

function tryResume() {
  const saved = safeLoad();
  if (saved && saved.core && saved.core.alive) {
    app.game = { seed: saved.seed, core: saved.core, t: saved.t || 0, scoutMemory: saved.scoutMemory || {} };
  }
}

// --- screen management ---

const SCREEN_IDS = ['title', 'howto', 'play', 'soft', 'survived', 'king', 'died'];

function showScreen(name) {
  app.screen = name;
  for (const id of SCREEN_IDS) {
    const el = document.getElementById(`screen-${id}`);
    if (!el) continue;
    el.classList.toggle('active', id === name);
  }
  render();
}

// --- rendering ---

function el(id) {
  return document.getElementById(id);
}

function drawCrabSilhouette(ctx, w, h, scale = 1, tone = '#d9e6f2') {
  ctx.save();
  ctx.translate(w / 2, h / 2 + 10);
  ctx.scale(scale, scale);
  ctx.fillStyle = tone;
  ctx.globalAlpha = 0.92;
  // body
  ctx.beginPath();
  ctx.ellipse(0, 0, 34, 22, 0, 0, Math.PI * 2);
  ctx.fill();
  // eyes
  ctx.beginPath();
  ctx.ellipse(-10, -20, 3, 5, 0, 0, Math.PI * 2);
  ctx.ellipse(10, -20, 3, 5, 0, 0, Math.PI * 2);
  ctx.fill();
  // legs
  ctx.strokeStyle = tone;
  ctx.lineWidth = 3;
  for (const side of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const x0 = side * 28;
      const y0 = -6 + i * 9;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x0 + side * 16, y0 + 10);
      ctx.stroke();
    }
  }
  // claws
  ctx.beginPath();
  ctx.ellipse(-38, -4, 8, 6, 0.4, 0, Math.PI * 2);
  ctx.ellipse(38, -4, 8, 6, -0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function renderTitleCanvas() {
  const c = el('titleCanvas');
  if (!c) return;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  drawCrabSilhouette(ctx, c.width, c.height, 1.3);
}

function renderStage() {
  const c = el('stage');
  if (!c) return;
  const ctx = c.getContext('2d');
  const w = c.width;
  const h = c.height;
  ctx.clearRect(0, 0, w, h);

  const height01 = Crab.tideHeight(app.game.t);
  const waterY = h - 20 - height01 * (h - 60);

  // sky/rock gradient already set via CSS background; draw water
  ctx.fillStyle = 'rgba(90,140,180,0.22)';
  ctx.beginPath();
  ctx.moveTo(0, waterY);
  for (let x = 0; x <= w; x += 10) {
    const wobble = Math.sin(x * 0.05 + app.game.t) * 3;
    ctx.lineTo(x, waterY + wobble);
  }
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fill();

  // moon
  ctx.fillStyle = 'rgba(217,230,242,0.85)';
  ctx.beginPath();
  ctx.arc(w - 34, 30, 14, 0, Math.PI * 2);
  ctx.fill();

  // spot markers
  const n = Crab.SPOTS.length;
  Crab.SPOTS.forEach((spot, i) => {
    const x = ((i + 0.5) / n) * w;
    const y = h - 34;
    const mem = app.game.scoutMemory[spot.id];
    const known = mem && mem.t === app.game.t;
    let color = 'rgba(217,230,242,0.35)';
    if (known) color = mem.present ? '#d97b6c' : '#7fb8a3';
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fill();
  });

  // crab position (bobbing near center-bottom)
  drawCrabSilhouette(ctx, w / 2, h - 44, 0.55 + app.game.core.rank * 0.04);
}

function spotStatusLabel(spot) {
  const mem = app.game.scoutMemory[spot.id];
  if (!mem || mem.t !== app.game.t) return { text: 'unscouted', cls: 'unknown' };
  return mem.present ? { text: 'hunter watching', cls: 'present' } : { text: 'clear just now', cls: 'clear' };
}

function renderPlayScreen() {
  const { core, t } = app.game;
  el('rankLabel').textContent = Crab.rankName(core.rank);
  el('moltLabel').textContent = `shell ${core.molts + 1} of ${Crab.MAX_RANK}`;
  el('tideLabel').textContent = Crab.tideLabel(t).replace(/^a /, '').replace(/^slack/, 'slack');
  el('tickLabel').textContent = `tide: ${Crab.tideState(t)}`;

  const threshold = Crab.thresholdForRank(core.rank);
  el('growthNum').textContent = `${core.growth} / ${threshold}`;
  el('growthBar').style.width = `${Math.min(100, (core.growth / threshold) * 100)}%`;
  el('scarsNum').textContent = String(core.scars);

  const list = el('spotsList');
  list.innerHTML = '';
  for (const spot of Crab.SPOTS) {
    const allowed = Crab.tideAllowsSpot(spot, t);
    const status = spotStatusLabel(spot);
    const div = document.createElement('div');
    div.className = `spot${allowed ? '' : ' blocked'}`;
    div.innerHTML = `
      <div class="name">${spot.name}</div>
      <div class="sub">${allowed ? 'reachable now' : `needs ${spot.tideAccess.join(' or ')} tide`}</div>
      <span class="sign ${status.cls}">${status.text}</span>
      <div class="spotactions"></div>
    `;
    const actions = div.querySelector('.spotactions');

    const forageBtn = document.createElement('button');
    forageBtn.className = 'btn';
    forageBtn.textContent = 'Forage';
    forageBtn.disabled = !allowed || !core.alive;
    forageBtn.onclick = () => doForage(spot.id);

    const scoutBtn = document.createElement('button');
    scoutBtn.className = 'btn ghost';
    scoutBtn.textContent = 'Scout';
    scoutBtn.disabled = !core.alive;
    scoutBtn.onclick = () => doScout(spot.id);

    actions.appendChild(forageBtn);
    actions.appendChild(scoutBtn);

    if (Crab.isReady(core)) {
      const moltBtn = document.createElement('button');
      moltBtn.className = 'btn primary';
      moltBtn.textContent = 'Molt here';
      moltBtn.disabled = !allowed;
      moltBtn.onclick = () => doMolt(spot.id);
      actions.appendChild(moltBtn);
    }
    list.appendChild(div);
  }

  const moltBtn = el('btn-molt');
  if (Crab.isReady(core)) {
    moltBtn.textContent = 'Ready to molt — pick a hideout above';
    moltBtn.disabled = true;
  } else {
    moltBtn.textContent = `Not ready — grow ${threshold - core.growth} more`;
    moltBtn.disabled = true;
  }

  renderStage();
}

function render() {
  if (app.screen === 'title') renderTitleCanvas();
  if (app.screen === 'play') renderPlayScreen();
}

// --- actions ---

function doForage(spotId) {
  if (!app.game.core.alive) return;
  app.game.core = Crab.forage(app.game.core, spotId, app.game.t);
  app.game.t += 1;
  persist();
  render();
}

function doScout(spotId) {
  if (!app.game.core.alive) return;
  const { present, state } = Crab.scout(app.game.core, spotId, app.game.t);
  app.game.core = state;
  app.game.scoutMemory[spotId] = { t: app.game.t, present };
  app.game.t += 1;
  persist();
  render();
}

function doWait() {
  if (!app.game.core.alive) return;
  app.game.t += 1;
  persist();
  render();
}

function doMolt(spotId) {
  const gate = Crab.canMolt(app.game.core, spotId, app.game.t);
  if (!gate.ok) return;
  const result = Crab.soft(app.game.core, spotId, app.game.t);
  app.pendingMolt = { spotId, t: app.game.t, result };
  el('softText').textContent = SOFT_LINES[spotId] || 'You go still and wait.';
  el('softSub').textContent = 'the old shell is already cracking';
  el('softCountdown').textContent = String(SOFT_REAL_SECONDS);
  showScreen('soft');
  startSoftAnimation();
}

function resolveMolt() {
  const { result, spotId, t } = app.pendingMolt;
  app.game.core = result.state;
  app.game.t = t + Crab.MOLT_DURATION;
  persist();

  if (!result.survived) {
    const spot = Crab.spotById(spotId);
    const spotName = spot ? spot.name : 'that hideout';
    const priorMolts = app.game.core.molts > 0 ? ` You made it ${app.game.core.molts} shells first.` : '';
    el('diedLine').textContent = `${spotName} wasn't enough, not at ${Crab.tideLabel(t)}.${priorMolts}`;
    showScreen('died');
    safeClear();
    return;
  }

  if (app.game.core.molts >= Crab.MAX_RANK) {
    el('shareTextKing').textContent = Crab.shareText(app.game.core, spotId, t);
    showScreen('king');
    safeClear();
    return;
  }

  el('survivedTitle').textContent = `You held. ${Crab.rankName(app.game.core.rank)}, now.`;
  el('survivedRank').textContent = app.game.core.rank;
  el('survivedMolts').textContent = app.game.core.molts;
  el('shareText').textContent = Crab.shareText(app.game.core, spotId, t);
  showScreen('survived');
}

// --- soft-window cosmetic countdown (outcome already decided; this is pacing only) ---

function startSoftAnimation() {
  app.softAnim.running = true;
  app.softAnim.remaining = SOFT_REAL_SECONDS;
  app.softAnim.lastNow = null;
  requestAnimationFrame(tick);
}

function step(now) {
  if (!app.softAnim.running) return;
  if (app.softAnim.lastNow == null) app.softAnim.lastNow = now;
  const dt = (now - app.softAnim.lastNow) / 1000;
  app.softAnim.lastNow = now;
  app.softAnim.remaining -= dt;
  const shown = Math.max(0, Math.ceil(app.softAnim.remaining));
  const cd = el('softCountdown');
  if (cd) cd.textContent = String(shown);
  if (app.softAnim.remaining <= 0) {
    app.softAnim.running = false;
    resolveMolt();
    return;
  }
}

function tick(now) {
  step(now);
  if (app.softAnim.running) requestAnimationFrame(tick);
}

function skipSoft() {
  if (!app.softAnim.running) return;
  app.softAnim.running = false;
  resolveMolt();
}

function restart() {
  app.game = freshGame(loadRandomSeed());
  app.pendingMolt = null;
  safeClear();
  showScreen('play');
}

// --- wiring ---

function wire() {
  el('btn-play').onclick = () => {
    tryResume();
    showScreen('play');
  };
  el('btn-howto').onclick = () => showScreen('howto');
  el('btn-howto-back').onclick = () => showScreen('title');
  el('btn-wait').onclick = doWait;
  el('btn-restart-inline').onclick = restart;
  el('btn-continue').onclick = () => showScreen('play');
  el('btn-restart-king').onclick = restart;
  el('btn-restart-died').onclick = restart;
}

wire();
showScreen('title');

// --- dev hook: ?dev=1 exposes window.__g to script every screen without a human ---

if (typeof location !== 'undefined' && /(?:^|[?&])dev=1(?:&|$)/.test(location.search)) {
  window.__g = {
    getState: () => JSON.parse(JSON.stringify({ screen: app.screen, game: app.game, pendingMolt: app.pendingMolt })),
    goTo: (name) => showScreen(name),
    forage: (spotId) => doForage(spotId),
    scout: (spotId) => doScout(spotId),
    wait: () => doWait(),
    molt: (spotId) => doMolt(spotId),
    skipSoft: () => skipSoft(),
    step: (now) => step(now),
    restart: () => restart(),
    Crab,
  };
}
