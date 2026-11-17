import { request } from "node:http";
import { connect, type Socket } from "node:net";
import { onTestFinished } from "vitest";
import { SESSION_VIEW_ID, type SessionModel, type ViewEntry } from "#surface";
import {
  encode,
  LineDecoder,
  type DeliverySnapshot,
  type HubMessage,
  type ReporterMessage,
} from "#src/protocol";
import type { SessionRecord } from "#src/hub/hub";
import { tempDir as sharedTempDir } from "#test-helpers";

export { sleep, waitFor } from "#test-helpers";

export function onCleanup(cleanup: () => unknown): void {
  onTestFinished(async () => {
    await cleanup();
  });
}

/** Short prefix: unix socket paths are limited to about 104 bytes on macOS. */
export const tempDir = (): string => sharedTempDir(onTestFinished, "pid-");

export function sessionModel(overrides: Partial<SessionModel> = {}): SessionModel {
  return {
    sessionId: "session-a",
    cwd: "/work/api",
    status: { kind: "idle", since: 1 },
    startedAt: 1,
    ...overrides,
  };
}

export function sessionView(overrides: Partial<SessionModel> = {}): ViewEntry {
  return { id: SESSION_VIEW_ID, kind: "session", title: "Session", model: sessionModel(overrides) };
}

/** A snapshot with a `system.session` view, unless `views` says otherwise. */
export function snapshot(
  overrides: Partial<DeliverySnapshot> & { session?: Partial<SessionModel> } = {},
): DeliverySnapshot {
  const { session, ...rest } = overrides;
  return { id: "101", host: { pid: 101 }, views: [sessionView(session)], ...rest };
}

export interface FakeReporter {
  socket: Socket;
  send(message: ReporterMessage | Record<string, unknown>): void;
  /** Everything the hub sent, decoded, in order. */
  received: Array<HubMessage & Record<string, unknown>>;
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
  const received: FakeReporter["received"] = [];
  const decoder = new LineDecoder();
  socket.on("data", (chunk: Buffer) => {
    for (const decoded of decoder.push(chunk))
      if (decoded.ok) received.push(decoded.value as FakeReporter["received"][number]);
  });
  socket.on("error", () => {});
  return {
    socket,
    closed,
    received,
    send: (message) => socket.write(encode(message as ReporterMessage)),
  };
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

/** The session records a hub serves, or none while it has no HTTP port. */
export async function listSessions(
  hub: { httpPort?: number } | undefined,
): Promise<SessionRecord[]> {
  return hub?.httpPort
    ? (JSON.parse((await get(hub.httpPort, "/api/sessions")).body).sessions as SessionRecord[])
    : [];
}

/** A record's view by id, when it has one. */
export function view(record: SessionRecord | undefined, id: string): ViewEntry | undefined {
  return record?.views.find((entry) => entry.id === id);
}

/** A record's core session model, when its session view has one. */
export function core(record: SessionRecord | undefined): SessionModel | undefined {
  const entry = view(record, SESSION_VIEW_ID);
  return entry?.kind === "session" ? entry.model : undefined;
}

/** Posts an action request to the page's action route, as the page does. */
export function postAction(
  hub: { httpPort?: number; token: string },
  session: string,
  body: unknown,
): Promise<{ status: number; body: string }> {
  return post(
    hub.httpPort!,
    `/api/sessions/${session}/actions`,
    {
      "x-dashboard-token": hub.token,
      origin: `http://127.0.0.1:${hub.httpPort}`,
      "content-type": "application/json",
    },
    JSON.stringify(body),
  );
}
