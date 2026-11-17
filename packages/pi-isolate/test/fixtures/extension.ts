import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { defineScenario, HOLD } from "#scripted-model/scenario";

const root = process.env.PI_ISOLATE_FIXTURES!;
if (
  process.env.PI_ISOLATE_NETWORK_PROBE === "1" &&
  !existsSync(join(root, "allowed/network.json"))
) {
  const request = (url: string) => {
    const result = spawnSync(
      "/usr/bin/curl",
      ["--silent", "--show-error", "--fail", "--noproxy", "", "--max-time", "15", url],
      { encoding: "utf8" },
    );
    return { status: result.status, body: result.stdout, diagnostic: result.stderr };
  };
  writeFileSync(
    join(root, "allowed/network.json"),
    JSON.stringify({
      allowed: request("https://example.com"),
      denied: request("https://example.org"),
    }),
  );
}
function check(root: string, fs: typeof import("node:fs"), join: typeof import("node:path").join) {
  const result: Record<string, unknown> = {};
  for (const dir of ["allowed", "denied"]) {
    try {
      result[`${dir}Read`] = fs.readFileSync(join(root, dir, "secret"), "utf8");
    } catch {
      result[`${dir}Read`] = "blocked";
    }
    try {
      fs.writeFileSync(join(root, dir, "written"), "child");
      result[`${dir}Write`] = "ok";
    } catch {
      result[`${dir}Write`] = "blocked";
    }
  }
  result.hostOnly = process.env.PI_ISOLATE_HOST_ONLY ?? "absent";
  result.literal = process.env.PI_ISOLATE_LITERAL;
  result.proxy = Boolean(process.env.HTTPS_PROXY || process.env.https_proxy);
  result.cwd = process.cwd();
  return result;
}
const nested = spawnSync(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    `import {readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';const root=${JSON.stringify(root)};process.stdout.write(JSON.stringify((${check.toString()})(root,{readFileSync,writeFileSync},join)));`,
  ],
  { encoding: "utf8" },
);
writeFileSync(
  join(root, "allowed/report.json"),
  JSON.stringify({
    top: check(root, { readFileSync, writeFileSync } as typeof import("node:fs"), join),
    subprocess: nested.status === 0 ? JSON.parse(nested.stdout) : { error: nested.stderr },
  }),
);
export default defineScenario({ replies: [["isolation-probe-ok"]], prompts: { hold: [HOLD] } });
