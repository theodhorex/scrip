const USDC_DECIMALS = 6;

export function formatUnits(value: string, decimals = USDC_DECIMALS): string {
  const v = BigInt(value);
  const base = BigInt(10) ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  const wholeStr = whole.toLocaleString("en-US");
  return frac ? `${wholeStr}.${frac}` : wholeStr;
}

export function formatUsdc(value: string): string {
  return `${formatUnits(value)} USDC`;
}

// Share of `part` in `total` as a 0-100 number, for bar widths.
export function percent(part: string, total: string): number {
  const t = BigInt(total);
  if (t === BigInt(0)) return 0;
  return Number((BigInt(part) * BigInt(10000)) / t) / 100;
}

// budget - spent - reserved, clamped at 0. Use isOverdrawn to detect a violated invariant.
export function remaining(budget: string, spent: string, reserved: string): string {
  const left = BigInt(budget) - BigInt(spent) - BigInt(reserved);
  return (left > BigInt(0) ? left : BigInt(0)).toString();
}

export function isOverdrawn(budget: string, spent: string, reserved: string): boolean {
  return BigInt(spent) + BigInt(reserved) > BigInt(budget);
}

export function formatTime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}
