import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { onTestFinished } from "vitest";

/**
 * A `gh` on PATH that answers every call with what `answer` last set, so pi-git
 * reads pull requests without GitHub. Removed, and PATH restored, when the test ends.
 */
export function fakeGh(initial: object): { answer(json: object): void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "bundle-gh-")));
  const reply = join(dir, "reply.json");
  const answer = (json: object) => writeFileSync(reply, JSON.stringify(json));
  answer(initial);
  writeFileSync(join(dir, "gh"), `#!/bin/sh\nexec cat '${reply}'\n`);
  chmodSync(join(dir, "gh"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${path ?? ""}`;
  onTestFinished(() => {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  });
  return { answer };
}
