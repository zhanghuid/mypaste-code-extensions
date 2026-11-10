/** The JSON value shapes every page module works with. */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export function isJsonObject(value: unknown): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses JSON, keeping the caller's error for its own message. */
export function parseJson(source: string): JsonValue {
  return JSON.parse(source) as JsonValue;
}
