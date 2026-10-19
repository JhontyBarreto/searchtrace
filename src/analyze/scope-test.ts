// "Is it real?" for a scope's click total, and BH family 2 over every eligible scope (5.4, 5.12). Owner: WP-E.
//
// A scope (section, page or search) is a census of its units, so its total change has no sampling
// of units to model. Its uncertainty is counting noise (quasi-Poisson, phi from the site's clicks)
// plus the period-to-period swing every series shows beyond counting noise. That extra variance is
// measured once on the whole site's own history (the headline's empirical SE squared minus its
// quasi-Poisson part) and added to every scope, exactly as for impressions. So the headline, the
// sections, the pages and the searches all answer "is it real?" with the same kind of interval.
//
// BH family 2 is fixed before looking at the current window: every template plus every page and
// search that meets its baseline floor (page baseline clicks >= 30, search baseline expected clicks
// >= 30). Ranking by the size of the change only chooses what is shown, never what is tested.
import type { PeriodEffect } from '../core/types.js';
import { benjaminiHochberg, normalCdf } from './stats.js';

export interface ScopeComparison {
  /** Cc / Cb - 1, or null with no baseline clicks. */
  estimate: number | null;
  /** 95% range of the relative change, clipped at -100%. */
  ci95: [number, number] | null;
  /** The same range in clicks (Cb times the relative range). */
  absoluteCi95: [number, number] | null;
  p: number;
  se: number;
}

/**
 * Extra log-scale variance of clicks between periods, beyond counting noise, from the headline
 * comparison: max(0, SE_emp^2 - phi (1/pre + 1/post)) when the empirical SE was used, else 0.
 */
export function extraVariance(h: PeriodEffect, phi: number): number {
  if (h.seSource !== 'empirical' || !(h.pre > 0) || !(h.post > 0) || !Number.isFinite(h.se)) return 0;
  return Math.max(0, h.se ** 2 - phi * (1 / h.pre + 1 / h.post));
}

/**
 * Closed-form comparison of two click totals: se = sqrt(phi (1/Cb + 1/Cc) + extra), centred on
 * ln(Cc / Cb). A zero total uses 0.5 (a continuity correction), so a search with no clicks left
 * still gets a finite range.
 */
export function compareCounts(Cb: number, Cc: number, phi: number, extra: number): ScopeComparison {
  if (!(Cb > 0) && !(Cc > 0)) return { estimate: null, ci95: null, absoluteCi95: null, p: 1, se: Infinity };
  const b = Cb > 0 ? Cb : 0.5;
  const c = Cc > 0 ? Cc : 0.5;
  const ph = phi > 0 && Number.isFinite(phi) ? phi : 1;
  const se = Math.sqrt(ph * (1 / b + 1 / c) + Math.max(0, extra));
  const lr = Math.log(c / b);
  const ci: [number, number] = [Math.max(-1, Math.exp(lr - 1.96 * se) - 1), Math.exp(lr + 1.96 * se) - 1];
  const p = se > 0 ? 2 * normalCdf(-Math.abs(lr) / se) : 1;
  return {
    estimate: Cb > 0 ? Cc / Cb - 1 : null,
    ci95: Cb > 0 ? ci : null,
    absoluteCi95: Cb > 0 ? [Cb * ci[0], Cb * ci[1]] : null,
    p,
    se,
  };
}

/** One hypothesis of BH family 2: a scope key and its p. */
export interface FamilyMember { key: string; p: number }

/** BH q-values for every member, by key. */
export function familyQ(members: FamilyMember[]): Map<string, number> {
  const sorted = [...members].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const q = benjaminiHochberg(sorted.map((m) => m.p));
  return new Map(sorted.map((m, k) => [m.key, q[k]]));
}

/** One candidate hypothesis of BH family 2, described by baseline-only quantities plus its two totals. */
export interface FamilyScope { level: 'template' | 'page' | 'query'; key: string; baseClicks: number; curClicks: number; baseExpected: number }

/** Floors fixed before looking at the current window: 30 baseline clicks (sections, pages) or 30 expected baseline clicks (searches). */
export const FAMILY_FLOOR = 30;

/** The family key of a scope. */
export const familyKey = (level: string, key: string): string => `${level}|${key}`;

/**
 * BH family 2 over every eligible scope (not only the ones shown), with each scope's closed-form p.
 * Returns q by familyKey(level, key); ineligible scopes have no q.
 */
export function scopeFamilyQ(scopes: FamilyScope[], phi: number, extra: number): Map<string, number> {
  const members: FamilyMember[] = [];
  for (const s of scopes) {
    const eligible = s.level === 'query' ? s.baseExpected >= FAMILY_FLOOR : s.baseClicks >= FAMILY_FLOOR;
    if (eligible) members.push({ key: familyKey(s.level, s.key), p: compareCounts(s.baseClicks, s.curClicks, phi, extra).p });
  }
  return familyQ(members);
}

