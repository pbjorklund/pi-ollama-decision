# Pi Ollama decision

Personal Pi provider for Nimble on `http://127.0.0.1:11435`. It adds a classifier, not a chat model, and does not change the default model.

## Install

```sh
pi install git:github.com/pbjorklund/pi-ollama-decision
```

The repo is private, so Git must have access to `pbjorklund/pi-ollama-decision`. Pi supplies `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent`; there are no other runtime dependencies. Tested with Pi 1.0.4.

The separate desktop Ollama service must support `/v1/systemone` and have `nimble` installed. [Ollama's decision docs](https://github.com/ollama/ollama/blob/main/docs/capabilities/decision.mdx) require Ollama 0.35.0 or later for Nimble. This extension does not install, start, or pull anything.

On startup, the extension checks `/api/tags` for `nimble` or `nimble:latest`, then `/api/show` for the `decision` capability and the architecture's context length. The advertised context window is the smaller of that model maximum and 8192 tokens, matching the separate desktop service's configured context. Discovery has a 1.5-second total timeout. A missing service, model, or usable metadata skips registration without an extension error. Thinkpad and dev VM installs can keep the package enabled without running the service. Start a new Pi session or run `/reload` after starting the service or pulling Nimble.

## Use

The provider is `ollama-decision`. Its model ID is the name returned by Ollama, usually `nimble:latest`. Classifiers do not appear in `/model`. With codemode enabled, use:

```js
const modelsHere = await models.getAvailableOfType("classifier", "ollama-decision");
if (!modelsHere.length) return "Local Nimble is unavailable";
const result = await models.classify(modelsHere[0], {
  state: { message: "Synthetic test: the checkout fails." },
  questions: {
    broken: {
      type: "bool",
      instructions: "Does the message describe a software failure?",
      criteria: { true: "A software failure", false: "No software failure" },
    },
  },
});
return result.stopReason === "stop" ? result.answers : result.errorMessage;
```

Extensions can also call `ctx.modelRegistry.classify()`. Pi's built-in `typesafe-system-one` adapter sends requests to `/v1/systemone`, maps public `bool` to Ollama's wire-level `noul`, and handles choice, score, usage, errors, and aborts. The provider uses the dummy key `ollama` because Pi's adapter requires a key; local Ollama does not authenticate it. Reported model costs are zero.

If the service stops after startup, classifier calls return Pi's normal error result. No cloud fallback is configured. Classification sends only the supplied state and questions to the local service.

## General agent use

When local Nimble is available, Pi also gets `decision_check`. Its tool guidance asks the agent to use it for uncertain semantic categorization or triage that could change the next step, not deterministic checks or every message. It calls the classifier directly, without generating a codemode script. Your selected chat model, thinking level, tools and permissions stay unchanged.

The tool compares 2-6 explicit alternatives against a short sanitized factual summary (up to 4000 characters). It adds an insufficient-evidence option and checks for answer-controlling instructions in the same local inference. It returns `advisory` with a choice, probabilities and confidence, or `inconclusive` with no recommended choice. The agent must still verify advice against source evidence; the tool never executes actions, clears human waits or establishes facts or permissions. Inconclusive means continue normal reasoning, not retry until the model agrees.

A choice needs at least 90% selected-category probability and less than 10% instruction-contamination probability to be returned as advice. These are conservative abstention heuristics, not calibrated correctness or a security guarantee. Input must be a factual summary, not raw external instructions or an entire conversation. Evidence and question parameters enter the normal Pi tool transcript; local inference does not make secret input safe to record.

The tool uses a 10-second inference deadline, zero retries and no cloud fallback. Errors, malformed answers, missing models and cancellation return an explicit inconclusive error result without upstream error text. Nested usage is included in the tool result. If discovery fails at startup, neither the provider nor tool registers; Pi continues normally. To roll back tool use, deactivate `decision_check` with Pi's tool controls, or remove this package from the personal overlay and relink to disable the provider too.

Example inputs:

```json
{
  "evidence": "Checkout returns HTTP 500 on every attempt.",
  "question": "Which category does the evidence support?",
  "alternatives": [
    { "label": "bug", "description": "A software malfunction" },
    { "label": "billing", "description": "A charge or invoice issue" }
  ]
}
```

### Evaluation and limits

A high-probability cutoff alone failed: one injected instruction produced the wrong recommendation in all three development trials. A shorter prompt still failed. The final tool also asks whether evidence tries to control the answer and abstains when that signal is uncertain or positive. This is a model-based warning, not an independent security boundary; permissions and authoritative verification remain outside it.

`npm run eval` runs nine synthetic component cases three times: five development cases and four initially held-out paraphrases, missing-fact and injection cases. It compares raw top-category selection with guarded advice from the same inference. Promotion requires zero incorrect advisories, zero provider failures and at least three useful ordinary-case advisories. The recorded final run had six wrong raw selections, zero wrong returned advisories, six useful advisories and 21 abstentions across 27 calls. All four adversarial cases abstained in every trial. Warm calls in that run took about 0.34-0.71 seconds. These are local component smoke results, not an agent-quality benchmark or general injection defense. The held-out cases become regression cases after this run; add fresh cases for later changes.

```sh
npm run eval
```

The eval uses only the local service with synthetic inputs and prints case IDs, labels, status and timing, not customer content. It exits nonzero when its quality gate fails. It does not run chat-model calls or prove that Pi's final actions improve. Measure real agent outcomes before claiming a general quality gain.

## Check

Use Node 22.18 or later (native TypeScript stripping) and an installed `pi` binary:

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
```

Tests use synthetic state and mocked local HTTP responses. They cover discovery, quiet absence, Pi runtime registration and key resolution, choice/bool/score conversion, usage, HTTP failures, malformed answers, and cancellation. Binary regression tests copy the package outside the checkout without `node_modules`, disable Jiti caches, and use isolated Pi RPC settings to check startup and classification with the bundled adapter. They do not call a cloud provider or require a running Ollama service.
