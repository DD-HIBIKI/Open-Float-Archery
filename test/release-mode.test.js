import test from "node:test";
import assert from "node:assert/strict";
import {
  BOW_THRESHOLD_G,
  LOW_THRESHOLD_G,
  TRAINER_THRESHOLD_G,
  isLowThreshold,
  isTrainerCapture,
  normalizeReleaseMode,
  releaseModeForThreshold,
  thresholdForReleaseMode,
} from "../app/telemetry/release-mode.js";

test("presets map to the two shipped thresholds", () => {
  assert.equal(BOW_THRESHOLD_G, 12);
  assert.equal(TRAINER_THRESHOLD_G, 2);
  assert.equal(thresholdForReleaseMode("bow"), 12);
  assert.equal(thresholdForReleaseMode("trainer"), 2);
});

test("unknown mode values fall back to bow so captures are never hidden by accident", () => {
  for (const value of [null, undefined, "", "  ", "bow ", true, 0, 1, {}, []]) {
    const mode = normalizeReleaseMode(value);
    assert.equal(mode, "bow");
  }
  assert.equal(normalizeReleaseMode("Trainer"), "trainer");
  assert.equal(normalizeReleaseMode(" trainer\n"), "trainer");
});

test("a manually dragged threshold still resolves to a mode", () => {
  assert.equal(releaseModeForThreshold(12), "bow");
  assert.equal(releaseModeForThreshold("12.0"), "bow");
  assert.equal(releaseModeForThreshold(4), "bow");
  assert.equal(releaseModeForThreshold(3.5), "trainer");
  assert.equal(releaseModeForThreshold(2), "trainer");
  for (const value of [null, undefined, "", "bad", NaN, Infinity]) {
    assert.equal(releaseModeForThreshold(value), "bow");
  }
});

test("the low-threshold warning boundary is exclusive and finite-only", () => {
  assert.equal(LOW_THRESHOLD_G, 4);
  assert.equal(isLowThreshold(3.5), true);
  assert.equal(isLowThreshold("2.0"), true);
  assert.equal(isLowThreshold(4), false);
  assert.equal(isLowThreshold(12), false);
  for (const value of [null, undefined, "", "bad", NaN, Infinity]) {
    assert.equal(isLowThreshold(value), false);
  }
});

test("only records explicitly tagged as trainer are trainer captures", () => {
  assert.equal(isTrainerCapture({ release_mode: "trainer" }), true);
  assert.equal(isTrainerCapture({ release_mode: "bow" }), false);
  assert.equal(isTrainerCapture({ release_mode: "TRAINER" }), true);
  assert.equal(isTrainerCapture({}), false);
  assert.equal(isTrainerCapture(null), false);
  assert.equal(isTrainerCapture(undefined), false);
});
