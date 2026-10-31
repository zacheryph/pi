import { describe, expect, it } from "vitest";
import { encode, isSnapshot, LineDecoder } from "#src/protocol";
import { snapshot } from "#test/helpers";

describe("LineDecoder", () => {
  it("joins partial chunks and splits several messages", () => {
    const decoder = new LineDecoder();
    const line = encode({ type: "bye", reason: "quit" });
    expect(decoder.push(line.slice(0, 5))).toEqual([]);
    expect(decoder.push(line.slice(5) + line)).toEqual([
      { type: "bye", reason: "quit" },
      { type: "bye", reason: "quit" },
    ]);
  });

  it("drops malformed lines and keeps going", () => {
    const decoder = new LineDecoder();
    expect(decoder.push('{nope\n\n{"a":1}\n')).toEqual([{ a: 1 }]);
  });

  it("discards an unterminated line over the size cap", () => {
    const decoder = new LineDecoder();
    decoder.push("x".repeat(1024 * 1024 + 1));
    expect(decoder.push('{"a":2}\n')).toEqual([{ a: 2 }]);
  });
});

describe("isSnapshot", () => {
  it("accepts a minimal snapshot and rejects broken ones", () => {
    expect(isSnapshot(snapshot())).toBe(true);
    expect(isSnapshot({ ...snapshot(), id: "" })).toBe(false);
    expect(isSnapshot({ ...snapshot(), pid: 1.5 })).toBe(false);
    expect(isSnapshot({ ...snapshot(), status: { kind: "idle" } })).toBe(false);
    expect(isSnapshot(null)).toBe(false);
  });
});
