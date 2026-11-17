// Small runtime checks shared by the model guards. Internal: not re-exported from the index.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An absent optional field, or one that passes `check`. */
export const optional = (value: unknown, check: (value: unknown) => boolean): boolean =>
  value === undefined || check(value);

export const isString = (value: unknown): value is string => typeof value === "string";

export const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

/** A string with at least one character that is not whitespace, at most `max` UTF-16 units. */
export const isText =
  (max = Infinity) =>
  (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0 && value.length <= max;

/** A string of at most `max` UTF-16 units; may be empty. */
export const isBoundedString =
  (max: number) =>
  (value: unknown): value is string =>
    typeof value === "string" && value.length <= max;

/** Any number but `NaN` and `±Infinity`. */
export const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** A finite number of zero or more. */
export const isAmount = (value: unknown): value is number => isFiniteNumber(value) && value >= 0;

/** A whole number of zero or more. */
export const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

/** An array whose every item passes `check`, with at most `max` items. */
export const isArrayOf =
  (check: (value: unknown) => boolean, max = Infinity) =>
  (value: unknown): value is unknown[] =>
    Array.isArray(value) && value.length <= max && value.every(check);

/** True when no two items share `key(item)`. */
export function uniqueBy<T>(items: readonly T[], key: (item: T) => unknown): boolean {
  return new Set(items.map(key)).size === items.length;
}

/** `true`: the only value a flag that is either set or absent may hold. */
export const isTrue = (value: unknown): value is true => value === true;
