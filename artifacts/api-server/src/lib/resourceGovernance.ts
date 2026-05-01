import type { Request, Response } from "express";

export type GenerationPath = "ai" | "meme" | "video";
export type Tier = "unregistered" | "registered" | "legendary" | "admin";

export interface GovernancePolicy {
  dailySpendCapUsd: number;
  monthlySpendCapUsd: number;
  requestsPerDay: number;
  concurrentGenerations: number;
  maxDurationSec: number;
  maxPayloadBytes: number;
}

const POLICIES: Record<Tier, GovernancePolicy> = {
  unregistered: { dailySpendCapUsd: 0, monthlySpendCapUsd: 0, requestsPerDay: 0, concurrentGenerations: 0, maxDurationSec: 0, maxPayloadBytes: 0 },
  registered: { dailySpendCapUsd: 3, monthlySpendCapUsd: 25, requestsPerDay: 25, concurrentGenerations: 1, maxDurationSec: 8, maxPayloadBytes: 1_500_000 },
  legendary: { dailySpendCapUsd: 20, monthlySpendCapUsd: 250, requestsPerDay: 250, concurrentGenerations: 3, maxDurationSec: 30, maxPayloadBytes: 8_000_000 },
  admin: { dailySpendCapUsd: 200, monthlySpendCapUsd: 2000, requestsPerDay: 2000, concurrentGenerations: 10, maxDurationSec: 120, maxPayloadBytes: 25_000_000 },
};

type UsageEvent = {
  at: number; userId: string; endpoint: string; provider: string; model: string;
  estimatedCostUsd: number; actualCostUsd: number; accepted: boolean; rejectReason?: string;
};

const usageEvents: UsageEvent[] = [];
const idempotencyCache = new Map<string, { status: number; body: unknown; expiresAt: number }>();
const inFlightByUser = new Map<string, number>();
const providerHealth = new Map<string, { fails: number; latencyMs: number[]; openedUntil: number }>();

export function enforceGovernance(req: Request, res: Response, opts: { path: GenerationPath; estimatedCostUsd?: number; provider: string; model: string; maxDurationSec?: number; payloadBytes?: number }): { ok: boolean; idempotencyKey: string | null } {
  const userId = req.user?.id ?? "anon";
  const tier = (req.user?.realUserRole === "admin" ? "admin" : (req.user?.membershipTier ?? "unregistered")) as Tier;
  const policy = POLICIES[tier];
  const endpoint = req.path;
  const idempotencyKey = req.header("idempotency-key") ?? null;

  if (idempotencyKey) {
    const cached = idempotencyCache.get(`${userId}:${endpoint}:${idempotencyKey}`);
    if (cached && cached.expiresAt > Date.now()) {
      res.status(cached.status).json(cached.body);
      return { ok: false, idempotencyKey };
    }
  }

  const now = Date.now();
  const dayAgo = now - 86_400_000;
  const monthAgo = now - 30 * 86_400_000;
  const userEvents = usageEvents.filter((e) => e.userId === userId && e.accepted);
  const requestsToday = userEvents.filter((e) => e.at >= dayAgo).length;
  const spendDay = userEvents.filter((e) => e.at >= dayAgo).reduce((s, e) => s + e.actualCostUsd, 0);
  const spendMonth = userEvents.filter((e) => e.at >= monthAgo).reduce((s, e) => s + e.actualCostUsd, 0);
  const concurrency = inFlightByUser.get(userId) ?? 0;

  const reject = (reason: string, status = 429) => {
    usageEvents.push({ at: now, userId, endpoint, provider: opts.provider, model: opts.model, estimatedCostUsd: opts.estimatedCostUsd ?? 0, actualCostUsd: 0, accepted: false, rejectReason: reason });
    res.status(status).json({ error: "RESOURCE_GOVERNANCE_REJECTED", reason });
  };

  if (requestsToday >= policy.requestsPerDay) return reject("REQUESTS_PER_DAY_EXCEEDED"), { ok: false, idempotencyKey };
  if (spendDay + (opts.estimatedCostUsd ?? 0) > policy.dailySpendCapUsd) return reject("DAILY_SPEND_CAP_EXCEEDED"), { ok: false, idempotencyKey };
  if (spendMonth + (opts.estimatedCostUsd ?? 0) > policy.monthlySpendCapUsd) return reject("MONTHLY_SPEND_CAP_EXCEEDED"), { ok: false, idempotencyKey };
  if (concurrency >= policy.concurrentGenerations) return reject("CONCURRENT_GENERATION_LIMIT"), { ok: false, idempotencyKey };
  if ((opts.maxDurationSec ?? 0) > policy.maxDurationSec) return reject("MAX_DURATION_EXCEEDED", 400), { ok: false, idempotencyKey };
  if ((opts.payloadBytes ?? 0) > policy.maxPayloadBytes) return reject("MAX_PAYLOAD_EXCEEDED", 400), { ok: false, idempotencyKey };

  const health = providerHealth.get(opts.provider);
  if (health && health.openedUntil > now) return reject("PROVIDER_CIRCUIT_OPEN", 503), { ok: false, idempotencyKey };

  inFlightByUser.set(userId, concurrency + 1);
  usageEvents.push({ at: now, userId, endpoint, provider: opts.provider, model: opts.model, estimatedCostUsd: opts.estimatedCostUsd ?? 0, actualCostUsd: 0, accepted: true });
  return { ok: true, idempotencyKey };
}

export function completeGovernance(req: Request, info: { provider: string; latencyMs: number; failed: boolean; actualCostUsd: number; responseStatus?: number; responseBody?: unknown; idempotencyKey?: string | null }) {
  const userId = req.user?.id ?? "anon";
  inFlightByUser.set(userId, Math.max(0, (inFlightByUser.get(userId) ?? 1) - 1));
  for (let i = usageEvents.length - 1; i >= 0; i--) {
    const e = usageEvents[i]!;
    if (e.userId === userId && e.endpoint === req.path && e.accepted && e.actualCostUsd === 0) { e.actualCostUsd = info.actualCostUsd; break; }
  }
  const h = providerHealth.get(info.provider) ?? { fails: 0, latencyMs: [], openedUntil: 0 };
  h.latencyMs.push(info.latencyMs); if (h.latencyMs.length > 25) h.latencyMs.shift();
  const avg = h.latencyMs.reduce((a, b) => a + b, 0) / h.latencyMs.length;
  h.fails = info.failed ? h.fails + 1 : 0;
  if (h.fails >= 3 || avg > 10_000) h.openedUntil = Date.now() + 60_000;
  providerHealth.set(info.provider, h);
  if (info.idempotencyKey && info.responseStatus && info.responseBody) {
    idempotencyCache.set(`${userId}:${req.path}:${info.idempotencyKey}`, { status: info.responseStatus, body: info.responseBody, expiresAt: Date.now() + 10 * 60_000 });
  }
}

export function getGovernanceAdminView() {
  const spendByUser = new Map<string, number>();
  for (const e of usageEvents) spendByUser.set(e.userId, (spendByUser.get(e.userId) ?? 0) + e.actualCostUsd);
  const topSpenders = [...spendByUser.entries()].sort((a,b)=>b[1]-a[1]).slice(0,20).map(([userId, total]) => ({ userId, total }));
  const rejections = usageEvents.filter((e) => !e.accepted).slice(-200);
  const alerts = [...providerHealth.entries()].filter(([,h]) => h.openedUntil > Date.now()).map(([provider,h])=>({ provider, openedUntil: h.openedUntil }));
  return { topSpenders, rejections, alerts };
}
