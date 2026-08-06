"use client";

import { useEffect, useRef, useState } from "react";
import { FileVideo, ImageUp, X } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  ATTACHMENT_ACCEPT,
  MAX_ATTACHMENTS,
  MAX_TOTAL_ATTACHMENT_BYTES,
  formatBytes,
  isImageAttachment,
  reviewAttachments,
  type RejectedAttachment,
} from "@/lib/support/help-attachments";

export interface AttachmentDropzoneProps {
  id: string;
  files: File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
  /** From the server, when it refused what the client let through. */
  error?: string;
}

/**
 * Attach screenshots and screen recordings by dropping them or picking them.
 *
 * The drop target is a `<label>` over a real file input rather than a `div`
 * with a click handler. That is the whole accessibility story: the input keeps
 * its own focus ring and its own keyboard behaviour, the label makes the entire
 * area clickable, and dragging is an addition on top of a control that already
 * worked without it.
 *
 * Files are held as `File` objects and handed to the action, so nothing is
 * uploaded until the message is sent. Removing one before sending means it
 * never leaves the machine.
 */
export function AttachmentDropzone({
  id,
  files,
  onChange,
  disabled = false,
  error,
}: AttachmentDropzoneProps) {
  // A counter, not a boolean: dragging over a child element fires `dragleave`
  // on the parent, and a boolean makes the highlight flicker.
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [rejected, setRejected] = useState<RejectedAttachment[]>([]);

  const used = files.reduce((sum, file) => sum + file.size, 0);
  const full = files.length >= MAX_ATTACHMENTS;
  // Closed rather than merely unresponsive: an area that still invites a drop
  // and then refuses every file reads as broken.
  const closed = disabled || full;

  function add(incoming: FileList | null) {
    if (!incoming || incoming.length === 0) return;

    const review = reviewAttachments(Array.from(incoming), files);
    setRejected(review.rejected);

    if (review.accepted.length > 0) {
      onChange([...files, ...review.accepted]);
    }
  }

  function remove(index: number) {
    setRejected([]);
    onChange(files.filter((_, position) => position !== index));
  }

  function endDrag() {
    dragDepth.current = 0;
    setDragging(false);
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <label
        htmlFor={id}
        onDragEnter={(event) => {
          if (closed) return;
          event.preventDefault();
          dragDepth.current += 1;
          setDragging(true);
        }}
        onDragOver={(event) => {
          // Without this the browser navigates to the dropped file instead.
          if (!closed) event.preventDefault();
        }}
        onDragLeave={() => {
          dragDepth.current -= 1;
          if (dragDepth.current <= 0) endDrag();
        }}
        onDrop={(event) => {
          if (closed) return;
          event.preventDefault();
          endDrag();
          add(event.dataTransfer.files);
        }}
        className={cn(
          "flex flex-col items-center gap-1 rounded-[10px] border border-dashed border-gray-300 bg-gray-50/60 px-4 py-5 text-center transition-colors",
          !closed && "cursor-pointer hover:border-purple-600/50 hover:bg-purple-50/40",
          // The ring belongs to the input, which is what focus actually lands
          // on; the label wears it so a keyboard user sees the target.
          "has-[input:focus-visible]:border-purple-600 has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-purple-600/20",
          dragging && "border-purple-600 bg-purple-50",
          error && "border-red-600",
          disabled && "opacity-55",
        )}
      >
        <span
          className={cn(
            "inline-flex size-8 items-center justify-center rounded-lg bg-white text-gray-500 ring-1 ring-gray-200",
            dragging && "text-purple-600 ring-purple-600/30",
          )}
        >
          <ImageUp className="size-4" aria-hidden />
        </span>

        <span className="text-[13px] text-gray-700">
          {dragging ? (
            "Drop to attach"
          ) : full ? (
            `That's all ${MAX_ATTACHMENTS} files — remove one to add another`
          ) : (
            <>
              <span className="font-medium text-purple-600">
                Choose a file
              </span>{" "}
              or drag one here
            </>
          )}
        </span>

        {/* The limits live in the field hint below, not in here: text inside a
            label becomes part of the input's accessible name, and a name that
            recites three numbers is read out on every focus. */}
        <input
          id={id}
          type="file"
          multiple
          accept={ATTACHMENT_ACCEPT}
          disabled={closed}
          aria-describedby={`${id}-hint`}
          onChange={(event) => {
            add(event.target.files);
            // Cleared so removing a file and re-picking it still fires change.
            event.target.value = "";
          }}
          className="sr-only"
        />
      </label>

      {files.length > 0 ? (
        <>
          <ul className="flex flex-col gap-1.5">
            {files.map((file, index) => (
              <AttachedFile
                key={`${file.name}:${file.size}:${index}`}
                file={file}
                disabled={disabled}
                onRemove={() => remove(index)}
              />
            ))}
          </ul>

          <p className="text-right text-[12px] text-gray-400 tabular-nums">
            {formatBytes(used)} of {formatBytes(MAX_TOTAL_ATTACHMENT_BYTES)}
          </p>
        </>
      ) : null}

      {rejected.length > 0 ? (
        <ul role="alert" className="flex flex-col gap-1">
          {rejected.map((file) => (
            <li
              key={`${file.name}:${file.reason}`}
              className="text-[12px] text-red-600"
            >
              <span className="font-medium">{file.name}</span> wasn&rsquo;t
              attached — {file.reason}.
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** One attached file: a preview if we can render one, the name, the size. */
function AttachedFile({
  file,
  disabled,
  onRemove,
}: {
  file: File;
  disabled: boolean;
  onRemove: () => void;
}) {
  return (
    <li className="flex items-center gap-2.5 rounded-lg border border-gray-200 bg-white px-2.5 py-2">
      <span className="inline-flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-gray-100 text-gray-500">
        {/* Only images and videos get this far, so anything without a preview
            is a clip. */}
        {isImageAttachment(file) ? (
          <ImagePreview file={file} />
        ) : (
          <FileVideo className="size-4" aria-hidden />
        )}
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-gray-950">
          {file.name}
        </span>
        <span className="block text-[12px] text-gray-500 tabular-nums">
          {formatBytes(file.size)}
        </span>
      </span>

      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-950 focus-visible:ring-2 focus-visible:ring-purple-600/20 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-45"
      >
        <X className="size-4" aria-hidden />
        <span className="sr-only">Remove {file.name}</span>
      </button>
    </li>
  );
}

/**
 * A thumbnail read straight off the file.
 *
 * The URL is created once, on mount: the list keys on name and size, so a
 * different file is a different component rather than a new prop on this one.
 * It is revoked on unmount, because a form somebody opens, fills, and abandons
 * would otherwise hold every image they previewed until the page reloads.
 */
function ImagePreview({ file }: { file: File }) {
  const [url] = useState(() => URL.createObjectURL(file));

  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  // A local object URL, not a remote asset: `next/image` would only put a
  // loader in front of bytes the browser is already holding.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt="" className="size-full object-cover" />;
}
