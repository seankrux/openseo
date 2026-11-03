import { Ga4Service } from "@/server/features/ga4/services/Ga4Service";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import { z } from "zod";

const ADMIN = "https://analyticsadmin.googleapis.com/v1beta";
const streamSchema = z.object({
  type: z.string().optional(),
  webStreamData: z
    .object({
      measurementId: z
        .string()
        .regex(/^G-[A-Z0-9]+$/)
        .optional(),
    })
    .optional(),
});
const adminResponseSchema = streamSchema.extend({
  name: z
    .string()
    .regex(/^properties\/\d+$/)
    .optional(),
  dataStreams: z.array(streamSchema).optional(),
});
const errorSchema = z.object({ error: z.object({ message: z.string() }) });

/** The GA4 login to act as: GA4_SETUP_GOOGLE_EMAIL (default seantechworks@gmail.com). */
export async function pickGa4Login(userId: string) {
  const want = (
    (await getOptionalEnvValue("GA4_SETUP_GOOGLE_EMAIL")) ??
    "seantechworks@gmail.com"
  ).toLowerCase();
  const { accounts } =
    await Ga4Service.listPropertiesForUserWithGrantStatus(userId);
  const hit = accounts.find((a) => (a.email ?? "").toLowerCase() === want);
  if (!hit)
    throw new Error(
      `No connected Google Analytics login for ${want}. Connect it under Integrations.`,
    );
  if (hit.email?.toLowerCase().startsWith("seanguillermo@"))
    throw new Error("Refusing to use seanguillermo@gmail.com for GA4 setup.");
  return hit;
}

export async function admin(
  token: string,
  method: string,
  path: string,
  body?: unknown,
) {
  const r = await fetch(ADMIN + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: unknown = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  if (!r.ok) {
    const msg =
      errorSchema.safeParse(json).data?.error.message ??
      JSON.stringify(json).slice(0, 200);
    const scopeHint =
      r.status === 403 && /scope/i.test(msg)
        ? " (reconnect Google Analytics with GA4_OAUTH_MANAGE_SCOPES=1 so the login grants analytics.edit)"
        : "";
    throw new Error(
      `Admin API ${method} ${path.split("?")[0]} ${r.status}: ${msg}${scopeHint}`,
    );
  }
  return adminResponseSchema.parse(json);
}
