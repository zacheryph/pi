import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { encode, type ReporterMessage, type SessionSnapshot } from "#src/protocol";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

export function onCleanup(cleanup: () => unknown): void {
  cleanups.push(cleanup);
}

/** Short prefix: unix socket paths are limited to about 104 bytes on macOS. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pid-"));
  onCleanup(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export async function waitFor<T>(check: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: "101", pid: 101, sessionId: "session-a", cwd: "/work/api",
    status: { kind: "idle", since: 1 }, startedAt: 1, ...overrides,
  };
}

export interface FakeReporter {
  socket: Socket;
  send(message: ReporterMessage | Record<string, unknown>): void;
  closed: Promise<void>;
}

export async function fakeReporter(path: string): Promise<FakeReporter> {
  const socket = connect(path);
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  onCleanup(() => socket.destroy());
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  return { socket, closed, send: (message) => socket.write(encode(message as ReporterMessage)) };
}

export function get(port: number, path: string, host = `127.0.0.1:${port}`): Promise<{ status: number; body: string; type?: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, type: res.headers["content-type"] }));
    });
    req.on("error", reject);
    req.end();
  });
}

export function post(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "POST", headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}
