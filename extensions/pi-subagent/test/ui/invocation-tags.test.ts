import { describe, expect, it } from "vitest";
import { buildInvocationTags } from "#src/ui/display";

describe("buildInvocationTags", () => {
  it("tags a foreground run, the exception now that agents run in the background", () => {
    expect(buildInvocationTags({ runInBackground: false }).tags).toEqual(["foreground"]);
  });

  it("leaves a background run untagged", () => {
    expect(buildInvocationTags({ runInBackground: true }).tags).toEqual([]);
  });

  it("leaves an invocation that records no mode untagged", () => {
    expect(buildInvocationTags({ thinking: "high" }).tags).toEqual(["thinking: high"]);
  });
});
