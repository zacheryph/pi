import { createServer, type Socket } from "node:net";
import { mkdir, lstat } from "node:fs/promises";
import { feedDirectory, feedPath } from "./path.ts";

/** Read-only private feed; every connection receives the latest complete state. */
export async function serveFeed(
  sessionId: string,
  read: () => unknown,
  subscribe: (changed: () => void) => () => void,
): Promise<() => Promise<void>> {
  const dir = feedDirectory();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error("Pi presentation directory must be private and owned by this user.");
  const sockets = new Set<Socket>();
  const publish = (socket: Socket) => {
    const frame = `${JSON.stringify(read())}\n`;
    // Disconnect a slow client; reconnect gets a fresh snapshot rather than a growing queue.
    if (Buffer.byteLength(frame) > 1024 * 1024 || socket.writableLength > 1024 * 1024)
      socket.destroy();
    else socket.write(frame);
  };
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    publish(socket);
  });
  const off = subscribe(() => {
    for (const socket of sockets) publish(socket);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(feedPath(sessionId), () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    off();
    server.close();
    throw error;
  }
  return async () => {
    off();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  };
}
