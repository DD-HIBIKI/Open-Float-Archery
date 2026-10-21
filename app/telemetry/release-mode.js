// Release-mode presets for shot detection.
//
// The firmware compares the raw acceleration magnitude against one threshold
// (`thresh:<g>`), and a real bow needs the 12 g default while a dry-fire
// release trainer needs a much lower value. The browser owns the only copy of
// that setting, so the presets live here and the settings page pushes them to
// the device on every connect.

export const BOW_THRESHOLD_G = 12;
// 2.0 g is the firmware's own floor (MIN_SHOT_ACCEL_THRESHOLD_G) and the value
// verified against a buffered-cylinder release trainer on 2026-10-19. Raise it
// toward the measured trainer peak once real captures give a number.
export const TRAINER_THRESHOLD_G = 2;

// Below this value ordinary handling (setting the device down, bumping the bow,
// drawing the trainer) starts satisfying the release gate, so captures can no
// longer be assumed to be real arrows.
export const LOW_THRESHOLD_G = 4;

export const RELEASE_MODES = ["bow", "trainer"];

// Slider values arrive as both numbers and strings; everything else (null,
// "", booleans, NaN, Infinity) must not coerce to a "low threshold" by accident.
function numericThreshold(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// Unknown or legacy values fall back to the bow mode: tagging a capture as a
// trainer capture hides it from the default history view, so it must be an
// explicit choice.
export function normalizeReleaseMode(value) {
  return String(value == null ? "" : value).trim().toLowerCase() === "trainer"
    ? "trainer"
    : "bow";
}

export function thresholdForReleaseMode(mode) {
  return normalizeReleaseMode(mode) === "trainer"
    ? TRAINER_THRESHOLD_G
    : BOW_THRESHOLD_G;
}

// A manually dragged slider still needs a mode; anything under the low
// threshold is trainer-like by definition.
export function releaseModeForThreshold(gValue) {
  const threshold = numericThreshold(gValue);
  return threshold !== null && threshold < LOW_THRESHOLD_G ? "trainer" : "bow";
}

export function isLowThreshold(gValue) {
  const threshold = numericThreshold(gValue);
  return threshold !== null && threshold < LOW_THRESHOLD_G;
}

export function isTrainerCapture(shot) {
  return !!shot && normalizeReleaseMode(shot.release_mode) === "trainer";
}

// A real arrow - even a release-trainer dry fire - stays well under 8 g: the
// 2026-10-20 export shows real trainer captures at 2.1-4.3 g and bow captures at
// 2.2-4.5 g, while the 9 false triggers of the 13:42 batch hit 12.3-18.2 g. A
// trainer-mode capture above this peak is the gate firing on handling, a bump,
// or the draw itself, not a shot.
export const FALSE_TRIGGER_PEAK_G = 8.0;

// Peak impact of a capture in g. Newer records store it; older ones only keep
// the raw acceleration axes, which are in milli-g.
function peakGValue(shot) {
  if (!shot || typeof shot !== "object") return null;
  const stored = numericThreshold(shot.peak_g);
  if (stored !== null) return stored;
  const axes = [numericThreshold(shot.axMg), numericThreshold(shot.ayMg), numericThreshold(shot.azMg)];
  if (axes.some((axis) => axis === null)) return null;
  return Math.hypot(axes[0], axes[1], axes[2]) / 1000;
}

// False triggers only exist while the release gate is trainer-low: at 12 g a
// trainer-mode 15 g capture is a real (if suspiciously large) shot, and the
// threshold is part of the record's provenance. A missing or high threshold
// therefore never hides a capture.
export function isLikelyFalseTrigger(shot, thresholdG) {
  if (!shot || typeof shot !== "object") return false;
  if (normalizeReleaseMode(shot.release_mode) !== "trainer") return false;
  const threshold = numericThreshold(thresholdG);
  if (threshold === null || threshold >= LOW_THRESHOLD_G) return false;
  const peakG = peakGValue(shot);
  return peakG !== null && peakG > FALSE_TRIGGER_PEAK_G;
}

// Stamped onto the record when it is saved, so the history views never have to
// re-derive the verdict from a threshold that has since changed. Records written
// before the flag existed have no threshold provenance, but a trainer-mode
// capture only ever came from the sub-4 g gate, so they fall back to the trainer
// preset instead of staying visible forever. An explicit `false` is honoured:
// it is the save-time verdict, not a hint to re-derive.
export function isFalseTriggerCapture(shot) {
  if (!shot || typeof shot !== "object") return false;
  if (shot.false_trigger === true) return true;
  if (shot.false_trigger === false) return false;
  return isLikelyFalseTrigger(shot, TRAINER_THRESHOLD_G);
}
