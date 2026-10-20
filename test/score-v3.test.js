import test from "node:test";
import assert from "node:assert/strict";
import {
  FLOAT_SCORE_V3_VERSION,
  computeFloatScoreV3FromTrace,
  detectClickerMs,
  shotV3Score,
  v3ModeForShot,
  v3ScoreFromMetrics,
} from "../app/telemetry/score.js";

const RATE = 208;
const DT_US = Math.round(1e6 / RATE);

function makeTrace({
  seconds = 3,
  holdNoise = 0,
  holdDrift = 0,
  releaseTorque = 0,
  followNoise = 0,
} = {}) {
  const releaseIndex = Math.round(1.5 * RATE);
  const points = [];
  for (let i = 0; i < Math.round(seconds * RATE); i += 1) {
    const tUs = (i - releaseIndex) * DT_US;
    const t = tUs / 1e6;
    const rel = i - releaseIndex;
    const hold = rel < 0;
    let roll = hold ? holdDrift * t : 0;
    let pitch = 0;
    if (hold) {
      roll += holdNoise * Math.sin(i * 0.7);
      pitch += holdNoise * Math.cos(i * 0.53);
    }
    if (rel >= -3 && rel <= 6) roll += releaseTorque;
    if (!hold && followNoise) {
      roll += followNoise * Math.sin(i * 0.4);
      pitch += followNoise * 0.5 * Math.sin(i * 0.31);
    }
    points.push({ tUs, roll, pitch, yaw: 0 });
  }
  return points;
}

function makeMic(clickMs) {
  const series = [];
  for (let t = -1500; t <= 300; t += 1) {
    let amp = 0;
    if (clickMs != null && Math.abs(t - clickMs) < 2) amp = 120;
    else if (clickMs != null && t > clickMs && t < clickMs + 6) amp = 60;
    series.push({ tUs: t * 1000, micAmp: amp });
  }
  return series;
}

test("v3 returns a flat-top score for a perfectly still hold", () => {
  const result = computeFloatScoreV3FromTrace(makeTrace(), { releaseMode: "trainer" });
  assert.equal(result.version, FLOAT_SCORE_V3_VERSION);
  assert.ok(result.metrics.holdSway < 1e-6);
  assert.ok(result.metrics.aimDrift < 1e-6);
  assert.ok(result.formScore >= 99);
});

test("more hold noise and drift lower the v3 score", () => {
  const steady = computeFloatScoreV3FromTrace(makeTrace(), { releaseMode: "trainer" });
  const noisy = computeFloatScoreV3FromTrace(makeTrace({ holdNoise: 1.2 }), { releaseMode: "trainer" });
  const drifting = computeFloatScoreV3FromTrace(makeTrace({ holdDrift: 6 }), { releaseMode: "trainer" });
  assert.ok(noisy.metrics.holdSway > 0.5);
  assert.ok(drifting.metrics.aimDrift > 4.5);
  assert.ok(noisy.formScore < steady.formScore);
  assert.ok(drifting.formScore < steady.formScore);
});

test("release torque and follow smoothness are measured in their own windows", () => {
  const torqued = computeFloatScoreV3FromTrace(makeTrace({ releaseTorque: 2 }), { releaseMode: "bow" });
  assert.ok(Math.abs(torqued.metrics.releaseTorque - 2) < 0.2);
  const shakyFollow = computeFloatScoreV3FromTrace(makeTrace({ followNoise: 1.5 }), { releaseMode: "bow" });
  assert.ok(shakyFollow.metrics.followSmooth > 0.4);
  assert.ok(shakyFollow.formScore < 100);
});

test("the trainer mode drops release torque from the composite", () => {
  const trace = makeTrace({ releaseTorque: 2.5 });
  const bow = computeFloatScoreV3FromTrace(trace, { releaseMode: "bow" });
  const trainer = computeFloatScoreV3FromTrace(trace, { releaseMode: "trainer" });
  assert.notEqual(bow.formScore, trainer.formScore);
  assert.equal(trainer.components.releaseTorque != null, true);
  // releaseTorque still measured, just unweighted
  assert.ok(Math.abs(trainer.metrics.releaseTorque - 2.5) < 0.3);
});

test("clicker detection finds a click at -250 ms and stays silent without one", () => {
  const click = detectClickerMs(makeMic(-250));
  assert.ok(click);
  assert.ok(Math.abs(click.mcrMs - 250) <= 8, `got ${click.mcrMs}`);
  assert.equal(detectClickerMs(makeMic(null)), null);
  assert.equal(detectClickerMs([]), null);
});

test("trainer mode records the clicker timing while bow mode does not", () => {
  const trace = makeTrace();
  const trainer = computeFloatScoreV3FromTrace(trace, { releaseMode: "trainer", micSeries: makeMic(-250) });
  const bow = computeFloatScoreV3FromTrace(trace, { releaseMode: "bow", micSeries: makeMic(-250) });
  assert.ok(Math.abs(trainer.metrics.mcrMs - 250) <= 8);
  assert.equal(bow.metrics.mcrMs, null);
});

test("legacy trainer captures are inferred from a low peak", () => {
  assert.equal(v3ModeForShot({ peak_g: 3.2 }), "trainer");
  assert.equal(v3ModeForShot({ peak_g: 16 }), "bow");
  assert.equal(v3ModeForShot({ release_mode: "trainer", peak_g: 16 }), "trainer");
  assert.equal(v3ModeForShot({ release_mode: "bow", peak_g: 3 }), "bow");
});

test("stored metrics score consistently and stay versioned", () => {
  const stored = {
    v3_version: FLOAT_SCORE_V3_VERSION,
    v3_mode: "trainer",
    hold_sway: 0.35,
    aim_drift: 2.19,
    release_torque: 0.63,
    follow_smooth: 0.43,
  };
  const scored = shotV3Score(stored);
  assert.ok(scored.formScore > 80 && scored.formScore <= 100);
  assert.equal(shotV3Score({ ...stored, v3_version: "openfloat-float-score-v1" }), null);
  assert.equal(shotV3Score({ v3_version: FLOAT_SCORE_V3_VERSION }), null);
});

test("v3 scoring is deterministic and clamps invalid input", () => {
  const trace = makeTrace({ holdNoise: 0.8, holdDrift: 3 });
  const a = computeFloatScoreV3FromTrace(trace, { releaseMode: "trainer" });
  const b = computeFloatScoreV3FromTrace(trace, { releaseMode: "trainer" });
  assert.deepEqual(a, b);
  assert.equal(computeFloatScoreV3FromTrace([], { releaseMode: "trainer" }).formScore, null);
  assert.equal(v3ScoreFromMetrics({}, "trainer").formScore, null);
});


function makeTipTrace(tipDeg = -20) {
  const releaseIndex = Math.round(1.5 * RATE);
  const points = [];
  for (let i = 0; i < Math.round(3 * RATE); i += 1) {
    const tUs = (i - releaseIndex) * DT_US;
    let pitch = 0;
    if (i > releaseIndex + 20) {
      const progress = Math.min(1, (i - releaseIndex - 20) / 84);
      pitch = tipDeg * progress;
    }
    points.push({ tUs, roll: 0, pitch, yaw: 0 });
  }
  return points;
}

test("bow tip reports the forward pitch roll as a diagnostic, not a score", () => {
  const result = computeFloatScoreV3FromTrace(makeTipTrace(-20), { releaseMode: "trainer" });
  assert.ok(Math.abs(result.metrics.bowTipDeg + 20) < 2, `tip ${result.metrics.bowTipDeg}`);
  assert.ok(result.metrics.bowTipMono >= 90, `mono ${result.metrics.bowTipMono}`);
  assert.ok(result.metrics.bowTipMs != null && result.metrics.bowTipMs > 200, `ms ${result.metrics.bowTipMs}`);
  assert.ok(result.metrics.bowTipRate > 40, `rate ${result.metrics.bowTipRate}`);
  // The smooth tip is removed by the follow-through detrend, so the composite
  // stays high: bow tip is reported, not scored.
  assert.ok(result.formScore >= 95, `score ${result.formScore}`);
});
