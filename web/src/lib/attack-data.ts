import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type AttackBroadcast = {
  n: number;
  accepted: number;
  refusedByRpc: number;
  burstMs: number;
};

export type AttackCaseResult = {
  contract: "naive" | "scrip";
  broadcast: AttackBroadcast;
  budget: string;
  merchantReceived: string;
  exceededBudget: boolean;
  overBudgetBy: string;
  paymentsPaid: string;
  spent: string;
  reserved: string;
  openRequests: number;
};

export type AttackParams = {
  N: number;
  PACE_MS: number;
  amount: string;
  budget: string;
  funded: string;
};

export type AttackRunResult = {
  network: string;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  params: AttackParams;
  cases: AttackCaseResult[];
  naive: AttackCaseResult | null;
  scrip: AttackCaseResult | null;
};

export type AttackCatalogCase = {
  id?: string;
  category: string | number;
  layer: string;
  expected: {
    label: string;
    [key: string]: unknown;
  };
  actual: {
    label: string;
    [key: string]: unknown;
  };
  verdict: string;
  [key: string]: unknown;
};

export type AttackCatalogSummary = {
  total?: number;
  byCategory?: Record<string, Record<string, number>>;
  byLayer?: Record<string, Record<string, number>>;
  byLabel?: Record<string, number>;
  [key: string]: unknown;
};

export type AttackCatalog = {
  cases: AttackCatalogCase[];
  summary?: AttackCatalogSummary;
  [key: string]: unknown;
};

export const CATEGORY_NAMES: Record<string, string> = {
  "1": "1. Penerima",
  "2": "2. Jumlah",
  "3": "3. Anggaran & paralel",
  "4": "4. Persetujuan & nonce",
  "5": "5. Akses & identitas",
  "6": "6. Delegate & kunci",
  "7": "7. Gas & sumber daya",
  "8": "8. Format & parsing",
  "9": "9. Fasilitator operasional",
  "10": "10. Siklus hidup mandat",
  "11": "11. Token & keuangan",
  "12": "12. Di luar jaminan (absurd)",
};

export type CategoryMatrixRow = {
  category: string;
  categoryName: string;
  blocked: number;
  inert: number;
  outOfScope: number;
  breach: number;
  total: number;
};

export function buildCategoryMatrix(cases: AttackCatalogCase[]): CategoryMatrixRow[] {
  const map = new Map<string, CategoryMatrixRow>();

  for (const c of cases) {
    const catKey = String(c.category);
    if (!map.has(catKey)) {
      map.set(catKey, {
        category: catKey,
        categoryName: CATEGORY_NAMES[catKey] ?? `Kategori ${catKey}`,
        blocked: 0,
        inert: 0,
        outOfScope: 0,
        breach: 0,
        total: 0,
      });
    }

    const row = map.get(catKey)!;
    row.total++;
    const label = c.actual?.label ?? c.expected?.label;
    if (label === "BLOCKED") row.blocked++;
    else if (label === "INERT") row.inert++;
    else if (label === "OUT_OF_SCOPE") row.outOfScope++;
    else if (label === "BREACH") row.breach++;
  }

  return Array.from(map.values()).sort((a, b) => {
    const numA = Number(a.category);
    const numB = Number(b.category);
    if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
    return a.category.localeCompare(b.category);
  });
}

export const LAYERS = ["A", "B", "C", "D", "E"] as const;
export const VERDICTS = ["PASS", "FAIL", "SKIPPED", "BREACH"] as const;
export type Verdict = (typeof VERDICTS)[number];
export type VerdictCounts = Record<Verdict, number> & { other: number; total: number };

export type LayerMatrixRow = {
  category: string;
  categoryName: string;
  cells: Record<string, VerdictCounts>;
  total: VerdictCounts;
};

function emptyCounts(): VerdictCounts {
  return { PASS: 0, FAIL: 0, SKIPPED: 0, BREACH: 0, other: 0, total: 0 };
}

function addVerdict(counts: VerdictCounts, verdict: string) {
  counts.total++;
  if ((VERDICTS as readonly string[]).includes(verdict)) counts[verdict as Verdict]++;
  else counts.other++;
}

/** Category x layer matrix of verdicts, exactly as recorded in the catalog. */
export function buildLayerMatrix(cases: AttackCatalogCase[]): LayerMatrixRow[] {
  const map = new Map<string, LayerMatrixRow>();
  for (const c of cases) {
    const catKey = String(c.category);
    let row = map.get(catKey);
    if (!row) {
      row = {
        category: catKey,
        categoryName: CATEGORY_NAMES[catKey] ?? `Kategori ${catKey}`,
        cells: {},
        total: emptyCounts(),
      };
      map.set(catKey, row);
    }
    const layer = c.layer.toUpperCase();
    row.cells[layer] ??= emptyCounts();
    addVerdict(row.cells[layer], c.verdict);
    addVerdict(row.total, c.verdict);
  }
  return Array.from(map.values()).sort((a, b) => {
    const na = Number(a.category);
    const nb = Number(b.category);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return a.category.localeCompare(b.category);
  });
}

export function totalsByLayer(rows: LayerMatrixRow[]): Record<string, VerdictCounts> {
  const out: Record<string, VerdictCounts> = {};
  for (const l of LAYERS) out[l] = emptyCounts();
  for (const r of rows)
    for (const [l, c] of Object.entries(r.cells)) {
      out[l] ??= emptyCounts();
      for (const v of VERDICTS) out[l][v] += c[v];
      out[l].other += c.other;
      out[l].total += c.total;
    }
  return out;
}

export function getOutOfScopeCases(cases: AttackCatalogCase[]): AttackCatalogCase[] {
  return cases.filter(
    (c) => c.actual?.label === "OUT_OF_SCOPE" || c.expected?.label === "OUT_OF_SCOPE",
  );
}

export function formatUsdcUnits(rawUnits: string | bigint, fractionDigits = 2): string {
  try {
    const units = typeof rawUnits === "bigint" ? rawUnits : BigInt(rawUnits || "0");
    const whole = units / BigInt(1_000_000);
    const rem = units % BigInt(1_000_000);
    const fullFrac = rem.toString().padStart(6, "0");
    const sliced = fullFrac.slice(0, fractionDigits).padEnd(fractionDigits, "0");
    return `${whole.toString()}.${sliced} USDC`;
  } catch {
    return "0.00 USDC";
  }
}

function resolveRepoPath(relativePath: string): string | null {
  const candidates: string[] = [
    // Current working directory
    resolve(process.cwd(), relativePath),
    // Up one level (if running from web/)
    resolve(process.cwd(), "..", relativePath),
  ];

  try {
    if (typeof import.meta.url === "string") {
      const currentDir = dirname(fileURLToPath(import.meta.url));
      // From web/src/lib/ up three levels to repo root
      candidates.push(resolve(currentDir, "../../..", relativePath));
    }
  } catch {
    // ignore
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function parseAttackResults(raw: unknown): AttackRunResult | null {
  if (!raw || typeof raw !== "object") return null;

  let runData: unknown = raw;
  if (Array.isArray(raw)) {
    if (raw.length === 0) return null;
    runData = raw[raw.length - 1]; // Use latest run
  }

  if (!runData || typeof runData !== "object" || Array.isArray(runData)) {
    return null;
  }

  const run = runData as Record<string, unknown>;

  if (typeof run.network !== "string" || !run.network) return null;
  if (typeof run.startedAt !== "string") return null;
  if (!run.params || typeof run.params !== "object") return null;

  const paramsObj = run.params as Record<string, unknown>;
  if (typeof paramsObj.N !== "number" || typeof paramsObj.amount !== "string" || typeof paramsObj.budget !== "string") {
    return null;
  }

  const params: AttackParams = {
    N: paramsObj.N,
    PACE_MS: typeof paramsObj.PACE_MS === "number" ? paramsObj.PACE_MS : 0,
    amount: paramsObj.amount,
    budget: paramsObj.budget,
    funded: typeof paramsObj.funded === "string" ? paramsObj.funded : "0",
  };

  if (!Array.isArray(run.cases) || run.cases.length === 0) {
    return null;
  }

  const cases: AttackCaseResult[] = [];
  let naiveCase: AttackCaseResult | null = null;
  let scripCase: AttackCaseResult | null = null;

  for (const item of run.cases) {
    if (!item || typeof item !== "object") return null;
    const c = item as Record<string, unknown>;

    if (c.contract !== "naive" && c.contract !== "scrip" && c.contract !== "amanat") return null;
    if (typeof c.budget !== "string" || typeof c.merchantReceived !== "string") return null;
    if (typeof c.exceededBudget !== "boolean" || typeof c.overBudgetBy !== "string") return null;
    if (typeof c.paymentsPaid !== "string" && typeof c.paymentsPaid !== "number") return null;

    if (!c.broadcast || typeof c.broadcast !== "object") return null;
    const b = c.broadcast as Record<string, unknown>;
    if (typeof b.n !== "number" || typeof b.accepted !== "number" || typeof b.burstMs !== "number") {
      return null;
    }

    const broadcast: AttackBroadcast = {
      n: b.n,
      accepted: b.accepted,
      refusedByRpc: typeof b.refusedByRpc === "number" ? b.refusedByRpc : 0,
      burstMs: b.burstMs,
    };

    const contract: "naive" | "scrip" = c.contract === "naive" ? "naive" : "scrip";

    const parsedCase: AttackCaseResult = {
      contract,
      broadcast,
      budget: c.budget,
      merchantReceived: c.merchantReceived,
      exceededBudget: c.exceededBudget,
      overBudgetBy: c.overBudgetBy,
      paymentsPaid: String(c.paymentsPaid),
      spent: typeof c.spent === "string" ? c.spent : c.merchantReceived,
      reserved: typeof c.reserved === "string" ? c.reserved : "0",
      openRequests: typeof c.openRequests === "number" ? c.openRequests : 0,
    };

    cases.push(parsedCase);
    if (parsedCase.contract === "naive") naiveCase = parsedCase;
    if (parsedCase.contract === "scrip") scripCase = parsedCase;
  }

  return {
    network: run.network,
    startedAt: run.startedAt,
    finishedAt: typeof run.finishedAt === "string" ? run.finishedAt : run.startedAt,
    ok: run.ok === true,
    params,
    cases,
    naive: naiveCase,
    scrip: scripCase,
  };
}

export function loadAttackResults(customPath?: string): AttackRunResult | null {
  try {
    const filePath = customPath ?? resolveRepoPath("results/attack.json");
    if (!filePath || !existsSync(filePath)) {
      return null;
    }

    const raw = readFileSync(filePath, "utf-8");
    const json = JSON.parse(raw);
    return parseAttackResults(json);
  } catch {
    return null;
  }
}

export function parseAttackCatalog(raw: unknown): AttackCatalog | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.cases)) return null;

  const validCases: AttackCatalogCase[] = [];

  for (const item of obj.cases) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const c = item as Record<string, unknown>;

    const category = typeof c.category === "number" ? String(c.category) : (typeof c.category === "string" ? c.category : null);
    if (!category) return null;
    if (typeof c.layer !== "string" || !c.layer) return null;
    if (typeof c.verdict !== "string" || !c.verdict) return null;

    if (!c.expected || typeof c.expected !== "object" || Array.isArray(c.expected)) return null;
    const exp = c.expected as Record<string, unknown>;
    if (typeof exp.label !== "string" || !exp.label) return null;

    if (!c.actual || typeof c.actual !== "object" || Array.isArray(c.actual)) return null;
    const act = c.actual as Record<string, unknown>;
    if (typeof act.label !== "string" || !act.label) return null;

    validCases.push(c as AttackCatalogCase);
  }

  const catalog: AttackCatalog = {
    cases: validCases,
  };

  if (obj.summary && typeof obj.summary === "object" && !Array.isArray(obj.summary)) {
    catalog.summary = obj.summary as AttackCatalogSummary;
  }

  return catalog;
}

export function loadAttackCatalog(customPath?: string): AttackCatalog | null {
  try {
    const filePath = customPath ?? resolveRepoPath("results/attack-catalog.json");
    if (!filePath || !existsSync(filePath)) {
      return null;
    }

    const raw = readFileSync(filePath, "utf-8");
    const json = JSON.parse(raw);
    return parseAttackCatalog(json);
  } catch {
    return null;
  }
}
