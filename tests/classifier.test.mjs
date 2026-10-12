import test from "node:test";
import assert from "node:assert/strict";
import { classifyPost, JEV_CONFIG } from "../src/classifier.js";

const MOCK_CONTEXT = Object.freeze({ mode: "mock" });

test("real Jev mode is the configured default", () => {
  assert.equal(JEV_CONFIG.MOCK_MODE, false);
  assert.equal(JEV_CONFIG.API_URL, "https://api.typesafe.ai/v1/systemone");
  assert.equal(JEV_CONFIG.MODEL, "jev-latest");
});

test("mock classifications are valid and deterministic", async () => {
  const text = "We reduced request latency by 37% in 2026 after profiling three database queries.";
  const first = await classifyPost(text, MOCK_CONTEXT);
  const second = await classifyPost(text, MOCK_CONTEXT);

  assert.deepEqual(first, second);
  assert.ok(Number.isInteger(first.slop_score));
  assert.ok(first.slop_score >= 0 && first.slop_score <= 100);
  assert.ok(first.short_reason.length > 0);
  assert.ok(first.short_reason.trim().split(/\s+/).length < 15);
});

test("obvious engagement bait scores higher than concrete writing", async () => {
  const concrete = await classifyPost(
    "We reduced request latency by 37% in 2026 after profiling three database queries.",
    MOCK_CONTEXT
  );
  const bait = await classifyPost(
    "Here's the truth. This groundbreaking game-changer will unlock your potential. Agree? Comment below. Repost if this resonates.",
    MOCK_CONTEXT
  );

  assert.ok(bait.slop_score > concrete.slop_score, `${bait.slop_score} should exceed ${concrete.slop_score}`);
});

test("empty posts are rejected", async () => {
  await assert.rejects(() => classifyPost("   ", MOCK_CONTEXT), /empty post/i);
});
