import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalModelRequest, ModelRuntime, ModelRuntimeOptions } from "../../src/model/index.js";
import { createRouterRuntime } from "../../src/router/RouterRuntime.js";
import type { RouterConfig } from "../../src/router/config/schema.js";
import { calculateInputCost, calculateCacheReadCost } from "../../src/router/utils/modelPricing.js";

const capabilities = {
  supportsToolUse: true,
  supportsStreaming: true,
  supportsParallelToolCalls: false,
  supportsThinking: false,
  supportsJsonSchema: false,
  supportsSystemPrompt: true,
  supportsPromptCache: true,
  maxContextTokens: 8192,
  maxOutputTokens: 1024,
};

const config: RouterConfig = {
  enabled: true,
  scenarios: { default: { id: "primary/main", provider: "primary", model: "main" } },
  zeroUsageRetry: { enabled: false, maxAttempts: 1 },
  transientRetry: { enabled: false, maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
  stats: { enabled: false },
};

const runtime: ModelRuntime = {
  async *stream(_request: CanonicalModelRequest, _options?: ModelRuntimeOptions) {},
  async complete() {
    throw new Error("not used");
  },
  getCapabilities() {
    return capabilities;
  },
  getMultimodal() {
    return { input: ["text"] };
  },
  getProviderProtocol() {
    return "openai";
  },
  getProviderBaseUrl(provider: string) {
    return `https://${provider}.invalid`;
  },
};

test("router drops cache plan when explicit routing changes provider or model", async () => {
  const router = createRouterRuntime(config, { modelRuntime: runtime });
  const request: CanonicalModelRequest = {
    provider: "primary",
    model: "main",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    cacheBreakpoints: [0],
    cachePlan: {
      provider: "primary",
      model: "main",
      system: true,
      tools: false,
      messages: [0],
      fingerprint: "primary-main",
      generation: 1,
    },
  };

  const decision = await router.decide({
    request,
    sessionId: "cache-route",
    isMainAgent: true,
    metadata: { explicitProvider: "other", explicitModel: "fast" },
  });
  const materialized = router.materializeRequest(decision, request);

  assert.equal(materialized.cachePlan, undefined);
  assert.equal(materialized.cacheBreakpoints, undefined);
  await router.shutdown();
});

test("pricing unit is metadata and does not change cost calculations", () => {
  const pricing = {
    "primary/main": { input: 2, cacheRead: 0.5, unit: "¥/百万 Token" as const },
  };

  assert.equal(calculateInputCost(1_000_000, "primary", "main", pricing), 2);
  assert.equal(calculateCacheReadCost(1_000_000, "primary", "main", pricing), 0.5);
});

test("router stats prefer an explicit baseline model over the scenario default", async () => {
  const router = createRouterRuntime({
    ...config,
    stats: {
      enabled: true,
      filePath: `/tmp/pilotdeck-router-baseline-${process.pid}-${Math.random().toString(36).slice(2)}/stats.json`,
      baselineModel: { provider: "baseline", model: "model" },
      modelPricing: {
        "primary/main": { input: 1 },
        "baseline/model": { input: 3 },
      },
    },
  }, { modelRuntime: runtime });
  router.stats.observe({
    sessionId: "baseline-test",
    scenarioType: "default",
    resolvedFrom: "scenario",
    provider: "primary",
    model: "main",
    usage: { inputTokens: 1_000_000, outputTokens: 0 },
    startedAt: new Date(0).toISOString(),
    endedAt: new Date(1).toISOString(),
  });
  assert.equal(router.stats.snapshot().totalBaselineCost, 3);
  await router.shutdown();
});

type CacheRouteOptions = {
  currentTier: string;
  nextTier: "simple" | "medium" | "reasoning";
  judgeFails?: boolean;
  isNewTask?: boolean;
  currentProvider?: string;
  currentModel?: string;
  nextInputPrice?: number;
};

async function routeCacheChange(options: CacheRouteOptions) {
  const currentProvider = options.currentProvider ?? "current";
  const currentModel = options.currentModel ?? "cached-model";
  const nextModel = `${options.nextTier}-model`;
  const nextProvider = "next";
  const cacheConfig: RouterConfig = {
    ...config,
    tokenSaver: {
      enabled: true,
      judge: { id: "judge/router", provider: "judge", model: "router" },
      defaultTier: "medium",
      judgeTimeoutMs: 5_000,
      tiers: {
        simple: { model: { id: "next/simple-model", provider: "next", model: "simple-model" } },
        medium: { model: { id: "next/medium-model", provider: "next", model: "medium-model" } },
        reasoning: { model: { id: "next/reasoning-model", provider: "next", model: "reasoning-model" } },
      },
      cacheAwareSwitching: {
        enabled: true,
        minSavingsRatio: 0,
      },
    },
    stats: {
      enabled: false,
      modelPricing: {
        [`${currentProvider}/${currentModel}`]: { input: 10, cacheRead: 1 },
        [`${nextProvider}/${nextModel}`]: { input: options.nextInputPrice ?? 3 },
      },
    },
  };
  const judgeRuntime = {
    ...runtime,
    async complete() {
      if (options.judgeFails) {
        return {
          role: "assistant" as const,
          content: [{ type: "thinking" as const, text: "unfinished analysis" }],
          finishReason: "length" as const,
        };
      }
      return {
        role: "assistant" as const,
        content: [{
          type: "text" as const,
          text: `<tier>${options.nextTier}</tier>${options.isNewTask ? "<new_task>yes</new_task>" : ""}`,
        }],
        finishReason: "stop" as const,
      };
    },
  } satisfies ModelRuntime;
  const router = createRouterRuntime(cacheConfig, { modelRuntime: runtime, judgeRuntime });
  const sessionId = `cache-${Math.random()}`;
  router.observeUsage(sessionId, {
    inputTokens: 1_000,
    outputTokens: 0,
    cacheReadTokens: 1_000,
    totalTokens: 1_000,
  });
  const decision = await router.decide({
    request: {
      provider: "primary",
      model: "main",
      messages: [{ role: "user", content: [{ type: "text", text: "verify the implementation carefully" }] }],
    },
    sessionId,
    isMainAgent: true,
    metadata: {
      previousTier: options.currentTier,
      previousProvider: currentProvider,
      previousModel: currentModel,
    },
  });
  await router.shutdown();
  return decision;
}

test("judge fallback selects the configured default tier instead of preserving a cheaper sticky tier", async () => {
  const decision = await routeCacheChange({
    currentTier: "simple",
    nextTier: "medium",
    judgeFails: true,
  });

  assert.equal(decision.model, "medium-model");
  assert.equal(decision.tokenSaverTier, "medium");
  assert.equal(decision.mutations.cacheAwareSwitch, undefined);
});

test("a confirmed new task does not preserve the previous task's cheaper sticky tier", async () => {
  const decision = await routeCacheChange({
    currentTier: "simple",
    nextTier: "reasoning",
    isNewTask: true,
  });

  assert.equal(decision.model, "reasoning-model");
  assert.equal(decision.tokenSaverTier, "reasoning");
  assert.equal(decision.mutations.cacheAwareSwitch, undefined);
  assert.equal(decision.mutations.taskCardRoute?.isNewTask, true);
});

test("judge-selected upgrades always switch without consulting the cache guard", async () => {
  const decision = await routeCacheChange({
    currentTier: "medium",
    nextTier: "reasoning",
    nextInputPrice: 100,
  });
  assert.equal(decision.model, "reasoning-model");
  assert.equal(decision.tokenSaverTier, "reasoning");
  assert.equal(decision.mutations.cacheAwareSwitch, undefined);
});

test("downgrades still use the cache guard", async () => {
  const decision = await routeCacheChange({
    currentTier: "reasoning",
    nextTier: "simple",
  });
  assert.equal(decision.model, "cached-model");
  assert.equal(decision.mutations.cacheAwareSwitch?.action, "kept_sticky");
  assert.equal(decision.mutations.cacheAwareSwitch?.direction, "downgrade");
});

test("unknown tiers and same-tier model changes use the legacy guard", async () => {
  const unknown = await routeCacheChange({
    currentTier: "legacy",
    nextTier: "medium",
  });
  assert.equal(unknown.model, "cached-model");
  assert.equal(unknown.mutations.cacheAwareSwitch?.direction, "unknown");
  assert.equal(unknown.mutations.cacheAwareSwitch?.action, "kept_sticky");

  const same = await routeCacheChange({
    currentTier: "medium",
    nextTier: "medium",
    currentProvider: "other",
    currentModel: "other-medium-model",
  });
  assert.equal(same.model, "other-medium-model");
  assert.equal(same.mutations.cacheAwareSwitch?.direction, "same");
  assert.equal(same.mutations.cacheAwareSwitch?.action, "kept_sticky");
});
