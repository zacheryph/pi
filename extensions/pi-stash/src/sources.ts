import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

export interface SourceText {
  text: string;
  mime: string;
  source: string;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ".json": "application/json", ".md": "text/markdown", ".markdown": "text/markdown",
  ".csv": "text/csv", ".html": "text/html", ".xml": "application/xml", ".yaml": "application/yaml",
  ".yml": "application/yaml", ".ts": "text/typescript", ".js": "text/javascript", ".py": "text/x-python",
};

export function guessMime(text: string, path?: string): string {
  const byExtension = path ? MIME_BY_EXTENSION[extname(path).toLowerCase()] : undefined;
  if (byExtension) return byExtension;
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(text);
      return "application/json";
    } catch { /* plain text */ }
  }
  return "text/plain";
}

function tooLarge(bytes: number, limit: number): Error {
  return new Error(`Entry is ${bytes} bytes; the limit is ${limit} bytes (stash.maxEntryBytes)`);
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!!rel && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * Same path spelling as Pi's `read` (`@` prefix, `~`, relative to cwd), but
 * the real file must stay inside the real cwd: a symlink pointing outside is
 * refused, as are directories, devices and binary files.
 */
export function readCwdFile(path: string, cwd: string, maxBytes: number): SourceText {
  let spelled = path.trim().replace(/^@/, "");
  if (spelled === "~" || spelled.startsWith("~/")) spelled = homedir() + spelled.slice(1);
  const resolved = resolve(cwd, spelled);
  const realCwd = realpathSync(cwd);
  let real: string;
  try {
    real = realpathSync(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`File not found: ${path}`);
    throw error;
  }
  if (!isInside(realCwd, real)) throw new Error(`Path is outside the working directory: ${path}`);
  const stat = statSync(real);
  if (!stat.isFile()) throw new Error(`Not a regular file: ${path}`);
  if (stat.size > maxBytes) throw tooLarge(stat.size, maxBytes);
  const buffer = readFileSync(real);
  if (buffer.includes(0)) throw new Error(`Binary files cannot be stashed: ${path}`);
  const text = buffer.toString("utf8");
  const display = relative(realCwd, real) || ".";
  return { text, mime: guessMime(text, real), source: `path:${display}` };
}

interface BranchEntry {
  type?: unknown;
  message?: {
    role?: unknown; toolCallId?: unknown; toolName?: unknown;
    content?: unknown; details?: unknown;
  };
}

/** Pi's bash keeps the untruncated output in a temp file; prefer it when present. */
function fullOutput(details: unknown): string | undefined {
  if (!details || typeof details !== "object") return undefined;
  const path = (details as { fullOutputPath?: unknown }).fullOutputPath;
  if (typeof path !== "string" || !isAbsolute(path)) return undefined;
  try {
    const temp = realpathSync(tmpdir());
    if (!isInside(temp, realpathSync(path)) || lstatSync(path).isSymbolicLink() || !statSync(path).isFile()) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Text of an earlier tool result on the current branch (persisted results only). */
export function readToolResult(branch: Iterable<unknown>, toolCallId: string, maxBytes: number): SourceText {
  let found: BranchEntry["message"] | undefined;
  for (const entry of branch) {
    const item = entry as BranchEntry;
    if (item?.type === "message" && item.message?.role === "toolResult" && item.message.toolCallId === toolCallId) {
      found = item.message;
    }
  }
  if (!found) {
    throw new Error(`No tool result with id "${toolCallId}" on the current branch. Calls made inside a codemode script are not kept; stash their output with content instead.`);
  }
  const text = fullOutput(found.details) ?? (Array.isArray(found.content) ? found.content : [])
    .filter((part): part is { type: "text"; text: string } => !!part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes) throw tooLarge(bytes, maxBytes);
  const toolName = typeof found.toolName === "string" ? found.toolName : "unknown";
  return { text, mime: guessMime(text), source: `tool:${toolName}` };
}

export function literalContent(text: string, maxBytes: number): SourceText {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes) throw tooLarge(bytes, maxBytes);
  return { text, mime: guessMime(text), source: "content" };
}
