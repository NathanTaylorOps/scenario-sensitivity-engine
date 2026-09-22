import type { Decision, Driver } from "./types.ts";
import { distributionRange } from "./validation.ts";

/**
 * Soft guardrails for the driver editor — deliberately the other half of a
 * two-tier system, not a replacement for `validation.ts`:
 *
 *   - `validatePersona` (validation.ts) is a HARD, non-bypassable check: an
 *     inverted min/max, a negative capex, a percentage entered as "26"
 *     instead of "0.26" — these are just wrong, and the editor must refuse
 *     to save them, full stop.
 *   - This module is a SOFT, non-blocking warning: a value that's valid but
 *     unusual compared to the range this driver originally shipped with. A
 *     real business reason to move outside a sourced range is entirely
 *     possible (a specific supplier quote, a known one-off condition) — the
 *     point isn't to block that, it's to make sure it doesn't happen
 *     silently. The editor shows these warnings and carries them into any
 *     exported scenario file, but never refuses to save over one.
 */

export interface GuardrailWarning {
  driverId: string;
  message: string;
}

function formatRange(range: { low: number; high: number }): string {
  const round = (n: number) => (Number.isInteger(n) ? n : Math.round(n * 1000) / 1000);
  return `${round(range.low)} to ${round(range.high)}`;
}

/**
 * Compares one edited driver against the baseline (built-in default or
 * template) it started from. Returns null if the edit looks unremarkable.
 * Two checks, deliberately simple enough to explain in one sentence each:
 *
 *   1. No overlap at all with the originally sourced range — the strongest
 *      signal something was typo'd or the person genuinely moved to a
 *      different real-world assumption without updating the rationale.
 *   2. The uncertainty range's width changed by more than 4x in either
 *      direction — a huge jump in confidence (either direction) that's
 *      worth a second look even when the center is unchanged.
 */
export function compareDriverToBaseline(edited: Driver, baseline: Driver): GuardrailWarning | null {
  const editedRange = distributionRange(edited.distribution);
  const baselineRange = distributionRange(baseline.distribution);
  if (!editedRange || !baselineRange) return null;

  const overlaps = editedRange.low <= baselineRange.high && editedRange.high >= baselineRange.low;
  if (!overlaps) {
    return {
      driverId: edited.id,
      message: `"${edited.label}" was edited to ${formatRange(editedRange)}, which no longer overlaps its originally sourced range (${formatRange(baselineRange)}). Not blocked — just make sure the reason for the change is written into this driver's rationale.`,
    };
  }

  const baselineWidth = baselineRange.high - baselineRange.low;
  const editedWidth = editedRange.high - editedRange.low;
  if (baselineWidth > 0) {
    if (editedWidth > baselineWidth * 4) {
      return {
        driverId: edited.id,
        message: `"${edited.label}"'s uncertainty range is now much wider than its sourced default (${formatRange(editedRange)} vs. ${formatRange(baselineRange)}) — confirm this reflects genuinely lower confidence, not a units slip in the bounds.`,
      };
    }
    if (editedWidth < baselineWidth * 0.1) {
      return {
        driverId: edited.id,
        message: `"${edited.label}"'s uncertainty range is now much narrower than its sourced default (${formatRange(editedRange)} vs. ${formatRange(baselineRange)}) — confirm this reflects genuinely higher confidence, not an accidental near-constant.`,
      };
    }
  }

  return null;
}

/** Runs compareDriverToBaseline across every driver the edited decision
 * shares with its baseline. A driver present only in `edited` (newly added
 * by the person, not present in the template/baseline) has nothing to
 * compare against and is silently skipped — that's expected, not a gap. */
export function compareDecisionToBaseline(edited: Decision, baseline: Decision): GuardrailWarning[] {
  const baselineById = new Map(baseline.drivers.map((d) => [d.id, d]));
  const warnings: GuardrailWarning[] = [];
  for (const driver of edited.drivers) {
    const base = baselineById.get(driver.id);
    if (!base) continue;
    const warning = compareDriverToBaseline(driver, base);
    if (warning) warnings.push(warning);
  }
  return warnings;
}
