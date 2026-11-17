#!/usr/bin/env node
import { createJiti } from "jiti";
await createJiti(import.meta.url, { fsCache: false }).import("../src/cli.ts");
