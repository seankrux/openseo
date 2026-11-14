import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";
import { cooperativeD1 } from "@/server/lib/cooperative-yield";

// Queries hand workerd's one thread back to waiting requests; see cooperative-yield.
export const d1Db = drizzle(cooperativeD1(env.DB), { schema });
