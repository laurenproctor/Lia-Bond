import type {
  CreateEscalationInput,
  CreateMentionAnalysisInput,
  Location,
  Mention,
  RiskLevel,
} from "@/domain";
import { ESCALATION_CATEGORIES } from "@/domain";
import { ANALYSIS_PROMPT_VERSION } from "@/lib/analysis/prompt";
import type { MentionAnalysisOutput } from "@/lib/analysis/schema";

/**
 * Model output into Lia's shape.
 *
 * Pure: no clock, no network, no database. That is what makes the awkward
 * cases — a relevance of 1.02, a risk level with no category, a critical
 * finding with no title — testable as themselves rather than only as part of a
 * run that happened to include one.
 *
 * The governing rule is to clamp rather than reject. A score a hair outside its
 * range is a rounding artefact; throwing away an otherwise sound analysis of a
 * food-safety complaint over the third decimal place would be the wrong
 * trade every time.
 */

/** Risk levels that must produce an escalation. */
const ESCALATING_RISK: readonly RiskLevel[] = ["high", "critical"];

export function requiresEscalation(riskLevel: RiskLevel): boolean {
  return ESCALATING_RISK.includes(riskLevel);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Trimmed, non-empty, capped. Null rather than an empty string. */
function text(value: string | undefined, max: number): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

/**
 * Topics, tidied.
 *
 * Lowercased and deduplicated because their whole purpose is grouping across
 * hundreds of mentions — "Wait Times" and "wait times" as separate rows would
 * split exactly the pattern somebody is looking for. Capped at six so one
 * verbose analysis cannot dominate a topic chart.
 */
function normalizeTopics(topics: string[]): string[] {
  const seen = new Set<string>();

  for (const topic of topics) {
    const cleaned = topic.trim().toLowerCase().slice(0, 80);
    if (cleaned) seen.add(cleaned);
    if (seen.size >= 6) break;
  }

  return [...seen];
}

/** Guards against a category the model invented despite the constraint. */
function normalizeCategories(
  categories: string[],
): MentionAnalysisOutput["riskCategories"] {
  const known = new Set<string>(ESCALATION_CATEGORIES);
  return [
    ...new Set(categories.filter((category) => known.has(category))),
  ] as MentionAnalysisOutput["riskCategories"];
}

export interface NormalizeAnalysisInput {
  output: MentionAnalysisOutput;
  mentionId: string;
  analysisRunId: string | null;
  modelProvider: string;
  modelName: string;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Stamped by the caller so every analysis in a run shares one instant. */
  analyzedAt: string;
  /** Null for the heuristic path, which uses no prompt. */
  promptVersion?: string | null;
}

export function toAnalysisInput(
  input: NormalizeAnalysisInput,
): CreateMentionAnalysisInput {
  const { output } = input;

  return {
    mentionId: input.mentionId,
    modelProvider: input.modelProvider,
    modelName: input.modelName,
    promptVersion:
      input.promptVersion === undefined
        ? ANALYSIS_PROMPT_VERSION
        : (input.promptVersion ?? ANALYSIS_PROMPT_VERSION),
    relevanceScore: clamp(output.relevanceScore, 0, 1),
    relevanceExplanation: text(output.relevanceExplanation, 2000),
    sentiment: output.sentiment,
    sentimentScore: clamp(output.sentimentScore, -1, 1),
    riskLevel: output.riskLevel,
    riskCategories: normalizeCategories(output.riskCategories),
    riskExplanation: text(output.riskExplanation, 2000),
    topics: normalizeTopics(output.topics),
    factsNeedingVerification: output.factsNeedingVerification
      .map((fact) => fact.trim().slice(0, 400))
      .filter((fact) => fact.length > 0)
      .slice(0, 10),
    recommendedAction: output.recommendedAction,
    recommendationExplanation: text(output.recommendationExplanation, 2000),
    analyzedAt: input.analyzedAt,
    analysisRunId: input.analysisRunId,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
  };
}

/**
 * The escalation an analysis raises.
 *
 * Returns null below the threshold, so a caller cannot escalate a low-risk
 * mention by mistake — the decision lives here rather than at the call site.
 *
 * The title is derived when the model omitted one. A missing string must never
 * be what stops a critical review reaching somebody: `escalations.title` is
 * `not null` with a length check, so an empty title would fail the insert and
 * the escalation would silently not exist.
 */
export function toEscalationInput(
  output: MentionAnalysisOutput,
  mention: Mention,
  location: Location | null,
): CreateEscalationInput | null {
  if (!requiresEscalation(output.riskLevel)) return null;

  const categories = normalizeCategories(output.riskCategories);
  const category = categories[0] ?? "other";

  return {
    mentionId: mention.id,
    category,
    severity: output.riskLevel,
    title: text(output.escalationTitle, 240) ?? derivedTitle(category, location),
    summary: text(output.riskExplanation, 2000),
    // No due date. Inventing an SLA the organization never agreed to would put
    // a deadline in the escalations centre that nobody set and nobody owns.
    dueAt: null,
  };
}

function derivedTitle(
  category: CreateEscalationInput["category"],
  location: Location | null,
): string {
  const subject = category.replace(/_/g, " ");
  const where = location ? ` at ${location.name}` : "";
  // Capitalised so it reads as a title in a queue rather than as a tag.
  return `${subject.charAt(0).toUpperCase()}${subject.slice(1)} risk${where}`;
}
