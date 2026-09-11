import type { PilotDeckToolResult } from "../../tool/protocol/result.js";

const MAX_PAIRS = 8;
const MAX_FIELD_CHARS = 500;
const MAX_EVIDENCE_CHARS = 4_000;
const EVIDENCE_HEADER = "Clarification collected through ask_user_question:";

/**
 * Convert successful structured elicitation results into bounded routing
 * context. The answer is transient evidence for the next Judge call; it is
 * deliberately not part of the persistent TaskCard.
 */
export function extractElicitationRouteEvidence(
  results: PilotDeckToolResult[],
): string | undefined {
  const lines = [EVIDENCE_HEADER];
  let pairCount = 0;

  for (const result of results) {
    if (result.type !== "success" || result.toolName !== "ask_user_question") {
      continue;
    }

    const data = result.data;
    if (!isRecord(data) || !Array.isArray(data.questions) || !isRecord(data.answers)) {
      continue;
    }

    for (const question of data.questions) {
      if (pairCount >= MAX_PAIRS || !isRecord(question)) {
        break;
      }
      if (typeof question.question !== "string") {
        continue;
      }
      const questionKey = question.question;
      const questionText = boundedText(questionKey);
      if (!questionText) {
        continue;
      }

      const answer = normalizeAnswer(data.answers[questionKey]);
      if (!answer) {
        continue;
      }

      lines.push(`- Question: ${questionText}`);
      lines.push(`  Answer: ${answer}`);
      pairCount += 1;
    }

    if (pairCount >= MAX_PAIRS) {
      break;
    }
  }

  if (pairCount === 0) {
    return undefined;
  }
  return lines.join("\n").slice(0, MAX_EVIDENCE_CHARS);
}

function normalizeAnswer(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const parts = value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    return boundedText(parts.join(", "));
  }
  return boundedText(value);
}

function boundedText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.replace(/\s+/g, " ").trim().slice(0, MAX_FIELD_CHARS);
  return text.length > 0 ? text : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
