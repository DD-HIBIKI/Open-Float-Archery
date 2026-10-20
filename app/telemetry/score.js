// OpenFloat scoring is intentionally transparent and locally computed.
// The score is not modeled on any commercial product; it blends movement
// features that are visible in the stored trace and useful for coaching.

export const FLOAT_SCORE_VERSION = "openfloat-float-score-v1";

// Saved scores are measurements on a 0-100 scale. Zero is valid; blanks,
// booleans, and out-of-range imports are unavailable, not clamped measurements.
export function scoreValue(raw) {
  if (typeof raw !== "number" && typeof raw !== "string") return null;
  if (typeof raw === "string" && !raw.trim()) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

export function shotFloatScore(shot) {
  if (shot?.shot_score != null) return scoreValue(shot.shot_score);
  // Only older records used stability as the overall score. A newer capture
  // with an explicit score version must not invent a score while it is pending.
  return shot?.score_version ? null : scoreValue(shot?.stability_score);
}

export function averageShotScore(shots) {
  const scores = shots.map(shotFloatScore).filter((score) => score != null);
  return scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null;
}

const LIVE_SCORE_WINDOW = 120;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stdDev(values) {
  if (values.length < 2) return 0;
  const mean = average(values);
  const variance = average(values.map((value) => (value - mean) ** 2));
  return Math.sqrt(variance);
}

function maxAbs(values) {
  if (!values.length) return 0;
  return values.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
}

function pointMotionDps(pt) {
  const rotDps = Number(pt.rotDps);
  if (Number.isFinite(rotDps)) return Math.abs(rotDps);
  return Math.hypot(pt.gx || 0, pt.gy || 0, pt.gz || 0);
}

function traceSlice(trace, start, end) {
  return trace.slice(Math.max(0, start), Math.max(0, end));
}

function releaseIndexForTrace(trace) {
  if (!trace.length) return 0;

  let bestIdx = Math.max(0, Math.round(trace.length * 0.62));
  let bestMotion = -Infinity;
  for (let i = 0; i < trace.length; i++) {
    const pt = trace[i];
    const accelDelta = Math.abs(Math.hypot(pt.ax || 0, pt.ay || 0, pt.az || 0) - 1);
    const gyroMag = pointMotionDps(pt);
    const motion = accelDelta * 35 + gyroMag;
    if (motion > bestMotion) {
      bestMotion = motion;
      bestIdx = i;
    }
  }
  return bestIdx;
}

export function computeFloatScoreFromTrace(trace, options = {}) {
  const points = (trace || []).filter(Boolean);
  if (points.length === 0) {
    return {
      scoreVersion: FLOAT_SCORE_VERSION,
      formScore: 0,
      holdStability: 0,
      releaseQuality: 0,
      followThrough: 0,
      levelConsistency: 0,
    };
  }

  const releaseIdx =
    Number.isInteger(options.releaseIndex) && options.releaseIndex >= 0
      ? Math.min(points.length - 1, options.releaseIndex)
      : releaseIndexForTrace(points);
  const sampleRateHz = Number(options.sampleRateHz) > 0 ? Number(options.sampleRateHz) : 52;
  const preSamples = Math.max(8, Math.round(sampleRateHz * 1.5));
  const releaseSamples = Math.max(4, Math.round(sampleRateHz * 0.18));
  const followSamples = Math.max(8, Math.round(sampleRateHz * 0.75));

  const hold = traceSlice(points, releaseIdx - preSamples, releaseIdx);
  const release = traceSlice(points, releaseIdx - Math.round(releaseSamples / 2), releaseIdx + releaseSamples);
  const follow = traceSlice(points, releaseIdx + 1, releaseIdx + followSamples + 1);
  const holdWindow = hold.length ? hold : points.slice(-Math.min(points.length, LIVE_SCORE_WINDOW));
  const releaseWindow = release.length ? release : points.slice(-Math.min(points.length, releaseSamples));
  const followWindow = follow.length ? follow : points.slice(-Math.min(points.length, followSamples));

  const holdRollStd = stdDev(holdWindow.map((pt) => pt.roll || 0));
  const holdPitchStd = stdDev(holdWindow.map((pt) => pt.pitch || 0));
  const holdGyroAvg = average(
    holdWindow.map(pointMotionDps),
  );
  const holdStability = clamp(100 - (holdRollStd + holdPitchStd) * 18 - holdGyroAvg * 0.55, 0, 100);

  const releaseGyroPeak = maxAbs(
    releaseWindow.map(pointMotionDps),
  );
  const releaseAccelPeak = maxAbs(
    releaseWindow.map((pt) => Math.hypot(pt.ax || 0, pt.ay || 0, pt.az || 0) - 1),
  );
  const releaseQuality = clamp(100 - releaseGyroPeak * 0.9 - releaseAccelPeak * 18, 0, 100);

  const followGyroAvg = average(
    followWindow.map(pointMotionDps),
  );
  const followRollTravel = maxAbs(followWindow.map((pt) => (pt.roll || 0) - (points[releaseIdx]?.roll || 0)));
  const followPitchTravel = maxAbs(followWindow.map((pt) => (pt.pitch || 0) - (points[releaseIdx]?.pitch || 0)));
  const followThrough = clamp(100 - followGyroAvg * 0.65 - (followRollTravel + followPitchTravel) * 8, 0, 100);

  const avgAbsCant = average(holdWindow.map((pt) => Math.abs(pt.roll || 0)));
  const cantSpread = stdDev(holdWindow.map((pt) => pt.roll || 0));
  const levelConsistency = clamp(100 - avgAbsCant * 6 - cantSpread * 12, 0, 100);

  const isManual = !!options.isManual;

  const formScore = isManual
    ? clamp(holdStability * 0.7 + levelConsistency * 0.3, 0, 100)
    : clamp(
        holdStability * 0.4 +
          releaseQuality * 0.24 +
          followThrough * 0.22 +
          levelConsistency * 0.14,
        0,
        100,
      );

  return {
    scoreVersion: FLOAT_SCORE_VERSION,
    formScore: Math.round(formScore),
    holdStability: Math.round(holdStability),
    releaseQuality: isManual ? null : Math.round(releaseQuality),
    followThrough: isManual ? null : Math.round(followThrough),
    levelConsistency: Math.round(levelConsistency),
    releaseIndex: releaseIdx,
  };
}

export function computeLiveFloatScore({ roll = 0, pitch = 0, gyroMag = 0, accelG = 1, trace = [] }) {
  const window = (trace || []).slice(-LIVE_SCORE_WINDOW);
  const traceScore = computeFloatScoreFromTrace(window.length ? window : [{ roll, pitch, gx: gyroMag, ax: 0, ay: 0, az: accelG }]);
  const releaseQuality = clamp(100 - gyroMag * 1.35 - Math.abs(accelG - 1) * 12, 0, 100);
  const levelConsistency = clamp(100 - Math.abs(roll) * 6 - Math.abs(pitch) * 1.5, 0, 100);
  const formScore = clamp(
    traceScore.holdStability * 0.45 +
      releaseQuality * 0.18 +
      traceScore.followThrough * 0.17 +
      levelConsistency * 0.2,
    0,
    100,
  );

  return {
    scoreVersion: FLOAT_SCORE_VERSION,
    formScore: Math.round(formScore),
    holdStability: traceScore.holdStability,
    releaseQuality: Math.round(releaseQuality),
    followThrough: traceScore.followThrough,
    levelConsistency: Math.round(levelConsistency),
  };
}

// ---------------------------------------------------------------------------
// v3 preview scoring (angle-only model, 2026-10-20)
//
// The v2 live frame carries int8 accelerations (0.1 g) and no gyroscope, so the
// angular-rate values used by v1 are dominated by a ~17-19 dps quantisation
// floor. v3 therefore only consumes angles:
//
//   holdSway       detrended RMS of roll/pitch over [-750, -50] ms
//   aimDrift       |slope| of roll/pitch over the same window, deg/s
//   releaseTorque  max |roll - baseline| over [-20, +100] ms
//   followSmooth   sigma(roll) + 0.5 sigma(quadratic pitch residual) over
//                  [+100, +350] ms
//
// score(x) = 100 * 2 ** (-(x/scale)^2): flat at the top, most sensitive around
// half scale, so measurement noise cannot punish the best shots.
// Scales are cold start values measured on the trainer (0.7 s window); a real
// bow needs its own calibration. Weights follow the plan: the trainer drops
// releaseTorque because the pneumatic impulse is not a bow-limb impulse.
// ---------------------------------------------------------------------------

export const FLOAT_SCORE_V3_VERSION = "openfloat-float-score-v3";

export const V3_SCALES = {
  holdSway: 0.79,
  aimDrift: 3.86,
  releaseTorque: 3.0,
  followSmooth: 1.12,
};

export const V3_WEIGHTS = {
  bow: { holdSway: 0.35, aimDrift: 0.2, releaseTorque: 0.3, followSmooth: 0.15 },
  trainer: { holdSway: 0.35, aimDrift: 0.2, releaseTorque: 0, followSmooth: 0.15 },
};

const V3_HOLD_US = [-750000, -50000];
const V3_RELEASE_US = [-20000, 100000];
const V3_FOLLOW_US = [100000, 350000];
const V3_MCRT_US = [-600000, -60000];
const V3_BASELINE_US = [-100000, -50000];

function v3Window(points, t0, [lo, hi]) {
  const start = t0 + lo;
  const end = t0 + hi;
  return points.filter((point) => point.tUs >= start && point.tUs < end);
}

function v3Median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function v3LineFit(points, key) {
  const n = points.length;
  if (n < 3) return { slope: 0, residuals: points.map(() => 0) };
  let sumT = 0;
  let sumY = 0;
  for (const point of points) {
    sumT += point.tUs / 1e6;
    sumY += point[key] || 0;
  }
  const meanT = sumT / n;
  const meanY = sumY / n;
  let sxx = 0;
  let sxy = 0;
  for (const point of points) {
    const dt = point.tUs / 1e6 - meanT;
    sxx += dt * dt;
    sxy += dt * ((point[key] || 0) - meanY);
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  return {
    slope,
    residuals: points.map((point) => (point[key] || 0) - (meanY + slope * (point.tUs / 1e6 - meanT))),
  };
}

function solve3(matrix, vector) {
  const a = matrix.map((row, index) => [...row, vector[index]]);
  for (let col = 0; col < 3; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < 3; row += 1) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-12) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    for (let row = col + 1; row < 3; row += 1) {
      const factor = a[row][col] / a[col][col];
      for (let k = col; k < 4; k += 1) a[row][k] -= factor * a[col][k];
    }
  }
  const out = [0, 0, 0];
  for (let row = 2; row >= 0; row -= 1) {
    let sum = a[row][3];
    for (let k = row + 1; k < 3; k += 1) sum -= a[row][k] * out[k];
    out[row] = sum / a[row][row];
  }
  return out;
}

function v3QuadraticResidual(points, key) {
  const n = points.length;
  if (n < 5) return points.map(() => 0);
  const power = [0, 0, 0, 0, 0];
  const rhs = [0, 0, 0];
  for (const point of points) {
    const t = point.tUs / 1e6;
    const y = point[key] || 0;
    let tp = 1;
    for (let k = 0; k < 5; k += 1) {
      power[k] += tp;
      if (k < 3) rhs[k] += tp * y;
      tp *= t;
    }
  }
  const solved = solve3(
    [[power[0], power[1], power[2]], [power[1], power[2], power[3]], [power[2], power[3], power[4]]],
    rhs,
  );
  if (!solved) return points.map(() => 0);
  return points.map((point) => {
    const t = point.tUs / 1e6;
    return (point[key] || 0) - (solved[0] + solved[1] * t + solved[2] * t * t);
  });
}

function v3MicSteps(micSeries) {
  const steps = [];
  for (const point of micSeries) {
    const amp = Number(point.micAmp) || 0;
    const tUs = Number(point.tUs);
    if (!Number.isFinite(tUs)) continue;
    if (steps.length && amp === steps[steps.length - 1].amp) steps[steps.length - 1].end = tUs;
    else steps.push({ tUs, amp, end: tUs });
  }
  return steps;
}

// Clicker detection on the microphone envelope. The envelope only updates every
// ~4.5 ms (the firmware refreshes it every fifth live frame), so the result is
// accurate to about +-5 ms - enough for a 100-300 ms clicker->release interval.
export function detectClickerMs(micSeries) {
  const mic = (Array.isArray(micSeries) ? micSeries : []).filter(
    (point) => point && Number.isFinite(Number(point.tUs)),
  );
  if (mic.length < 50) return null;
  const steps = v3MicSteps(mic);
  const quiet = steps.filter((step) => step.tUs >= -1.5e6 && step.tUs <= -1.0e6).map((step) => step.amp);
  const threshold = Math.max(5 * v3Median(quiet), 60);
  const events = [];
  let current = null;
  for (const step of steps) {
    if (step.amp >= threshold) {
      if (!current) current = { start: step.tUs, end: step.end };
      else current.end = step.end;
    } else if (current && step.tUs - current.end > 30000) {
      events.push(current);
      current = null;
    }
  }
  if (current) events.push(current);
  const click = events.find((event) => event.start >= V3_MCRT_US[0] && event.start <= V3_MCRT_US[1]);
  if (!click) return null;
  const mcrMs = Math.round(-click.start / 1000);
  return {
    mcrMs,
    label: mcrMs < 80 ? "anticipation" : mcrMs > 280 ? "hesitation" : null,
  };
}

export function v3ModeForShot(shot) {
  const mode = String(shot?.release_mode ?? "").trim().toLowerCase();
  if (mode === "trainer") return "trainer";
  if (!mode && Number(shot?.peak_g) < 6) return "trainer"; // legacy trainer captures
  return "bow";
}

export function v3Scale(value, scale) {
  if (!Number.isFinite(value)) return null;
  return 100 * Math.pow(2, -Math.pow(value / scale, 2));
}

export function v3ScoreFromMetrics(metrics, mode = "bow") {
  const weights = V3_WEIGHTS[mode === "trainer" ? "trainer" : "bow"];
  const components = {};
  let total = 0;
  let weight = 0;
  for (const [name, scale] of Object.entries(V3_SCALES)) {
    const value = Number(metrics?.[name]);
    const score = Number.isFinite(value) ? v3Scale(value, scale) : null;
    components[name] = score == null ? null : Math.round(score);
    if (score == null || !weights[name]) continue;
    total += score * weights[name];
    weight += weights[name];
  }
  return {
    version: FLOAT_SCORE_V3_VERSION,
    mode: mode === "trainer" ? "trainer" : "bow",
    formScore: weight ? Math.round(total / weight) : null,
    components,
  };
}

export function computeFloatScoreV3FromTrace(trace, options = {}) {
  const points = (trace || []).filter((point) => point && Number.isFinite(point.tUs));
  const mode = options.releaseMode === "trainer" ? "trainer"
    : options.releaseMode ? "bow"
      : Number(options.peakG) < 6 ? "trainer" : "bow";
  if (points.length < 64) {
    return { version: FLOAT_SCORE_V3_VERSION, mode, formScore: null, components: {}, metrics: {} };
  }
  const releaseIndex = points.findIndex((point) => point.tUs >= 0);
  const t0 = releaseIndex >= 0 ? points[releaseIndex].tUs : points[0].tUs;

  const hold = v3Window(points, t0, V3_HOLD_US);
  if (hold.length < 16) {
    return { version: FLOAT_SCORE_V3_VERSION, mode, formScore: null, components: {}, metrics: {} };
  }
  const rollFit = v3LineFit(hold, "roll");
  const pitchFit = v3LineFit(hold, "pitch");
  const holdSway = Math.sqrt(
    hold.reduce((sum, _point, index) => sum + rollFit.residuals[index] ** 2 + pitchFit.residuals[index] ** 2, 0)
      / hold.length,
  );
  const aimDrift = Math.hypot(rollFit.slope, pitchFit.slope);
  const holdMeanRoll = hold.reduce((sum, point) => sum + (point.roll || 0), 0) / hold.length;

  const baseline = v3Window(points, t0, V3_BASELINE_US);
  const baselineRoll = baseline.length
    ? baseline.reduce((sum, point) => sum + (point.roll || 0), 0) / baseline.length
    : holdMeanRoll;
  const release = v3Window(points, t0, V3_RELEASE_US);
  const releaseTorque = release.length
    ? release.reduce((peak, point) => Math.max(peak, Math.abs((point.roll || 0) - baselineRoll)), 0)
    : null;

  const follow = v3Window(points, t0, V3_FOLLOW_US);
  let followSmooth = null;
  if (follow.length >= 8) {
    const rollSd = stdDev(follow.map((point) => point.roll || 0));
    const pitchResidual = v3QuadraticResidual(follow, "pitch");
    followSmooth = rollSd + 0.5 * stdDev(pitchResidual);
  }

  const clicker = mode === "trainer" ? detectClickerMs(options.micSeries) : null;

  const metrics = {
    holdSway,
    aimDrift,
    releaseTorque,
    followSmooth,
    holdMeanRoll,
    mcrMs: clicker ? clicker.mcrMs : null,
    mcrLabel: clicker ? clicker.label : null,
  };
  const scored = v3ScoreFromMetrics(metrics, mode);
  return { ...scored, metrics };
}

// Score a stored capture from the v3 metrics written at trace-freeze time.
export function shotV3Score(shot) {
  if (!shot || shot.v3_version !== FLOAT_SCORE_V3_VERSION) return null;
  const metrics = {
    holdSway: shot.hold_sway,
    aimDrift: shot.aim_drift,
    releaseTorque: shot.release_torque,
    followSmooth: shot.follow_smooth,
  };
  if (!Object.values(metrics).some((value) => Number.isFinite(Number(value)))) return null;
  return v3ScoreFromMetrics(metrics, shot.v3_mode === "trainer" ? "trainer" : "bow");
}

