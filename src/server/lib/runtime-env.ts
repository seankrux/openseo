import { isHostedAuthMode } from "@/lib/auth-mode";

let workersEnvPromise: Promise<Record<string, unknown> | null> | null = null;

export async function getOptionalEnvValue(
  name: string,
): Promise<string | undefined> {
  return getEnvValueSync((await getWorkersEnv()) ?? {}, name);
}

/**
 * Sync variant for callers that already hold an env record (e.g. a Durable
 * Object's `this.env`, needed because Think's `getModel()` hook is sync).
 * Same policy as the async form: process.env first (where local `.env.local`
 * secrets land in dev), skipping empty strings, then the given env.
 * In Vitest, explicit mocked worker env bindings take precedence over the
 * container's process.env so unit tests can override AUTH_MODE / secrets.
 */
export function getEnvValueSync(env: object, name: string): string | undefined {
  const isVitest =
    typeof process !== "undefined" && process.env?.VITEST === "true";
  if (isVitest) {
    const workerVal: unknown = Reflect.get(env, name);
    if (typeof workerVal === "string" && workerVal !== "") {
      return workerVal;
    }
  }
  const processValue =
    typeof process !== "undefined" ? process.env?.[name] : undefined;
  if (processValue) {
    return processValue;
  }
  const value: unknown = Reflect.get(env, name);
  return typeof value === "string" && value !== "" ? value : undefined;
}

export async function getRequiredEnvValue(name: string): Promise<string> {
  const value = await getOptionalEnvValue(name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export async function isHostedServerAuthMode(): Promise<boolean> {
  return isHostedAuthMode(await getOptionalEnvValue("AUTH_MODE"));
}

async function getWorkersEnv(): Promise<Record<string, unknown> | null> {
  if (!workersEnvPromise) {
    workersEnvPromise = loadWorkersEnv();
  }
  return workersEnvPromise;
}

async function loadWorkersEnv(): Promise<Record<string, unknown> | null> {
  try {
    const workersModule = await import("cloudflare:workers");
    return isRecord(workersModule.env) ? workersModule.env : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
