import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkHost, type WorkMessage, type WorkRecord } from "#work";
import type { PrFacts } from "#src/prs";
import {
  diff,
  FinalReadError,
  MAX_READ_FAILURES,
  nextBaseline,
  PrWatches,
  WATCH_MESSAGE,
  WATCH_OWNER,
  type Reading,
  type SavedBaseline,
} from "#src/watch";

const REF = { host: "github.com", owner: "acme", repo: "api", number: 12 };
const URL = "https://github.com/acme/api/pull/12";
const KEY = "github.com/acme/api#12";
const INTERVAL = 60_000;

const reading = (facts: PrFacts, extra: Partial<Reading> = {}): Reading => ({
  facts: { state: "open", headSha: "aaa111", ...facts },
  source: "gh",
  ...extra,
});
const pending = reading({ checks: { passed: 0, failed: 0, pending: 2 } });
const green = reading({ checks: { passed: 2, failed: 0, pending: 0 } });
const red = reading(
  { checks: { passed: 1, failed: 1, pending: 0 } },
  { failedChecks: ["lint\n(node 24)"] },
);

/** A work host over an in-memory store, and the watches of one session instance on it. */
function setup(records: WorkRecord[] = [], saved: SavedBaseline[] = []) {
  const sent: Array<{ message: WorkMessage; mode: string }> = [];
  const host = createWorkHost({
    store: { read: () => records, append: (record) => records.push(record) },
    delivery: {
      isIdle: () => true,
      send: (items, mode) => {
        for (const { payload } of items) sent.push({ message: payload, mode });
      },
      lost: vi.fn(),
    },
  });
  host.start();
  const replies: Array<Reading | Error> = [];
  const read = vi.fn(async () => {
    const next = replies.length > 1 ? replies.shift()! : replies[0]!;
    if (next instanceof Error) throw next;
    return next;
  });
  const onChange = vi.fn();
  const watches = new PrWatches({
    host: () => host,
    read,
    saveBaseline: (entry) => saved.push(entry),
    onChange,
    now: () => Date.now(),
    intervalMs: () => INTERVAL,
  });
  const open = (first: Reading, until: "settled" | "merged" = "settled", timeoutMs = 3_600_000) =>
    watches.open({
      ref: REF,
      url: URL,
      until,
      deadline: Date.now() + timeoutMs,
      callId: "call-1",
      sessionId: "s1",
      reading: first,
    });
  /** The newest saved baseline per item, as the extension reads them back. */
  const latest = () => new Map(saved.map((entry) => [entry.item, entry.baseline]));
  const adopt = (sessionId = "s1") =>
    host.adopt(WATCH_OWNER, (item) => watches.adopt(item, sessionId, latest().get(item.id)));
  const texts = () => sent.map(({ message }) => message.content as string);
  return { host, watches, replies, read, sent, texts, open, adopt, records, saved, onChange };
}

const tick = (ms = INTERVAL) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("diff", () => {
  it("reports nothing while nothing changed", () => {
    expect(diff(nextBaseline(undefined, pending), pending)).toEqual([]);
    expect(diff(nextBaseline(undefined, green), green)).toEqual([]);
  });

  it("reports finished checks once per head and result, and again after a rerun", () => {
    let baseline = nextBaseline(undefined, pending);
    expect(diff(baseline, red)).toEqual([
      {
        type: "checks",
        headSha: "aaa111",
        passed: 1,
        failed: 1,
        failedChecks: ["lint\n(node 24)"],
      },
    ]);
    baseline = nextBaseline(baseline, red);
    expect(diff(baseline, red)).toEqual([]);
    // A rerun that fails the same way is news again: the checks ran in between.
    baseline = nextBaseline(baseline, pending);
    expect(diff(baseline, red)).toHaveLength(1);
  });

  it("keeps the last report when a read could not show the checks", () => {
    const baseline = nextBaseline(nextBaseline(undefined, green), reading({}));
    expect(diff(baseline, green)).toEqual([]);
  });

  it("reports a moved head, a changed review decision, new activity and conflicts", () => {
    const before = reading(
      { checks: { passed: 0, failed: 0, pending: 1 }, review: "review_required", mergeable: true },
      { comments: 1, reviews: 0 },
    );
    const after = reading(
      {
        headSha: "bbb222",
        checks: { passed: 0, failed: 0, pending: 1 },
        review: "changes_requested",
        mergeable: false,
      },
      { comments: 2, reviews: 2 },
    );
    expect(diff(nextBaseline(undefined, before), after)).toEqual([
      { type: "head", from: "aaa111", to: "bbb222" },
      { type: "review", from: "review_required", to: "changes_requested" },
      { type: "activity", reviews: 2, comments: 1 },
      { type: "conflicts" },
    ]);
  });

  it("does not compare comment counts read through gh with ones read through MCP", () => {
    const viaGh = reading({}, { comments: 1, reviews: 1 });
    const viaMcp = reading(
      {},
      { comments: 4, reviews: 3, source: "mcp__github__pull_request_read" },
    );
    const baseline = nextBaseline(undefined, viaGh);
    expect(diff(baseline, viaMcp)).toEqual([]);
    // From then on the MCP counts are the baseline.
    const next = nextBaseline(baseline, viaMcp);
    expect(diff(next, { ...viaMcp, comments: 5 })).toEqual([
      { type: "activity", reviews: 0, comments: 1 },
    ]);
  });
});

describe("PrWatches", () => {
  it("opens one work item and completes it when checks settle", async () => {
    const h = setup();
    h.replies.push(pending, red);
    h.open(pending);
    expect(h.host.list()).toEqual([
      expect.objectContaining({ owner: "pi-git", kind: "pr", label: "PR 12 CI" }),
    ]);
    expect(h.watches.get(KEY)).toMatchObject({ until: "settled", url: URL });

    await tick();
    expect(h.sent).toEqual([]);
    await tick();
    expect(h.texts()).toEqual([
      [
        "Pull request acme/api#12:",
        "Checks finished on head aaa111: 1 failed (lint (node 24)), 1 passed.",
        "The watch has ended.",
        URL,
      ].join("\n"),
    ]);
    expect(h.sent[0]!.message).toMatchObject({
      customType: WATCH_MESSAGE,
      details: { key: KEY, ended: true, headSha: "aaa111", events: [{ type: "checks" }] },
    });
    expect(h.host.list()).toEqual([]);
    expect(h.watches.list()).toEqual([]);
    // Nothing reads a watch that ended.
    await tick(10 * INTERVAL);
    expect(h.read).toHaveBeenCalledTimes(2);
  });

  it("reports a head that moved mid-watch and goes on to the new head's checks", async () => {
    const h = setup();
    const moved = reading({ headSha: "bbb222", checks: { passed: 0, failed: 0, pending: 2 } });
    const settled = reading({ headSha: "bbb222", checks: { passed: 2, failed: 0, pending: 0 } });
    h.replies.push(moved, settled);
    h.open(pending);

    await tick();
    expect(h.texts()).toEqual([
      [
        "Pull request acme/api#12:",
        "Head moved from aaa111 to bbb222: someone pushed.",
        "Still watching until checks finish on its head.",
        URL,
      ].join("\n"),
    ]);
    expect(h.host.list()).toHaveLength(1);

    await tick();
    expect(h.texts()[1]).toContain("Checks finished on head bbb222: all 2 passed.");
    expect(h.host.list()).toEqual([]);
  });

  it("until merged stays open through settled checks and a review, and ends on the merge", async () => {
    const h = setup();
    const approved = reading({ ...green.facts, review: "approved" });
    h.replies.push(green, approved, reading({ ...approved.facts, state: "merged" }));
    h.open(reading({ ...pending.facts, review: "review_required" }), "merged");
    expect(h.host.list()[0]!.label).toBe("PR 12 until merged");

    await tick();
    expect(h.texts()[0]).toContain("Checks finished on head aaa111: all 2 passed.");
    expect(h.texts()[0]).toContain("Still watching until it is merged or closed.");
    await tick();
    expect(h.texts()[1]).toContain("Review decision is now approved (was review required).");
    expect(h.host.list()).toHaveLength(1);
    await tick();
    expect(h.texts()[2]).toContain("Merged.\nThe watch has ended.");
    expect(h.host.list()).toEqual([]);
  });

  it("ends a watch for settled checks when the pull request is closed instead", async () => {
    const h = setup();
    h.replies.push(reading({ ...pending.facts, state: "closed" }));
    h.open(pending);
    await tick();
    expect(h.texts()[0]).toContain("Closed without merging.\nThe watch has ended.");
  });

  it("ends at the timeout, without reading past it", async () => {
    const h = setup();
    h.replies.push(pending);
    h.open(pending, "settled", 150_000);
    await tick(); // 60s
    await tick(); // 120s
    expect(h.sent).toEqual([]);
    await tick(30_000);
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(h.texts()).toEqual([
      [
        "Pull request acme/api#12:",
        "Timed out before checks finish on its head.",
        "Read it with git_pr_status, and call git_pr_watch again to keep waiting.",
        "The watch has ended.",
        URL,
      ].join("\n"),
    ]);
    expect(h.host.list()).toEqual([]);
  });

  it("backs off while reads fail, recovers, and gives up after repeated failures", async () => {
    const h = setup();
    h.replies.push(new Error("HTTP 502"), pending, new Error("HTTP 502\nBad gateway"));
    h.open(pending, "settled", 24 * 3_600_000);

    await tick(); // fails: next read after 2 intervals
    await tick();
    expect(h.read).toHaveBeenCalledTimes(1);
    await tick(); // reads fine again
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(h.sent).toEqual([]);

    // From here every read fails: 2, 4, 8 and 15 intervals apart (the backoff is capped).
    await tick(); // failure 1
    for (const intervals of [2, 4, 8, 15]) await tick(intervals * INTERVAL);
    expect(h.read).toHaveBeenCalledTimes(2 + MAX_READ_FAILURES);
    expect(h.texts()).toEqual([
      [
        "Pull request acme/api#12:",
        `Its status could not be read ${MAX_READ_FAILURES} times in a row: HTTP 502 Bad gateway`,
        "Call git_pr_watch again once it can be read.",
        "The watch has ended.",
        URL,
      ].join("\n"),
    ]);
    expect(h.host.list()).toEqual([]);
  });

  it("ends at once when no later read can work", async () => {
    const h = setup();
    h.replies.push(new FinalReadError("gh is not installed, and no reader is available"));
    h.open(pending);
    await tick();
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.texts()[0]).toContain("Its status can no longer be read: gh is not installed");
  });

  it("stops on request without a message", async () => {
    const h = setup();
    h.replies.push(green);
    h.open(pending);
    expect(h.watches.stop(KEY)).toBe(true);
    expect(h.watches.stop(KEY)).toBe(false);
    await tick(5 * INTERVAL);
    expect(h.read).not.toHaveBeenCalled();
    expect(h.sent).toEqual([]);
    expect(h.host.list()).toEqual([]);
    expect(h.records.at(-1)).toMatchObject({ op: "close", reason: "cancelled" });
  });

  it("continues from a reading the agent took itself", async () => {
    const h = setup();
    const pushed = reading({ headSha: "bbb222", checks: { passed: 0, failed: 0, pending: 1 } });
    h.replies.push(pushed);
    h.open(pending);
    await tick(30_000);
    h.watches.rebase(KEY, pushed);
    // Its own push is not reported back, and the next read is a whole interval away.
    await tick(30_000);
    expect(h.read).not.toHaveBeenCalled();
    await tick(30_000);
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.sent).toEqual([]);
  });

  it("is adopted after a reload and continues from the saved baseline", async () => {
    const first = setup();
    const moved = reading({ headSha: "bbb222", checks: { passed: 0, failed: 0, pending: 2 } });
    first.replies.push(moved);
    first.open(pending, "merged");
    await tick();
    expect(first.texts()[0]).toContain("Head moved from aaa111 to bbb222");
    expect(first.saved).toHaveLength(1);
    first.watches.shutdown();
    first.host.dispose();
    await tick(5 * INTERVAL);
    expect(first.read).toHaveBeenCalledTimes(1);

    // A new instance of the same session: the item is still open in its transcript.
    const second = setup(first.records, first.saved);
    const settled = reading({ headSha: "bbb222", checks: { passed: 2, failed: 0, pending: 0 } });
    second.replies.push(moved, settled);
    second.adopt();
    expect(second.host.settleStartup()).toEqual([]);
    expect(second.watches.get(KEY)).toMatchObject({ until: "merged", deadline: 4_600_000 });
    // It reads soon after startup, and does not report the moved head a second time.
    await tick(5_000);
    expect(second.read).toHaveBeenCalledTimes(1);
    expect(second.sent).toEqual([]);
    await tick();
    expect(second.texts()).toEqual([expect.stringContaining("Checks finished on head bbb222")]);
  });

  it("leaves another session's item to be reported lost", () => {
    const first = setup();
    first.open(pending);
    first.watches.shutdown();
    first.host.dispose();
    // A fork inherits the records under a new session id.
    const fork = setup(first.records);
    fork.adopt("fork");
    expect(fork.watches.list()).toEqual([]);
    expect(fork.host.settleStartup()).toHaveLength(1);
  });

  it("drops a read that answers after the session shut down", async () => {
    const h = setup();
    let answer!: (value: Reading) => void;
    h.read.mockImplementationOnce(() => new Promise<Reading>((resolve) => (answer = resolve)));
    h.open(pending);
    await tick();
    h.watches.shutdown();
    answer(green);
    await tick(5 * INTERVAL);
    expect(h.sent).toEqual([]);
    // The item stays open for the next instance.
    expect(h.host.list()).toHaveLength(1);
  });
});
