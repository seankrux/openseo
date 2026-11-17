import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { account } from "@/db/schema";
import { LOCAL_ADMIN_USER_ID } from "@/server/auth/delegated-organization";
import { getGoogleAccessMode } from "@/server/features/google/googleAccess";
import {
  GATEWAY_GOOGLE_ACCOUNT_ID,
  getGatewayGoogleStatus,
} from "@/server/features/google/gatewayGoogle";

export type GoogleGrantRef = {
  id: string;
  accountId: string;
  ownerUserId: string;
};

/**
 * Google accounts a member can list or bind properties from.
 *
 * In Every App (gateway) mode the member's own Connect grant is the
 * gateway connection, but imported self-host tokens still live on
 * `local-admin`. Include those so GSC/GA4 property lists and links use
 * the grant owner's user id (the one `account` and `connected_by_user_id`
 * already store) instead of falling through to a single gateway login.
 */
export async function listGoogleGrantsForUser(
  userId: string,
  providerId: string,
): Promise<GoogleGrantRef[]> {
  const asGrant = (
    row: { id: string; accountId: string; ownerUserId?: string },
    fallbackUserId: string,
  ): GoogleGrantRef => ({
    id: row.id,
    accountId: row.accountId,
    ownerUserId: row.ownerUserId || fallbackUserId,
  });

  if ((await getGoogleAccessMode()) === "gateway") {
    const ownerIds = Array.from(new Set([userId, LOCAL_ADMIN_USER_ID]));
    const stored = await db
      .select({
        id: account.id,
        accountId: account.accountId,
        ownerUserId: account.userId,
      })
      .from(account)
      .where(
        and(
          inArray(account.userId, ownerIds),
          eq(account.providerId, providerId),
        ),
      );
    const gateway = (await getGatewayGoogleStatus()).connected
      ? [
          {
            id: GATEWAY_GOOGLE_ACCOUNT_ID,
            accountId: GATEWAY_GOOGLE_ACCOUNT_ID,
            ownerUserId: userId,
          } satisfies GoogleGrantRef,
        ]
      : [];
    return [...gateway, ...stored.map((row) => asGrant(row, userId))];
  }

  const stored = await db
    .select({
      id: account.id,
      accountId: account.accountId,
      ownerUserId: account.userId,
    })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, providerId)));
  return stored.map((row) => asGrant(row, userId));
}
