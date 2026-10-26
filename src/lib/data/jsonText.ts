/*
 * JSON text for jsonb parameters. Postgres jsonb rejects two things that
 * JSON.stringify writes for perfectly ordinary JavaScript strings:
 *
 * - a lone UTF-16 surrogate, written as "\ud83c" (scraped ad copy cut in the
 *   middle of an emoji): "invalid input syntax for type json / Unicode low
 *   surrogate must follow a high surrogate";
 * - NUL, written as "\u0000": "unsupported Unicode escape sequence".
 *
 * jsonText writes both as U+FFFD (the Unicode replacement character), in
 * string values and in object keys, and leaves everything else exactly as
 * JSON.stringify wrote it. Every jsonb/json parameter in src/lib/data is
 * written with it (tests/jsonText.test.ts enforces this).
 *
 * Fast path: when JSON.stringify's text holds no "\ud"/"\uD" and no "\u0000"
 * escape the text is returned as it is (a 30 MB record is not walked or
 * copied). Otherwise the text is parsed back and the parsed value is cleaned:
 * the substring test only decides whether to look (an escaped backslash
 * followed by "ud83c" also triggers it, and then nothing is changed).
 */

export const REPLACEMENT_CHARACTER = "�";

/** True when Postgres can hold the string as jsonb text (no lone surrogate, no NUL). */
export function isStorableText(text: string): boolean {
  return text.isWellFormed() && !text.includes("\u0000");
}

/** The string with each lone surrogate and each NUL replaced by U+FFFD. */
export function storableText(text: string): string {
  // toWellFormed replaces every lone surrogate with U+FFFD.
  return text.toWellFormed().replaceAll("\u0000", REPLACEMENT_CHARACTER);
}

interface Stats {
  replaced: number;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Sets an own enumerable property (a "__proto__" key stays a key). */
function put(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__") {
    Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  } else {
    target[key] = value;
  }
}

function cleanString(text: string, stats: Stats): string {
  if (isStorableText(text)) return text;
  stats.replaced += 1;
  return storableText(text);
}

/**
 * Copy-on-write clean: returns `value` itself when nothing in it changes, and
 * otherwise a copy in which only the changed branches are new. Walks strings,
 * arrays and plain objects; other objects (Date, Buffer, ...) are returned as
 * they are.
 */
function clean(value: unknown, stats: Stats): unknown {
  if (typeof value === "string") return cleanString(value, stats);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    let out: unknown[] | null = null;
    for (let i = 0; i < value.length; i += 1) {
      const item: unknown = value[i];
      const next = clean(item, stats);
      if (next !== item) {
        out ??= value.slice();
        out[i] = next;
      }
    }
    return out ?? value;
  }
  if (!isPlainObject(value)) return value;
  const keys = Object.keys(value);
  let out: Record<string, unknown> | null = null;
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    const item = value[key];
    const next = clean(item, stats);
    const nextKey = cleanString(key, stats);
    if (!out && (next !== item || nextKey !== key)) {
      out = Object.getPrototypeOf(value) === null ? (Object.create(null) as Record<string, unknown>) : {};
      for (let j = 0; j < i; j += 1) put(out, keys[j], value[keys[j]]);
    }
    if (out) put(out, nextKey, next);
  }
  return out ?? value;
}

/** `value` with lone surrogates and NUL replaced by U+FFFD; `value` itself when it has none (never modified). */
export function sanitizeJsonValue<T>(value: T): T {
  return clean(value, { replaced: 0 }) as T;
}

/** sanitizeJsonValue plus how many strings (values and keys) it changed. */
export function sanitizeJsonValueWithStats<T>(value: T): { value: T; replaced: number } {
  const stats: Stats = { replaced: 0 };
  const out = clean(value, stats) as T;
  return { value: out, replaced: stats.replaced };
}

/** True when JSON.stringify's text may hold an escape jsonb rejects. */
function mayNeedCleaning(text: string): boolean {
  return text.includes("\\ud") || text.includes("\\uD") || text.includes("\\u0000");
}

/** jsonText plus how many strings (values and keys) were changed. */
export function jsonTextWithStats(value: unknown): { text: string; replaced: number } {
  // JSON.stringify returns undefined for undefined (and functions): kept as is.
  const text = JSON.stringify(value) as string | undefined;
  if (text === undefined || !mayNeedCleaning(text)) return { text: text as string, replaced: 0 };
  const stats: Stats = { replaced: 0 };
  // The parsed text is exactly what would be stored (toJSON applied, undefined members left out).
  const cleaned = clean(JSON.parse(text) as unknown, stats);
  if (stats.replaced === 0) return { text, replaced: 0 };
  return { text: JSON.stringify(cleaned), replaced: stats.replaced };
}

/** The JSON text of `value` for a jsonb parameter: JSON.stringify, with lone surrogates and NUL as U+FFFD. */
export function jsonText(value: unknown): string {
  return jsonTextWithStats(value).text;
}
