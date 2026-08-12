// MOLT — pure core. No DOM, no WebAudio, no wall-clock reads, no unseeded RNG.
// Every stateful function is pure: (state, ...) -> new state or descriptor.

export const TIDE_PERIOD = 24;
export const MOLT_DURATION = 8;
export const READY_BASE = 10;
export const SCAR_FACTOR = 0.15;
export const SCAR_RISK_THRESHOLD = 0.3;
export const SURVIVAL_LIMIT = 1.6;
export const FORAGE_YIELD = 4;
export const FORAGE_YIELD_SCARED = 2;
export const MAX_RANK = 8;

export const SPOTS = [
  { id: 'eelgrass', name: 'the eelgrass drift', occlusion: 0.82, tideAccess: ['any'] },
  { id: 'barnacle', name: 'the barnacle crack', occlusion: 0.55, tideAccess: ['any'] },
  { id: 'mussel', name: 'the mussel bed', occlusion: 0.65, tideAccess: ['rising', 'high'] },
  { id: 'sandy', name: 'the sandy hollow', occlusion: 0.35, tideAccess: ['any'] },
  { id: 'ledge', name: 'under the ledge', occlusion: 0.9, tideAccess: ['low', 'falling'] },
];

const RANK_NAMES = [
  'sliver', 'pea', 'thumbnail', 'coin', 'walnut', 'fist', 'palm', 'king of the pool',
];

const PATROL_PERIODS = [6, 8, 9, 12, 16];

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function spotById(id) {
  return SPOTS.find((s) => s.id === id) || null;
}

export function rankName(rank) {
  return RANK_NAMES[Math.min(rank, RANK_NAMES.length - 1)];
}

// --- tide ---

export function tidePhase(t) {
  return (((t % TIDE_PERIOD) + TIDE_PERIOD) % TIDE_PERIOD) / TIDE_PERIOD;
}

export function tideHeight(t) {
  const p = tidePhase(t);
  return (1 - Math.cos(2 * Math.PI * p)) / 2;
}

export function tideState(t) {
  const p = tidePhase(t);
  if (p < 0.04 || p > 0.96) return 'low';
  if (p < 0.46) return 'rising';
  if (p <= 0.54) return 'high';
  return 'falling';
}

export function tideLabel(t) {
  const s = tideState(t);
  if (s === 'low' || s === 'high') return 'slack tide';
  if (s === 'rising') return 'a rising tide';
  return 'a falling tide';
}

export function tideAllowsSpot(spot, t) {
  if (spot.tideAccess.includes('any')) return true;
  return spot.tideAccess.includes(tideState(t));
}

// --- predators ---

export function predatorParams(spot, seed) {
  const rng = mulberry32((seed ^ hashStr(spot.id)) >>> 0);
  const period = PATROL_PERIODS[Math.floor(rng() * PATROL_PERIODS.length)];
  const phase = Math.floor(rng() * period);
  const dutyCycle = 0.2 + rng() * 0.3;
  return { period, phase, dutyCycle };
}

export function predatorPresence(spot, t, seed) {
  const { period, phase, dutyCycle } = predatorParams(spot, seed);
  const pos = (((t + phase) % period) + period) % period;
  return pos < dutyCycle * period;
}

export function risk(spot, t, seed) {
  const present = predatorPresence(spot, t, seed);
  const base = 1 - spot.occlusion;
  return present ? base : base * 0.05;
}

export function safety(spot, t, seed) {
  return 1 - risk(spot, t, seed);
}

// --- readiness ---

export function thresholdForRank(rank) {
  return READY_BASE * (rank + 1);
}

export function isReady(state) {
  return state.growth >= thresholdForRank(state.rank);
}

// --- state ---

export function createState(seed) {
  return {
    seed,
    rank: 0,
    growth: 0,
    scars: 0,
    alive: true,
    molts: 0,
    log: [],
  };
}

export function forage(state, spotId, t) {
  if (!state.alive) return state;
  const spot = spotById(spotId);
  if (!spot) return state;
  const r = risk(spot, t, state.seed);
  const scared = r > SCAR_RISK_THRESHOLD;
  const yieldAmt = scared ? FORAGE_YIELD_SCARED : FORAGE_YIELD;
  return {
    ...state,
    growth: state.growth + yieldAmt,
    scars: state.scars + (scared ? 1 : 0),
    log: [...state.log, { type: 'forage', t, spotId, scared, yieldAmt }],
  };
}

export function scout(state, spotId, t) {
  if (!state.alive) return { present: false, state };
  const spot = spotById(spotId);
  if (!spot) return { present: false, state };
  const present = predatorPresence(spot, t, state.seed);
  return {
    present,
    state: { ...state, log: [...state.log, { type: 'scout', t, spotId, present }] },
  };
}

export function canMolt(state, spotId, t) {
  if (!state.alive) return { ok: false, reason: 'dead' };
  const spot = spotById(spotId);
  if (!spot) return { ok: false, reason: 'no_spot' };
  if (!isReady(state)) return { ok: false, reason: 'not_ready' };
  if (!tideAllowsSpot(spot, t)) return { ok: false, reason: 'tide_blocked' };
  return { ok: true };
}

export function moltExposure(state, spotId, t) {
  const spot = spotById(spotId);
  let exposure = 0;
  for (let i = 0; i < MOLT_DURATION; i++) exposure += risk(spot, t + i, state.seed);
  return exposure;
}

export function soft(state, spotId, t) {
  const gate = canMolt(state, spotId, t);
  if (!gate.ok) return { ok: false, reason: gate.reason, state };
  const exposure = moltExposure(state, spotId, t);
  const effectiveExposure = exposure * (1 + state.scars * SCAR_FACTOR);
  const survived = effectiveExposure <= SURVIVAL_LIMIT;
  const newState = {
    ...state,
    alive: survived,
    rank: survived ? state.rank + 1 : state.rank,
    growth: survived ? 0 : state.growth,
    scars: survived ? 0 : state.scars,
    molts: survived ? state.molts + 1 : state.molts,
    log: [...state.log, { type: 'molt', t, spotId, exposure, effectiveExposure, survived }],
  };
  return { ok: true, survived, exposure, effectiveExposure, state: newState };
}

// --- size gates ---

export function threatsForRank(rank) {
  if (rank <= 1) return ['gull', 'heron', 'rockfish', 'otter', 'big crab'];
  if (rank <= 3) return ['gull', 'heron', 'otter', 'big crab'];
  if (rank <= 5) return ['heron', 'big crab'];
  return ['big crab'];
}

export function preyForRank(rank) {
  if (rank <= 1) return ['diatoms', 'tiny worms'];
  if (rank <= 3) return ['barnacle spat', 'sand fleas', 'small mussels'];
  if (rank <= 5) return ['young whelks', 'shore shrimp'];
  return ['crab molt scraps', 'young whelks', 'shore shrimp', 'small mussels'];
}

// --- share ---

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'];

export function shareText(state, spotId, t, url = 'http://moltgame.defimagic.io') {
  const spot = spotById(spotId);
  const ord = ORDINALS[Math.max(0, Math.min(state.molts - 1, ORDINALS.length - 1))] || 'first';
  const verdict = state.alive ? 'and lived' : 'and did not surface';
  const spotName = spot ? spot.name : 'the drift';
  return `\u{1F980} MOLT · ${ord} shell · I chose ${spotName} at ${tideLabel(t)} ${verdict} · ${url}`;
}

// --- solver policy (proves an 8-molt run is reachable, deterministically) ---

export function solverPolicy(seed, opts = {}) {
  const maxTicks = opts.maxTicks || 6000;
  const lookahead = opts.lookahead || 40;
  let state = createState(seed);
  let t = 0;
  while (state.alive && state.molts < MAX_RANK && t < maxTicks) {
    if (!isReady(state)) {
      const candidates = SPOTS.filter((sp) => tideAllowsSpot(sp, t));
      let best = candidates[0];
      for (const sp of candidates) {
        if (risk(sp, t, seed) < risk(best, t, seed)) best = sp;
      }
      if (!best) {
        t += 1;
        continue;
      }
      state = forage(state, best.id, t);
      t += 1;
    } else {
      let bestChoice = null;
      for (let dt = 0; dt < lookahead; dt++) {
        const tt = t + dt;
        for (const sp of SPOTS) {
          const gate = canMolt(state, sp.id, tt);
          if (!gate.ok) continue;
          const exposure = moltExposure(state, sp.id, tt);
          const eff = exposure * (1 + state.scars * SCAR_FACTOR);
          if (!bestChoice || eff < bestChoice.eff) bestChoice = { tt, spotId: sp.id, eff };
        }
      }
      if (!bestChoice) {
        t += 1;
        continue;
      }
      const result = soft(state, bestChoice.spotId, bestChoice.tt);
      state = result.state;
      t = bestChoice.tt + MOLT_DURATION;
    }
  }
  return state;
}
