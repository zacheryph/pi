import { describe, expect, it } from "vitest";
import { compareNewestFirst, findExactModel, resolveModel } from "#src/models";

const models = [
  { provider: "a", id: "haiku-4-5-20251001", name: "Haiku", extra: 1 },
  { provider: "a", id: "haiku-5-5", name: "Haiku", extra: 2 },
  { provider: "b", id: "haiku-9", name: "Haiku", extra: 3 },
];
const registry = {
  getAll: () => models,
  getAvailable: () => models.slice(0, 2),
  find: (provider: string, id: string) =>
    models.find((m) => m.provider === provider && m.id === id),
};

describe("model lookup primitives", () => {
  it("matches exactly and case-insensitively without silently enabling fuzzy/latest selection", () => {
    expect(findExactModel(models, "A/HAIKU-5-5")).toBe(models[1]);
    expect(findExactModel(models, "haiku-5-5")).toBe(models[1]);
    expect(findExactModel(models, "haiku")).toBeUndefined();
    expect(findExactModel(models, "haiku@latest")).toBeUndefined();
  });

  it("compares numeric versions, then ids, without depending on an SDK model", () => {
    expect([...models].sort(compareNewestFirst)).toEqual([models[2], models[1], models[0]]);
    expect(compareNewestFirst({ id: "v2-b" }, { id: "v2-a" })).toBeLessThan(0);
  });

  it("uses only available models and preserves identity, extra fields and catalog order", () => {
    const before = [...models];
    const found = resolveModel("haiku@latest", registry);
    expect(found).toBe(models[1]);
    if (typeof found !== "string") expect(found.extra).toBe(2);
    expect(models).toEqual(before);
    expect(resolveModel("b/haiku-9", registry)).toContain("Model not found");
    expect(resolveModel("haiku-4", registry)).toBe(models[0]);
  });
});
