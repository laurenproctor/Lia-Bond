import { describe, expect, it } from "vitest";
import { resolveSelection } from "@/lib/selection";

interface Item {
  id: string;
}

const items: Item[] = [{ id: "a" }, { id: "b" }, { id: "c" }];
const idOf = (item: Item) => item.id;

describe("resolveSelection", () => {
  it("returns the matching item when the param matches", () => {
    expect(resolveSelection(items, "b", idOf)).toEqual({ id: "b" });
  });

  it("falls back to the first item when the param is stale", () => {
    expect(resolveSelection(items, "deleted-id", idOf)).toEqual({ id: "a" });
  });

  it("falls back to the first item when the param is missing", () => {
    expect(resolveSelection(items, undefined, idOf)).toEqual({ id: "a" });
  });

  it("returns null when there is nothing to select", () => {
    expect(resolveSelection([], "a", idOf)).toBeNull();
    expect(resolveSelection([], undefined, idOf)).toBeNull();
  });
});
