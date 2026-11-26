import { describe as group, expect, it } from "vitest";
import { viewRegistry, type FormModel } from "#surface";
import { fakeEventBus } from "#test-helpers";
import { age, describe, EMPTY, hintText, readAttention } from "#src/rows";
import { listOf, NOW, producers, reviewItem, row, staleItem } from "#test/fixtures";

const MINUTE = 60_000;

group("readAttention", () => {
  it("reads owed rows from every attention view, ready before stale", () => {
    const bus = fakeEventBus();
    producers(bus);
    const { list, views } = readAttention(bus);
    expect([...views]).toEqual(["git.attention", "todo.attention"]);
    expect(list.rows.map((r) => r.key)).toEqual([
      "git.attention/pr:github.com/acme/web#42",
      "todo.attention/task:fix-auth-bug",
      "git.attention/pr:github.com/acme/api#57",
    ]);
    expect(list.owed).toBe(3);
  });

  it("leaves the session's own questionnaires and waiting status out", () => {
    const bus = fakeEventBus();
    const views = viewRegistry(bus);
    views.define({
      id: "ask.questions",
      kind: "form",
      title: "Questions",
      model: () =>
        ({
          questionnaires: [
            {
              id: "call-1",
              questions: [{ question: "Which queue?", options: [{ label: "SQS" }] }],
              submit: { action: "ask.submit" },
              cancel: { action: "ask.cancel" },
            },
          ],
        }) satisfies FormModel,
    });
    expect(readAttention(bus).list).toEqual(EMPTY);
    producers(bus);
    const { list } = readAttention(bus);
    expect(list.blocking).toBe(0);
    expect(list.rows.every((r) => r.kind === "owed")).toBe(true);
  });

  it("reports a failing producer and counts what the producers left out", () => {
    const bus = fakeEventBus();
    const fixture = producers(bus);
    fixture.set("git", { items: [reviewItem()], total: 14 });
    fixture.views.define({
      id: "broken.attention",
      kind: "attention",
      title: "Broken",
      model: () => {
        throw new Error("boom");
      },
    });
    const { list } = readAttention(bus);
    expect(list.failed).toEqual(["broken.attention"]);
    expect(list.owed).toBe(15);
    expect(list.more).toBe(13);
  });
});

group("hintText", () => {
  it("counts every owed item, and is absent when nothing is owed", () => {
    expect(hintText(EMPTY)).toBeUndefined();
    expect(hintText(listOf([row(reviewItem())]))).toBe("◆ 1 needs you · /attention");
    expect(hintText(listOf([row(reviewItem())], { owed: 3, more: 2 }))).toBe(
      "◆ 3 need you · /attention",
    );
  });
});

group("age", () => {
  it("is compact and never negative", () => {
    expect(age(undefined, NOW)).toBeUndefined();
    expect(age(NOW + MINUTE, NOW)).toBe("now");
    expect(age(NOW - 12 * MINUTE, NOW)).toBe("12m");
    expect(age(NOW - 3 * 60 * MINUTE, NOW)).toBe("3h");
    expect(age(NOW - 72 * 60 * MINUTE, NOW)).toBe("3d");
  });
});

group("describe", () => {
  it("prints each row with its state, reason, age and link", () => {
    expect(describe(listOf([row(reviewItem()), row(staleItem)], { more: 2 }), NOW)).toBe(
      [
        "Needs you · this session",
        "◆ Review acme/web#42 · Ready",
        "  Checkout cleanup · draft at a13c90e · 12m",
        "  https://github.com/acme/web/pull/42",
        "◇ acme/api#57 · Stale",
        "  Pushed since you were asked · 3h",
        "  https://github.com/acme/api/pull/57",
        "and 2 more",
      ].join("\n"),
    );
  });

  it("says when nothing is owed, and which views could not be read", () => {
    expect(describe(EMPTY, NOW)).toBe("Nothing needs you in this session.");
    expect(describe(listOf([], { failed: ["git.attention"] }), NOW)).toBe(
      "Nothing needs you in this session.\nCouldn't read git.attention.",
    );
  });

  it("keeps an untrusted reason on one line", () => {
    const text = describe(listOf([row(reviewItem({ reason: "one\ntwo\x1b[31m" }))]), NOW);
    expect(text).toContain("  one two · 12m");
    expect(text).not.toContain("\x1b");
  });
});
