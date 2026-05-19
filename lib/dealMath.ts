/**
 * Deal calculation logic for the in-app settlement tool.
 *
 * Handles all five deal types:
 *   1. flat                — $X guaranteed, optional sellout/threshold bonuses
 *   2. percentage_of_gross — X% of gross, no expense deductions
 *   3. percentage_of_net   — X% of (gross − fees − capped expenses)
 *   4. vs                  — max(guarantee, percentage_of_net) + bonuses when % wins
 *   5. door                — gross minus capped expenses, artist takes the door
 *
 * Structured deal-level recoups (DealRecoup[]) are applied in the engine:
 *   - insideExpenseCap: true  → recoup counts within the expense cap ceiling
 *   - insideExpenseCap: false → recoup deducted from gross before cap is applied
 *
 * Bonuses are read from bonusesJson. Only structured bonuses are evaluated;
 * anything only in dealNotesFreetext is invisible to this engine.
 */

import type { Deal, Expense, TicketSale, Bonus, DealRecoup } from "@/db/schema";

export type SettlementCalculation =
  | {
      supported: true;
      grossBoxOffice: number;
      netBoxOffice: number;
      totalExpenses: number;
      totalToArtist: number;
      steps: { label: string; value: number; note?: string }[];
      finalFormula: string;
      bonusesApplied: { label: string; amount: number; reason: string }[];
      bonusesNotTriggered: { label: string; amount: number; reason: string }[];
    }
  | {
      supported: false;
      reason: string;
      dealType: Deal["dealType"];
    };

interface CalcInput {
  deal: Deal;
  ticketSales: TicketSale[];
  expenses: Expense[];
  venueCapacity?: number;
  ticketsSold?: number;
  dealRecoups?: DealRecoup[];
}

export function parseBonuses(deal: Deal): Bonus[] {
  if (!deal.bonusesJson) return [];
  try {
    const parsed = JSON.parse(deal.bonusesJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function parseDealRecoups(deal: Deal): DealRecoup[] {
  if (!deal.dealRecoupsJson) return [];
  try {
    const parsed = JSON.parse(deal.dealRecoupsJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function calculateSettlement(input: CalcInput): SettlementCalculation {
  const { deal, ticketSales, expenses, venueCapacity, dealRecoups = [] } = input;

  const grossBoxOffice = ticketSales.reduce((sum, t) => sum + t.gross, 0);
  const totalFees = ticketSales.reduce((sum, t) => sum + t.fees, 0);
  const netBoxOffice = grossBoxOffice - totalFees;
  const totalExpenses = expenses
    .filter((e) => !e.absorbedByVenue)
    .reduce((sum, e) => sum + e.amount, 0);

  const tickets =
    input.ticketsSold ?? ticketSales.reduce((sum, t) => sum + (t.qty ?? 0), 0);

  // ---------- flat guarantee ----------
  if (deal.dealType === "flat") {
    if (deal.guaranteeAmount == null) {
      return {
        supported: false,
        reason: "Flat deal is missing a guarantee amount.",
        dealType: deal.dealType,
      };
    }
    const bonusResult = applyBonuses(parseBonuses(deal), {
      gross: grossBoxOffice,
      tickets,
      capacity: venueCapacity,
    });

    return {
      supported: true,
      grossBoxOffice,
      netBoxOffice,
      totalExpenses,
      totalToArtist: deal.guaranteeAmount + bonusResult.totalApplied,
      steps: [
        {
          label: "Flat guarantee",
          value: deal.guaranteeAmount,
          note: "No expense deductions. The guarantee is the floor.",
        },
        ...bonusResult.applied.map((b) => ({
          label: b.label,
          value: b.amount,
          note: b.reason,
        })),
      ],
      finalFormula: bonusResult.applied.length
        ? `flat ${deal.guaranteeAmount} + bonuses ${bonusResult.totalApplied} = ${(deal.guaranteeAmount + bonusResult.totalApplied).toFixed(2)}`
        : `flat guarantee = ${deal.guaranteeAmount}`,
      bonusesApplied: bonusResult.applied,
      bonusesNotTriggered: bonusResult.notTriggered,
    };
  }

  // ---------- percentage of gross ----------
  if (deal.dealType === "percentage_of_gross") {
    if (deal.percentage == null) {
      return {
        supported: false,
        reason: "Percentage-of-gross deal is missing a percentage.",
        dealType: deal.dealType,
      };
    }
    const payout = grossBoxOffice * deal.percentage;
    const bonusResult = applyBonuses(parseBonuses(deal), {
      gross: grossBoxOffice,
      tickets,
      capacity: venueCapacity,
    });

    return {
      supported: true,
      grossBoxOffice,
      netBoxOffice,
      totalExpenses,
      totalToArtist: payout + bonusResult.totalApplied,
      steps: [
        { label: "Gross box office", value: grossBoxOffice },
        {
          label: `× ${(deal.percentage * 100).toFixed(0)}%`,
          value: payout,
          note: "Percentage of gross — no expense deductions.",
        },
        ...bonusResult.applied.map((b) => ({
          label: b.label,
          value: b.amount,
          note: b.reason,
        })),
      ],
      finalFormula: bonusResult.applied.length
        ? `gross × ${deal.percentage} + bonuses = ${(payout + bonusResult.totalApplied).toFixed(2)}`
        : `gross × ${deal.percentage} = ${payout.toFixed(2)}`,
      bonusesApplied: bonusResult.applied,
      bonusesNotTriggered: bonusResult.notTriggered,
    };
  }

  // ---------- percentage of net ----------
  if (deal.dealType === "percentage_of_net") {
    if (deal.percentage == null) {
      return {
        supported: false,
        reason: "Percentage-of-net deal is missing a percentage.",
        dealType: deal.dealType,
      };
    }
    const recoups = resolveRecoups(dealRecoups, totalExpenses, deal.expenseCap ?? null);
    const adjustedNet = Math.max(0, netBoxOffice - recoups.offGrossTotal - recoups.cappedPassthrough);
    const payout = adjustedNet * deal.percentage;
    const bonusResult = applyBonuses(parseBonuses(deal), {
      gross: grossBoxOffice,
      tickets,
      capacity: venueCapacity,
    });

    return {
      supported: true,
      grossBoxOffice,
      netBoxOffice,
      totalExpenses,
      totalToArtist: payout + bonusResult.totalApplied,
      steps: [
        { label: "Gross box office", value: grossBoxOffice },
        { label: "Less CC + platform fees", value: -totalFees },
        ...recoups.recoupSteps,
        {
          label: deal.expenseCap != null
            ? `Less expenses (capped at ${fmt(deal.expenseCap)})`
            : "Less expenses",
          value: -recoups.cappedPassthrough,
          note: buildExpenseNote(totalExpenses, recoups.insideCapTotal, deal.expenseCap),
        },
        {
          label: `× ${(deal.percentage * 100).toFixed(0)}%`,
          value: payout,
        },
        ...bonusResult.applied.map((b) => ({
          label: b.label,
          value: b.amount,
          note: b.reason,
        })),
      ],
      finalFormula: `net × ${deal.percentage} = ${payout.toFixed(2)}`,
      bonusesApplied: bonusResult.applied,
      bonusesNotTriggered: bonusResult.notTriggered,
    };
  }

  // ---------- vs deal ----------
  if (deal.dealType === "vs") {
    if (deal.guaranteeAmount == null || deal.percentage == null) {
      return {
        supported: false,
        reason: "Vs deal requires both a guarantee amount and a percentage.",
        dealType: deal.dealType,
      };
    }
    const recoups = resolveRecoups(dealRecoups, totalExpenses, deal.expenseCap ?? null);
    const netAfterExpenses = Math.max(
      0,
      netBoxOffice - recoups.offGrossTotal - recoups.cappedPassthrough,
    );
    const pctPayout = netAfterExpenses * deal.percentage;
    const percentageWins = pctPayout >= deal.guaranteeAmount;
    const base = Math.max(deal.guaranteeAmount, pctPayout);

    const bonusResult = percentageWins
      ? applyBonuses(parseBonuses(deal), { gross: grossBoxOffice, tickets, capacity: venueCapacity })
      : {
          applied: [] as { label: string; amount: number; reason: string }[],
          notTriggered: parseBonuses(deal).map((b) => ({
            label: b.label,
            amount: "amount" in b ? (b as { amount: number }).amount : 0,
            reason: "Guarantee applies — percentage didn't exceed floor",
          })),
          totalApplied: 0,
        };

    return {
      supported: true,
      grossBoxOffice,
      netBoxOffice,
      totalExpenses,
      totalToArtist: base + bonusResult.totalApplied,
      steps: [
        { label: "Gross box office", value: grossBoxOffice },
        { label: "Less CC + platform fees", value: -totalFees },
        ...recoups.recoupSteps,
        {
          label: deal.expenseCap != null
            ? `Less expenses (capped at ${fmt(deal.expenseCap)})`
            : "Less expenses",
          value: -recoups.cappedPassthrough,
          note: buildExpenseNote(totalExpenses, recoups.insideCapTotal, deal.expenseCap),
        },
        { label: "Net after all deductions", value: netAfterExpenses },
        {
          label: `× ${(deal.percentage * 100).toFixed(0)}% (percentage payout)`,
          value: pctPayout,
        },
        {
          label: percentageWins
            ? "Guarantee floor (not triggered)"
            : "Guarantee floor applies",
          value: deal.guaranteeAmount,
          note: percentageWins
            ? `Percentage ${fmt(pctPayout)} > guarantee — percentage wins`
            : `Percentage ${fmt(pctPayout)} < guarantee — guarantee applies`,
        },
        ...bonusResult.applied.map((b) => ({
          label: b.label,
          value: b.amount,
          note: b.reason,
        })),
      ],
      finalFormula: percentageWins
        ? `max(guarantee, net × ${deal.percentage}) = ${base.toFixed(2)}`
        : `guarantee floor = ${deal.guaranteeAmount}`,
      bonusesApplied: bonusResult.applied,
      bonusesNotTriggered: bonusResult.notTriggered,
    };
  }

  // ---------- door deal ----------
  if (deal.dealType === "door") {
    const cappedExpenses = Math.min(totalExpenses, deal.expenseCap ?? totalExpenses);
    const payout = Math.max(0, grossBoxOffice - cappedExpenses);
    return {
      supported: true,
      grossBoxOffice,
      netBoxOffice,
      totalExpenses,
      totalToArtist: payout,
      steps: [
        { label: "Gross box office", value: grossBoxOffice },
        {
          label: deal.expenseCap != null
            ? `Less expenses (capped at ${fmt(deal.expenseCap)})`
            : "Less expenses",
          value: -cappedExpenses,
        },
      ],
      finalFormula: `gross − expenses = ${payout.toFixed(2)}`,
      bonusesApplied: [],
      bonusesNotTriggered: [],
    };
  }

  // Should never reach here given the exhaustive switch above, but TypeScript needs it
  return {
    supported: false,
    dealType: deal.dealType,
    reason: `Unknown deal type: ${deal.dealType}`,
  };
}

// ── Private helpers ─────────────────────────────────────────────────────────

function resolveRecoups(
  dealRecoups: DealRecoup[],
  passthroughExpenses: number,
  expenseCap: number | null,
): {
  offGrossTotal: number;
  insideCapTotal: number;
  cappedPassthrough: number;
  recoupSteps: { label: string; value: number; note: string }[];
} {
  const offGross = dealRecoups.filter((r) => !r.insideExpenseCap);
  const insideCap = dealRecoups.filter((r) => r.insideExpenseCap);

  const offGrossTotal = offGross.reduce((s, r) => s + r.amount, 0);
  const insideCapTotal = insideCap.reduce((s, r) => s + r.amount, 0);
  const capLimit = expenseCap ?? Infinity;
  const cappedPassthrough = Math.min(passthroughExpenses + insideCapTotal, capLimit);

  const recoupSteps = offGross.map((r) => ({
    label: r.label,
    value: -r.amount,
    note: "Off gross — separate deduction before expense cap",
  }));

  return { offGrossTotal, insideCapTotal, cappedPassthrough, recoupSteps };
}

function fmt(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function buildExpenseNote(
  passthrough: number,
  insideCapRecoupTotal: number,
  cap: number | null,
): string | undefined {
  if (insideCapRecoupTotal === 0) return undefined;
  const parts = [
    `${fmt(passthrough)} other expenses`,
    `${fmt(insideCapRecoupTotal)} recoup inside cap`,
  ];
  if (cap != null) parts.push(`cap ${fmt(cap)}`);
  return parts.join(" + ").replace(` + cap ${fmt(cap!)}`, `; cap ${fmt(cap!)}`);
}

/** Evaluate a list of bonuses against the show's actual numbers. */
function applyBonuses(
  bonuses: Bonus[],
  ctx: { gross: number; tickets: number; capacity?: number },
) {
  const applied: { label: string; amount: number; reason: string }[] = [];
  const notTriggered: { label: string; amount: number; reason: string }[] = [];

  for (const b of bonuses) {
    if (b.type === "gross_threshold") {
      if (ctx.gross >= b.threshold) {
        applied.push({
          label: b.label,
          amount: b.amount,
          reason: `Gross ${ctx.gross.toLocaleString()} ≥ ${b.threshold.toLocaleString()}`,
        });
      } else {
        notTriggered.push({
          label: b.label,
          amount: b.amount,
          reason: `Gross ${ctx.gross.toLocaleString()} < ${b.threshold.toLocaleString()}`,
        });
      }
    } else if (b.type === "sellout") {
      if (ctx.capacity != null && ctx.tickets >= ctx.capacity * 0.95) {
        applied.push({
          label: b.label,
          amount: b.amount,
          reason: `${ctx.tickets} of ${ctx.capacity} sold`,
        });
      } else {
        notTriggered.push({
          label: b.label,
          amount: b.amount,
          reason:
            ctx.capacity != null
              ? `${ctx.tickets} of ${ctx.capacity} sold (sellout = ≥95%)`
              : `Capacity unknown — can't evaluate`,
        });
      }
    } else if (b.type === "attendance_threshold") {
      if (ctx.tickets >= b.threshold) {
        applied.push({
          label: b.label,
          amount: b.amount,
          reason: `${ctx.tickets} ≥ ${b.threshold}`,
        });
      } else {
        notTriggered.push({
          label: b.label,
          amount: b.amount,
          reason: `${ctx.tickets} < ${b.threshold}`,
        });
      }
    } else if (b.type === "tier_ratchet") {
      notTriggered.push({
        label: b.label,
        amount: 0,
        reason: "Tier ratchets need vs-deal or % of net support — not yet handled",
      });
    }
  }

  return {
    applied,
    notTriggered,
    totalApplied: applied.reduce((s, b) => s + b.amount, 0),
  };
}
