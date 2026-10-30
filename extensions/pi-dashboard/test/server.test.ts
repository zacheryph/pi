import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HUB_ENTRY, nodeRuntime } from "#src/launch";
import { hubPaths, PROTOCOL_VERSION } from "#src/protocol";
import { fakeReporter, get, onCleanup, snapshot, tempDir, waitFor } from "#test/helpers";

// Runs the hub exactly as Pi launches it: plain Node stripping the TypeScript.
function runHub(dir: string, idleGraceMs: number) {
  const child = spawn(nodeRuntime(), ["--disable-warning=ExperimentalWarning", HUB_ENTRY, "--dir", dir, "--port", "0", "--idle-grace-ms", String(idleGraceMs)], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  onCleanup(() => { if (child.exitCode === null) child.kill(); });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  return { child, exited, log: () => stderr };
}

describe("hub process", () => {
  it("starts under plain Node, serves sessions, and exits once the last one quits", async () => {
    const dir = tempDir();
    const hub = runHub(dir, 200);
    const port = Number((await waitFor(() => hub.log().match(/listening on http:\/\/127\.0\.0\.1:(\d+)\//) ?? undefined, 10_000))[1]);
    const reporter = await fakeReporter(hubPaths(dir).socket);
    reporter.send({ type: "hello", version: PROTOCOL_VERSION, snapshot: snapshot({ name: "real" }) });
    await waitFor(async () => (await get(port, "/api/sessions")).body.includes("\"name\":\"real\""));
    reporter.send({ type: "bye", reason: "quit" });
    reporter.socket.end();
    expect(await hub.exited).toBe(0);
    expect(existsSync(hubPaths(dir).socket)).toBe(false);
    expect(hub.log()).not.toContain("ExperimentalWarning");
  });

  it("exits quietly when another hub already owns the socket", async () => {
    const dir = tempDir();
    const first = runHub(dir, 5_000);
    await waitFor(() => first.log().includes("listening on"), 10_000);
    const second = runHub(dir, 5_000);
    expect(await second.exited).toBe(0);
    expect(second.log()).toContain("another hub owns the socket");
    first.child.kill("SIGTERM");
    expect(await first.exited).toBe(0);
  });
});
