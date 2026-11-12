import { request } from "node:http";
import { connect, type Socket } from "node:net";
import { onTestFinished } from "vitest";
import { encode, type ReporterMessage, type SessionSnapshot } from "#src/protocol";
import { tempDir as sharedTempDir } from "#test-helpers";

export { sleep, waitFor } from "#test-helpers";

export function onCleanup(cleanup: () => unknown): void {
  onTestFinished(async () => {
    await cleanup();
  });
}

/** Short prefix: unix socket paths are limited to about 104 bytes on macOS. */
export const tempDir = (): string => sharedTempDir(onTestFinished, "pid-");

export function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: "101",
    pid: 101,
    sessionId: "session-a",
    cwd: "/work/api",
    status: { kind: "idle", since: 1 },
    startedAt: 1,
    ...overrides,
  };
}

export interface FakeReporter {
  socket: Socket;
  send(message: ReporterMessage | Record<string, unknown>): void;
  closed: Promise<void>;
}

export async function fakeReporter(path: string): Promise<FakeReporter> {
  const socket = connect(path);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  onCleanup(() => socket.destroy());
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  return { socket, closed, send: (message) => socket.write(encode(message as ReporterMessage)) };
}

export function get(
  port: number,
  path: string,
  host = `127.0.0.1:${port}`,
): Promise<{ status: number; body: string; type?: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body, type: res.headers["content-type"] }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

export function post(
  port: number,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: { host: `127.0.0.1:${port}`, ...headers },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** The session cards a hub serves, or none while it has no HTTP port. */
export async function listSessions(
  hub: { httpPort?: number } | undefined,
): Promise<Array<Record<string, unknown>>> {
  return hub?.httpPort
    ? (JSON.parse((await get(hub.httpPort, "/api/sessions")).body).sessions as Array<
        Record<string, unknown>
      >)
    : [];
}
