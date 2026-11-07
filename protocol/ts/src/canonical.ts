/**
 * Canonical JSON (see protocol/SPEC.md §3).
 *
 * - Objects: keys sorted by UTF-16 code unit (keys are restricted to ASCII
 *   [A-Za-z0-9_], so this equals byte order), no whitespace.
 * - Numbers: safe integers only (|n| <= 2^53 - 1), base 10, no exponent.
 * - Strings: exactly what ECMAScript JSON.stringify emits for a well-formed
 *   string: escape `"` `\` and U+0000..U+001F (\b \f \n \r \t short forms,
 *   others as \u00xx lowercase); `/` and non-ASCII are NOT escaped (raw UTF-8).
 *   Lone surrogates are rejected.
 * - true / false / null and arrays are allowed for forward compatibility.
 */
export class CanonicalJsonError extends Error {}

const KEY_RE = /^[A-Za-z0-9_]+$/;

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new CanonicalJsonError(`not a safe integer: ${value}`);
    return Object.is(value, -0) ? '0' : String(value);
  }
  if (typeof value === 'string') {
    if (!value.isWellFormed()) throw new CanonicalJsonError('string has a lone surrogate');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const keys = Object.keys(value as object).sort();
    return `{${keys
      .map((k) => {
        if (!KEY_RE.test(k)) throw new CanonicalJsonError(`bad key: ${k}`);
        return `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`;
      })
      .join(',')}}`;
  }
  throw new CanonicalJsonError(`unsupported value type: ${typeof value}`);
}
