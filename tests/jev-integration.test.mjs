import test from "node:test";
import assert from "node:assert/strict";
import {
  buildJevRequest,
  classifyPost,
  JEV_CONFIG,
  mapJevResponse
} from "../src/classifier.js";

const JEV_CONTEXT = Object.freeze({
  mode: "jev",
  authToken: "local-test-key",
  apiUrl: JEV_CONFIG.API_URL,
  model: JEV_CONFIG.MODEL,
  timeoutMs: 100
});

function validJevResponse(overrides = {}) {
  return {
    model: "jev-1.13.0",
    answers: {
      slop_score: {
        type: "score",
        score: 3.75,
        confidence: 0.88,
        legend: {
          0: "No slop",
          1: "Minimal",
          2: "Mild",
          3: "Moderate",
          4: "Strong",
          5: "Overwhelming"
        },
        probabilities: { 0: 0, 1: 0.02, 2: 0.08, 3: 0.3, 4: 0.41, 5: 0.19 }
      },
      dominant_signal: {
        type: "choice",
        choice: "engagement_bait",
        confidence: 0.84,
        probabilities: {
          none: 0.01,
          ai_like_template: 0.05,
          generic_phrasing: 0.05,
          engagement_bait: 0.84,
          low_information_density: 0.02,
          hype: 0.02,
          formulaic_linkedin: 0.01
        }
      }
    },
    usage: { input_tokens: 210, output_tokens: 34 },
    ...overrides
  };
}

test("buildJevRequest follows the official System One contract", () => {
  const request = buildJevRequest("Post text only");
  assert.deepEqual(Object.keys(request), ["model", "state", "questions"]);
  assert.equal(request.model, "jev-latest");
  assert.equal(request.state, "Post text only");
  assert.equal(request.questions.slop_score.type, "score");
  assert.equal(request.questions.slop_score.criteria.length, 6);
  assert.equal(request.questions.dominant_signal.type, "choice");
  assert.equal(Object.keys(request.questions.dominant_signal.criteria).length, 7);
});

test("real Jev call sends bearer auth, only post text as state, and maps the score", async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, options };
    return new Response(JSON.stringify(validJevResponse()), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  const result = await classifyPost("  Exact   LinkedIn post text.  ", JEV_CONTEXT, { fetchImpl });
  const request = JSON.parse(captured.options.body);
  assert.equal(captured.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(captured.options.method, "POST");
  assert.equal(captured.options.headers.Authorization, "Bearer local-test-key");
  assert.equal(request.state, "Exact LinkedIn post text.");
  assert.equal("text" in request, false);
  assert.deepEqual(result, {
    slop_score: 75,
    short_reason: "Engagement prompts outweigh the post's substantive content."
  });
});

test("Jev response mapping rejects malformed answers", () => {
  const malformed = validJevResponse({ answers: { slop_score: { type: "score", score: "high" } } });
  assert.throws(() => mapJevResponse(malformed), /malformed slop score/i);
});

test("authentication and rate-limit errors are actionable", async () => {
  await assert.rejects(
    () => classifyPost("Post", JEV_CONTEXT, {
      fetchImpl: async () => new Response("", { status: 401 })
    }),
    /authentication failed/i
  );
  await assert.rejects(
    () => classifyPost("Post", JEV_CONTEXT, {
      fetchImpl: async () => new Response("", { status: 429, headers: { "Retry-After": "30 seconds" } })
    }),
    /retry after 30 seconds/i
  );
});

test("Jev requests time out cleanly", async () => {
  const timeoutContext = { ...JEV_CONTEXT, timeoutMs: 5 };
  const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    }, { once: true });
  });
  await assert.rejects(
    () => classifyPost("Post", timeoutContext, { fetchImpl }),
    /timed out/i
  );
});
