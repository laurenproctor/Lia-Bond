"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { pressWidgetStatusSchema, type PressWidget } from "@/domain";
import { authorize } from "@/lib/actions/guard";
import { runAction, type ActionResult } from "@/lib/actions/result";
import {
  rotatePressWidgetEmbedId,
  savePressWidget,
  setPressWidgetStatus,
  type RotatePressResult,
  type SavePressWidgetResult,
} from "@/lib/widgets/press/service";

/**
 * Website press widget server actions.
 *
 * Every one goes through `authorize("website_widget.manage")` before touching
 * the data source, and none of them is the only check: the repositories are
 * organization-scoped by type, and the policies in
 * `20260821000200_press_widget_rls.sql` restate the same three roles
 * underneath.
 *
 * One permission covers all three, and it is the same permission the review
 * widget's actions use — one authority over what the company publishes on its
 * own website, rather than two names for it. See the comment on
 * `website_widget.manage` in `src/lib/auth/permissions.ts`.
 *
 * `revalidatePath` covers the configuration screen and the Website widgets
 * landing page, which shows whether each widget is set up. The public embed is
 * a route handler with its own cache headers and is not part of Next's data
 * cache — see `src/app/embed/press-widget/[publicId]/route.ts` for why a save
 * takes effect within a minute rather than instantly.
 */

const CONFIGURATION_PATH = "/integrations/press-widget";
const LANDING_PATH = "/integrations/website-widgets";

function revalidate(): void {
  revalidatePath(CONFIGURATION_PATH);
  revalidatePath(LANDING_PATH);
}

export async function savePressWidgetAction(
  input: unknown,
): Promise<ActionResult<SavePressWidgetResult>> {
  return runAction("press_widget.save", async () => {
    const context = await authorize("website_widget.manage");

    const result = await savePressWidget(
      {
        dataSource: context.dataSource,
        scope: context.scope,
        actorUserId: context.userId,
      },
      input,
    );

    revalidate();
    return result;
  });
}

const statusInputSchema = z.object({ status: pressWidgetStatusSchema });

export async function setPressWidgetStatusAction(
  input: unknown,
): Promise<ActionResult<PressWidget>> {
  return runAction("press_widget.set_status", async () => {
    const parsed = statusInputSchema.parse(input);
    const context = await authorize("website_widget.manage");

    const widget = await setPressWidgetStatus(
      {
        dataSource: context.dataSource,
        scope: context.scope,
        actorUserId: context.userId,
      },
      parsed,
    );

    revalidate();
    return widget;
  });
}

/**
 * Issue a new embed id.
 *
 * The clock is read here rather than passed in. A caller-supplied "now" on a
 * public entry point is a caller-supplied audit timestamp, and this is the one
 * action whose timestamp somebody will be reading months later to work out
 * when a snippet stopped resolving.
 *
 * It takes no input at all: there is one press widget per organization, so the
 * scope names it completely. An action with a widget id would be an action
 * that had to check the id belonged to the caller's tenant, which is a check
 * worth not having to write.
 */
export async function rotatePressWidgetEmbedIdAction(): Promise<
  ActionResult<RotatePressResult>
> {
  return runAction("press_widget.rotate", async () => {
    const context = await authorize("website_widget.manage");

    const result = await rotatePressWidgetEmbedId(
      {
        dataSource: context.dataSource,
        scope: context.scope,
        actorUserId: context.userId,
      },
      { now: new Date().toISOString() },
    );

    revalidate();
    return result;
  });
}
