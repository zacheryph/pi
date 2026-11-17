import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Disposers, attachedChild } from "#src/lifecycle";
import { quoteArg, resolvePi, splitArguments } from "#src/resolve";

it("quotes every argument including empty strings and shell metacharacters", () => {
  const values = ["", "hello world", "'", "$(exit 44)", "`exit 45`", "a\nb", "--isolate", "雪 👋"];
  const command = [
    process.execPath,
    "-e",
    "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
    "--",
    ...values,
  ]
    .map(quoteArg)
    .join(" ");
  expect(
    JSON.parse(
      execFileSync("/bin/bash", ["--noprofile", "--norc", "-c", command], { encoding: "utf8" }),
    ),
  ).toEqual(values);
});
it("resolves the peer bin independently of cwd and PATH", () => {
  expect(resolvePi().entry).toMatch(/pi-coding-agent\/dist\/bundle\/cli\.js$/);
});
it("delegates a plain invocation without a policy or SRT", () => {
  const bin = fileURLToPath(new URL("../bin/pi-launch.mjs", import.meta.url));
  expect(
    execFileSync(process.execPath, [bin, "--version"], {
      encoding: "utf8",
      env: { ...process.env, PATH: "/nonexistent" },
      cwd: "/tmp",
    }).trim(),
  ).toBe("1.5.2");
});
describe("resource lifetime", () => {
  it("unwinds in reverse order exactly once even when a disposer fails", async () => {
    const stack = new Disposers();
    const order: number[] = [];
    stack.add(() => {
      order.push(1);
    });
    stack.add(() => {
      order.push(2);
      throw new Error("failure");
    });
    stack.add(() => {
      order.push(3);
    });
    await expect(stack.close()).rejects.toThrow("cleanup failed");
    await stack.close();
    expect(order).toEqual([3, 2, 1]);
  });
  it("preserves nonzero child exit status", async () => {
    const child = attachedChild(
      process.execPath,
      ["-e", "process.exit(37)"],
      {},
      new AbortController().signal,
    );
    expect(await child.done).toEqual({ code: 37, signal: null });
    await child.stop();
  });
  it("forwards supervisor cancellation and preserves the child signal", async () => {
    const abort = new AbortController();
    const child = attachedChild(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      {},
      abort.signal,
    );
    abort.abort("SIGTERM");
    expect(await child.done).toEqual({ code: null, signal: "SIGTERM" });
  });
  it("handles spawn failure without waiting forever", async () => {
    const child = attachedChild("/does-not-exist/pi-isolate", [], {}, new AbortController().signal);
    await expect(child.done).rejects.toThrow();
    await child.stop();
  });
});

it.skipIf(process.env.PI_ISOLATE_PROBE !== "1")(
  "stops an observed detached descendant after the immediate child exits",
  async ({ onTestFinished }) => {
    const { tempDir } = await import("#test-helpers");
    const { readFileSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const pidFile = join(tempDir(onTestFinished), "pid");
    const script = `const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});writeFileSync(${JSON.stringify(pidFile)},String(child.pid));child.unref();setTimeout(()=>process.exit(0),400);`;
    let descendant: number | undefined;
    onTestFinished(() => {
      if (descendant) {
        try {
          process.kill(descendant, "SIGKILL");
        } catch {}
      }
    });
    const child = attachedChild(process.execPath, ["-e", script], {}, new AbortController().signal);
    expect(await child.done).toEqual({ code: 0, signal: null });
    expect(existsSync(pidFile)).toBe(true);
    descendant = Number(readFileSync(pidFile, "utf8"));
    await child.stop();
    expect(() => process.kill(descendant!, 0)).toThrow();
    descendant = undefined;
  },
);

it("consumes only a leading isolation flag, preserving prompts and option values", () => {
  for (const args of [[], ["prompt", "--isolate"], ["--model", "--isolate"], ["--", "--isolate"]]) {
    expect(splitArguments(args)).toEqual({ isolated: false, args });
  }
  expect(splitArguments(["--isolate", "", "--model", "--isolate", "雪"])).toEqual({
    isolated: true,
    args: ["", "--model", "--isolate", "雪"],
  });
});
