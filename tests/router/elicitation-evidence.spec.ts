import assert from "node:assert/strict";
import test from "node:test";

import { extractElicitationRouteEvidence } from "../../src/router/tokenSaver/extractElicitationRouteEvidence.js";
import type { PilotDeckToolResult } from "../../src/tool/protocol/result.js";

function result(toolName: string, data: unknown): PilotDeckToolResult {
  return {
    type: "success",
    toolCallId: `${toolName}-1`,
    toolName,
    content: [{ type: "text", text: "ok" }],
    data,
    startedAt: "2026-09-11T00:00:00.000Z",
    completedAt: "2026-09-11T00:00:00.001Z",
  };
}

test("extracts bounded structured ask_user_question answers", () => {
  const evidence = extractElicitationRouteEvidence([
    result("ask_user_question", {
      questions: [
        { question: "Environment?", header: "Env", options: [] },
        { question: "Verification?", header: "Verify", options: [] },
      ],
      answers: {
        "Environment?": "Production",
        "Verification?": ["Rollback", "Full verification"],
      },
    }),
  ]);

  assert.ok(evidence);
  assert.match(evidence, /Clarification collected through ask_user_question:/);
  assert.match(evidence, /Question: Environment\?/);
  assert.match(evidence, /Answer: Production/);
  assert.match(evidence, /Answer: Rollback, Full verification/);
  assert.ok(evidence.length <= 4_000);
});

test("ignores failed, non-elicitation, and empty answers", () => {
  assert.equal(extractElicitationRouteEvidence([
    result("bash", { answers: { "Environment?": "Production" } }),
  ]), undefined);

  assert.equal(extractElicitationRouteEvidence([
    {
      ...result("ask_user_question", undefined),
      type: "error",
      error: { code: "tool_execution_failed", message: "cancelled" },
    },
  ]), undefined);

  assert.equal(extractElicitationRouteEvidence([
    result("ask_user_question", {
      questions: [{ question: "Environment?", header: "Env", options: [] }],
      answers: { "Environment?": "   " },
    }),
  ]), undefined);
});
