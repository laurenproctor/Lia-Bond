import "server-only";

import type { Mention, PlatformProfile } from "@/domain";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";
import { workspacePathFor } from "@/lib/view-models/mention";

/**
 * The one useful thing to do next, resolved from real data.
 *
 * The Workspace Ready screen's job is not to congratulate somebody on finishing
 * a form — it is to hand them the first thing worth doing, and it has to be a
 * thing that genuinely exists. Every branch below is decided by a repository
 * read, so the screen can never offer to open a draft that was never generated
 * or a review that was never imported.
 *
 * The order is by how much value the customer gets for one click, most first:
 *
 * 1. a real response draft — the product's whole promise, already delivered
 * 2. an analysed mention — Lia has an opinion about it
 * 3. an imported mention — there is real feedback to read
 * 4. connected profiles but no sync yet — start the import
 * 5. nothing connected — connect a source
 *
 * Each rung is strictly weaker than the one above, and reaching rung 5 means
 * the customer skipped step 2, which is the only honest thing left to say.
 */

export type QuickWinKind =
  | "review_draft"
  | "analyzed_mention"
  | "imported_mention"
  | "start_import"
  | "connect_source";

export interface QuickWin {
  kind: QuickWinKind;
  /** The button label. Sentence case, per CLAUDE.md. */
  label: string;
  /** One line saying what is waiting. Never describes data that is not there. */
  description: string;
  /**
   * Where the button goes, or null when the action is not a navigation.
   *
   * `start_import` has no destination: it runs a real synchronisation through
   * the existing service and stays on the page to report what happened.
   */
  href: string | null;
}

export interface QuickWinInput {
  dataSource: LiaDataSource;
  scope: OrganizationScope;
}

/**
 * A mention worth opening.
 *
 * Prefers the one somebody would actually action first — highest risk, then
 * most recent — over an arbitrary row, because the whole point of the rung is
 * that the first click is worth making.
 */
function pickMention(mentions: Mention[]): Mention | null {
  const severity: Record<Mention["riskLevel"], number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };

  return (
    [...mentions].sort((a, b) => {
      const byRisk = severity[a.riskLevel] - severity[b.riskLevel];
      if (byRisk !== 0) return byRisk;
      return Date.parse(b.receivedAt) - Date.parse(a.receivedAt);
    })[0] ?? null
  );
}

/** Profiles Lia is actually monitoring. Disconnected ones do not count. */
export function activeProfiles(profiles: PlatformProfile[]): PlatformProfile[] {
  return profiles.filter((profile) => profile.status === "active");
}

export async function resolveQuickWin({
  dataSource,
  scope,
}: QuickWinInput): Promise<QuickWin> {
  // Rung 1. Drafts still awaiting a person — an approved or published one is
  // not work, and offering it as "your first suggested response" would send
  // somebody to a decision that has already been made.
  const drafts = await dataSource.responseDrafts.list(scope, {
    statuses: ["draft", "awaiting_approval"],
    limit: 1,
  });

  const draft = drafts[0];
  if (draft) {
    const mention = await dataSource.mentions.get(scope, draft.mentionId);
    return {
      kind: "review_draft",
      label: "Review first suggestion",
      description:
        "Lia has drafted a reply. Read it, edit anything you'd say differently, and decide whether it goes out.",
      // The workspace for the mention it answers, so the reviewer sees what is
      // being replied to. Falls back to the response library if the mention has
      // since been removed.
      href: mention ? workspacePathFor(mention) : "/responses",
    };
  }

  const mentions = await dataSource.mentions.list(scope, { limit: 50 });

  // Rung 2. Analysed: Lia has read it and has something to say about it. The
  // status is the signal rather than a join onto `mention_analyses`, because an
  // analysis whose outcome never landed on the mention is not visible to any
  // screen the button would send somebody to.
  const analyzed = mentions.filter(
    (mention) =>
      mention.status !== "new" || mention.sentiment !== "unknown",
  );

  const analyzedMention = pickMention(analyzed);
  if (analyzedMention) {
    return {
      kind: "analyzed_mention",
      label: "Review first analysed mention",
      description:
        "Lia has read your feedback and flagged what needs attention first.",
      href: workspacePathFor(analyzedMention),
    };
  }

  // Rung 3. Imported but not yet analysed. There is real feedback to read even
  // though Lia has not formed a view on it.
  const importedMention = pickMention(mentions);
  if (importedMention) {
    return {
      kind: "imported_mention",
      label: "Review imported feedback",
      description:
        "Your feedback is in. Analysis runs on a schedule, so opinions will follow.",
      href: workspacePathFor(importedMention),
    };
  }

  // Rung 4. Profiles are connected but nothing has been imported. This is the
  // ordinary state at the end of setup, because there is no job runner for
  // review sync — see docs/onboarding.md.
  const profiles = activeProfiles(await dataSource.platformProfiles.list(scope));
  if (profiles.length > 0) {
    return {
      kind: "start_import",
      label: "Start importing reviews",
      description:
        "Your locations are connected. Importing brings your existing reviews into Lia.",
      href: null,
    };
  }

  // Rung 5. Nothing is connected, which means step 2 was skipped.
  return {
    kind: "connect_source",
    label: "Connect Google Business Profile",
    description:
      "No source is connected yet, so there is nothing to monitor. Connecting Google is the fastest way to start.",
    href: "/integrations/google-business-profile",
  };
}
