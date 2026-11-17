/**
 * Self-hosted OpenSEO runs every request, cron job and binding (D1, R2) on
 * workerd's single event-loop thread. workerd only polls its sockets, and so
 * only accepts a new HTTP request, when its event queue runs empty. D1 and R2
 * calls are served inside the same process, so a job that awaits one binding
 * call after another never empties the queue: page requests and timers wait
 * until the whole job finishes. Measured on miniflare 4.20260625 (workerd
 * 1.20260625.1): a 4 s loop of awaited D1 or R2 calls held a /health request
 * for the full 4 s and a setInterval never fired; a setTimeout(0) every few
 * calls let /health through.
 *
 * yieldIfBusy hands the thread back with a setTimeout(0) once SLICE_MS have
 * passed since the last hand-back, so long chains of binding calls (and long
 * synchronous loops that call it) let queued requests run. When the loop was
 * idle anyway the extra timer costs one turn of the event loop.
 */

// Held from module load so test fake timers cannot stall it.
const realSetTimeout = globalThis.setTimeout;
const SLICE_MS = 20;
let lastYield = 0;

export function yieldIfBusy(): Promise<void> | undefined {
  const now = Date.now();
  if (now - lastYield < SLICE_MS) return undefined;
  lastYield = now;
  return new Promise<void>((resolve) =>
    realSetTimeout(() => {
      lastYield = Date.now();
      resolve();
    }, 0),
  );
}

function afterYield<T>(call: () => Promise<T>): Promise<T> {
  const pending = yieldIfBusy();
  return pending ? pending.then(call) : call();
}

type Method = (...args: unknown[]) => unknown;

/** Patch the methods in place so the binding still receives its own objects. */
function patchMethods(
  target: object,
  names: readonly string[],
  wrap: (original: Method) => Method,
) {
  const record = target as Record<string, unknown>;
  for (const name of names) {
    const original = record[name];
    if (typeof original === "function")
      record[name] = wrap((original as Method).bind(target));
  }
  return target;
}

function cooperativeStatement<S extends object>(statement: S): S {
  patchMethods(
    statement,
    ["first", "all", "raw", "run"],
    (original) =>
      (...args) =>
        afterYield(() => original(...args) as Promise<unknown>),
  );
  return patchMethods(
    statement,
    ["bind"],
    (original) =>
      (...args) =>
        cooperativeStatement(original(...args) as object),
  ) as S;
}

/** A D1 binding whose queries hand the thread back to queued requests. */
export function cooperativeD1(database: D1Database): D1Database {
  // Unit tests load the client without a binding.
  if (typeof database !== "object" || database === null) return database;
  return new Proxy(database, {
    get(target, prop) {
      if (prop === "prepare")
        return (query: string) => cooperativeStatement(target.prepare(query));
      if (prop === "batch" || prop === "exec")
        return (...args: unknown[]) =>
          afterYield(
            () =>
              (Reflect.get(target, prop) as Method).apply(
                target,
                args,
              ) as Promise<unknown>,
          );
      const value: unknown = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** An R2 binding whose calls hand the thread back to queued requests. */
export function cooperativeR2(bucket: R2Bucket): R2Bucket {
  if (typeof bucket !== "object" || bucket === null) return bucket;
  return new Proxy(bucket, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (typeof value !== "function") return value;
      const method = (value as Method).bind(target);
      return typeof prop === "string" &&
        ["get", "put", "head", "list", "delete"].includes(prop)
        ? (...args: unknown[]) =>
            afterYield(() => method(...args) as Promise<unknown>)
        : method;
    },
  });
}
