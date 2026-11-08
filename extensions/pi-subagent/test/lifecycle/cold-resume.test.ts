import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { reopenRefusal, resolveSavedModel } from "#src/lifecycle/cold-resume";
import { makeModel } from "#test/helpers/make-model";
import { tempDir } from "../../../../packages/pi-test-helpers/src/temp.ts";

describe("reopenRefusal", () => {
  let dir: string;
  let transcript: string;
  let cwd: string;
  const usable = () => true;

  beforeEach(() => {
    dir = tempDir(onTestFinished, "cold-resume-");
    transcript = join(dir, "agent.jsonl");
    writeFileSync(transcript, "{}\n");
    cwd = join(dir, "worktree");
    mkdirSync(cwd);
  });

  it("accepts a transcript and directory that both exist", () => {
    expect(reopenRefusal({ type: "explore", outputFile: transcript, cwd }, usable)).toBeUndefined();
  });

  it("refuses when no transcript was recorded", () => {
    expect(reopenRefusal({ type: "explore", cwd }, usable)).toBe("session-released");
  });

  it("refuses when the transcript is gone", () => {
    rmSync(transcript);
    expect(reopenRefusal({ type: "explore", outputFile: transcript, cwd }, usable)).toBe(
      "session-released",
    );
  });

  it("refuses a transcript path that is not a file", () => {
    expect(reopenRefusal({ type: "explore", outputFile: cwd, cwd }, usable)).toBe(
      "session-released",
    );
  });

  it("refuses when the directory was removed", () => {
    rmSync(cwd, { recursive: true });
    expect(reopenRefusal({ type: "explore", outputFile: transcript, cwd }, usable)).toBe(
      "directory-unavailable",
    );
  });

  it("refuses a record that never named its directory", () => {
    expect(reopenRefusal({ type: "explore", outputFile: transcript }, usable)).toBe(
      "directory-unavailable",
    );
  });

  it("refuses a type that is no longer usable", () => {
    expect(reopenRefusal({ type: "Gone", outputFile: transcript, cwd }, () => false)).toBe(
      "agent-type-unavailable",
    );
  });

  it("reports the missing transcript first, since nothing else then matters", () => {
    rmSync(transcript);
    rmSync(cwd, { recursive: true });
    expect(reopenRefusal({ type: "Gone", outputFile: transcript, cwd }, () => false)).toBe(
      "session-released",
    );
  });
});

describe("resolveSavedModel", () => {
  const model = makeModel({ provider: "open", id: "vendor/model-1" });
  const registry = {
    find: (provider: string, id: string) =>
      provider === model.provider && id === model.id ? model : undefined,
    getAll: () => [model],
    getAvailable: () => [model],
  };

  it("finds an exact label, splitting at the first slash", () => {
    expect(resolveSavedModel("open/vendor/model-1", registry)).toBe(model);
  });

  it("gives up on a model it cannot find, without guessing", () => {
    expect(resolveSavedModel("open/vendor/model", registry)).toBeUndefined();
  });

  it("gives up on a model that is no longer available", () => {
    expect(
      resolveSavedModel("open/vendor/model-1", { ...registry, getAvailable: () => [] }),
    ).toBeUndefined();
  });

  it("gives up on a missing or malformed label", () => {
    expect(resolveSavedModel(undefined, registry)).toBeUndefined();
    expect(resolveSavedModel("no-slash", registry)).toBeUndefined();
  });
});
