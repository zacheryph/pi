import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { fakePi, tempDir } from "#test-helpers";
import { stashSettings } from "#src/config";
import stashExtension from "#src/index";
import { BlobStore } from "#src/store";

type Mode = "tui" | "rpc" | "json" | "print";

/** pi-stash on a fake `pi`, a real store in a temp directory and a context in `mode`. */
async function started(mode: Mode, options: { maxStoreBytes?: number } = {}) {
  const session = SessionManager.inMemory("/stash-test");
  const store = new BlobStore(join(tempDir(onTestFinished, "pi-stash-"), "stash"));
  const h = fakePi({
    appendEntry: vi.fn((type: string, data: unknown) => {
      session.appendCustomEntry(type, data);
    }),
  });
  stashExtension(h.api, {
    store,
    loadConfig: () => ({ ...stashSettings.defaults(), ...options }),
  });
  const ui = { notify: vi.fn(), custom: vi.fn(async () => undefined) };
  const ctx = {
    cwd: session.getCwd(),
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    ui,
    sessionManager: session,
  };
  await h.emit("session_start", { reason: "startup" }, ctx);
  const put = (name: string, content: string, description?: string) =>
    h.runTool("stash_put", { name, content, description }, ctx);
  return { h, ctx, ui, put };
}

describe("/stash outside the terminal", () => {
  it.each(["rpc", "json", "print"] as const)(
    "lists the entries as a displayed message in %s mode",
    async (mode) => {
      const env = await started(mode);
      await env.put(
        "auth-findings",
        "line one\nline two\n",
        "Findings \u001b[31mabout\u001b[0m auth",
      );
      await env.put("empty-ish", "x");
      await env.h.runCommand("stash", "", env.ctx);

      expect(env.ui.custom).not.toHaveBeenCalled();
      expect(env.ui.notify).not.toHaveBeenCalled();
      const [shown] = env.h.shown();
      expect(shown).toMatchObject({ customType: "stash:output", display: true, level: "info" });
      const rows = shown.text.split("\n");
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.includes("auth-findings"))).toContain("2 lines");
      expect(shown.text).toContain("— Findings about auth");
      expect(shown.text).not.toContain("\u001b");
      expect(env.h.pi.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ display: true }),
        {
          triggerTurn: false,
        },
      );
    },
  );

  it("says so when the branch has no entries", async () => {
    const env = await started("rpc");
    await env.h.runCommand("stash", "", env.ctx);
    expect(env.h.shown().map((shown) => shown.text)).toEqual(["No stash entries on this branch."]);
  });

  it("lists at most 100 entries and counts the rest", async () => {
    const env = await started("rpc");
    for (let index = 0; index < 103; index++) await env.put(`entry-${index}`, `content ${index}`);
    await env.h.runCommand("stash", "", env.ctx);
    const rows = env.h.shown()[0].text.split("\n");
    expect(rows).toHaveLength(101);
    expect(rows.at(-1)).toMatch(/^\+3 more/);
  });

  it("warns first when the store is over its cap", async () => {
    const env = await started("rpc", { maxStoreBytes: 1 });
    await env.put("big", "some content here");
    await env.h.runCommand("stash", "", env.ctx);
    const [shown] = env.h.shown();
    expect(shown.level).toBe("warning");
    expect(shown.content).toMatch(/^Warning: Store is .* over the .* cap; run \/stash:gc/);
    expect(shown.text).toContain("big");
  });

  it("keeps the terminal on the overlay", async () => {
    const env = await started("tui");
    await env.put("auth-findings", "line one\n");
    await env.h.runCommand("stash", "", env.ctx);
    expect(env.ui.custom).toHaveBeenCalledOnce();
    expect(env.h.shown()).toEqual([]);
  });
});

describe("/stash:gc outside the terminal", () => {
  it("reports what it freed as a displayed message", async () => {
    const env = await started("rpc");
    await env.put("auth-findings", "line one\n");
    await env.h.runCommand("stash:gc", "", env.ctx);
    expect(env.ui.notify).not.toHaveBeenCalled();
    expect(env.h.shown().map((shown) => shown.text)).toEqual([
      expect.stringMatching(/^Stash GC: removed 0 blobs, freed 0 B; 1 kept \(retention \d+d\)\.$/),
    ]);
  });

  it("keeps the terminal on notifications", async () => {
    const env = await started("tui");
    await env.h.runCommand("stash:gc", "", env.ctx);
    expect(env.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Stash GC: removed"),
      "info",
    );
    expect(env.h.shown()).toEqual([]);
  });
});
