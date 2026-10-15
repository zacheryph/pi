import { describe, expect, it, vi } from "vitest";
import { parseTldrResponse, selectTldrModel, sessionSnapshot, titleSlug } from "../src/core.js";
import { DEFAULT_CONFIG } from "../src/config.js";

const fakeModel = (provider: string, id: string) => ({ provider, id, name: id, type: "chat" }) as any;

describe("pi-tldr core", () => {
  it("defaults to automatic naming and model discovery", () => {
    expect(DEFAULT_CONFIG).toEqual({ model: "auto", setSessionName: true });
  });

  it("uses the newest Haiku over Luna, and accepts exact configured models", () => {
    const luna = fakeModel("custom", "luna");
    const old = fakeModel("anthropic", "claude-haiku-4-5-20251001");
    const newest = fakeModel("anthropic", "claude-haiku-4-6-20261001");
    const ctx = { modelRegistry: { getAvailable: () => [luna, old, newest] }, model: luna } as any;
    expect(selectTldrModel(ctx, "auto")).toBe(newest);
    expect(selectTldrModel(ctx, "custom/luna")).toBe(luna);
    expect(() => selectTldrModel(ctx, "custom/nonexistent")).toThrow(/not available/i);
    ctx.modelRegistry.getAvailable = () => [luna];
    expect(selectTldrModel(ctx, "auto")).toBe(luna);
  });

  it("rejects terminal escapes in output and clamps 4-word slugs", () => {
    expect(titleSlug("  Network / Routing   Migration PLAN extras  ")).toBe("network-routing-migration-plan");
    expect(titleSlug("\u001b]0;hijack\u0007teSt  Title ")).toBe("test-title");
    const parsed = parseTldrResponse('```json\n{"title":"Network Routing Migration Plan Extra", "premise":"Move routes", "findings":"One issue; two fixes", "status":"Pending rollout\\nreview"}\n```');
    expect(parsed.title).toBe("network-routing-migration-plan");
    expect(parsed.status).toBe("Pending rollout review");
    expect(() => parseTldrResponse("not json")).toThrow(/invalid JSON/);
  });

  it("preserves original user premise in a compacted branch", () => {
    const original = { role: "user", content: "Migrate network routes" };
    const fakeCtx = { sessionManager: {
      getBranch: () => [{ type: "message", message: original }],
      buildSessionProjection: () => ({ messages: [{ role: "user", content: "After compaction: update stack A" }] }),
    } } as any;
    const snapshot = sessionSnapshot(fakeCtx);
    expect(snapshot).toContain("Migrate network routes");
    expect(snapshot).toContain("After compaction: update stack A");
  });
});
