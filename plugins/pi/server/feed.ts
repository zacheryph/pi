import { createConnection } from "node:net";
import { stateSchema, type HarnessState } from "../shared/state.ts";
import { feedPath } from "./path.ts";

/** One bounded JSON line per full snapshot; never joins partial frames across reconnects. */
export class FeedDecoder {
  private buffer = "";
  push(chunk: string): HarnessState[] {
    this.buffer += chunk;
    if (this.buffer.length > 1024 * 1024) throw new Error("Pi presentation frame is too large.");
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    return lines.filter((line) => line.trim()).map((line) => stateSchema.parse(JSON.parse(line)));
  }
}

export function followFeed(
  sessionId: string,
  signal: AbortSignal,
  onState: (state: HarnessState) => void,
  onUnavailable: () => void,
): () => void {
  let socket: ReturnType<typeof createConnection> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const connect = () => {
    if (stopped || signal.aborted) return;
    const decoder = new FeedDecoder();
    socket = createConnection(feedPath(sessionId));
    socket.setEncoding("utf8");
    socket.on("data", (data) => {
      try {
        for (const state of decoder.push(String(data))) {
          if (state.sessionId !== sessionId) throw new Error("Pi session changed.");
          onState(state);
        }
      } catch {
        socket?.destroy();
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      if (stopped || signal.aborted) return;
      onUnavailable();
      timer = setTimeout(connect, 1000);
      timer.unref();
    });
  };
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    socket?.destroy();
    signal.removeEventListener("abort", stop);
  };
  signal.addEventListener("abort", stop, { once: true });
  connect();
  return stop;
}
