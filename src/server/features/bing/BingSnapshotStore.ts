import { env } from "cloudflare:workers";
import { cooperativeR2 } from "@/server/lib/cooperative-yield";
import { AppError } from "@/server/lib/errors";
import { bingSnapshotSchema, type BingSnapshot } from "./BingSnapshot";

/** R2 calls hand workerd's one thread back to waiting requests. */
const bucket = () => cooperativeR2(env.R2);

type SnapshotScope = Pick<
  BingSnapshot,
  "organizationId" | "projectId" | "bindingId" | "siteUrl"
>;
const MAX_BYTES = 2_097_152;

async function key(scope: SnapshotScope) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(scope.siteUrl),
  );
  const property = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `bing-webmaster/v1/${encodeURIComponent(scope.organizationId)}/${encodeURIComponent(scope.projectId)}/${encodeURIComponent(scope.bindingId)}/${property}/snapshot.json`;
}

async function read(scope: SnapshotScope): Promise<BingSnapshot | null> {
  try {
    const object = await bucket().get(await key(scope));
    if (!object || object.size > MAX_BYTES) return null;
    const text = await object.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BYTES) return null;
    const parsed = bingSnapshotSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return null;
    const snapshot = parsed.data;
    if (Date.parse(snapshot.fetchedAt) > Date.now()) return null;
    return snapshot.organizationId === scope.organizationId &&
      snapshot.projectId === scope.projectId &&
      snapshot.bindingId === scope.bindingId &&
      snapshot.siteUrl === scope.siteUrl
      ? snapshot
      : null;
  } catch {
    return null;
  }
}

async function save(snapshot: BingSnapshot): Promise<void> {
  try {
    const text = JSON.stringify(bingSnapshotSchema.parse(snapshot));
    if (new TextEncoder().encode(text).byteLength > MAX_BYTES)
      throw new Error();
    await bucket().put(await key(snapshot), text, {
      httpMetadata: {
        contentType: "application/json",
        cacheControl: "private, no-store",
      },
    });
  } catch {
    throw new AppError("INTERNAL_ERROR");
  }
}

export const BingSnapshotStore = { read, save } as const;
