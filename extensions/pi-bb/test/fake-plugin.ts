import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { onTestFinished } from "vitest";
import { waitFor } from "#test-helpers";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** One accepted WebSocket on the fake plugin; text frames only. */
export class FakeSocket {
  readonly received: unknown[] = [];
  readonly headers: IncomingMessage["headers"];
  closed?: { code: number };
  private buffer = Buffer.alloc(0);

  constructor(
    private readonly socket: Socket,
    headers: IncomingMessage["headers"],
  ) {
    this.headers = headers;
    socket.on("data", (chunk: Buffer) => this.read(chunk));
    socket.on("close", () => {
      this.closed ??= { code: 1006 };
    });
  }

  send(message: unknown): void {
    this.frame(0x1, Buffer.from(JSON.stringify(message)));
  }

  /** Closes with a code, as the plugin does when it refuses a session. */
  close(code = 1000): void {
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code);
    this.frame(0x8, payload);
    this.socket.end();
    this.closed ??= { code };
  }

  /** Drops the TCP connection without a close frame, as a crashed plugin would. */
  drop(): void {
    this.socket.destroy();
  }

  private frame(opcode: number, payload: Buffer): void {
    if (this.socket.destroyed) return;
    const length = payload.length;
    const head =
      length < 126
        ? Buffer.from([0x80 | opcode, length])
        : length < 65_536
          ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff])
          : (() => {
              const buffer = Buffer.alloc(10);
              buffer[0] = 0x80 | opcode;
              buffer[1] = 127;
              buffer.writeBigUInt64BE(BigInt(length), 2);
              return buffer;
            })();
    this.socket.write(Buffer.concat([head, payload]));
  }

  private read(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      const opcode = this.buffer[0]! & 0x0f;
      let length = this.buffer[1]! & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      // Clients always mask.
      if (this.buffer.length < offset + 4 + length) return;
      const mask = this.buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + length));
      for (let index = 0; index < payload.length; index += 1) payload[index]! ^= mask[index % 4]!;
      this.buffer = this.buffer.subarray(offset + 4 + length);
      if (opcode === 0x1) this.received.push(JSON.parse(payload.toString("utf8")));
      else if (opcode === 0x8) {
        this.closed ??= { code: payload.length >= 2 ? payload.readUInt16BE(0) : 1005 };
        this.socket.end();
      }
    }
  }
}

/** A stand-in for the pi-surface plugin's session endpoint. */
export class FakePlugin {
  readonly sockets: FakeSocket[] = [];
  readonly paths: string[] = [];
  private server?: Server;

  async start(): Promise<string> {
    const server = createServer((_request, response) => {
      response.statusCode = 426;
      response.end();
    });
    server.on("upgrade", (request: IncomingMessage, socket: Socket) => {
      const key = request.headers["sec-websocket-key"];
      if (typeof key !== "string") {
        socket.destroy();
        return;
      }
      const accept = createHash("sha1").update(`${key}${GUID}`).digest("base64");
      socket.write(
        [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${accept}`,
          "",
          "",
        ].join("\r\n"),
      );
      this.paths.push(request.url ?? "");
      this.sockets.push(new FakeSocket(socket, request.headers));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    this.server = server;
    onTestFinished(() => this.stop());
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}/api/v1/plugins/pi-surface/http/session`;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.drop();
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** The nth accepted socket, once it exists. */
  socket(index = 0): Promise<FakeSocket> {
    return waitFor(() => this.sockets[index]);
  }

  /** Messages on a socket matching `type`, once there are at least `count`. */
  async messages(socket: FakeSocket, type: string, count = 1): Promise<Array<Record<string, any>>> {
    return waitFor(() => {
      const found = socket.received.filter(
        (message) => (message as { type?: unknown }).type === type,
      ) as Array<Record<string, any>>;
      return found.length >= count ? found : undefined;
    });
  }
}
