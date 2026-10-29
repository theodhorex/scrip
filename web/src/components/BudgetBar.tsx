import { formatUsdc, isOverdrawn, percent, remaining } from "@/lib/format";
import type { U128 } from "@/lib/types";

type BudgetBarProps = {
  spent: U128;
  reserved: U128;
  budget: U128;
  showLegend?: boolean;
};

// Segments are told apart by fill pattern as well as colour: solid = spent,
// hatched = reserved, empty = remaining. Widths are fixed; the entrance
// animation scales each segment from the left (transform only).
export function BudgetBar({
  spent,
  reserved,
  budget,
  showLegend = false,
}: BudgetBarProps) {
  const spentPct = percent(spent, budget);
  const reservedPct = percent(reserved, budget);
  const overdrawn = isOverdrawn(budget, spent, reserved);
  const remainingStr = remaining(budget, spent, reserved);
  const remainingPct = percent(remainingStr, budget);

  const ariaText = `Budget: ${formatUsdc(budget)} total. Spent: ${formatUsdc(
    spent
  )} (${spentPct.toFixed(1)}%). Reserved: ${formatUsdc(
    reserved
  )} (${reservedPct.toFixed(1)}%). Remaining: ${formatUsdc(
    remainingStr
  )} (${remainingPct.toFixed(1)}%).`;

  return (
    <div className="w-full space-y-1.5">
      <div
        role="img"
        aria-label={ariaText}
        className={`bp-app-bar ${overdrawn ? "bp-app-bar-over" : ""}`}
      >
        {spentPct > 0 && (
          <div
            style={{ width: `${spentPct}%` }}
            className="bp-app-seg bp-app-seg-spent"
            title={`Spent: ${formatUsdc(spent)}`}
          />
        )}
        {reservedPct > 0 && (
          <div
            style={{ width: `${reservedPct}%` }}
            className="bp-app-seg bp-app-seg-reserved"
            title={`Reserved: ${formatUsdc(reserved)}`}
          />
        )}
        {remainingPct > 0 && (
          <div
            style={{ width: `${remainingPct}%` }}
            className="bp-app-seg bp-app-seg-left"
            title={`Remaining: ${formatUsdc(remainingStr)}`}
          />
        )}
      </div>
      {overdrawn && (
        <p role="alert" className="text-xs font-medium text-bp-reject bp-app-mono">
          ✕ INVARIANT_VIOLATED: spent + reserved exceeds budget.
        </p>
      )}
      {showLegend && (
        <div className="bp-app-legend">
          <div className="bp-app-legend-items bp-tabular">
            <span>
              <i className="bp-app-swatch" style={{ background: "var(--bp-pass)" }} aria-hidden="true" />
              Spent {spentPct.toFixed(0)}%
            </span>
            <span>
              <i
                className="bp-app-swatch"
                style={{ background: "repeating-linear-gradient(135deg, var(--bp-pass) 0 2px, var(--bp-canvas) 2px 4px)" }}
                aria-hidden="true"
              />
              Reserved {reservedPct.toFixed(0)}%
            </span>
            <span>
              <i className="bp-app-swatch" style={{ background: "var(--bp-line-strong)" }} aria-hidden="true" />
              Remaining {remainingPct.toFixed(0)}%
            </span>
          </div>
          <span className="bp-app-mono text-bp-ink">{formatUsdc(budget)}</span>
        </div>
      )}
    </div>
  );
}
