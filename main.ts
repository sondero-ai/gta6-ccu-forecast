// Forecast GTA VI's launch-day Twitch viewers hour by hour.
// Empirical launch-day shape pooled from late-peaking comparables, scaled by hour 1.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Standard-normal quantiles at 5%, 25%, 50%, 75%, 95%.
const Z = [-1.6448536269514722, -0.6744897501960817, 0, 0.6744897501960817, 1.6448536269514722];
const SPREAD = 0.85; // shrink fitted residual spread
const MIN_SAMPLES = 5;
const LANE_PEAK = 8; // keep launches peaking at or after hour 9 of the UTC day
const MIN_V0 = 100;
const HOUR_MS = 3_600_000;

interface HourlyPoint { from?: string; viewers?: number }
interface Comparable { day_start?: string; hourly?: HourlyPoint[] }
interface CaseFile { known?: Array<{ viewers?: number }>; comparables?: Comparable[] }
interface Shape { v0: number; ratios: number[] } // ratios[k] for k = 1..23; NaN means missing

const round2 = (x: number): number => Math.round(x * 100) / 100;

const parseMs = (v: unknown): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string') return Date.parse(v);
  return NaN;
};

/** Median of a non-empty list; 1 when empty, as the fallback requires. */
const median = (xs: number[]): number => {
  if (xs.length === 0) return 1;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** Population standard deviation. */
const popStd = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
};

/** Build one comparable's launch-day shape; null when it cannot be used. */
const shapeOf = (c: Comparable): Shape | null => {
  const dayStart = parseMs(c.day_start);
  if (!Number.isFinite(dayStart) || !Array.isArray(c.hourly)) return null;

  // One viewer value per hour offset; the first valid point wins.
  const byHour = new Map<number, number>();
  for (const p of c.hourly) {
    const hourIndex = Math.round((parseMs(p?.from) - dayStart) / HOUR_MS);
    const viewers = Number(p?.viewers);
    if (!Number.isInteger(hourIndex) || hourIndex < 0 || hourIndex > 24) continue;
    if (!Number.isFinite(viewers) || viewers <= 0) continue;
    if (!byHour.has(hourIndex)) byHour.set(hourIndex, viewers);
  }

  const v0 = byHour.get(0);
  if (v0 === undefined || v0 < MIN_V0) return null;

  const ratios: number[] = new Array(24).fill(NaN);
  for (let k = 1; k <= 23; k++) {
    const viewers = byHour.get(k);
    if (viewers !== undefined) ratios[k] = viewers / v0;
  }
  return { v0, ratios };
};

/** Hour offset of the largest ratio (smallest on ties), or null if none exist. */
const peakOf = (shape: Shape): number | null => {
  let peak: number | null = null;
  let best = -Infinity;
  for (let k = 1; k <= 23; k++) {
    const r = shape.ratios[k];
    if (Number.isFinite(r) && r > best) {
      best = r;
      peak = k;
    }
  }
  return peak;
};

/** Ordinary least squares y = a + b*x; flat line if x has no spread. */
const fitLine = (xs: number[], ys: number[]) => {
  const n = xs.length;
  const xBar = xs.reduce((a, b) => a + b, 0) / n;
  const yBar = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - xBar) ** 2;
    sxy += (xs[i] - xBar) * (ys[i] - yBar);
  }
  const b = sxx > 0 ? sxy / sxx : 0;
  return { a: yBar - b * xBar, b };
};

mkdirSync(OUTPUT_DIR, { recursive: true });
// Name order makes two runs write the same bytes.
const files = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();

for (const file of files) {
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as CaseFile;

  const rawH1 = Number(c.known?.[0]?.viewers);
  const h1 = Number.isFinite(rawH1) && rawH1 > 0 ? rawH1 : 1;

  const pool: Shape[] = [];
  for (const comparable of c.comparables ?? []) {
    const shape = shapeOf(comparable);
    if (shape !== null) pool.push(shape);
  }
  // The target is a late-peaking launch, so regress only on late-peaking peers.
  const lane = pool.filter((s) => {
    const peak = peakOf(s);
    return peak !== null && peak >= LANE_PEAK;
  });

  // Model per target hour h = 2..24, indexed k = h - 1 = 1..23.
  const mu: number[] = new Array(23).fill(0);
  const sigma: number[] = new Array(23).fill(NaN);
  for (let k = 1; k <= 23; k++) {
    const samples = lane.flatMap((s) =>
      Number.isFinite(s.ratios[k]) ? [{ x: Math.log(s.v0), y: Math.log(s.ratios[k]) }] : []);
    if (samples.length >= MIN_SAMPLES) {
      const { a, b } = fitLine(samples.map((s) => s.x), samples.map((s) => s.y));
      const residuals = samples.map((s) => s.y - (a + b * s.x));
      mu[k - 1] = a + b * Math.log(h1);
      sigma[k - 1] = popStd(residuals);
    } else {
      // Too few peers in the lane: use the median shape over the whole pool,
      // with its log spread around that median.
      const ratios = pool.flatMap((s) => Number.isFinite(s.ratios[k]) ? [s.ratios[k]] : []);
      mu[k - 1] = Math.log(median(ratios));
      sigma[k - 1] = popStd(ratios.map((r) => Math.log(r) - mu[k - 1]));
    }
  }

  // Smooth each hour's spread over a +-2 hour window.
  const smooth: number[] = new Array(23).fill(0);
  for (let k = 0; k < 23; k++) {
    const window: number[] = [];
    for (let j = Math.max(0, k - 2); j <= Math.min(22, k + 2); j++) {
      if (Number.isFinite(sigma[j])) window.push(sigma[j]);
    }
    smooth[k] = window.length > 0 ? window.reduce((a, b) => a + b, 0) / window.length : 0;
  }

  const hours = Array.from({ length: 23 }, (_, k) => {
    const hour = k + 2;
    const q = Z.map((z) => h1 * Math.exp(mu[k] + z * SPREAD * smooth[k]));
    // Clamp to contract bounds and keep every value finite.
    const clean = q.map((v) => Number.isFinite(v) ? Math.min(1e9, Math.max(1, v)) : Math.min(1e9, Math.max(1, h1)));
    // Enforce order, round to 2 decimals, then re-enforce (rounding is monotone).
    for (let j = 1; j < clean.length; j++) clean[j] = Math.max(clean[j], clean[j - 1]);
    const rounded = clean.map(round2);
    for (let j = 1; j < rounded.length; j++) rounded[j] = Math.max(rounded[j], rounded[j - 1]);
    return { hour, q: rounded };
  });

  const id = file.slice(0, -'.in'.length);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours })}\n`);
}
