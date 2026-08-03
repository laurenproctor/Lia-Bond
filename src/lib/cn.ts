type ClassValue =
  | string
  | number
  | null
  | undefined
  | false
  | ClassValue[]
  | { [key: string]: boolean | null | undefined };

/**
 * Minimal class-name joiner. Deliberately not a Tailwind class merger — the
 * components in this app compose classes by slot rather than by overriding, so
 * conflict resolution is never needed and the dependency is not worth it.
 */
export function cn(...values: ClassValue[]): string {
  const out: string[] = [];

  for (const value of values) {
    if (!value) continue;

    if (typeof value === "string" || typeof value === "number") {
      out.push(String(value));
      continue;
    }

    if (Array.isArray(value)) {
      const nested = cn(...value);
      if (nested) out.push(nested);
      continue;
    }

    for (const [key, enabled] of Object.entries(value)) {
      if (enabled) out.push(key);
    }
  }

  return out.join(" ");
}
