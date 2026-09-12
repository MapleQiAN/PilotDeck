import assert from "node:assert/strict";
import test from "node:test";

import type {
  CanonicalModelRequest,
  ModelDefinition,
  ProviderConfig,
} from "../../../src/model/index.js";
import { buildOpenAIRequest } from "../../../src/model/providers/openai/request.js";

test("explicit off mode emits the GLM thinking disable flag", () => {
  const request: CanonicalModelRequest = {
    provider: "hackthon",
    model: "glm-5.3",
    messages: [{ role: "user", content: [{ type: "text", text: "classify this" }] }],
    thinking: { enabled: false, mode: "off" },
    stream: false,
  };
  const model = {
    id: "glm-5.3",
    capabilities: {},
    multimodal: {},
  } as ModelDefinition;
  const provider = {
    id: "hackthon",
    protocol: "openai",
    url: "http://example.test/v1",
    apiKey: "test-key",
    headers: {},
    models: {},
  } as ProviderConfig;

  const body = buildOpenAIRequest(request, model, provider) as {
    thinking?: { type?: string };
  };

  assert.deepEqual(body.thinking, { type: "disabled" });
});
