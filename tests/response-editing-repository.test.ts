import { beforeEach, describe, expect, it } from "vitest";
import { freshDataSource, ushg } from "./helpers/scope";
import type { LiaDataSource } from "@/lib/data/types";
import type { ResponseDraft } from "@/domain";

let data: LiaDataSource;

beforeEach(() => {
  data = freshDataSource();
});

async function editableDraft(): Promise<ResponseDraft> {
  const drafts = await data.responseDrafts.list(ushg.admin(), {
    statuses: ["draft", "awaiting_approval"],
  });
  const draft = drafts[0];
  if (!draft) throw new Error("Seed dataset has no editable draft");
  return draft;
}

async function lockedDraft(): Promise<ResponseDraft> {
  const drafts = await data.responseDrafts.list(ushg.admin(), {
    statuses: ["approved", "published"],
  });
  const draft = drafts[0];
  if (!draft) throw new Error("Seed dataset has no decided draft");
  return draft;
}

describe("saveFinalText", () => {
  it("persists the text and bumps updatedAt", async () => {
    const draft = await editableDraft();
    const saved = await data.responseDrafts.saveFinalText(
      ushg.admin(),
      draft.id,
      "A hand-tuned reply.",
    );
    expect(saved.finalText).toBe("A hand-tuned reply.");
    expect(saved.status).toBe(draft.status);

    const reread = await data.responseDrafts.get(ushg.admin(), draft.id);
    expect(reread?.finalText).toBe("A hand-tuned reply.");
  });

  it("refuses once the draft is decided", async () => {
    const draft = await lockedDraft();
    await expect(
      data.responseDrafts.saveFinalText(ushg.admin(), draft.id, "Too late."),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses an unknown draft", async () => {
    await expect(
      data.responseDrafts.saveFinalText(
        ushg.admin(),
        "00000000-0000-4000-8000-000000000000",
        "Nobody home.",
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("decide with finalText", () => {
  it("applies text and status in one write", async () => {
    const draft = await editableDraft();
    const { draft: decided } = await data.responseDrafts.decide(
      ushg.admin(),
      draft.id,
      "approved",
      ushg.admin().userId,
      undefined,
      "Approved exactly as amended.",
    );
    expect(decided.status).toBe("approved");
    expect(decided.finalText).toBe("Approved exactly as amended.");
  });

  it("leaves finalText untouched when not provided", async () => {
    const draft = await editableDraft();
    const { draft: decided } = await data.responseDrafts.decide(
      ushg.admin(),
      draft.id,
      "approved",
      ushg.admin().userId,
    );
    expect(decided.finalText).toBe(draft.finalText);
  });
});
