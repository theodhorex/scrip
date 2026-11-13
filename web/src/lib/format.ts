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

const TOKEN_NAMES: Record<string, string> = {
  "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af": "Testnet USDC",
  "wrap.testnet": "wNEAR",
};

/** Human name for a token contract id; unknown ids are shortened, never hidden. */
export function tokenName(id: string): string {
  return TOKEN_NAMES[id] ?? (id.length > 24 ? `${id.slice(0, 10)}…${id.slice(-6)}` : id);
}
