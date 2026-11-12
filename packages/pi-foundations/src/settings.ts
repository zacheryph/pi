import { errorText } from "./errors.ts";
import { isRecord } from "./guards.ts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { sanitizeLine } from "../../pi-ui/src/text.ts";

/** Missing files are absent; callers choose whether other failures throw, warn or fall back. */
export function readSettingsFile<T>(
  path: string,
  sanitize: (raw: unknown) => Partial<T>,
  onError?: (error: unknown) => void,
): Partial<T> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    if (!onError) throw error;
    onError(error);
    return {};
  }
  try {
    return sanitize(JSON.parse(raw));
  } catch (error) {
    if (!onError) throw error;
    onError(error);
    return {};
  }
}

/** Write JSON after creating its parent directory; errors remain the caller's decision. */
export function writeSettingsFile(path: string, value: unknown, trailingNewline = false): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + (trailingNewline ? "\n" : ""), "utf8");
}

/** Preserve unknown keys and refuse to overwrite malformed/non-object existing settings. */
export function patchSettingsFile(path: string, patch: object): void {
  const existing = readSettingsFile<Record<string, unknown>>(path, (raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("Settings must be a JSON object");
    return raw as Record<string, unknown>;
  });
  writeSettingsFile(path, { ...existing, ...patch }, true);
}

// ---- Declarative settings ----

/** What a field's default or transform may depend on. */
export interface SettingsContext {
  /** Session working directory. */
  cwd: string;
  /** Pi agent directory holding the global file. */
  agentDir: string;
}

/**
 * Outcome of validating one raw JSON value; `reason` completes "`<key>` …".
 * A collection that keeps its valid members lists each one it `dropped`, e.g.
 * `[2] must be a string`, which also completes "`<key>` …".
 */
export type FieldCheck<T> =
  | { ok: true; value: T; dropped?: string[] }
  | { ok: false; reason: string };

/** Validates one setting. Without a default it can only be wrapped by `optional`. */
export interface Validator<T> {
  check(raw: unknown): FieldCheck<T>;
}

/** A validated setting with its default and an optional post-merge transform. */
export interface Field<T> extends Validator<T> {
  readonly default: T | ((context: SettingsContext) => T);
  /** Applied to the merged value, default included. */
  transform?(value: T, context: SettingsContext): T;
}

interface FieldOptions<T> {
  default?: T | ((context: SettingsContext) => T);
  transform?: (value: T, context: SettingsContext) => T;
}

/** A helper given a `default` builds a field; without one, a validator for `optional`. */
export type Built<T, O> = O extends { default: unknown } ? Field<T> : Validator<T>;

const ok = <T>(value: T): FieldCheck<T> => ({ ok: true, value });
const fail = (reason: string): FieldCheck<never> => ({ ok: false, reason });

function build<T, O extends FieldOptions<T>>(
  check: (raw: unknown) => FieldCheck<T>,
  options: O,
): Built<T, O> {
  const { default: fallback, transform } = options;
  return { check, default: fallback, ...(transform ? { transform } : {}) } as Built<T, O>;
}

/** `true` or `false`. */
export function bool<O extends FieldOptions<boolean>>(options: O): Built<boolean, O> {
  return build(
    (raw) => (typeof raw === "boolean" ? ok(raw) : fail("must be true or false")),
    options,
  );
}

interface RangeOptions {
  min?: number;
  max?: number;
  /** Require a value strictly greater than `min`. */
  exclusiveMin?: boolean;
}

function range(kind: string, { min, max, exclusiveMin }: RangeOptions): string {
  if (min !== undefined && max !== undefined) return `must be ${kind} from ${min} to ${max}`;
  if (min !== undefined)
    return `must be ${kind} ${exclusiveMin ? "greater than" : "at least"} ${min}`;
  if (max !== undefined) return `must be ${kind} at most ${max}`;
  return `must be ${kind}`;
}

function inRange(value: number, { min, max, exclusiveMin }: RangeOptions): boolean {
  if (min !== undefined && (exclusiveMin ? value <= min : value < min)) return false;
  return max === undefined || value <= max;
}

/** A finite number, optionally bounded. */
export function number<O extends FieldOptions<number> & RangeOptions>(
  options: O,
): Built<number, O> {
  return build(
    (raw) =>
      typeof raw === "number" && Number.isFinite(raw) && inRange(raw, options)
        ? ok(raw)
        : fail(range("a number", options)),
    options,
  );
}

/** A safe integer, optionally bounded. */
export function int<O extends FieldOptions<number> & RangeOptions>(options: O): Built<number, O> {
  return build(
    (raw) =>
      typeof raw === "number" && Number.isSafeInteger(raw) && inRange(raw, options)
        ? ok(raw)
        : fail(range("an integer", options)),
    options,
  );
}

/** One of a fixed set of strings. */
export function oneOf<const V extends string, O extends FieldOptions<V>>(
  values: readonly V[],
  options: O,
): Built<V, O> {
  return build(
    (raw) =>
      values.includes(raw as V)
        ? ok(raw as V)
        : fail(`must be one of ${values.map((value) => JSON.stringify(value)).join(", ")}`),
    options,
  );
}

/** A string, trimmed and required to be non-empty when asked. */
export function string<O extends FieldOptions<string> & { trim?: boolean; nonEmpty?: boolean }>(
  options: O,
): Built<string, O> {
  return build((raw) => {
    if (typeof raw !== "string") return fail("must be a string");
    const value = options.trim ? raw.trim() : raw;
    return options.nonEmpty && !value ? fail("must be a non-empty string") : ok(value);
  }, options);
}

/** Keep the valid members of an array and name the ones dropped. */
function members<T>(
  entries: [label: string, raw: unknown][],
  item: Validator<T>,
): { kept: [label: string, value: T][]; dropped: string[] } {
  const kept: [string, T][] = [];
  const dropped: string[] = [];
  for (const [label, raw] of entries) {
    const result = item.check(raw);
    if (result.ok) kept.push([label, result.value]);
    else dropped.push(`${label} ${result.reason}`);
  }
  return { kept, dropped };
}

const withDropped = <T>(value: T, dropped: string[]): FieldCheck<T> =>
  dropped.length ? { ok: true, value, dropped } : ok(value);

/**
 * An array whose valid members are kept; each invalid one is dropped and named.
 * `unique` removes repeats. Defaults to a fresh empty array.
 */
export function list<T>(
  item: Validator<T>,
  options: { unique?: boolean; default?: (context: SettingsContext) => T[] } = {},
): Field<T[]> {
  return {
    check: (raw) => {
      if (!Array.isArray(raw)) return fail("must be a list");
      const { kept, dropped } = members(
        raw.map((value, index) => [`[${index}]`, value]),
        item,
      );
      const values = kept.map(([, value]) => value);
      return withDropped(options.unique ? [...new Set(values)] : values, dropped);
    },
    default: options.default ?? (() => []),
  };
}

/**
 * A JSON object of keys to values; valid entries are kept, each invalid one is
 * dropped and named. Defaults to a fresh empty object.
 */
export function record<T>(
  item: Validator<T>,
  options: { default?: (context: SettingsContext) => Record<string, T> } = {},
): Field<Record<string, T>> {
  return {
    check: (raw) => {
      if (!isRecord(raw)) return fail("must be an object");
      const { kept, dropped } = members(
        Object.entries(raw).map(([key, value]) => [`.${key}`, value]),
        item,
      );
      // Object.fromEntries defines own properties, so a "__proto__" key stays data.
      return withDropped(
        Object.fromEntries(kept.map(([label, value]) => [label.slice(1), value])),
        dropped,
      );
    },
    default: options.default ?? (() => ({})),
  };
}

/** A setting with no default: absent unless a file sets it. */
export function optional<T>(validator: Validator<T>): Field<T | undefined> {
  return { check: (raw) => validator.check(raw), default: undefined };
}

type ValueOf<F> = F extends { check(raw: unknown): FieldCheck<infer T> } ? T : never;
type OptionalKeys<F> = { [K in keyof F]: undefined extends ValueOf<F[K]> ? K : never }[keyof F];

/** The fully defaulted object a definition loads; `optional` fields may be absent. */
export type SettingsValues<F extends Record<string, Field<unknown>>> = Flatten<
  {
    -readonly [K in keyof F as K extends OptionalKeys<F> ? never : K]: ValueOf<F[K]>;
  } & { -readonly [K in OptionalKeys<F>]?: ValueOf<F[K]> }
>;
type Flatten<T> = { [K in keyof T]: T[K] };

/** The loaded type of a definition, e.g. `SettingsOf<typeof stashSettings>`. */
export type SettingsOf<S extends { defaults: (...args: never[]) => unknown }> = ReturnType<
  S["defaults"]
>;

interface SettingsOptions<F extends Record<string, Field<unknown>>> {
  /** Topic: files are `<agent dir>/<name>.json` and `.pi/<name>.json`; warnings say `[pi-<name>]`. */
  name: string;
  /** `global` reads only the agent directory; `layered` lets the project file override it. */
  scope: "global" | "layered";
  fields: F;
  /** Offer `save`, which patches the project file. Layered definitions only. */
  writable?: boolean;
}

export interface SettingsDefinition<F extends Record<string, Field<unknown>>> {
  readonly name: string;
  readonly scope: "global" | "layered";
  readonly fields: F;
  /** The global file, and the project file when layered. */
  paths: (cwd: string, agentDir?: string) => { global: string; project?: string };
  /** Every field at its default, transformed. Reads no files. */
  defaults: (cwd?: string, agentDir?: string) => SettingsValues<F>;
  /**
   * Read the files and return a fully defaulted object. Never throws: a missing
   * file is silent; an unreadable, unparseable or non-object file, or invalid
   * and unknown fields, warn once per file and fall back to the lower layer.
   */
  load: (cwd: string, agentDir?: string) => SettingsValues<F>;
}

export interface WritableSettingsDefinition<
  F extends Record<string, Field<unknown>>,
> extends SettingsDefinition<F> {
  /**
   * Merge valid fields of `patch` into the project file, keeping its other keys.
   * Invalid fields are dropped. Throws when the file cannot be read, parsed or written.
   */
  save: (cwd: string, patch: Partial<SettingsValues<F>>) => void;
}

/**
 * Declare an extension's settings once: the files, every field's validation and
 * default, and the loaded type. One behaviour for every extension; see `load`.
 */
export function defineSettings<const F extends Record<string, Field<unknown>>>(
  options: SettingsOptions<F> & { writable: true },
): WritableSettingsDefinition<F>;
export function defineSettings<const F extends Record<string, Field<unknown>>>(
  options: SettingsOptions<F>,
): SettingsDefinition<F>;
export function defineSettings<const F extends Record<string, Field<unknown>>>(
  options: SettingsOptions<F>,
): WritableSettingsDefinition<F> {
  const { name, scope, fields, writable } = options;
  if (writable && scope !== "layered") throw new Error(`[pi-${name}] only layered settings save`);
  const filename = `${name}.json`;
  const keys = Object.keys(fields) as (keyof F & string)[];
  const warn = (text: string) => console.warn(sanitizeLine(`[pi-${name}] ${text}`));

  const paths = (cwd: string, agentDir = getAgentDir()) => ({
    global: join(agentDir, filename),
    ...(scope === "layered" ? { project: join(cwd, ".pi", filename) } : {}),
  });

  const validate = (input: Record<string, unknown>, problems?: string[]) => {
    const values: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(input)) {
      if (!Object.hasOwn(fields, key)) {
        problems?.push(`${key} is not a setting`);
        continue;
      }
      const result = fields[key].check(raw);
      if (!result.ok) {
        problems?.push(`${key} ${result.reason}`);
        continue;
      }
      values[key] = result.value;
      for (const entry of result.dropped ?? []) problems?.push(`${key}${entry}`);
    }
    return values;
  };

  const readLayer = (path: string) => {
    const input = readSettingsFile<Record<string, unknown>>(
      path,
      (raw) => {
        if (!isRecord(raw)) throw new Error("settings must be a JSON object");
        return raw;
      },
      (error) => warn(`Ignoring settings at ${path}: ${errorText(error)}`),
    );
    const problems: string[] = [];
    const values = validate(input, problems);
    if (problems.length) warn(`Ignoring invalid settings at ${path}: ${problems.join("; ")}`);
    return values;
  };

  const resolve = (layers: Record<string, unknown>[], context: SettingsContext) => {
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const field = fields[key];
      const layer = layers.findLast((values) => Object.hasOwn(values, key));
      const value = layer
        ? layer[key]
        : typeof field.default === "function"
          ? (field.default as (context: SettingsContext) => unknown)(context)
          : field.default;
      const final = field.transform ? field.transform(value, context) : value;
      if (final !== undefined) result[key] = final;
    }
    return result as SettingsValues<F>;
  };

  const definition: SettingsDefinition<F> = {
    name,
    scope,
    fields,
    paths,
    defaults: (cwd = process.cwd(), agentDir = getAgentDir()) => resolve([], { cwd, agentDir }),
    load: (cwd, agentDir = getAgentDir()) => {
      const { global, project } = paths(cwd, agentDir);
      const layers = [readLayer(global), ...(project ? [readLayer(project)] : [])];
      return resolve(layers, { cwd, agentDir });
    },
  };
  if (!writable) return definition as WritableSettingsDefinition<F>;
  return {
    ...definition,
    save: (cwd, patch) => {
      const defined = Object.fromEntries(
        Object.entries(patch).filter(([, value]) => value !== undefined),
      );
      patchSettingsFile(join(cwd, ".pi", filename), validate(defined));
    },
  };
}
