import { describe, expect, it } from "vitest";
import { buildInvocationTags } from "#src/ui/display";

describe("buildInvocationTags", () => {
  it("tags only the overrides an invocation records", () => {
    expect(buildInvocationTags({ thinking: "high" }).tags).toEqual(["thinking: high"]);
  });
});
