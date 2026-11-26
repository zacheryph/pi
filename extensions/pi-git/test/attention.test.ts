import { describe, expect, it } from "vitest";
import { isViewModel, settleSnapshot, type AttentionModel } from "#surface";
import {
  ATTENTION_TYPE,
  attentionModel,
  foldReviews,
  GIT_ATTENTION_DISMISS,
  isAttentionEntry,
  reduceReviews,
  reviewItem,
  rowForItem,
  type ReviewDismissal,
  type ReviewEvent,
  type ReviewRequest,
  type ReviewRows,
} from "#src/attention";
import { LEDGER_TYPE } from "#src/ledger";
import { observedStatus, type PrFacts, type PrRecord } from "#src/prs";

const A = "a13c90e".padEnd(40, "0");
const B = "b24d01f".padEnd(40, "1");
const KEY = "github.com/acme/web#42";
const REF = { host: "github.com", owner: "acme", repo: "web", number: 42 };

const request = (at: number, head = A, extra: Partial<ReviewRequest> = {}): ReviewRequest => ({
  v: 1,
  kind: "request",
  key: KEY,
  ...REF,
  head,
  at,
  ...extra,
});

const dismissal = (at: number, head = A): ReviewDismissal => ({
  v: 1,
  kind: "dismissal",
  key: KEY,
  head,
  at,
});

/** The ledger's PR record after an observation of `facts` at `at`. */
const facts = (at: number, observed: PrFacts, key = KEY): PrRecord => ({
  v: 1,
  kind: "pr",
  key,
  ...REF,
  url: "https://github.com/acme/web/pull/42",
  origin: "created",
  title: "Checkout cleanup",
  status: observedStatus(observed, at, "gh"),
  calls: [],
  createdAt: 1,
  updatedAt: at,
});

const fold = (events: readonly ReviewEvent[]): ReviewRows =>
  events.reduce<ReviewRows>(reduceReviews, new Map());

/** What a session holds after the events: none, or the row's state and requested head. */
const outcome = (rows: ReviewRows) => {
  const row = rows.get(KEY);
  return row ? `${row.state}@${row.request.head.slice(0, 1)}` : "none";
};

describe("reduceReviews", () => {
  const cases: [string, ReviewEvent[], string][] = [
    ["a request opens a ready row", [request(10)], "ready@a"],
    ["facts before the request change nothing", [facts(5, { headSha: B }), request(10)], "ready@a"],
    [
      "a same-head retry keeps the first request",
      [request(10), request(20, A, { reason: "again" })],
      "ready@a",
    ],
    ["a new full head marks it stale", [request(10), facts(11, { headSha: B })], "stale@a"],
    [
      "an abbreviated head is not evidence",
      [request(10), facts(11, { headSha: "b24d01f" })],
      "ready@a",
    ],
    [
      "checks alone are not evidence",
      [request(10), facts(11, { checks: { passed: 3, failed: 0, pending: 0 } })],
      "ready@a",
    ],
    [
      "it stays stale when the head moves back",
      [request(10), facts(11, { headSha: B }), facts(12, { headSha: A })],
      "stale@a",
    ],
    [
      "a request at the new head makes it ready again",
      [request(10), facts(11, { headSha: B }), request(12, B)],
      "ready@b",
    ],
    [
      "a request for the old head after a stale one is ready",
      [request(10), facts(11, { headSha: B }), request(12, A)],
      "ready@a",
    ],
    [
      "ready for review resolves a draft request",
      [request(10, A, { draft: true }), facts(11, { draft: false, headSha: A })],
      "none",
    ],
    [
      "draft false does not resolve a request made on a ready PR",
      [request(10), facts(11, { draft: false })],
      "ready@a",
    ],
    ["an approval resolves it", [request(10), facts(11, { review: "approved" })], "none"],
    [
      "an approval at a new head leaves it stale",
      [request(10), facts(11, { headSha: B, review: "approved" })],
      "stale@a",
    ],
    [
      "ready for review does not resolve a stale request",
      [request(10, A, { draft: true }), facts(11, { headSha: B }), facts(12, { draft: false })],
      "stale@a",
    ],
    ["a merge resolves it", [request(10), facts(11, { state: "merged" })], "none"],
    [
      "a close resolves a stale one",
      [request(10), facts(11, { headSha: B }), facts(12, { state: "closed" })],
      "none",
    ],
    [
      "a reopen does not revive it",
      [request(10), facts(11, { state: "closed" }), facts(12, { state: "open" })],
      "none",
    ],
    [
      "a request after a reopen opens a new row",
      [request(10), facts(11, { state: "closed" }), facts(12, { state: "open" }), request(13)],
      "ready@a",
    ],
    ["a dismissal resolves it", [request(10), dismissal(11)], "none"],
    ["a dismissal of another head does nothing", [request(10), dismissal(11, B)], "ready@a"],
    [
      "a dismissal resolves a stale one",
      [request(10), facts(11, { headSha: B }), dismissal(12)],
      "none",
    ],
    [
      "a request after a dismissal opens a new row",
      [request(10), dismissal(11), request(12)],
      "ready@a",
    ],
    [
      "another PR's facts do nothing",
      [request(10), facts(11, { state: "merged" }, "github.com/acme/web#43")],
      "ready@a",
    ],
    ["facts with no request do nothing", [facts(11, { state: "merged" })], "none"],
    // A subagent's report adopted after the request, of what it saw before it.
    [
      "an older fact adopted later changes nothing",
      [request(10), facts(9, { state: "merged", headSha: B })],
      "ready@a",
    ],
  ];

  it.each(cases)("%s", (_name, events, expected) => {
    expect(outcome(fold(events))).toBe(expected);
  });

  it("replay over session entries agrees with each case", () => {
    for (const [name, events, expected] of cases) {
      const entries = events.map((data) => ({
        type: "custom",
        customType: data.kind === "pr" ? LEDGER_TYPE : ATTENTION_TYPE,
        data,
      }));
      // Other entries and malformed ones in between are skipped.
      entries.splice(1, 0, { type: "custom", customType: ATTENTION_TYPE, data: { v: 2 } } as never);
      expect(outcome(foldReviews(entries)), name).toBe(expected);
    }
  });

  it("returns the same rows when an event changes nothing, so no change is announced", () => {
    const rows = fold([request(10)]);
    expect(reduceReviews(rows, request(20))).toBe(rows);
    expect(reduceReviews(rows, facts(11, { checks: { passed: 1, failed: 0, pending: 0 } }))).toBe(
      rows,
    );
    expect(reduceReviews(rows, dismissal(12, B))).toBe(rows);
  });

  it("keeps the request's time when a retry changes nothing", () => {
    expect(fold([request(10), request(20)]).get(KEY)?.request.at).toBe(10);
  });
});

describe("attention entries", () => {
  it("accepts a request or dismissal with a full head and a canonical key", () => {
    expect(isAttentionEntry(request(1))).toBe(true);
    expect(isAttentionEntry(request(1, A, { draft: true, reason: "Checkout cleanup" }))).toBe(true);
    expect(isAttentionEntry(dismissal(1))).toBe(true);
  });

  it("refuses anything else", () => {
    const bad: [string, unknown][] = [
      ["version", { ...request(1), v: 2 }],
      ["kind", { ...request(1), kind: "raise" }],
      ["short head", request(1, "a13c90e")],
      ["key of another PR", { ...request(1), key: "github.com/acme/web#43" }],
      [
        "host with a path",
        { ...request(1), host: "github.com/evil", key: "github.com/evil/acme/web#42" },
      ],
      [
        "host with userinfo",
        { ...request(1), host: "me@github.com", key: "me@github.com/acme/web#42" },
      ],
      ["owner with a slash", { ...request(1), owner: "a/b", key: "github.com/a/b/web#42" }],
      ["repo ..", { ...request(1), repo: "..", key: "github.com/acme/..#42" }],
      ["number", { ...request(1), number: 0, key: "github.com/acme/web#0" }],
      ["long reason", request(1, A, { reason: "r".repeat(201) })],
      ["no time", { ...dismissal(1), at: Number.NaN }],
    ];
    for (const [name, value] of bad) expect(isAttentionEntry(value), name).toBe(false);
  });
});

describe("the git.attention model", () => {
  it("maps each row to a review item with a link and a dismiss at the requested head", () => {
    const record = facts(11, { state: "open", draft: true, headSha: A });
    const rows = fold([request(10, A, { draft: true }), record]);
    const model = attentionModel(rows, new Map([[KEY, record]]));
    expect(model).toEqual({
      items: [
        {
          id: `pr:${KEY}`,
          rev: A,
          category: "review",
          title: "Review acme/web#42",
          reason: "Checkout cleanup · draft at a13c90e",
          state: "ready",
          since: 10,
          observedAt: 11,
          link: { url: "https://github.com/acme/web/pull/42", label: "acme/web#42" },
          dismiss: { action: GIT_ATTENTION_DISMISS, args: { id: `pr:${KEY}`, rev: A } },
        },
      ],
      total: 1,
    });
    expect(isViewModel("attention", model)).toBe(true);
    expect(rowForItem(rows, `pr:${KEY}`)).toBe(rows.get(KEY));
    expect(rowForItem(rows, KEY)).toBeUndefined();
  });

  it("says why a stale item is stale, and prefers the request's own reason", () => {
    const rows = fold([request(10, A, { reason: "Retry policy" }), facts(11, { headSha: B })]);
    expect(reviewItem(rows.get(KEY)!, undefined)).toMatchObject({
      state: "stale",
      reason: "Retry policy · new commits since a13c90e",
    });
  });

  it("keeps the item and its link through settling, without the dismiss action", () => {
    const rows = fold([request(10)]);
    const model = attentionModel(rows, new Map());
    const settled = settleSnapshot(
      { id: "1", views: [{ id: "git.attention", kind: "attention", title: "Git", model }] },
      100,
    );
    const item = (settled.views[0]!.model as AttentionModel).items[0]!;
    expect(item.dismiss).toBeUndefined();
    expect(item.link?.url).toBe("https://github.com/acme/web/pull/42");
  });

  it("lists the oldest requests first and counts the ones past the cap", () => {
    let rows: ReviewRows = new Map();
    for (let n = 1; n <= 55; n += 1)
      rows = reduceReviews(
        rows,
        request(100 - n, A, { key: `github.com/acme/web#${n}`, number: n }),
      );
    const model = attentionModel(rows, new Map());
    expect(model.total).toBe(55);
    expect(model.items).toHaveLength(50);
    expect(model.items[0]!.id).toBe("pr:github.com/acme/web#55");
    expect(isViewModel("attention", model)).toBe(true);
  });
});
