/** A value that survives `JSON.stringify` and `JSON.parse` unchanged. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
/** Properties set to `undefined` are allowed and dropped by `JSON.stringify`, as for optional fields. */
export interface JsonObject {
  readonly [key: string]: JsonValue | undefined;
}

/** Plain objects only: class instances, functions, `NaN` and `Infinity` are not JSON. */
export function isJsonValue(value: unknown): value is JsonValue {
  const seen = new Set<object>();
  const check = (value: unknown): boolean => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    let ok: boolean;
    if (Array.isArray(value)) ok = value.every(check);
    else {
      const prototype = Object.getPrototypeOf(value) as unknown;
      ok =
        (prototype === Object.prototype || prototype === null) &&
        Object.values(value).every((item) => item === undefined || check(item));
    }
    seen.delete(value);
    return ok;
  };
  return check(value);
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) && isJsonValue(value);
}
