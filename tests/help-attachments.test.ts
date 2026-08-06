import { describe, expect, it } from "vitest";
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
  describeAttachment,
  formatBytes,
  isImageAttachment,
  reviewAttachments,
  safeAttachmentName,
} from "@/lib/support/help-attachments";

/**
 * Help request attachments.
 *
 * The dropzone and the action share `reviewAttachments`, so these tests cover
 * both. The property that matters most is that the budgets are consumed in
 * order: a person who drops six files is told which one put them over, not
 * handed back a rejected batch.
 */

const MB = 1024 * 1024;

function file(name: string, type: string, size: number) {
  return { name, type, size };
}

const SCREENSHOT = file("screenshot.png", "image/png", 240 * 1024);

describe("formatBytes", () => {
  it("reads the way a person would say it", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(240 * 1024)).toBe("240 KB");
    expect(formatBytes(4.5 * MB)).toBe("4.5 MB");
    expect(formatBytes(20 * MB)).toBe("20 MB");
  });

  it("rounds up, so a size never contradicts the limit it broke", () => {
    // Rounded down, one byte over the cap reads "10 MB — the limit is 10 MB".
    expect(formatBytes(MAX_ATTACHMENT_BYTES)).toBe("10 MB");
    expect(formatBytes(MAX_ATTACHMENT_BYTES + 1)).toBe("10.1 MB");
  });
});

describe("reviewAttachments", () => {
  it("accepts an image and a video", () => {
    const { accepted, rejected } = reviewAttachments([
      SCREENSHOT,
      file("clip.mov", "video/quicktime", 3 * MB),
    ]);

    expect(accepted).toHaveLength(2);
    expect(rejected).toEqual([]);
  });

  it("refuses anything that is not an image or a video", () => {
    const { accepted, rejected } = reviewAttachments([
      file("report.pdf", "application/pdf", 1024),
    ]);

    expect(accepted).toEqual([]);
    expect(rejected).toEqual([
      { name: "report.pdf", reason: "not an image or a video" },
    ]);
  });

  it("falls back to the extension when the browser offers no type", () => {
    // Some Windows builds hand over a `.mov` with an empty MIME type. The
    // browser's guess is not the file.
    const { accepted } = reviewAttachments([file("clip.mov", "", 2 * MB)]);
    expect(accepted).toHaveLength(1);
  });

  it("refuses a file over the per-file limit, and says how big it was", () => {
    const { rejected } = reviewAttachments([
      file("recording.mp4", "video/mp4", MAX_ATTACHMENT_BYTES + 1),
    ]);

    expect(rejected).toEqual([
      { name: "recording.mp4", reason: "10.1 MB — the limit is 10 MB per file" },
    ]);
  });

  it("refuses an empty file", () => {
    expect(reviewAttachments([file("empty.png", "image/png", 0)]).rejected).toEqual([
      { name: "empty.png", reason: "empty" },
    ]);
  });

  it("caps how many files come along", () => {
    const many = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, index) =>
      file(`shot-${index}.png`, "image/png", 1024),
    );

    const { accepted, rejected } = reviewAttachments(many);

    expect(accepted).toHaveLength(MAX_ATTACHMENTS);
    expect(rejected).toEqual([
      { name: `shot-${MAX_ATTACHMENTS}.png`, reason: "over the limit of 5 files" },
    ]);
  });

  it("stops at the total budget, naming the file that went over", () => {
    const { accepted, rejected } = reviewAttachments([
      file("a.mp4", "video/mp4", 9 * MB),
      file("b.mp4", "video/mp4", 9 * MB),
      file("c.mp4", "video/mp4", 9 * MB),
    ]);

    expect(accepted.map((entry) => entry.name)).toEqual(["a.mp4", "b.mp4"]);
    expect(rejected).toEqual([
      { name: "c.mp4", reason: "over the 20 MB total" },
    ]);
    expect(
      accepted.reduce((sum, entry) => sum + entry.size, 0),
    ).toBeLessThanOrEqual(MAX_TOTAL_ATTACHMENT_BYTES);
  });

  it("judges a second drop against what is already attached", () => {
    const { accepted, rejected } = reviewAttachments(
      [file("second.mp4", "video/mp4", 9 * MB)],
      [file("first.mp4", "video/mp4", 9 * MB), file("also.mp4", "video/mp4", 9 * MB)],
    );

    expect(accepted).toEqual([]);
    expect(rejected).toEqual([
      { name: "second.mp4", reason: "over the 20 MB total" },
    ]);
  });

  it("does not attach the same file twice", () => {
    const { accepted, rejected } = reviewAttachments([SCREENSHOT], [SCREENSHOT]);

    expect(accepted).toEqual([]);
    expect(rejected).toEqual([
      { name: "screenshot.png", reason: "already attached" },
    ]);
  });

  it("keeps a rejection from consuming budget the next file could use", () => {
    const { accepted } = reviewAttachments([
      file("huge.mp4", "video/mp4", 40 * MB),
      SCREENSHOT,
    ]);

    expect(accepted).toEqual([SCREENSHOT]);
  });
});

describe("safeAttachmentName", () => {
  it("keeps a name a person would recognise", () => {
    expect(safeAttachmentName("Screen Shot 2026-08-06 at 09.41.png")).toBe(
      "Screen Shot 2026-08-06 at 09.41.png",
    );
  });

  it("drops directory components and control characters", () => {
    expect(safeAttachmentName("../../etc/passwd.png")).toBe("passwd.png");
    expect(safeAttachmentName('shot\r\n"x".png')).toBe("shotx.png");
  });

  it("never returns an empty name", () => {
    expect(safeAttachmentName("   ")).toBe("attachment");
    expect(safeAttachmentName("/")).toBe("attachment");
  });
});

describe("isImageAttachment", () => {
  it("tells a still from a clip, by type or by extension", () => {
    expect(isImageAttachment(SCREENSHOT)).toBe(true);
    expect(isImageAttachment(file("shot.heic", "", 1024))).toBe(true);
    expect(isImageAttachment(file("clip.mov", "video/quicktime", 1024))).toBe(false);
  });
});

describe("describeAttachment", () => {
  it("names the file and its size, for the message body", () => {
    expect(describeAttachment(SCREENSHOT)).toBe("screenshot.png (240 KB)");
  });
});
