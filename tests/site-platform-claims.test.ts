import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AVAILABLE_PLATFORM_ROWS,
  PLATFORM_ROWS,
  UNAVAILABLE_PLATFORM_ROWS,
  availablePlatformNames,
} from "@/lib/site/content/platforms";
import { PRICING_FAQS } from "@/lib/site/content/pricing";

/**
 * The public site may not name a platform Lia cannot reach.
 *
 * This suite exists because of a real failure rather than a hypothetical one.
 * Reddit's commercial API application was rejected, and the product had
 * correctly gated every live Reddit path off — `resolveRedditDeployment`
 * returns `off`, `getRedditConnector` throws — while six separate pieces of
 * marketing copy went on selling Reddit monitoring. The capability model was
 * honest; the sentences around it were not, because nothing connected them.
 *
 * `PLATFORM_ROWS` is the record. These tests make it the *only* record, so
 * switching a platform off there is sufficient rather than merely a good start.
 */

/** The site copy, minus the one module that must name every platform. */
const COPY_ROOT = fileURLToPath(new URL("../src", import.meta.url));
const PLATFORMS_MODULE = "src/lib/site/content/platforms.ts";

function walk(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...walk(path));
    } else if (/\.tsx?$/.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

/**
 * Comments are not claims.
 *
 * A file may explain at length why Reddit is switched off — this one does —
 * without promising it to anybody. Block comments go entirely; line comments
 * only when the line is a comment, so a `https://` inside a string survives.
 */
function strippedOfComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*");
    })
    .join("\n");
}

const COPY_FILES = [
  ...walk(`${COPY_ROOT}/lib/site`),
  ...walk(`${COPY_ROOT}/app/(site)`),
]
  .map((path) => ({
    path: path.slice(path.indexOf("src/")),
    source: strippedOfComments(readFileSync(path, "utf8")),
  }))
  .filter((file) => file.path !== PLATFORMS_MODULE);

describe("platform availability is the single record", () => {
  it("has a row for every platform, split into available and not", () => {
    expect(AVAILABLE_PLATFORM_ROWS.length + UNAVAILABLE_PLATFORM_ROWS.length).toBe(
      PLATFORM_ROWS.length,
    );
    expect(AVAILABLE_PLATFORM_ROWS.every((row) => row.available)).toBe(true);
    expect(UNAVAILABLE_PLATFORM_ROWS.every((row) => !row.available)).toBe(true);
  });

  /*
   * Pinned deliberately. Reddit is not unavailable by accident or by oversight
   * — it is unavailable because Reddit rejected the application, and turning
   * this row back on is a decision that should have to delete a test that says
   * so, not a flag somebody flips while tidying.
   */
  it("keeps Reddit switched off until an agreement exists", () => {
    const reddit = PLATFORM_ROWS.find((row) => row.name === "Reddit");
    expect(reddit).toBeDefined();
    expect(reddit?.available).toBe(false);
  });

  it("never presents a publishing answer for an unavailable platform", () => {
    for (const mode of ["direct", "manual", "monitor"] as const) {
      const named = availablePlatformNames(mode);
      for (const row of UNAVAILABLE_PLATFORM_ROWS) {
        expect(named).not.toContain(row.name);
      }
    }
  });
});

describe("site copy cannot name an unavailable platform", () => {
  it("has something to check", () => {
    // A walk that silently found nothing would pass every assertion below.
    expect(COPY_FILES.length).toBeGreaterThan(5);
    expect(UNAVAILABLE_PLATFORM_ROWS.length).toBeGreaterThan(0);
  });

  for (const row of UNAVAILABLE_PLATFORM_ROWS) {
    it(`does not sell ${row.name} anywhere`, () => {
      const offenders = COPY_FILES.filter((file) =>
        file.source.includes(row.name),
      ).map((file) => file.path);

      expect(offenders).toEqual([]);
    });
  }
});

describe("the pricing FAQ answers from the platforms table", () => {
  const answer = PRICING_FAQS.find((faq) =>
    faq.question.startsWith("Which platforms"),
  )?.answer;

  it("names every available platform that takes a drafted reply", () => {
    expect(answer).toBeDefined();
    for (const name of availablePlatformNames("manual")) {
      expect(answer).toContain(name);
    }
  });

  it("names no platform that is switched off", () => {
    for (const row of UNAVAILABLE_PLATFORM_ROWS) {
      expect(answer).not.toContain(row.name);
    }
  });
});
