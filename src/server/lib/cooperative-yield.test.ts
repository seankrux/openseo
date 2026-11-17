import { describe, expect, it } from "vitest";
import {
  cooperativeD1,
  cooperativeR2,
  yieldIfBusy,
} from "@/server/lib/cooperative-yield";

class Statement {
  constructor(
    readonly sql: string,
    readonly params: unknown[] = [],
  ) {}
  bind(...params: unknown[]) {
    return new Statement(this.sql, params);
  }
  async all() {
    return { results: [{ sql: this.sql, params: this.params }] };
  }
  async first() {
    return this.params[0];
  }
}

class Database {
  prepare(sql: string) {
    return new Statement(sql);
  }
  async batch(statements: unknown[]) {
    return statements.map((s) => s instanceof Statement);
  }
}

describe("cooperativeD1", () => {
  it("keeps statement results and hands the binding its own objects", async () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- minimal fake binding
    const db = cooperativeD1(new Database() as unknown as D1Database);
    const statement = db.prepare("select ?").bind(7);
    expect(statement).toBeInstanceOf(Statement);
    expect(await statement.first()).toBe(7);
    expect(await statement.all()).toEqual({
      results: [{ sql: "select ?", params: [7] }],
    });
    expect(await db.batch([statement, db.prepare("select 1")])).toEqual([
      true,
      true,
    ]);
  });

  it("passes a missing binding through", () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tests run without bindings
    expect(cooperativeD1(undefined as unknown as D1Database)).toBeUndefined();
  });
});

describe("cooperativeR2", () => {
  it("forwards calls to the bucket", async () => {
    const bucket = {
      async get(key: string) {
        return { key };
      },
    };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- minimal fake binding
    const r2 = cooperativeR2(bucket as unknown as R2Bucket);
    expect(await r2.get("a")).toEqual({ key: "a" });
  });
});

describe("yieldIfBusy", () => {
  it("yields once a time slice has passed and not again right after", async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const pending = yieldIfBusy();
    expect(pending).toBeInstanceOf(Promise);
    await pending;
    expect(yieldIfBusy()).toBeUndefined();
  });
});
