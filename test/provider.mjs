import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import extension from "../pi-extension.ts";

const origin = "http://127.0.0.1:11435";
const tags = { models: [{ name: "nimble:latest" }, { name: "llama3:latest" }] };
const show = {
  capabilities: ["decision"],
  model_info: { "general.architecture": "qwen3", "qwen3.context_length": 32768 },
};

async function load(t, response) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return response(url, options);
  });
  const registrations = [];
  await extension({ registerProvider: (...args) => registrations.push(args) });
  return { calls, registrations };
}

function catalog(metadata = show, listing = tags) {
  return (url) => Response.json(url.endsWith("/api/tags") ? listing : metadata);
}

test("registers only the local Nimble classifier with discovered context", async (t) => {
  const { calls, registrations } = await load(t, catalog());
  assert.equal(registrations.length, 1);
  const [provider, config] = registrations[0];
  assert.equal(provider, "ollama-decision");
  assert.equal(config.apiKey, "ollama");
  assert.equal(config.baseUrl, `${origin}/v1`);
  assert.deepEqual(config.models, [{
    type: "classifier", id: "nimble:latest", name: "Nimble (local Ollama)",
    api: "typesafe-system-one", baseUrl: `${origin}/v1`, input: ["text"],
    contextWindow: 32768, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }]);
  assert.equal(typeof config.classifiers["typesafe-system-one"].classify, "function");
  assert.deepEqual(calls.map((c) => c.url), [`${origin}/api/tags`, `${origin}/api/show`]);
  assert.deepEqual(JSON.parse(calls[1].options.body), { model: "nimble:latest" });
  assert.ok(calls.every((c) => c.options.signal instanceof AbortSignal));
  assert.ok(calls.every((c) => c.options.redirect === "error"));
});

for (const [name, response] of [
  ["absent service", () => { throw new TypeError("fetch failed"); }],
  ["HTTP failure", () => new Response("unavailable", { status: 503 })],
  ["invalid JSON", () => new Response("not json")],
  ["missing Nimble", catalog(show, { models: [{ name: "llama3:latest" }] })],
  ["non-decision Nimble", catalog({ ...show, capabilities: ["completion"] })],
  ["missing context", catalog({ ...show, model_info: {} })],
  ["invalid context", catalog({ ...show, model_info: { "general.architecture": "qwen3", "qwen3.context_length": -1 } })],
  ["ambiguous Nimble", catalog(show, { models: [{ name: "nimble" }, { name: "nimble:latest" }] })],
  ["malformed listing", catalog(show, { models: [null] })],
]) {
  test(`quietly skips ${name}`, async (t) => {
    const { registrations } = await load(t, response);
    assert.deepEqual(registrations, []);
  });
}

test("Pi runtime exposes the classifier and resolves its dummy key without credentials", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-ollama-decision-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"), modelsPath: null,
    modelsStorePath: join(dir, "models-store.json"),
    refreshOnCreate: false, allowModelNetwork: false,
  });
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.ok(String(url).startsWith(origin));
    return catalog()(String(url));
  });
  await extension({ registerProvider: (...args) => runtime.registerProvider(...args) });
  const available = await runtime.getAvailableOfType("classifier", "ollama-decision");
  assert.equal(available.length, 1);
  assert.equal(available[0].id, "nimble:latest");
  assert.deepEqual(runtime.getModels("ollama-decision"), []);
  const result = await runtime.classify(available[0], {
    state: { message: "Synthetic test" },
    questions: { ok: { type: "bool", instructions: "OK?", criteria: { true: "Yes", false: "No" } } },
  }, {
    fetch: async (url, options) => {
      assert.equal(String(url), `${origin}/v1/systemone`);
      assert.equal(options.headers.authorization, "Bearer ollama");
      return Response.json({ answers: { ok: { type: "noul", noul: 0.9 } } });
    },
  });
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(result.answers.ok, { type: "bool", probability: 0.9 });
});

test("registered adapter maps choice, bool, score and usage to Pi", async (t) => {
  const { registrations } = await load(t, catalog());
  const [provider, config] = registrations[0];
  const model = { ...config.models[0], provider };
  const context = {
    state: "Synthetic ticket: the test checkout fails.",
    questions: {
      label: { type: "choice", instructions: "Choose a label", criteria: { bug: "Error", other: "Other" } },
      broken: { type: "bool", instructions: "Is it broken?", criteria: { false: "Works", true: "Fails" } },
      urgency: { type: "score", instructions: "Score urgency", criteria: ["Routine", "Immediate"] },
    },
  };
  let request;
  const classify = config.classifiers[model.api].classify;
  const result = await classify(model, context, {
    apiKey: config.apiKey,
    fetch: async (url, options) => {
      request = { url: String(url), options, payload: JSON.parse(options.body) };
      return Response.json({
        answers: {
          label: { type: "choice", choice: "bug", probabilities: { bug: 0.9, other: 0.1 }, confidence: 0.8 },
          broken: { type: "noul", noul: 0.95 },
          urgency: { type: "score", score: 0.75, confidence: 0.5 },
        },
        usage: { input_tokens: 100, output_tokens: 1 },
      });
    },
  });
  assert.equal(request.url, `${origin}/v1/systemone`);
  assert.equal(request.options.headers.authorization, "Bearer ollama");
  assert.deepEqual(request.payload, {
    model: model.id, state: context.state,
    questions: { ...context.questions, broken: { ...context.questions.broken, type: "noul" } },
  });
  assert.equal(context.questions.broken.type, "bool");
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(result.answers.broken, { type: "bool", probability: 0.95 });
  assert.equal(result.answers.label.choice, "bug");
  assert.equal(result.answers.urgency.score, 0.75);
  assert.equal(result.usage.totalTokens, 101);
  assert.equal(result.usage.cost.total, 0);
});

test("registered adapter maps HTTP, malformed answers, and abort failures", async (t) => {
  const { registrations } = await load(t, catalog());
  const [provider, config] = registrations[0];
  const model = { ...config.models[0], provider };
  const context = { state: "Synthetic test", questions: { ok: { type: "bool", instructions: "OK?" } } };
  const classify = config.classifiers[model.api].classify;
  for (const fetch of [
    async () => new Response("invalid request", { status: 400 }),
    async () => Response.json({ answers: {} }),
  ]) {
    const result = await classify(model, context, { apiKey: config.apiKey, maxRetries: 0, fetch });
    assert.equal(result.stopReason, "error");
    assert.ok(result.errorMessage);
    assert.deepEqual(result.answers, {});
  }
  const controller = new AbortController();
  controller.abort();
  const result = await classify(model, context, {
    apiKey: config.apiKey, signal: controller.signal, maxRetries: 0,
    fetch: async (_url, options) => { options.signal.throwIfAborted(); },
  });
  assert.equal(result.stopReason, "aborted");
  assert.ok(result.errorMessage);
});
