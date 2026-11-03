import { env } from "cloudflare:workers";
import { z } from "zod";

const STATE_KEY = "ga4setup:state";
const LOG_KEY = "ga4setup:log";

export type SiteStatus = {
  domain: string;
  projectId: string;
  status:
    | "pending"
    | "preview"
    | "created"
    | "tagged"
    | "live"
    | "linked"
    | "blocked"
    | "waiting"
    | "error";
  step?: string;
  propertyId?: string;
  measurementId?: string;
  detail?: string;
  attempts: number;
  updatedAt: string;
  nextTryAt?: string;
};
type State = Record<string, SiteStatus>;

export function kv(): KVNamespace | null {
  return env.KV ?? null;
}
export async function readState(): Promise<State> {
  const k = kv();
  if (!k) return {};
  return stateSchema.parse((await k.get(STATE_KEY, { type: "json" })) ?? {});
}
let stateLock: Promise<unknown> = Promise.resolve();
export async function patchState(
  domain: string,
  patch: Partial<SiteStatus> & { projectId: string },
) {
  const run = stateLock.then(async () => {
    const k = kv();
    if (!k) return;
    const s = await readState();
    const prev = s[domain] ?? {
      domain,
      projectId: patch.projectId,
      status: "pending",
      attempts: 0,
      updatedAt: "",
    };
    s[domain] = {
      ...prev,
      ...patch,
      domain,
      updatedAt: new Date().toISOString(),
    };
    await k.put(STATE_KEY, JSON.stringify(s));
  });
  stateLock = run.catch(() => undefined);
  return run;
}
/** One pass: older scope-403 "error" entries become "waiting" (single KV write). */
export async function migrateScopeErrorsToWaiting() {
  const run = stateLock.then(async () => {
    const k = kv();
    if (!k) return;
    const s = await readState();
    let n = 0;
    for (const v of Object.values(s)) {
      if (
        v.status === "error" &&
        /analytics\.edit|GA4_OAUTH_MANAGE_SCOPES|insufficient.*scope/i.test(
          v.detail ?? "",
        )
      ) {
        v.status = "waiting";
        v.detail = "waiting for Google Analytics reconnect with analytics.edit";
        v.attempts = 0;
        v.nextTryAt = new Date(Date.now() + 6 * 60 * 60_000).toISOString();
        n++;
      }
    }
    if (n) await k.put(STATE_KEY, JSON.stringify(s));
  });
  stateLock = run.catch(() => undefined);
  return run;
}
export async function appendLog(line: string) {
  const k = kv();
  if (!k) return;
  const log = z
    .array(z.string())
    .parse((await k.get(LOG_KEY, { type: "json" })) ?? []);
  log.unshift(`${new Date().toISOString()} ${line}`);
  await k.put(LOG_KEY, JSON.stringify(log.slice(0, 500)));
}
export async function readLog(): Promise<string[]> {
  const k = kv();
  return k
    ? z.array(z.string()).parse((await k.get(LOG_KEY, { type: "json" })) ?? [])
    : [];
}

const stateSchema: z.ZodType<State> = z.record(
  z.string(),
  z.object({
    domain: z.string(),
    projectId: z.string(),
    status: z.enum([
      "pending",
      "preview",
      "created",
      "tagged",
      "live",
      "linked",
      "blocked",
      "waiting",
      "error",
    ]),
    step: z.string().optional(),
    propertyId: z.string().optional(),
    measurementId: z.string().optional(),
    detail: z.string().optional(),
    attempts: z.number(),
    updatedAt: z.string(),
    nextTryAt: z.string().optional(),
  }),
);
