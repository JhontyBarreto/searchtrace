// Available-budget computation: month spend, pending, balance, per-run cap (4.5 step 3a). Owner: WP-D.
//
//   A = min(monthlyBudgetUsd - monthSpend - pendingUnknown * costPerCheck,  --budget ?? maxPerRunUsd,  balance)
//
// A is never negative. An unknown balance (the free user_data call failed) counts as zero, so
// a run that cannot see the balance posts nothing. The posting guard (`affordableChecks`) caps
// the number of checks at floor(A / costPerCheck) using the worst-case price, so the spend
// recorded later from DataForSEO can only be lower.

export interface BudgetInput {
  monthlyBudgetUsd: number;
  monthSpendUsd: number;
  pendingUnknown: number;
  costPerCheckUsd: number;
  perRunCapUsd: number;
  balanceUsd: number | null;
}

export type BudgetLimit = 'monthly' | 'per_run' | 'balance';

export interface BudgetResult {
  availableUsd: number;
  limitedBy: BudgetLimit;
  /** Monthly headroom before the per-run cap and balance: monthly - spend - reserved pending. */
  monthlyLeftUsd: number;
  reservedUsd: number;
}

const EPS = 1e-9;

/**
 * The lowest price per check searchtrace ever plans with: DataForSEO's live SERP with AI Overview
 * costs $0.0012. A config.json that says less (the price without AI Overview, or a typo) would let a
 * "hard" cap overspend by the ratio, so the configured price is a floor raised to this, never lowered.
 */
export const MIN_COST_PER_CHECK = 0.0012;

/** The price to plan with: the configured one, never below MIN_COST_PER_CHECK. */
export function planningPrice(configuredUsd: number): number {
  return Number.isFinite(configuredUsd) && configuredUsd > MIN_COST_PER_CHECK ? configuredUsd : MIN_COST_PER_CHECK;
}

function finiteOr(x: number, fallback: number): number {
  return Number.isFinite(x) ? x : fallback;
}

export function budgetFor(i: BudgetInput): BudgetResult {
  const cost = Math.max(0, finiteOr(i.costPerCheckUsd, 0));
  const reservedUsd = Math.max(0, finiteOr(i.pendingUnknown, 0)) * cost;
  const monthlyLeftUsd = finiteOr(i.monthlyBudgetUsd, 0) - Math.max(0, finiteOr(i.monthSpendUsd, 0)) - reservedUsd;
  const perRun = finiteOr(i.perRunCapUsd, 0);
  // null (could not read it) counts as zero; +Infinity means "not checked" (a dry run's estimate).
  const balance = i.balanceUsd === null || Number.isNaN(i.balanceUsd) ? 0 : i.balanceUsd;
  const options: [BudgetLimit, number][] = [
    ['monthly', monthlyLeftUsd],
    ['per_run', perRun],
    ['balance', balance],
  ];
  let best = options[0];
  for (const o of options) if (o[1] < best[1] - EPS) best = o;
  return { availableUsd: Math.max(0, best[1]), limitedBy: best[0], monthlyLeftUsd: Math.max(0, monthlyLeftUsd), reservedUsd };
}

export function availableBudget(i: BudgetInput): number {
  return budgetFor(i).availableUsd;
}

/** How many worst-case checks fit in usd (a tiny tolerance absorbs float error, never a whole check). */
export function affordableChecks(usd: number, costPerCheckUsd: number): number {
  if (!(costPerCheckUsd > 0) || !(usd > 0)) return 0;
  return Math.max(0, Math.floor(usd / costPerCheckUsd + EPS));
}
