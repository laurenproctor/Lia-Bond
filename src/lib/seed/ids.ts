/**
 * Deterministic UUIDs for seed data.
 *
 * Seeding must be repeatable: running it twice has to produce the same ids, or
 * every re-seed invalidates bookmarks, screenshots, and test fixtures. Random
 * v4 ids cannot do that, so seed ids are derived from a stable label.
 *
 * These are UUIDv5-shaped (SHA-1 of a namespace plus a name, per RFC 4122) but
 * computed with a small synchronous hash so the module stays dependency-free
 * and usable from both the app and the SQL generator.
 */

/** Fixed namespace for Lia demo data. Never reuse for production records. */
const NAMESPACE = "6f1c4b6e-3a52-4c7f-9b41-2d0a8e5f7c13";

/** FNV-1a, 32-bit. Fast, deterministic, and adequate for label spreading. */
function fnv1a(input: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Low `digits` hex characters of `value`, zero-padded. */
function hex(value: number, digits: number): string {
  return (value >>> 0).toString(16).padStart(digits, "0").slice(-digits);
}

/**
 * Derive a stable UUID from a label.
 *
 * The version nibble is set to 5 and the variant bits to RFC 4122, so the
 * result is a well-formed UUID that Postgres and Zod both accept.
 */
export function seedId(label: string): string {
  const scoped = `${NAMESPACE}:${label}`;
  const a = fnv1a(scoped, 0x811c9dc5);
  const b = fnv1a(scoped, a ^ 0x9e3779b9);
  const c = fnv1a(scoped, b ^ 0x85ebca6b);
  const d = fnv1a(scoped, c ^ 0xc2b2ae35);

  const timeLow = hex(a, 8);
  const timeMid = hex(b, 4);
  // Version 5.
  const timeHigh = `5${hex(b >>> 16, 3)}`;
  // Variant 10xx.
  const variantByte = ((c >>> 24) & 0x3f) | 0x80;
  const clockSeq = `${variantByte.toString(16).padStart(2, "0")}${hex(c, 2)}`;
  const node = `${hex(c >>> 8, 4)}${hex(d, 8)}`;

  return `${timeLow}-${timeMid}-${timeHigh}-${clockSeq}-${node}`.slice(0, 36);
}
