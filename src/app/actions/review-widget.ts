"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { reviewWidgetStatusSchema, uuidSchema, type ReviewWidget } from "@/domain";
import { authorize } from "@/lib/actions/guard";
import { runAction, type ActionResult } from "@/lib/actions/result";
import {
  rotateReviewWidgetEmbedId,
  saveReviewWidget,
  setReviewWidgetStatus,
  type RotateResult,
  type SaveWidgetResult,
} from "@/lib/widgets/service";

/**
 * Website review widget server actions.
 *
 * Every one goes through `authorize("website_widget.manage")` before touching
 * the data source, and none of them is the only check: the repositories are
 * organization-scoped by type, and the policies in
 * `20260820000300_review_widget_rls.sql` restate the same three roles
 * underneath.
 *
 * One permission covers all four, which is a deliberate narrowing rather than
 * laziness. The obvious alternative — a separate permission for rotation,
 * since it is the irreversible one — would put the emergency stop behind a
 * role the person who noticed the problem may not hold. The same judgement
 * `response.retract` records: minutes matter more than authority when
 * something needs to come off a public page, and the guard is an explicit
 * confirmation in the interface rather than a second role.
 *
 * `revalidatePath` covers the configuration screen only. The public embed is a
 * route handler with its own cache headers and is not part of Next's data
 * cache — see `src/app/embed/review-widget/[publicId]/route.ts` for why a save
 * takes effect within a minute rather than instantly.
 */

const CONFIGURATION_PATH = "/integrations/review-widget";

export async function saveReviewWidgetAction(
  input: unknown,
): Promise<ActionResult<SaveWidgetResult>> {
  return runAction("review_widget.save", async () => {
    const context = await authorize("website_widget.manage");

    const result = await saveReviewWidget(
      {
        dataSource: context.dataSource,
        scope: context.scope,
        actorUserId: context.userId,
      },
      input,
    );

    revalidatePath(CONFIGURATION_PATH);
    return result;
  });
}

const statusInputSchema = z.object({
  locationId: uuidSchema,
  status: reviewWidgetStatusSchema,
});

export async function setReviewWidgetStatusAction(
  input: unknown,
): Promise<ActionResult<ReviewWidget>> {
  return runAction("review_widget.set_status", async () => {
    const parsed = statusInputSchema.parse(input);
    const context = await authorize("website_widget.manage");

    const widget = await setReviewWidgetStatus(
      {
        dataSource: context.dataSource,
        scope: context.scope,
        actorUserId: context.userId,
      },
      parsed,
    );

    revalidatePath(CONFIGURATION_PATH);
    return widget;
  });
}

const rotateInputSchema = z.object({ locationId: uuidSchema });

/**
 * Issue a new embed id.
 *
 * The clock is read here rather than passed in. A caller-supplied "now" on a
 * public entry point is a caller-supplied audit timestamp, and this is the one
 * action whose timestamp somebody will be reading months later to work out
 * when a snippet stopped resolving.
 */
export async function rotateReviewWidgetEmbedIdAction(
  input: unknown,
): Promise<ActionResult<RotateResult>> {
  return runAction("review_widget.rotate", async () => {
    const parsed = rotateInputSchema.parse(input);
    const context = await authorize("website_widget.manage");

    const result = await rotateReviewWidgetEmbedId(
      {
        dataSource: context.dataSource,
        scope: context.scope,
        actorUserId: context.userId,
      },
      { locationId: parsed.locationId, now: new Date().toISOString() },
    );

    revalidatePath(CONFIGURATION_PATH);
    return result;
  });
}
