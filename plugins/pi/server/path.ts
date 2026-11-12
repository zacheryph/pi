import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const feedDirectory = () => join(tmpdir(), `pi-paseo-${process.getuid?.() ?? "user"}`);
export const feedPath = (sessionId: string) =>
  join(
    feedDirectory(),
    `${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}.sock`,
  );
