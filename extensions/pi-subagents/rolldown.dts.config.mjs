import { dts } from "rolldown-plugin-dts";

// Roll all public type surfaces into self-contained declaration bundles.
// We ship .ts source, so we want only .d.ts — no JS emit.
// Internal #src/* modules are inlined; peer-dependency types are kept external.

const external = [/^@earendil-works\//, "typebox"];
const plugins = () =>
  dts({
    tsconfig: "./tsconfig.dts.json",
    generator: "tsgo",
    emitDtsOnly: true,
  });

export default [
  // . entry: cross-extension service contract (spawn/abort/workspace seam)
  {
    input: { public: "src/service/service.ts" },
    output: { dir: "dist", format: "es", codeSplitting: false },
    external,
    plugins: plugins(),
  },
  // ./settings entry: generic layered config loader for @gotgenes/pi-* extensions
  {
    input: { settings: "src/layered-settings.ts" },
    output: { dir: "dist", format: "es", codeSplitting: false },
    external,
    plugins: plugins(),
  },
];
