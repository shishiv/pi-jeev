import { createHash } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

const evidenceItem = Type.String({ minLength: 1, maxLength: 600 });
const evidenceList = Type.Array(evidenceItem, { maxItems: 12 });
const optionSchema = Type.Object({
  id: Type.String({ pattern: "^[a-z][a-z0-9_]{0,31}$" }),
  action: Type.String({ minLength: 1, maxLength: 500 }),
  evidenceFor: evidenceList,
  evidenceAgainst: evidenceList,
}, { additionalProperties: false });

export const decisionSchema = Type.Object({
  question: Type.String({ minLength: 1, maxLength: 1200 }),
  context: Type.Object({
    observed: Type.Array(evidenceItem, { minItems: 1, maxItems: 20 }),
    constraints: evidenceList,
    unknowns: evidenceList,
  }, { additionalProperties: false }),
  options: Type.Array(optionSchema, { minItems: 2, maxItems: 8 }),
  stakes: StringEnum(["low", "medium", "high"] as const),
}, { additionalProperties: false });

export type DecisionInput = Static<typeof decisionSchema>;

type ChoiceAnswer = {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
};

type NoulAnswer = {
  type: "noul";
  noul: number;
};

export type RawDecisionResponse = {
  model: string;
  answers: Record<string, ChoiceAnswer | NoulAnswer>;
  usage: { input_tokens: number; output_tokens: number };
};

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type ChoiceQuestion = {
  type: "choice";
  instructions: { question: string; method: string[] };
  criteria: Record<string, { action: string; evidence_for: string[]; evidence_against: string[] }>;
};

type NoulQuestion = {
  type: "noul";
  instructions: { question: string; inspect?: string[]; method?: string };
  criteria: { true: string; false: string };
};

export type DecisionResult = {
  status: "recommend" | "abstain" | "review_required";
  recommendation: string | null;
  candidate: string;
  confidence: number;
  topProbability: number;
  runnerUpProbability: number;
  margin: number;
  evidenceSufficiency: number;
  candidateSupport: number;
  reasons: string[];
  probabilities: Record<string, number>;
  support: Record<string, number>;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
};

const probabilitySchema = Type.Number({ minimum: 0, maximum: 1 });
const choiceAnswerSchema = Type.Object({
  type: Type.Literal("choice"),
  choice: Type.String(),
  confidence: probabilitySchema,
  probabilities: Type.Record(Type.String(), probabilitySchema),
}, { additionalProperties: false });
const noulAnswerSchema = Type.Object({
  type: Type.Literal("noul"),
  noul: probabilitySchema,
}, { additionalProperties: false });
const responseSchema = Type.Object({
  model: Type.String({ minLength: 1, maxLength: 100 }),
  answers: Type.Record(Type.String(), Type.Union([choiceAnswerSchema, noulAnswerSchema])),
  usage: Type.Object({
    input_tokens: Type.Integer({ minimum: 0 }),
    output_tokens: Type.Integer({ minimum: 0 }),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

const policy = {
  low: { top: 0.60, margin: 0.12, sufficiency: 0.55, support: 0.55 },
  medium: { top: 0.75, margin: 0.20, sufficiency: 0.70, support: 0.65 },
  high: { top: 1, margin: 1, sufficiency: 1, support: 1 },
} as const;

function requireMeaningfulText(value: string, label: string): void {
  if (!value.trim()) throw new Error(`Jev: ${label} must not be blank`);
}

export function canonicalOptions(input: DecisionInput): DecisionInput["options"] {
  const seed = createHash("sha256").update(input.question).digest("hex");
  return [...input.options].sort((left, right) => {
    const leftKey = createHash("sha256").update(`${seed}\0${left.id}`).digest("hex");
    const rightKey = createHash("sha256").update(`${seed}\0${right.id}`).digest("hex");
    return leftKey.localeCompare(rightKey);
  });
}

export function validateDecisionInput(input: DecisionInput): void {
  if (!Check(decisionSchema, input)) throw new Error("Jev: invalid decision input");
  requireMeaningfulText(input.question, "question");
  for (const [index, value] of input.context.observed.entries()) requireMeaningfulText(value, `observed[${index}]`);
  for (const [index, value] of input.context.constraints.entries()) requireMeaningfulText(value, `constraints[${index}]`);
  for (const [index, value] of input.context.unknowns.entries()) requireMeaningfulText(value, `unknowns[${index}]`);
  const ids = new Set<string>();
  for (const [index, option] of input.options.entries()) {
    if (ids.has(option.id)) throw new Error("Jev: option ids must be unique");
    ids.add(option.id);
    requireMeaningfulText(option.action, `options[${index}].action`);
    for (const [item, value] of option.evidenceFor.entries()) requireMeaningfulText(value, `options[${index}].evidenceFor[${item}]`);
    for (const [item, value] of option.evidenceAgainst.entries()) requireMeaningfulText(value, `options[${index}].evidenceAgainst[${item}]`);
  }
}

export function buildRequest(input: DecisionInput) {
  validateDecisionInput(input);
  const options = canonicalOptions(input);
  const state = {
    decision: {
      question: input.question,
      observed: input.context.observed,
      constraints: input.context.constraints,
      unknowns: input.context.unknowns,
      options: options.map((option) => ({
        id: option.id,
        action: option.action,
        evidence_for: option.evidenceFor,
        evidence_against: option.evidenceAgainst,
      })),
    },
  };
  const questionEntries: Array<readonly [string, ChoiceQuestion | NoulQuestion]> = [
    ["decision", {
      type: "choice",
      instructions: {
        question: "Which candidate in `decision.options` best answers `decision.question`?",
        method: [
          "Use only `decision.observed` and the evidence attached to each candidate.",
          "Reject candidates that conflict with `decision.constraints`.",
          "Treat `decision.unknowns` as unavailable facts, not permission to assume them.",
          "Compare every candidate by the same standard.",
        ],
      },
      criteria: Object.fromEntries(options.map((option) => [option.id, {
        action: option.action,
        evidence_for: option.evidenceFor,
        evidence_against: option.evidenceAgainst,
      }])),
    }],
    ["evidence_sufficient", {
      type: "noul",
      instructions: {
        question: "Is the supplied evidence sufficient to choose one candidate without assuming a fact listed in `decision.unknowns`?",
        inspect: ["decision.observed", "decision.constraints", "decision.unknowns", "decision.options"],
      },
      criteria: {
        true: "One candidate is materially better supported and satisfies every stated constraint.",
        false: "The candidates remain tied, depend on an unknown fact, or the evidence does not distinguish them.",
      },
    }],
  ];
  options.forEach((option, index) => {
    questionEntries.push([`support_${index}`, {
      type: "noul",
      instructions: {
        question: `Is the candidate at \`decision.options[${index}]\` materially supported by the supplied evidence?`,
        method: "Weigh its evidence_for against its evidence_against and every stated constraint.",
      },
      criteria: {
        true: "The observed evidence supports this candidate and no stated constraint rules it out.",
        false: "Support is absent, contradicted, or depends on an unknown fact.",
      },
    }]);
  });
  return { model: "jev-latest", state, questions: Object.fromEntries(questionEntries) };
}

function asChoice(answer: ChoiceAnswer | NoulAnswer | undefined): ChoiceAnswer {
  if (!answer || answer.type !== "choice") throw new Error("Jev: missing decision choice; no decision accepted");
  return answer;
}

function asNoul(answer: ChoiceAnswer | NoulAnswer | undefined, label: string): number {
  if (!answer || answer.type !== "noul") throw new Error(`Jev: missing ${label} judgment; no decision accepted`);
  return answer.noul;
}

export function parseDecision(raw: JsonValue, input: DecisionInput): DecisionResult {
  validateDecisionInput(input);
  if (!Check(responseSchema, raw)) throw new Error("Jev: malformed API response; no decision accepted");
  // SAFETY: responseSchema has validated every field consumed below.
  const parsed = raw as RawDecisionResponse;
  const options = canonicalOptions(input);
  const optionIds = new Set(options.map((option) => option.id));
  const expectedAnswerIds = new Set(["decision", "evidence_sufficient", ...options.map((_, index) => `support_${index}`)]);
  const actualAnswerIds = Object.keys(parsed.answers);
  if (actualAnswerIds.length !== expectedAnswerIds.size || actualAnswerIds.some((id) => !expectedAnswerIds.has(id))) {
    throw new Error("Jev: unexpected answer set; no decision accepted");
  }
  const choice = asChoice(parsed.answers.decision);
  const distribution = Object.entries(choice.probabilities);
  const total = distribution.reduce((sum, [, value]) => sum + value, 0);
  const selectedProbability = choice.probabilities[choice.choice];
  if (!optionIds.has(choice.choice) || distribution.length !== optionIds.size
    || distribution.some(([id]) => !optionIds.has(id)) || Math.abs(total - 1) > 0.001
    || selectedProbability === undefined
    || distribution.some(([, value]) => value > selectedProbability + 0.000001)) {
    throw new Error("Jev: inconsistent choice distribution; no decision accepted");
  }
  const support = Object.fromEntries(options.map((option, index) => [
    option.id,
    asNoul(parsed.answers[`support_${index}`], `support_${index}`),
  ]));
  const evidenceSufficiency = asNoul(parsed.answers.evidence_sufficient, "evidence_sufficient");
  const ranked = distribution.map(([, value]) => value).sort((left, right) => right - left);
  const runnerUpProbability = ranked[1] ?? 0;
  const margin = selectedProbability - runnerUpProbability;
  const candidateSupport = support[choice.choice] ?? 0;
  const thresholds = policy[input.stakes];
  const reasons: string[] = [];
  if (input.stakes === "high") {
    reasons.push("high_stakes_require_review");
  } else {
    if (selectedProbability < thresholds.top) reasons.push("top_probability_below_threshold");
    if (margin < thresholds.margin) reasons.push("choice_margin_below_threshold");
    if (evidenceSufficiency < thresholds.sufficiency) reasons.push("evidence_insufficient");
    if (candidateSupport < thresholds.support) reasons.push("candidate_support_below_threshold");
  }
  const status = input.stakes === "high" ? "review_required" : reasons.length ? "abstain" : "recommend";
  return {
    status,
    recommendation: status === "recommend" ? choice.choice : null,
    candidate: choice.choice,
    confidence: choice.confidence,
    topProbability: selectedProbability,
    runnerUpProbability,
    margin,
    evidenceSufficiency,
    candidateSupport,
    reasons,
    probabilities: choice.probabilities,
    support,
    model: parsed.model,
    usage: parsed.usage,
  };
}
