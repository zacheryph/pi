import { describe, expect, it } from "vitest";
import { cardMissing, restoreCard } from "#src/index";
import { fakePi } from "#test-helpers";

const TYPE = "example:context";

type Entry = { type: string; customType?: string };
const compaction: Entry = { type: "compaction" };
const message: Entry = { type: "message" };
const written: Entry = { type: "custom_message", customType: TYPE };
const other: Entry = { type: "custom_message", customType: "other:context" };

/** A context over a branch the test can change; `getBranch` throws once `stale`. */
function branchCtx(branch: Entry[]) {
  let stale = false;
  return {
    branch,
    ctx: {
      sessionManager: {
        getBranch: () => {
          if (stale) throw new Error("stale context");
          return branch;
        },
      },
    },
    goStale: () => {
      stale = true;
    },
  };
}

/** A promise and the function that settles it. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("cardMissing", () => {
  it.each<[string, Entry[], boolean]>([
    ["a branch without a compaction", [message, message], false],
    ["a compaction with no card after it", [written, compaction, message], true],
    ["a compaction followed by the card", [compaction, message, written], false],
    ["a card of another type only", [compaction, other], true],
    ["a later compaction after the card", [compaction, written, compaction], true],
  ])("%s", (_name, branch, missing) => {
    expect(cardMissing(branchCtx(branch).ctx as never, TYPE)).toBe(missing);
  });
});

describe("restoreCard", () => {
  function setup(branch: Entry[], build: () => string | undefined | Promise<string | undefined>) {
    const fake = fakePi();
    const built: string[] = [];
    restoreCard(fake.api, {
      type: TYPE,
      build: (_ctx, event) => {
        built.push(event.type);
        return build();
      },
    });
    const session = branchCtx(branch);
    // Pi appends the message to the branch, as a later restore would see it.
    fake.pi.sendMessage.mockImplementation(() => session.branch.push(written));
    return { fake, built, ...session };
  }

  it.each(["session_start", "session_tree", "session_compact"])(
    "writes a hidden card once after %s when a compaction has none",
    async (event) => {
      const h = setup([message, compaction], () => "card");
      await h.fake.emit(event, { reason: "resume" }, h.ctx);
      expect(h.fake.pi.sendMessage).toHaveBeenCalledExactlyOnceWith(
        { customType: TYPE, content: "card", display: false },
        { triggerTurn: false },
      );
      // The card is on the branch now: later events leave it alone.
      for (const next of ["session_start", "session_tree"]) await h.fake.emit(next, {}, h.ctx);
      expect(h.fake.pi.sendMessage).toHaveBeenCalledOnce();
      expect(h.built).toEqual([event]);
    },
  );

  it("writes nothing on a branch without a compaction, and never builds", async () => {
    const h = setup([message], () => "card");
    for (const event of ["session_start", "session_tree"]) await h.fake.emit(event, {}, h.ctx);
    expect(h.built).toEqual([]);
    expect(h.fake.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("writes a fresh card after each compaction", async () => {
    const h = setup([message, compaction], () => "card");
    await h.fake.emit("session_compact", {}, h.ctx);
    h.branch.push(message, compaction);
    await h.fake.emit("session_compact", {}, h.ctx);
    expect(h.fake.pi.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("writes nothing when build has nothing to restore", async () => {
    const h = setup([compaction], () => undefined);
    await h.fake.emit("session_compact", {}, h.ctx);
    expect(h.built).toEqual(["session_compact"]);
    expect(h.fake.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("awaits an async build", async () => {
    const h = setup([compaction], async () => "later");
    await h.fake.emit("session_compact", {}, h.ctx);
    expect(h.fake.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: "later" }),
      { triggerTurn: false },
    );
  });

  it.each(["session_shutdown", "session_tree"])(
    "drops an async card that resolves after %s",
    async (event) => {
      const pending = deferred<string | undefined>();
      let calls = 0;
      // Only the first build is pending; the newer event's has nothing to restore.
      const h = setup([compaction], () => (calls++ === 0 ? pending.promise : undefined));
      const first = h.fake.emit("session_compact", {}, h.ctx);
      await h.fake.emit(event, {}, h.ctx);
      pending.resolve("stale");
      await first;
      expect(h.fake.pi.sendMessage).not.toHaveBeenCalled();
    },
  );

  it("drops an async card once another card reached the branch", async () => {
    const pending = deferred<string | undefined>();
    const h = setup([compaction], () => pending.promise);
    const first = h.fake.emit("session_compact", {}, h.ctx);
    h.branch.push(written);
    pending.resolve("late");
    await first;
    expect(h.fake.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("skips a stale context and a closed session without throwing", async () => {
    const stale = setup([compaction], () => "card");
    stale.goStale();
    await expect(stale.fake.emit("session_start", {}, stale.ctx)).resolves.toBeUndefined();
    expect(stale.built).toEqual([]);

    const closed = setup([compaction], () => "card");
    closed.fake.pi.sendMessage.mockImplementation(() => {
      throw new Error("closed");
    });
    await expect(closed.fake.emit("session_compact", {}, closed.ctx)).resolves.toBeUndefined();
  });
});
