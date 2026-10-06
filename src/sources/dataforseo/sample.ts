// Weekly design: census, or certainty units plus Poisson sampling with weekday spreading (5.11.1). Owner: WP-D.
//
// - Eligible: candidates with average position <= 20 and >= 10 impressions in the current window,
//   and no Google search operator (site:, inurl: and so on; billed at 5x and not a real search).
// - Census when every eligible search fits the budget (pi = 1).
// - Otherwise the 20 most negative deltaClicks and the top 20 by expectedBaseClicks are certainty
//   units (pi = 1). The rest are Poisson-sampled with pi proportional to expectedBaseClicks,
//   clipped to [0.05, 1] and scaled so the expected spend equals the remaining budget.
//   Inclusion depends only on data from before sampling, so 1/pi (Horvitz-Thompson) weights
//   are design-unbiased.
// - Each unit's weekday is hash32(keyword) % 7, which spreads the checks over the week.
// - Deterministic: every draw comes from rngFor(seed, unit), seed = property|isoWeek.
import { hash32 } from '../../core/ids.js';
import { rngFor } from '../../core/rng.js';
import type { Device, SampleDesignKind, SerpCandidate } from '../../core/types.js';

export interface DesignUnit {
  keyword: string;
  device: Device;
  pi: number;
  design: SampleDesignKind;
  weekday: number;
}

export const CERTAINTY_LOSERS = 20;
export const CERTAINTY_TOP = 20;
export const PI_MIN = 0.05;
const EPS = 1e-9;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const unitKey = (c: { keyword: string; device: Device }): string => `${c.keyword}|${c.device}`;

/**
 * Google search operators. A search like "site:example.com" is the owner checking their own index,
 * not a search to watch for AI Overviews, and DataForSEO bills a task with an operator at 5 times
 * the normal price (seen on a real run: $0.006 instead of $0.0012), which would break the budget
 * guard's worst case. Quoted phrases are billed normally and stay eligible.
 */
const SEARCH_OPERATOR = /(?:^|\s)[-+]?(?:site|inurl|allinurl|intitle|allintitle|intext|allintext|inanchor|allinanchor|related|cache|info|filetype|ext|link|define|source|location|before|after|daterange):(?=\S)|\bAROUND\(\d+\)/i;

export function hasSearchOperator(keyword: string): boolean {
  return SEARCH_OPERATOR.test(keyword);
}

/** Eligible candidates, one per (keyword, device), in a stable order. */
export function eligibleCandidates(candidates: SerpCandidate[]): SerpCandidate[] {
  const byKey = new Map<string, SerpCandidate>();
  for (const c of candidates) {
    if (!c || typeof c.keyword !== 'string' || c.keyword.trim() === '') continue;
    if (hasSearchOperator(c.keyword)) continue;
    if (c.device !== 'desktop' && c.device !== 'mobile') continue;
    if (!(c.pbar <= 20) || !(c.impressions >= 10)) continue;
    const k = unitKey(c);
    const prev = byKey.get(k);
    if (!prev || c.impressions > prev.impressions) byKey.set(k, c);
  }
  return [...byKey.values()].sort((a, b) => cmp(a.keyword, b.keyword) || cmp(a.device, b.device));
}

export function weekdayFor(keyword: string): number {
  return hash32(keyword) % 7;
}

/**
 * Scale k so that sum(clip(k * x, PI_MIN, 1)) = m. When even the floor overshoots m, the floor is
 * dropped and pi is proportional to x (capped at 1), so the expected spend still equals the budget.
 */
export function scaledInclusion(x: number[], m: number): number[] {
  const n = x.length;
  if (n === 0 || !(m > 0)) return x.map(() => 0);
  if (m >= n - EPS) return x.map(() => 1);
  const floor = PI_MIN * n <= m ? PI_MIN : 0;
  const total = (k: number): number => x.reduce((s, v) => s + Math.min(1, Math.max(floor, k * v)), 0);
  let lo = 0;
  let hi = 1;
  while (total(hi) < m && hi < 1e15) hi *= 2;
  for (let it = 0; it < 200; it++) {
    const mid = (lo + hi) / 2;
    if (total(mid) < m) lo = mid;
    else hi = mid;
  }
  return x.map((v) => Math.min(1, Math.max(floor, hi * v)));
}

/** seed = property|isoWeek. */
export function designSample(
  candidates: SerpCandidate[],
  budgetUsd: number,
  seed: string,
  costPerCheckUsd: number,
): { mode: 'census' | 'sample'; units: DesignUnit[] } {
  const q = eligibleCandidates(candidates);
  const c = costPerCheckUsd > 0 ? costPerCheckUsd : 0;
  const budget = Number.isFinite(budgetUsd) ? Math.max(0, budgetUsd) : 0;
  if (q.length === 0) return { mode: 'census', units: [] };

  if (c === 0 || q.length * c <= budget + EPS) {
    const units = [...q]
      .sort((a, b) => b.expectedBaseClicks - a.expectedBaseClicks || cmp(a.keyword, b.keyword) || cmp(a.device, b.device))
      .map((u): DesignUnit => ({ keyword: u.keyword, device: u.device, pi: 1, design: 'census', weekday: weekdayFor(u.keyword) }));
    return { mode: 'census', units };
  }

  // Certainty units: biggest losers first, then the biggest expected earners.
  const maxUnits = Math.floor(budget / c + EPS);
  const losers = [...q]
    .filter((u) => u.deltaClicks < 0)
    .sort((a, b) => a.deltaClicks - b.deltaClicks || cmp(a.keyword, b.keyword) || cmp(a.device, b.device))
    .slice(0, CERTAINTY_LOSERS);
  const top = [...q]
    .sort((a, b) => b.expectedBaseClicks - a.expectedBaseClicks || cmp(a.keyword, b.keyword) || cmp(a.device, b.device))
    .slice(0, CERTAINTY_TOP);
  const certainty: SerpCandidate[] = [];
  const taken = new Set<string>();
  for (const u of [...losers, ...top]) {
    if (taken.has(unitKey(u)) || certainty.length >= maxUnits) continue;
    taken.add(unitKey(u));
    certainty.push(u);
  }
  const units: DesignUnit[] = certainty.map((u) => ({
    keyword: u.keyword, device: u.device, pi: 1, design: 'certainty', weekday: weekdayFor(u.keyword),
  }));

  // Poisson sample of the rest, expected spend = what is left of the budget.
  const rest = q.filter((u) => !taken.has(unitKey(u)));
  const m = (budget - certainty.length * c) / c;
  const pis = scaledInclusion(rest.map((u) => Math.max(u.expectedBaseClicks, 1e-3)), m);
  const sampled: DesignUnit[] = [];
  rest.forEach((u, k) => {
    const pi = pis[k];
    if (!(pi > 0)) return;
    const draw = rngFor(seed, `design|${unitKey(u)}`)();
    if (draw < pi) sampled.push({ keyword: u.keyword, device: u.device, pi, design: pi >= 1 ? 'certainty' : 'poisson', weekday: weekdayFor(u.keyword) });
  });
  sampled.sort((a, b) => b.pi - a.pi || cmp(a.keyword, b.keyword) || cmp(a.device, b.device));
  return { mode: 'sample', units: [...units, ...sampled] };
}

/** Expected worst-case spend of a design: sum of pi * cost. */
export function expectedDesignCost(units: { pi: number }[], costPerCheckUsd: number): number {
  return units.reduce((s, u) => s + u.pi * costPerCheckUsd, 0);
}
