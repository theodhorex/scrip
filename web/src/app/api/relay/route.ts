// POST /api/relay: Scrip's hosted relayer (NEAR testnet). Body: {"signed_delegate": "<base64 borsh SignedDelegate>"}.
// The relayer pays the gas of a request_payment meta transaction signed by a mandate's agent key. The checks are
// the facilitator's (src/lib/relayer/*), plus: the sender must be the agent of the mandate it pays from.
// GET /api/relay: health (relayer account and contract, no secrets).
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner } from "near-api-js";
import { LIVE } from "@/lib/live";
import { createHostedRelayer, toResponse, MAX_BODY_BYTES } from "@/lib/relayer/hosted.mjs";
import { createRateLimiter } from "@/lib/relayer/ratelimit.mjs";

export const maxDuration = 30;

const RPC_URL = "https://rpc.testnet.fastnear.com";
// The relayer keeps at least this much NEAR (yocto) and refuses to relay below it.
const MIN_BALANCE = BigInt("500000000000000000000000"); // 0.5 NEAR

type Hosted = ReturnType<typeof createHostedRelayer>;
let hosted: Hosted | null = null;
let relayerAccount: Account | null = null;
const ipLimiter = createRateLimiter({ capacity: 20, refillPerSecond: 1 });

function relayer(): Hosted | null {
  if (hosted) return hosted;
  const accountId = process.env.RELAYER_ACCOUNT_ID;
  const key = process.env.RELAYER_PRIVATE_KEY;
  if (!accountId || !key) return null;
  const provider = new JsonRpcProvider({ url: RPC_URL });
  const account = new Account(accountId, provider, new KeyPairSigner(KeyPair.fromString(key as `ed25519:${string}`)));
  relayerAccount = account;
  hosted = createHostedRelayer({
    provider,
    relayerAccount: account,
    contractId: LIVE.contractId,
    minBalance: MIN_BALANCE,
    relayerBalance: async () => BigInt((await account.getBalance()) ?? 0),
  });
  return hosted;
}

const HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...HEADERS, ...headers } });
}

function clientIp(req: Request): string {
  // On Vercel the platform sets x-forwarded-for; its first entry is the client.
  return (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
}

export async function GET() {
  const r = relayer();
  let code: string | undefined = r ? undefined : "RELAYER_NOT_CONFIGURED";
  if (r && relayerAccount) {
    // Report a relayer that would refuse for lack of gas money, so clients can pay gas themselves instead.
    try {
      if (BigInt((await relayerAccount.getBalance()) ?? 0) <= MIN_BALANCE) code = "RELAYER_LOW_BALANCE";
    } catch {
      // Balance unknown: report the relayer as up; a relay call re-checks the balance anyway.
    }
  }
  return json(200, {
    ok: code === undefined,
    network: "testnet",
    contract: LIVE.contractId,
    relayer: process.env.RELAYER_ACCOUNT_ID ?? null,
    methods: ["request_payment"],
    ...(code ? { code } : {}),
  });
}

export async function POST(req: Request) {
  const ip = ipLimiter.tryTake(clientIp(req));
  if (!ip.allowed) return json(429, { ok: false, code: "IP_RATE_LIMITED" }, { "retry-after": String(Math.max(1, Math.ceil(ip.retryAfterMs / 1000))) });
  if (!/^application\/json(\s*;|$)/i.test(req.headers.get("content-type") ?? "")) return json(415, { ok: false, code: "UNSUPPORTED_MEDIA_TYPE" });
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return json(413, { ok: false, code: "BODY_TOO_LARGE" });
  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return json(413, { ok: false, code: "BODY_TOO_LARGE" });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json(400, { ok: false, code: "BAD_JSON" });
  }
  const signed = (body as { signed_delegate?: unknown } | null)?.signed_delegate;
  if (typeof signed !== "string") return json(400, { ok: false, code: "BAD_REQUEST" });

  const r = relayer();
  if (!r) return json(503, { ok: false, code: "RELAYER_NOT_CONFIGURED" });
  const out = toResponse(await r.relay(signed));
  return json(out.status, out.body, out.headers as Record<string, string>);
}
