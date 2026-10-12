import test from "node:test";
import assert from "node:assert/strict";

test("service worker calls Jev and caches the normalized result", async () => {
  let messageListener;
  let fetchCalls = 0;
  const writes = [];

  globalThis.chrome = {
    runtime: {
      onInstalled: { addListener() {} },
      onMessage: { addListener(listener) { messageListener = listener; } }
    },
    storage: {
      local: {
        async setAccessLevel({ accessLevel }) {
          assert.equal(accessLevel, "TRUSTED_CONTEXTS");
        },
        async get(key) {
          if (key === "jevSettings") {
            return { jevSettings: { authToken: "background-test-key", mockMode: false } };
          }
          return {};
        },
        async set(value) {
          writes.push(value);
        }
      }
    }
  };

  globalThis.fetch = async (_url, options) => {
    fetchCalls += 1;
    assert.equal(options.headers.Authorization, "Bearer background-test-key");
    return new Response(JSON.stringify({
      model: "jev-1.13.0",
      answers: {
        slop_score: {
          type: "score",
          score: 4,
          confidence: 0.91,
          legend: { 0: "None", 1: "Minimal", 2: "Mild", 3: "Moderate", 4: "Strong", 5: "Overwhelming" },
          probabilities: { 0: 0, 1: 0, 2: 0.02, 3: 0.18, 4: 0.6, 5: 0.2 }
        },
        dominant_signal: {
          type: "choice",
          choice: "formulaic_linkedin",
          confidence: 0.91,
          probabilities: { formulaic_linkedin: 0.91, none: 0.09 }
        }
      },
      usage: { input_tokens: 180, output_tokens: 30 }
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  await import(`../src/background.js?test=${Date.now()}`);
  assert.equal(typeof messageListener, "function");

  const send = () => new Promise((resolve) => {
    const keepChannelOpen = messageListener({
      type: "JEV_CLASSIFY_POST",
      payload: { text: "A formulaic LinkedIn post.", cacheKey: "text:test:27" }
    }, { tab: { url: "https://www.linkedin.com/feed/" } }, resolve);
    assert.equal(keepChannelOpen, true);
  });

  const first = await send();
  const second = await send();
  assert.equal(first.ok, true);
  assert.equal(first.cached, false);
  assert.equal(first.source, "jev");
  assert.deepEqual(first.result, {
    slop_score: 80,
    short_reason: "Formulaic LinkedIn storytelling relies on familiar motivational beats."
  });
  assert.equal(second.cached, true);
  assert.equal(fetchCalls, 1);
  assert.ok(writes.length >= 1, "The classification cache was not persisted.");
});
