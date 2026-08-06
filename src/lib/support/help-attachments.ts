/**
 * What a help request is allowed to carry.
 *
 * Pure and free of `server-only` on purpose: the dropzone and the action run
 * the same review function over the same limits. The client's copy of it exists
 * so somebody learns their 40 MB screen recording is too big before they wait
 * for an upload; the server's copy is the one that decides, because a file
 * picker is a suggestion and a request body is not.
 *
 * The caps are an email budget, not a storage one. Nothing here is persisted —
 * attachments ride along on the message to the support inbox and Lia keeps no
 * copy — so the ceiling is what a receiving mail server will accept, which in
 * practice is 25 MB for the whole message.
 */

export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * Accepted types, each with the extensions that identify it when the browser
 * offers no MIME type — which is what happens for `.mov` on some Windows
 * builds, and for anything dragged out of an archive.
 */
const ACCEPTED_TYPES: Record<string, readonly string[]> = {
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/gif": [".gif"],
  "image/webp": [".webp"],
  "image/heic": [".heic"],
  "image/heif": [".heif"],
  "video/mp4": [".mp4", ".m4v"],
  "video/quicktime": [".mov"],
  "video/webm": [".webm"],
};

/** The `accept` attribute: types for the picker, extensions for the stragglers. */
export const ATTACHMENT_ACCEPT = [
  ...Object.keys(ACCEPTED_TYPES),
  ...Object.values(ACCEPTED_TYPES).flat(),
].join(",");

/**
 * Every limit in one sentence, shown under the dropzone.
 *
 * Written from the constants rather than beside them: copy that says 10 MB
 * while the code enforces something else is worse than no copy at all.
 */
export const ATTACHMENT_LIMITS_HINT = `Images and video — up to ${MAX_ATTACHMENTS} files, ${formatBytes(MAX_ATTACHMENT_BYTES)} each and ${formatBytes(MAX_TOTAL_ATTACHMENT_BYTES)} in total.`;

/** The shape both a `File` and a server-side descriptor satisfy. */
export interface AttachmentDescriptor {
  name: string;
  type: string;
  size: number;
}

export interface RejectedAttachment {
  name: string;
  /** A fragment, rendered after the file name. */
  reason: string;
}

export interface AttachmentReview<T extends AttachmentDescriptor> {
  accepted: T[];
  rejected: RejectedAttachment[];
}

/**
 * Bytes as a person reads them.
 *
 * Rounded up, never down. These numbers appear in the sentence that explains a
 * rejection, and a file one byte over the cap rounded to "10 MB — the limit is
 * 10 MB per file" reads as a bug in Lia. Overstating a size by a tenth of a
 * megabyte costs nothing; contradicting yourself costs the person's trust in
 * every other number on the page.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;

  const megabytes = Math.ceil((bytes / (1024 * 1024)) * 10) / 10;
  return `${Number.isInteger(megabytes) ? megabytes : megabytes.toFixed(1)} MB`;
}

export function isImageAttachment(file: AttachmentDescriptor): boolean {
  return file.type.startsWith("image/") || matchesExtension(file.name, "image/");
}

/**
 * Decide which files can be attached, in order.
 *
 * Order matters: the count and total budgets are consumed as the list is
 * walked, so a person who drops six files is told which one put them over
 * rather than being handed a rejected batch. `existing` is what is already
 * attached, so a second drop is judged against the first.
 */
export function reviewAttachments<T extends AttachmentDescriptor>(
  incoming: readonly T[],
  existing: readonly AttachmentDescriptor[] = [],
): AttachmentReview<T> {
  const accepted: T[] = [];
  const rejected: RejectedAttachment[] = [];

  let count = existing.length;
  let total = existing.reduce((sum, file) => sum + file.size, 0);
  const seen = new Set(existing.map(identity));

  for (const file of incoming) {
    const reason = rejectionFor(file, { count, total, seen });

    if (reason) {
      rejected.push({ name: file.name, reason });
      continue;
    }

    accepted.push(file);
    count += 1;
    total += file.size;
    seen.add(identity(file));
  }

  return { accepted, rejected };
}

function rejectionFor(
  file: AttachmentDescriptor,
  budget: { count: number; total: number; seen: Set<string> },
): string | null {
  if (!isAccepted(file)) return "not an image or a video";
  if (file.size === 0) return "empty";
  if (budget.seen.has(identity(file))) return "already attached";

  if (file.size > MAX_ATTACHMENT_BYTES) {
    return `${formatBytes(file.size)} — the limit is ${formatBytes(MAX_ATTACHMENT_BYTES)} per file`;
  }

  if (budget.count >= MAX_ATTACHMENTS) {
    return `over the limit of ${MAX_ATTACHMENTS} files`;
  }

  if (budget.total + file.size > MAX_TOTAL_ATTACHMENT_BYTES) {
    return `over the ${formatBytes(MAX_TOTAL_ATTACHMENT_BYTES)} total`;
  }

  return null;
}

/** Name and size together: enough to catch the same file dropped twice. */
function identity(file: AttachmentDescriptor): string {
  return `${file.name}:${file.size}`;
}

function isAccepted(file: AttachmentDescriptor): boolean {
  if (file.type && file.type in ACCEPTED_TYPES) return true;
  // An unknown or absent MIME type falls back to the extension rather than
  // being refused: the browser's guess is not the file.
  return matchesExtension(file.name);
}

function matchesExtension(name: string, prefix = ""): boolean {
  const lowered = name.toLowerCase();

  return Object.entries(ACCEPTED_TYPES).some(
    ([type, extensions]) =>
      type.startsWith(prefix) &&
      extensions.some((extension) => lowered.endsWith(extension)),
  );
}

/**
 * A file name safe to put in a mail header.
 *
 * Directory components, control characters, and quotes come off; the name is
 * the sender's, so it survives otherwise. An empty result becomes a placeholder
 * rather than an attachment with no name at all.
 */
export function safeAttachmentName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";

  const cleaned = base
    .replace(/[\u0000-\u001f\u007f"]/g, "")
    .trim()
    .slice(0, 120);

  return cleaned || "attachment";
}

/** "screenshot.png (240 KB)" — how an attachment reads in the message body. */
export function describeAttachment(file: AttachmentDescriptor): string {
  return `${safeAttachmentName(file.name)} (${formatBytes(file.size)})`;
}
