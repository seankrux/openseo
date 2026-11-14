import { env } from "cloudflare:workers";
import { cooperativeR2 } from "@/server/lib/cooperative-yield";

/** R2 calls hand workerd's one thread back to waiting requests. */
const bucket = () => cooperativeR2(env.R2);

export async function getJsonFromR2(key: string): Promise<string> {
  const object = await bucket().get(key);
  if (!object) {
    throw new Error("Audit payload not found");
  }

  return object.text();
}

export async function putTextToR2(
  key: string,
  body: string,
): Promise<{ key: string; sizeBytes: number }> {
  await bucket().put(key, body, {
    httpMetadata: {
      contentType: "application/json",
    },
  });

  return {
    key,
    sizeBytes: Buffer.byteLength(body),
  };
}
