/**
 * Which item a split view shows.
 *
 * A missing or stale selection param falls back to the first item rather than
 * erroring: a stale bookmark or a deleted record degrades to "the page as
 * freshly opened" (D98). The lists are already sorted newest/worst-first, so
 * the first item is the right default focus. Null only when the list is empty.
 */
export function resolveSelection<T>(
  items: readonly T[],
  selectedId: string | undefined,
  idOf: (item: T) => string,
): T | null {
  if (selectedId) {
    const match = items.find((item) => idOf(item) === selectedId);
    if (match) return match;
  }
  return items[0] ?? null;
}
