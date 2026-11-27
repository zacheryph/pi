import { describe, expect, it } from "vitest";
import { utf8Bytes, type ViewEntry } from "#surface";
import {
  boundError,
  encode,
  LineDecoder,
  offeredActions,
  readCommand,
  readSnapshot,
  SNAPSHOT_FRAMING_BYTES,
  snapshotLine,
} from "#src/protocol";
import { snapshot } from "#test/helpers";

describe("LineDecoder", () => {
  it("joins partial chunks and splits several messages", () => {
    const decoder = new LineDecoder();
    const line = encode({ type: "bye", reason: "quit" });
    expect(decoder.push(line.slice(0, 5))).toEqual([]);
    expect(decoder.push(line.slice(5) + line)).toEqual([
      { ok: true, value: { type: "bye", reason: "quit" } },
      { ok: true, value: { type: "bye", reason: "quit" } },
    ]);
  });

  it("reports malformed lines and keeps going", () => {
    const decoder = new LineDecoder();
    expect(decoder.push('{nope\n\n{"a":1}\n')).toEqual([
      { ok: false, error: "Message is not JSON." },
      { ok: true, value: { a: 1 } },
    ]);
  });

  it("joins a multibyte character split across chunks", () => {
    const decoder = new LineDecoder();
    const bytes = Buffer.from('{"t":"é😀"}\n', "utf8");
    expect(decoder.push(bytes.subarray(0, 8))).toEqual([]);
    expect(decoder.push(bytes.subarray(8))).toEqual([{ ok: true, value: { t: "é😀" } }]);
  });

  it("measures lines in UTF-8 bytes, not UTF-16 units", () => {
    const decoder = new LineDecoder(100);
    // 60 units, 120 bytes: over the limit although its string length is not.
    const wide = JSON.stringify({ t: "é".repeat(54) });
    expect(wide.length).toBeLessThan(100);
    expect(utf8Bytes(wide)).toBeGreaterThan(100);
    const [refused] = decoder.push(`${wide}\n`);
    expect(refused).toEqual({ ok: false, error: expect.stringMatching(/^Message too large/) });
    expect(decoder.push(`${JSON.stringify({ t: "e".repeat(54) })}\n`)).toMatchObject([
      { ok: true },
    ]);
  });

  it("skips the rest of an oversized line however it arrives, then reads the next", () => {
    const decoder = new LineDecoder(64);
    expect(decoder.push("x".repeat(40))).toEqual([]);
    expect(decoder.push("x".repeat(40))).toEqual([]);
    expect(decoder.push(`${"x".repeat(1000)}\n{"a":2}\n`)).toEqual([
      { ok: false, error: "Message too large: 1080 bytes, over 64." },
      { ok: true, value: { a: 2 } },
    ]);
  });

  it("accepts a line of exactly the limit and rejects one byte more", () => {
    const decoder = new LineDecoder(10);
    expect(decoder.push(`"${"é".repeat(4)}"\n`)).toEqual([{ ok: true, value: "éééé" }]);
    expect(decoder.push(`"${"é".repeat(4)}x"\n`)).toMatchObject([{ ok: false }]);
  });
});

describe("snapshot lines", () => {
  it("frame a snapshot's JSON exactly as encode would, within the framing allowance", () => {
    const value = snapshot();
    const json = JSON.stringify(value);
    for (const type of ["hello", "update"] as const) {
      const line = snapshotLine(type, json);
      expect(JSON.parse(line)).toEqual(
        type === "hello" ? { type, version: 7, snapshot: value } : { type, snapshot: value },
      );
      expect(utf8Bytes(line) - utf8Bytes(json)).toBeLessThanOrEqual(SNAPSHOT_FRAMING_BYTES);
    }
  });

  it("reads snapshots tolerantly and rejects a malformed envelope", () => {
    expect(readSnapshot({ snapshot: snapshot() })).toEqual(snapshot());
    expect(readSnapshot({ snapshot: { id: "", views: [] } })).toBeUndefined();
    expect(readSnapshot({ snapshot: { id: "a" } })).toBeUndefined();
    expect(readSnapshot(null)).toBeUndefined();
    // A newer producer's kind is left out; a malformed known kind becomes an error entry.
    const read = readSnapshot({
      snapshot: {
        id: "a",
        views: [
          { id: "x.new", kind: "hologram", title: "New", model: {} },
          { id: "system.session", kind: "session", title: "Session", model: { cwd: 1 } },
        ],
      },
    });
    expect(read?.views).toEqual([
      { id: "system.session", kind: "session", title: "Session", error: "Malformed session view." },
    ]);
  });
});

describe("readCommand", () => {
  it("accepts Focus and well-formed action requests only", () => {
    expect(readCommand({ command: "focus" })).toEqual({ command: "focus" });
    expect(readCommand({ command: "action", action: "ask.submit", args: { id: "q" } })).toEqual({
      command: "action",
      action: "ask.submit",
      args: { id: "q" },
    });
    expect(readCommand({ command: "action", action: "Not An Id" })).toBeUndefined();
    expect(readCommand({ command: "action", action: "a.b", args: Number.NaN })).toBeUndefined();
    expect(readCommand({ command: "answer", question: "q" })).toBeUndefined();
    expect(readCommand(null)).toBeUndefined();
  });
});

describe("boundError", () => {
  it("keeps errors within the view error bound without splitting a surrogate pair", () => {
    expect(boundError("short")).toBe("short");
    const cut = boundError(`${"x".repeat(498)}😀😀`);
    expect(cut).toHaveLength(499);
    expect(cut.endsWith("x…")).toBe(true);
  });
});

describe("offeredActions", () => {
  it("collects the actions explorers and forms reference, and nothing from failed views", () => {
    const views: ViewEntry[] = [
      {
        id: "todo.explorer",
        kind: "explorer",
        title: "Todos",
        model: {
          title: "Todos",
          items: [],
          loadDetail: { action: "todo.inspect" },
          marker: { label: "flagged", onClear: { action: "todo.unflag" } },
        },
      },
      {
        id: "ask.questions",
        kind: "form",
        title: "Questions",
        model: {
          questionnaires: [
            {
              id: "q1",
              questions: [{ question: "Ok?", options: [] }],
              submit: { action: "ask.submit", args: { id: "q1" } },
              cancel: { action: "ask.cancel", args: { id: "q1" } },
            },
          ],
        },
      },
      { id: "git.prs", kind: "explorer", title: "PRs", error: "failed" },
      { id: "todo.widget", kind: "widget", title: "Tasks", model: { title: "Tasks", rows: [] } },
    ];
    expect([...offeredActions(views)].sort()).toEqual([
      "ask.cancel",
      "ask.submit",
      "todo.inspect",
      "todo.unflag",
    ]);
  });
});
