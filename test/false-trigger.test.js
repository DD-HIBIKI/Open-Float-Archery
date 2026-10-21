import test from "node:test";
import assert from "node:assert/strict";
import {
  FALSE_TRIGGER_PEAK_G,
  LOW_THRESHOLD_G,
  TRAINER_THRESHOLD_G,
  isFalseTriggerCapture,
  isLikelyFalseTrigger,
} from "../app/telemetry/release-mode.js";

// Ground truth from the 2026-10-20 export (21 saved captures). The 13:42 batch
// was taken in trainer mode at the 2 g preset and every one of its impacts is far
// above what a real capture reaches: the five real trainer dry fires peak at
// 2.09-4.27 g and the seven bow-mode shots at 2.24-4.51 g.
const FALSE_TRIGGER_PEAKS = [
  [12.38, 163.2],
  [15.16, 67.9],
  [18.2, 68.6],
  [18.04, 326.8],
  [14.58, -55.9],
  [13.55, 67.8],
  [12.28, 316],
  [16.63, -90],
  [12.75, -92.5],
];

const REAL_TRAINER_PEAKS = [
  [2.5, 157.8],
  [3.7, 158.5],
  [3.44, 158.5],
  [2.09, 155.8],
  [4.27, 159.1],
];

const BOW_CAPTURE_PEAKS = [
  [4.51, -0.1],
  [3.67, -1.6],
  [3.45, -0.7],
  [2.24, -2.7],
  [2.97, -2.1],
  [3.59, -0.1],
  [3.95, -0.2],
];

function captureRecord(peakG, rollDeg, fields = {}) {
  return {
    id: `shot-${peakG}`,
    capture_kind: "arrow",
    stored_upload: false,
    peak_g: peakG,
    roll_angle_deg: rollDeg,
    cant_angle_deg: rollDeg,
    ...fields,
  };
}

const FALSE_TRIGGERS = FALSE_TRIGGER_PEAKS.map(([peakG, rollDeg]) => captureRecord(peakG, rollDeg, {
  release_mode: "trainer",
  stored_upload: true,
}));
const REAL_TRAINER_CAPTURES = REAL_TRAINER_PEAKS.map(([peakG, rollDeg]) => captureRecord(peakG, rollDeg, {
  release_mode: "trainer",
}));
// Bow-mode records carry no release_mode in the export: the absence means bow.
const BOW_CAPTURES = BOW_CAPTURE_PEAKS.map(([peakG, rollDeg]) => captureRecord(peakG, rollDeg));
const EXPORT = [...FALSE_TRIGGERS, ...REAL_TRAINER_CAPTURES, ...BOW_CAPTURES];

test("the 9 trainer-mode false triggers of the 13:42 batch are flagged", () => {
  assert.equal(FALSE_TRIGGER_PEAK_G, 8);
  assert.equal(FALSE_TRIGGERS.length, 9);
  for (const shot of FALSE_TRIGGERS) {
    assert.equal(isLikelyFalseTrigger(shot, TRAINER_THRESHOLD_G), true, `peak ${shot.peak_g} g`);
  }
});

test("the 5 real trainer captures stay real shots", () => {
  assert.equal(REAL_TRAINER_CAPTURES.length, 5);
  for (const shot of REAL_TRAINER_CAPTURES) {
    assert.equal(isLikelyFalseTrigger(shot, TRAINER_THRESHOLD_G), false, `peak ${shot.peak_g} g`);
  }
});

test("the 7 bow-mode captures are never false triggers", () => {
  assert.equal(BOW_CAPTURES.length, 7);
  for (const shot of BOW_CAPTURES) {
    // Bow mode is not a trainer gate at any threshold, including the trainer one.
    assert.equal(isLikelyFalseTrigger(shot, 12), false, `peak ${shot.peak_g} g at 12 g`);
    assert.equal(isLikelyFalseTrigger(shot, TRAINER_THRESHOLD_G), false, `peak ${shot.peak_g} g at 2 g`);
  }
});

test("exactly the 9 false triggers of the 21-capture export are flagged", () => {
  assert.equal(EXPORT.length, 21);
  const flagged = EXPORT.filter((shot) => isLikelyFalseTrigger(shot, TRAINER_THRESHOLD_G));
  assert.equal(flagged.length, 9);
  assert.deepEqual(
    flagged.map((shot) => shot.peak_g).sort((a, b) => a - b),
    FALSE_TRIGGER_PEAKS.map(([peakG]) => peakG).sort((a, b) => a - b),
  );
});

test("the verdict needs a trainer-low threshold", () => {
  const shot = captureRecord(15, 0, { release_mode: "trainer" });
  assert.equal(isLikelyFalseTrigger(shot, TRAINER_THRESHOLD_G), true);
  assert.equal(isLikelyFalseTrigger(shot, "2.0"), true);
  assert.equal(isLikelyFalseTrigger(shot, 3.9), true);
  // The bow preset (12 g) and the low-threshold boundary (4 g) are real settings.
  assert.equal(isLikelyFalseTrigger(shot, LOW_THRESHOLD_G), false);
  assert.equal(isLikelyFalseTrigger(shot, "4.0"), false);
  assert.equal(isLikelyFalseTrigger(shot, 12), false);
  assert.equal(isLikelyFalseTrigger(shot, "12.0"), false);
  // Missing or unusable thresholds are never assumed to be trainer-low.
  for (const threshold of [null, undefined, "", "  ", "bad", NaN, Infinity, -Infinity, {}, [], true, false]) {
    assert.equal(isLikelyFalseTrigger(shot, threshold), false, `threshold ${String(threshold)}`);
  }
});

test("only trainer-mode captures can be false triggers", () => {
  assert.equal(isLikelyFalseTrigger(captureRecord(15, 0, { release_mode: "bow" }), TRAINER_THRESHOLD_G), false);
  assert.equal(isLikelyFalseTrigger(captureRecord(15, 0), TRAINER_THRESHOLD_G), false);
  assert.equal(isLikelyFalseTrigger(captureRecord(15, 0, { release_mode: "Trainer" }), TRAINER_THRESHOLD_G), true);
  assert.equal(isLikelyFalseTrigger(captureRecord(15, 0, { release_mode: " trainer\n" }), TRAINER_THRESHOLD_G), true);
});

test("the 8 g boundary is exclusive", () => {
  const shot = (peakG) => captureRecord(peakG, 0, { release_mode: "trainer" });
  assert.equal(isLikelyFalseTrigger(shot(FALSE_TRIGGER_PEAK_G), TRAINER_THRESHOLD_G), false);
  assert.equal(isLikelyFalseTrigger(shot(8.0001), TRAINER_THRESHOLD_G), true);
  assert.equal(isLikelyFalseTrigger(shot(7.999), TRAINER_THRESHOLD_G), false);
  assert.equal(isLikelyFalseTrigger(shot("15.2"), TRAINER_THRESHOLD_G), true);
});

test("records without peak_g fall back to the acceleration axes", () => {
  const trainerOnly = (fields) => ({ release_mode: "trainer", ...fields });
  assert.equal(isLikelyFalseTrigger(trainerOnly({ axMg: 12400, ayMg: 0, azMg: 2000 }), TRAINER_THRESHOLD_G), true);
  assert.equal(isLikelyFalseTrigger(trainerOnly({ axMg: 2000, ayMg: 0, azMg: 0 }), TRAINER_THRESHOLD_G), false);
  // Every axis must be measurable before a derived peak is trusted.
  assert.equal(isLikelyFalseTrigger(trainerOnly({ axMg: 15000, ayMg: 0 }), TRAINER_THRESHOLD_G), false);
  assert.equal(isLikelyFalseTrigger(trainerOnly({ axMg: "bad", ayMg: 0, azMg: 0 }), TRAINER_THRESHOLD_G), false);
  // A stored peak always wins over the raw axes.
  assert.equal(isLikelyFalseTrigger(trainerOnly({ peak_g: 2.5, axMg: 15000, ayMg: 0, azMg: 0 }), TRAINER_THRESHOLD_G), false);
});

test("garbage input can never be a false trigger", () => {
  for (const shot of [null, undefined, 42, "trainer", true, {}, [], { release_mode: "trainer" }]) {
    assert.equal(isLikelyFalseTrigger(shot, TRAINER_THRESHOLD_G), false, `shot ${String(shot)}`);
    assert.doesNotThrow(() => isLikelyFalseTrigger(shot, TRAINER_THRESHOLD_G));
  }
});

test("isFalseTriggerCapture trusts the stored flag and re-derives legacy records", () => {
  assert.equal(isFalseTriggerCapture({ false_trigger: true }), true);
  assert.equal(isFalseTriggerCapture({ false_trigger: false }), false);
  // An explicit save-time verdict wins even when the record looks suspicious.
  assert.equal(isFalseTriggerCapture({ release_mode: "trainer", peak_g: 18, false_trigger: false }), false);
  // Records saved before the flag existed carry trainer mode and a large impact:
  // the 13:42 batch is hidden without a database migration.
  for (const shot of FALSE_TRIGGERS) {
    assert.equal(isFalseTriggerCapture({ ...shot }), true, `legacy peak ${shot.peak_g} g`);
  }
  for (const shot of [...REAL_TRAINER_CAPTURES, ...BOW_CAPTURES]) {
    assert.equal(isFalseTriggerCapture({ ...shot }), false, `legacy peak ${shot.peak_g} g`);
  }
  // Only a real boolean `true` is trusted as a stored verdict.
  for (const value of ["true", 1, "yes", {}, []]) {
    assert.equal(isFalseTriggerCapture({ false_trigger: value }), false, `flag ${String(value)}`);
  }
  for (const shot of [null, undefined, 42, "shot", []]) {
    assert.equal(isFalseTriggerCapture(shot), false);
  }
});
