import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  boundaryProblems,
  clientProblems,
  importSpecifiers,
  packageBoundaryProblems,
  packageName,
} from "./package-boundary.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A repository on disk with one extension, two packages and the two clients, all within
 * the rules; `files` adds or replaces files by relative path (objects are written as JSON).
 * @param {Record<string, string | object>} [files]
 */
function fixture(t, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "package-boundary-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const all = {
    "package.json": { workspaces: ["extensions/pi-a", "packages/pi-lib", "packages/pi-surface"] },
    "extensions/pi-a/package.json": {
      name: "pi-a",
      imports: { "#src/*": "./src/*.ts", "#lib": "pi-lib" },
      exports: { ".": "./src/index.ts" },
    },
    "extensions/pi-a/src/index.ts": 'import { lib } from "#lib";\nexport const a = lib;\n',
    "packages/pi-lib/package.json": {
      name: "pi-lib",
      imports: { "#src/*": "./src/*.ts" },
      exports: { ".": "./src/index.ts" },
      dependencies: { zod: "^4.0.0" },
    },
    "packages/pi-lib/src/index.ts": 'import { z } from "zod";\nexport const lib = z;\n',
    "packages/pi-surface/package.json": {
      name: "pi-surface",
      imports: { "#src/*": "./src/*.ts" },
      exports: { ".": "./src/index.ts", "./*": "./src/*.ts" },
    },
    "packages/pi-surface/src/index.ts": 'export * from "#src/model";\n',
    "packages/pi-surface/src/model.ts": "export type Tone = string;\n",
    "bb-plugin/package.json": { name: "bb-plugin", dependencies: { "pi-surface": "file:../x" } },
    "bb-plugin/contract.ts":
      'import { z } from "zod";\nexport type { Tone } from "pi-surface/model";\n',
    "bb-plugin/ui/card.tsx": 'import { cn } from "@/lib/utils";\nexport const card = cn;\n',
    "bb-plugin/lib/utils.ts": "export const cn = 1;\n",
    "extensions/pi-dashboard/package.json": {
      name: "pi-dashboard",
      imports: { "#src/*": "./src/*.ts", "#surface": "pi-surface" },
    },
    "extensions/pi-dashboard/src/hub/server.ts":
      'import { join } from "node:path";\nimport { Hub } from "#src/hub/hub";\nimport type { Tone } from "#surface";\n',
    "extensions/pi-dashboard/src/hub/hub.ts":
      'import { PROTOCOL } from "#src/protocol";\nexport class Hub {}\n',
    "extensions/pi-dashboard/src/protocol.ts": "export const PROTOCOL = 7;\n",
    "extensions/pi-dashboard/src/reporter.ts": 'import { a } from "pi-a";\n',
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(
      join(dir, path),
      typeof content === "string" ? content : JSON.stringify(content, null, 2),
    );
  }
  return dir;
}

void test("this repository keeps packages and its clients off extensions", () => {
  assert.deepEqual(boundaryProblems(root), []);
});

void test("a fixture within the rules has no problems", (t) => {
  assert.deepEqual(boundaryProblems(fixture(t)), []);
});

void test("specifiers come from imports, re-exports, type imports, import() and require()", () => {
  const text = [
    'import a from "one";',
    'import type { B } from "two";',
    "import {",
    "  c,",
    "  type D,",
    '} from "three";',
    'export * from "four";',
    'export { e } from "five";',
    'import "six";',
    'const f = await import("seven");',
    'const g = require("eight");',
    '// import h from "not-this";',
    '/* import i from "nor-this"; */',
    "const text = \"import j from 'nor-that'\";",
  ].join("\n");
  assert.deepEqual(importSpecifiers(text).sort(), [
    "eight",
    "five",
    "four",
    "one",
    "seven",
    "six",
    "three",
    "two",
  ]);
  assert.equal(packageName("pi-todo/src/events"), "pi-todo");
  assert.equal(packageName("@scope/name/sub"), "@scope/name");
});

void test("a package that depends on an extension fails, in every dependency field", (t) => {
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const dir = fixture(t, {
      "packages/pi-lib/package.json": { name: "pi-lib", [field]: { "pi-a": "*" } },
    });
    assert.deepEqual(packageBoundaryProblems(dir), [
      `packages/pi-lib/package.json: ${field} names extension pi-a`,
    ]);
  }
  const byPath = fixture(t, {
    "packages/pi-lib/package.json": {
      name: "pi-lib",
      dependencies: { other: "file:../../extensions/pi-a" },
    },
  });
  assert.deepEqual(packageBoundaryProblems(byPath), [
    "packages/pi-lib/package.json: dependencies names extension other",
  ]);
});

void test("a package import map that names an extension or points into one fails", (t) => {
  const dir = fixture(t, {
    "packages/pi-lib/package.json": {
      name: "pi-lib",
      imports: {
        "#src/*": "./src/*.ts",
        "#a/*": "pi-a/*",
        "#a-src": "../../extensions/pi-a/src/index.ts",
        "#cond": { types: "./src/index.ts", default: "pi-a" },
      },
    },
  });
  assert.deepEqual(packageBoundaryProblems(dir), [
    "packages/pi-lib/package.json: imports maps to extension pi-a/*",
    "packages/pi-lib/package.json: imports maps to extension ../../extensions/pi-a/src/index.ts",
    "packages/pi-lib/package.json: imports maps to extension pi-a",
  ]);
});

void test("package source that imports an extension by name or relative path fails", (t) => {
  const dir = fixture(t, {
    "packages/pi-lib/src/index.ts": [
      'import type { A } from "pi-a/src/index";',
      'import { a } from "../../../extensions/pi-a/src/index.ts";',
      'export * from "../../pi-surface/src/model.ts";',
    ].join("\n"),
    "packages/pi-lib/test/lib.test.ts": 'const a = await import("pi-a");\n',
  });
  assert.deepEqual(packageBoundaryProblems(dir), [
    "packages/pi-lib/src/index.ts: package pi-lib imports extension code pi-a/src/index",
    "packages/pi-lib/src/index.ts: package pi-lib imports extension code ../../../extensions/pi-a/src/index.ts",
    "packages/pi-lib/test/lib.test.ts: package pi-lib imports extension code pi-a",
  ]);
});

void test("an extension may depend on packages and other extensions", (t) => {
  const dir = fixture(t, {
    "extensions/pi-a/src/index.ts": 'import { b } from "pi-b";\nimport { lib } from "#lib";\n',
    "extensions/pi-b/package.json": { name: "pi-b" },
  });
  assert.deepEqual(packageBoundaryProblems(dir), []);
});

void test("bb-plugin's contract reaches only pi-surface: no extension, no removed package", (t) => {
  const throughExtension = fixture(t, {
    "bb-plugin/contract.ts": 'export type { A } from "../extensions/pi-a/src/index.ts";\n',
  });
  assert.deepEqual(boundaryProblems(throughExtension), [
    "bb-plugin reaches extensions/pi-a/src/index.ts",
    "bb-plugin reaches packages/pi-lib/src/index.ts",
  ]);
  const throughPackage = fixture(t, {
    "bb-plugin/contract.ts": 'export type { Lib } from "pi-lib";\n',
    "bb-plugin/package.json": { name: "bb-plugin", dependencies: { "pi-lib": "file:../x" } },
  });
  assert.deepEqual(boundaryProblems(throughPackage), [
    "bb-plugin/package.json: dependencies names pi-lib, not pi-surface",
    "bb-plugin reaches packages/pi-lib/src/index.ts",
  ]);
  // A package that no longer exists is not mistaken for an outside one when it is a sibling path.
  const removed = fixture(t, {
    "bb-plugin/contract.ts":
      'export type { Snapshot } from "../packages/pi-presentation/src/contract";\n',
  });
  assert.deepEqual(boundaryProblems(removed), [
    "bb-plugin: bb-plugin/contract.ts: cannot resolve ../packages/pi-presentation/src/contract",
  ]);
});

void test("the dashboard hub loads only its own modules, pi-surface and Node built-ins", (t) => {
  const dashboard = (dir) =>
    clientProblems(dir, {
      name: "hub",
      entries: [join(dir, "extensions/pi-dashboard/src/hub/server.ts")],
      allowed: [
        join(dir, "extensions/pi-dashboard/src/hub"),
        join(dir, "extensions/pi-dashboard/src/protocol.ts"),
        join(dir, "packages/pi-surface/src"),
      ],
      externalAllowed: (specifier) => specifier.startsWith("node:"),
    });
  assert.deepEqual(dashboard(fixture(t)), []);
  const reporter = fixture(t, {
    "extensions/pi-dashboard/src/hub/hub.ts": 'import type { R } from "#src/reporter";\n',
  });
  assert.deepEqual(dashboard(reporter), [
    "hub reaches extensions/pi-a/src/index.ts",
    "hub reaches extensions/pi-dashboard/src/reporter.ts",
    "hub reaches packages/pi-lib/src/index.ts",
    "hub imports zod from outside the repository",
  ]);
  const dependency = fixture(t, {
    "extensions/pi-dashboard/src/protocol.ts": 'import { z } from "zod";\n',
  });
  assert.deepEqual(dashboard(dependency), ["hub imports zod from outside the repository"]);
});
