import * as fs from 'node:fs';
import * as url from 'node:url';
import {
  SPOTS,
  MOLT_DURATION,
  MAX_RANK,
  spotById,
  tideState,
  tideHeight,
  tideAllowsSpot,
  predatorParams,
  predatorPresence,
  risk,
  thresholdForRank,
  isReady,
  createState,
  forage,
  canMolt,
  soft,
  moltExposure,
  threatsForRank,
  preyForRank,
  shareText,
  solverPolicy,
} from './crab.mjs';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond) {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(name);
    console.log(`FAIL: ${name}`);
  }
}

// 1. determinism: predator presence is a pure function of (spot, t, seed)
{
  const spot = SPOTS[0];
  let ok = true;
  for (let t = 0; t < 200; t++) {
    if (predatorPresence(spot, t, 42) !== predatorPresence(spot, t, 42)) ok = false;
  }
  check('predatorPresence is deterministic across repeated calls', ok);
}

// 2. determinism: forage is a pure function of (state, spot, t)
{
  const s0 = createState(7);
  const a = forage(s0, 'eelgrass', 3);
  const b = forage(s0, 'eelgrass', 3);
  check(
    'forage(state, spot, t) deterministic and non-mutating',
    a.growth === b.growth && a.scars === b.scars && s0.growth === 0,
  );
}

// 3. predator patterns are exactly periodic by construction
{
  let ok = true;
  for (const spot of SPOTS) {
    const { period } = predatorParams(spot, 99);
    for (let t = 0; t < 100; t++) {
      if (predatorPresence(spot, t, 99) !== predatorPresence(spot, t + period, 99)) ok = false;
    }
  }
  check('predator presence repeats exactly at its own patrol period', ok);
}

// 4. predator patterns are learnable: autocorrelation peaks at the true period
{
  let ok = true;
  for (const spot of SPOTS) {
    const { period, dutyCycle } = predatorParams(spot, 1234);
    if (dutyCycle <= 0 || dutyCycle >= 1) continue; // degenerate, skip
    const N = 400;
    const signal = [];
    for (let t = 0; t < N; t++) signal.push(predatorPresence(spot, t, 1234) ? 1 : 0);
    const mean = signal.reduce((a, b) => a + b, 0) / N;
    function autocorr(lag) {
      let num = 0;
      let den = 0;
      for (let i = 0; i < N - lag; i++) {
        num += (signal[i] - mean) * (signal[i + lag] - mean);
      }
      for (let i = 0; i < N; i++) den += (signal[i] - mean) ** 2;
      return den === 0 ? 0 : num / den;
    }
    let bestLag = 1;
    let bestScore = -Infinity;
    for (let lag = 1; lag <= 30; lag++) {
      const score = autocorr(lag);
      if (score > bestScore) {
        bestScore = score;
        bestLag = lag;
      }
    }
    if (bestLag % period !== 0) ok = false;
  }
  check('autocorrelation of predator presence peaks at (a multiple of) the true patrol period', ok);
}

// 5. safety function matches occlusion geometry exactly
{
  let ok = true;
  for (const spot of SPOTS) {
    let sawPresent = false;
    let sawAbsent = false;
    for (let t = 0; t < 200 && (!sawPresent || !sawAbsent); t++) {
      const present = predatorPresence(spot, t, 55);
      const r = risk(spot, t, 55);
      if (present) {
        sawPresent = true;
        if (Math.abs(r - (1 - spot.occlusion)) > 1e-9) ok = false;
      } else {
        sawAbsent = true;
        if (Math.abs(r - (1 - spot.occlusion) * 0.05) > 1e-9) ok = false;
      }
    }
  }
  check('risk() matches occlusion geometry exactly for present/absent predator cases', ok);
}

// 6. molt only allowed when ready
{
  const s0 = createState(3);
  const gate = canMolt(s0, 'eelgrass', 0);
  const result = soft(s0, 'eelgrass', 0);
  check(
    'canMolt refuses and soft() refuses without state change when not ready',
    gate.ok === false && gate.reason === 'not_ready' && result.ok === false && result.state === s0,
  );
}
{
  let s = createState(3);
  while (!isReady(s)) s = forage(s, 'eelgrass', 0);
  const gate = canMolt(s, 'eelgrass', 0);
  check('canMolt allows once readiness threshold is met (tide permitting)', gate.ok === true);
}

// 7. soft-window mortality is deterministic given spot/time and matches the exposure model
{
  let s = createState(11);
  while (!isReady(s)) s = forage(s, 'eelgrass', 0);
  const t = 100;
  const expectedExposure = moltExposure(s, 'sandy', t);
  const r1 = soft(s, 'sandy', t);
  const r2 = soft(s, 'sandy', t);
  check(
    'soft() exposure matches sum-of-risk model and is repeatable for identical inputs',
    Math.abs(r1.exposure - expectedExposure) < 1e-9 &&
      r1.survived === r2.survived &&
      Math.abs(r1.effectiveExposure - r2.effectiveExposure) < 1e-9,
  );
}

// 8. size gates prey/threat tables: monotonic, real gating
{
  const low = threatsForRank(0);
  const high = threatsForRank(7);
  const gullGone = low.includes('gull') && !high.includes('gull');
  const monotoneShrink = high.length <= low.length;
  const preyChanges = preyForRank(0).join(',') !== preyForRank(7).join(',');
  check(
    'threat table shrinks with size and prey table changes with size',
    gullGone && monotoneShrink && preyChanges,
  );
}

// 9. 8-molt run is solvable by the solver policy across >=50 seeds, deterministically
{
  let allSurvived = true;
  let allEightMolts = true;
  for (let seed = 0; seed < 60; seed++) {
    const final = solverPolicy(seed);
    if (!final.alive) allSurvived = false;
    if (final.molts !== MAX_RANK) allEightMolts = false;
  }
  check('solver policy survives to 8 molts (king of the pool) across 60 seeds', allSurvived && allEightMolts);
}

// 10. solver policy is fully deterministic given the same seed
{
  const a = solverPolicy(777);
  const b = solverPolicy(777);
  check(
    'solverPolicy(seed) is deterministic',
    JSON.stringify(a) === JSON.stringify(b),
  );
}

// 11. bounds: no NaN, values stay in sane ranges over many seeds/ticks
{
  let ok = true;
  for (let t = 0; t < 500; t++) {
    const h = tideHeight(t);
    if (Number.isNaN(h) || h < -1e-9 || h > 1 + 1e-9) ok = false;
    for (const spot of SPOTS) {
      const r = risk(spot, t, 321);
      if (Number.isNaN(r) || r < 0 || r > 1) ok = false;
    }
  }
  check('tideHeight and risk stay within bounds, no NaN, over 500 ticks x all spots', ok);
}

// 12. rank/growth/scars never go negative across a solver run's log
{
  const final = solverPolicy(5);
  let ok = final.rank >= 0 && final.growth >= 0 && final.scars >= 0;
  check('rank, growth and scars never negative after a full run', ok);
}

// 13. tideAllowsSpot correctness for tide-restricted spots
{
  const mussel = spotById('mussel');
  const ledge = spotById('ledge');
  let ok = true;
  for (let t = 0; t < TIDE_PERIOD_CHECK(); t++) {
    const st = tideState(t);
    const musselOk = tideAllowsSpot(mussel, t);
    const ledgeOk = tideAllowsSpot(ledge, t);
    if (musselOk !== (st === 'rising' || st === 'high')) ok = false;
    if (ledgeOk !== (st === 'low' || st === 'falling')) ok = false;
  }
  check('tideAllowsSpot correctly gates tide-restricted spots', ok);
  function TIDE_PERIOD_CHECK() {
    return 24;
  }
}

// 14. threshold scaling is strictly increasing with rank
{
  let ok = true;
  for (let r = 0; r < 8; r++) {
    if (thresholdForRank(r + 1) <= thresholdForRank(r)) ok = false;
  }
  check('growth threshold strictly increases with rank', ok);
}

// 15. spot data integrity: unique ids, occlusion in [0,1]
{
  const ids = SPOTS.map((s) => s.id);
  const uniqueIds = new Set(ids).size === ids.length;
  const occOk = SPOTS.every((s) => s.occlusion >= 0 && s.occlusion <= 1);
  check('spot ids are unique and occlusion values are within [0,1]', uniqueIds && occOk);
}

// 16. predator params vary meaningfully across spots for a fixed seed
{
  const seed = 2026;
  const params = SPOTS.map((s) => predatorParams(s, seed));
  const allSame = params.every(
    (p) => p.period === params[0].period && p.phase === params[0].phase,
  );
  check('predatorParams differ across spots for a fixed seed (per-spot seeding works)', !allSame);
}

// 17. share text carries the expected structural elements, no bare emoji-as-meaning
{
  const s = { ...createState(1), molts: 4, alive: true };
  const text = shareText(s, 'eelgrass', 12);
  const hasCrab = text.includes('\u{1F980}');
  const hasWords = text.includes('MOLT') && text.includes('shell');
  const hasURL = text.includes('http://moltgame.defimagic.io');
  check('shareText produces the expected structured line with words carrying the meaning', hasCrab && hasWords && hasURL);
}

// 18. source-scan: pure core never calls Math.random() or Date.now() in logic paths
{
  const src = fs.readFileSync(url.fileURLToPath(new URL('./crab.mjs', import.meta.url)), 'utf8');
  const noRandom = !src.includes('Math.random(');
  const noDateNow = !src.includes('Date.now(');
  check('crab.mjs source contains no Math.random() or Date.now() calls', noRandom && noDateNow);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('Failures:', failures.join('; '));
  process.exit(1);
} else {
  process.exit(0);
}
