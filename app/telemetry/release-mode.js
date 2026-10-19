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
