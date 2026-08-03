import { resolveDataSourceKind } from "@/lib/env";
import { REFERENCE_NOW } from "@/lib/seed/clock";

/**
 * Display formatting.
 *
 * Relative times need a "now". In demo mode that is the seed clock, so
 * fixtures, screenshots, and tests all agree; against a real database it is the
 * wall clock. Every one of these helpers is called from a server component, so
 * the value is resolved once during render and never re-computed on the client
 * — there is no hydration mismatch to design around.
 */
export function displayNow(): number {
  return resolveDataSourceKind() === "demo" ? Date.parse(REFERENCE_NOW) : Date.now();
}

/** "12m", "4h", "3d" — the compact form used in queues and lists. */
export function formatRelativeShort(value: string, now = displayNow()): string {
  const deltaMinutes = Math.round((now - Date.parse(value)) / 60_000);
  const abs = Math.abs(deltaMinutes);

  if (abs < 1) return "now";
  if (abs < 60) return `${abs}m`;
  if (abs < 60 * 24) return `${Math.round(abs / 60)}h`;
  if (abs < 60 * 24 * 30) return `${Math.round(abs / (60 * 24))}d`;
  return `${Math.round(abs / (60 * 24 * 30))}mo`;
}

/** "12 minutes ago", "in 3 hours" — the readable form used in detail panels. */
export function formatRelativeLong(value: string, now = displayNow()): string {
  const deltaMinutes = Math.round((now - Date.parse(value)) / 60_000);
  const past = deltaMinutes >= 0;
  const abs = Math.abs(deltaMinutes);

  const [amount, unit] =
    abs < 60
      ? [abs, "minute"]
      : abs < 60 * 24
        ? [Math.round(abs / 60), "hour"]
        : abs < 60 * 24 * 30
          ? [Math.round(abs / (60 * 24)), "day"]
          : [Math.round(abs / (60 * 24 * 30)), "month"];

  if (amount < 1) return "just now";
  const plural = amount === 1 ? unit : `${unit}s`;
  return past ? `${amount} ${plural} ago` : `in ${amount} ${plural}`;
}

/** "11h 47m left" / "Overdue by 2h 5m" — SLA countdowns. */
export function formatSlaRemaining(
  dueAt: string,
  now = displayNow(),
): { label: string; overdue: boolean } {
  const deltaMinutes = Math.round((Date.parse(dueAt) - now) / 60_000);
  const overdue = deltaMinutes < 0;
  const abs = Math.abs(deltaMinutes);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  const duration = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

  return {
    label: overdue ? `Overdue by ${duration}` : `${duration} left`,
    overdue,
  };
}

/** "1h 47m" — durations expressed in minutes. */
export function formatDuration(totalMinutes: number): string {
  if (totalMinutes <= 0) return "—";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = Math.round(totalMinutes % 60);
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
});

/** "Jul 14" */
export function formatDate(value: string): string {
  return dateFormatter.format(new Date(value));
}

/** "Jul 14, 2026, 4:20 PM" */
export function formatDateTime(value: string): string {
  return dateTimeFormatter.format(new Date(value));
}

const numberFormatter = new Intl.NumberFormat("en-US");

export function formatNumber(value: number): string {
  return numberFormatter.format(value);
}

/** "1.2k", "18.4k" — used where column width is tight. */
export function formatCompactNumber(value: number): string {
  if (Math.abs(value) < 1000) return formatNumber(value);
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatPercent(value: number, fractionDigits = 0): string {
  return `${value.toFixed(fractionDigits)}%`;
}

/** "+8%" / "−3%" — signed deltas, using a true minus sign. */
export function formatSignedPercent(value: number, suffix = "%"): string {
  if (value === 0) return `0${suffix}`;
  const sign = value > 0 ? "+" : "−";
  return `${sign}${Math.abs(value)}${suffix}`;
}

export function formatRating(value: number | null): string {
  return value === null ? "—" : value.toFixed(1);
}

/** Turns a snake_case enum value into a readable phrase, as a last resort. */
export function humanize(value: string): string {
  const spaced = value.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
