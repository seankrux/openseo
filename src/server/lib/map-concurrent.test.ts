import { expect, it } from "vitest";
import { mapConcurrent } from "./map-concurrent";

it("keeps results aligned with input when later items finish first, within the concurrency limit", async () => {
  let active = 0;
  let maximum = 0;
  const result = await mapConcurrent([3, 2, 1, 0], 2, async (value) => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, value));
    active--;
    return `item-${value}`;
  });
  expect(result).toEqual(["item-3", "item-2", "item-1", "item-0"]);
  expect(maximum).toBe(2);
});
