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

## Check

Use Node 22.18 or later (native TypeScript stripping):

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
```

Tests use synthetic state and mocked local HTTP responses. They cover discovery, quiet absence, Pi runtime registration and key resolution, choice/bool/score conversion, usage, HTTP failures, malformed answers, and cancellation. They do not call a cloud provider or require a running Ollama service.
