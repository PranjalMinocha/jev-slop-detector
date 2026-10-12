/**
 * Classification boundary for Jev.
 *
 * This module only runs in the extension service worker. Never move secret
 * credentials into a content script or page-injected script.
 */

export const JEV_CONFIG = Object.freeze({
  MOCK_MODE: false,
  API_URL: "https://api.typesafe.ai/v1/systemone",
  MODEL: "jev-latest",
  TIMEOUT_MS: 12000
});

const SCORE_CRITERIA = Object.freeze([
  "No slop signals: specific, concrete, original, and information-dense writing.",
  "Minimal slop signals: mostly substantive writing with only faint generic or formulaic phrasing.",
  "Mild slop signals: some generic, templated, hype-driven, or low-information wording.",
  "Moderate slop signals: several clear patterns of engagement bait, hype, repetition, or formulaic LinkedIn writing.",
  "Strong slop signals: predominantly generic, AI-like, templated, engagement-driven, or low-information writing.",
  "Overwhelming slop signals: highly formulaic, repetitive, hype-heavy, engagement-baiting writing with little concrete information."
]);

const DOMINANT_SIGNAL_CRITERIA = Object.freeze({
  none: "The post is specific, original, and information-dense with no meaningful slop signal.",
  ai_like_template: "The wording resembles generic AI-assisted or reusable template prose; do not infer authorship.",
  generic_phrasing: "The post relies mainly on broad abstractions, clichés, or interchangeable generic claims.",
  engagement_bait: "The post prioritizes likes, comments, agreement, suspense, or repost prompts over substance.",
  low_information_density: "The post uses many words or repeated ideas to communicate little concrete information.",
  hype: "The post makes inflated, superlative, or transformative claims without concrete support.",
  formulaic_linkedin: "The post follows familiar LinkedIn storytelling, announcement, lesson, or motivational formulas."
});

const SIGNAL_REASONS = Object.freeze({
  ai_like_template: "Templated, AI-like wording makes the post feel interchangeable.",
  generic_phrasing: "Generic phrasing communicates little beyond familiar abstractions.",
  engagement_bait: "Engagement prompts outweigh the post's substantive content.",
  low_information_density: "Low information density stretches limited substance across many words.",
  hype: "Hype-heavy language makes claims without concrete support.",
  formulaic_linkedin: "Formulaic LinkedIn storytelling relies on familiar motivational beats."
});

const PHRASE_GROUPS = Object.freeze({
  engagement: [
    /\bagree\??\b/i,
    /\bthoughts\??\b/i,
    /\bcomment below\b/i,
    /\blet me know in the comments\b/i,
    /\blike and (?:share|repost)\b/i,
    /\brepost (?:this )?if\b/i,
    /\bfollow me for more\b/i,
    /\bwhat would you add\b/i
  ],
  templated: [
    /\bin today'?s (?:fast-paced|rapidly evolving)\b/i,
    /\bhere'?s the (?:truth|thing|reality)\b/i,
    /\blet that sink in\b/i,
    /\bread that again\b/i,
    /\bit'?s not (?:about|just) .{0,60}it'?s (?:about|also)\b/i,
    /\bi'?m (?:thrilled|excited|humbled) to (?:announce|share)\b/i,
    /\bthe future of .{2,50} is here\b/i,
    /\bthis is your reminder\b/i
  ],
  hype: [
    /\bgame[- ]changer\b/i,
    /\bgroundbreaking\b/i,
    /\brevolutionary\b/i,
    /\btransformative\b/i,
    /\bunprecedented\b/i,
    /\bunlock(?:ing)? (?:the )?(?:power|potential|future)\b/i,
    /\bsupercharge\b/i,
    /\b10x\b/i
  ],
  aiStyle: [
    /\bdelve\b/i,
    /\btapestry\b/i,
    /\bnuanced\b/i,
    /\blandscape\b/i,
    /\bparadigm shift\b/i,
    /\bleverage\b/i,
    /\bfoster(?:ing)?\b/i,
    /\bembark on\b/i,
    /\bin conclusion\b/i
  ]
});

export async function getClassifierContext(storageArea = chrome.storage.local) {
  const { jevSettings = {} } = await storageArea.get("jevSettings");
  const authToken = typeof jevSettings.authToken === "string" ? jevSettings.authToken.trim() : "";
  const useMock = JEV_CONFIG.MOCK_MODE || jevSettings.mockMode === true || !authToken;
  return Object.freeze({
    mode: useMock ? "mock" : "jev",
    authToken,
    apiUrl: JEV_CONFIG.API_URL,
    model: JEV_CONFIG.MODEL,
    timeoutMs: JEV_CONFIG.TIMEOUT_MS
  });
}

export function getClassifierCacheNamespace(context) {
  return context.mode === "jev"
    ? `jev-v1:${context.model}`
    : "mock-v1";
}

export async function classifyPost(text, context, dependencies = {}) {
  const normalizedText = normalizeInput(text);
  if (!normalizedText) {
    throw new Error("Cannot classify an empty post.");
  }

  const activeContext = context || await getClassifierContext();
  if (activeContext.mode === "mock") {
    // Small delay makes the mock exercise the real asynchronous UI path.
    await new Promise((resolve) => setTimeout(resolve, 90 + (stableHash(normalizedText) % 170)));
    return classifyWithMock(normalizedText);
  }

  return classifyWithJev(normalizedText, activeContext, dependencies.fetchImpl || fetch);
}

function normalizeInput(text) {
  if (typeof text !== "string") return "";
  return text.replace(/\s+/g, " ").trim().slice(0, 12000);
}

function classifyWithMock(text) {
  const words = text.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) || [];
  const uniqueRatio = words.length ? new Set(words).size / words.length : 1;
  const lineLikeBreaks = (text.match(/[.!?](?:\s|$)/g) || []).length;
  const hashtags = (text.match(/#[\p{L}\p{N}_]+/gu) || []).length;
  const emojis = (text.match(/\p{Extended_Pictographic}/gu) || []).length;

  const hits = Object.fromEntries(
    Object.entries(PHRASE_GROUPS).map(([group, patterns]) => [
      group,
      patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0)
    ])
  );

  let score = 10;
  score += Math.min(28, hits.engagement * 13);
  score += Math.min(28, hits.templated * 14);
  score += Math.min(20, hits.hype * 8);
  score += Math.min(18, hits.aiStyle * 6);
  score += Math.min(10, hashtags * 2);
  score += Math.min(9, emojis * 1.5);

  if (words.length >= 35 && uniqueRatio < 0.58) score += 16;
  else if (words.length >= 25 && uniqueRatio < 0.68) score += 8;

  if (words.length > 25 && lineLikeBreaks > words.length / 8) score += 9;
  if (/\b(?:1|2|3|4|5|one|two|three) (?:things|lessons|truths|rules|tips)\b/i.test(text)) score += 8;

  // Concrete details usually raise information density.
  const concreteSignals = (text.match(/\b(?:\d+(?:\.\d+)?%?|20\d{2}|https?:\/\/\S+|\$\d+)\b/g) || []).length;
  score -= Math.min(14, concreteSignals * 3);
  if (words.length >= 80 && uniqueRatio > 0.72) score -= 7;

  // Stable jitter prevents all ordinary posts from clustering on one number.
  score += (stableHash(text) % 11) - 5;
  const slopScore = Math.max(0, Math.min(100, Math.round(score)));

  return {
    slop_score: slopScore,
    short_reason: chooseReason(slopScore, hits, uniqueRatio, concreteSignals)
  };
}

function chooseReason(score, hits, uniqueRatio, concreteSignals) {
  if (hits.engagement >= 2) return "Generic engagement bait dominates the post.";
  if (hits.templated >= 1 && hits.hype >= 1) return "Templated framing combines with vague, inflated claims.";
  if (hits.templated >= 1) return "The phrasing follows a familiar, low-information template.";
  if (hits.hype >= 2) return "Heavy hype language adds little concrete information.";
  if (hits.aiStyle >= 2) return "Repeated AI-style wording makes the prose feel formulaic.";
  if (uniqueRatio < 0.58) return "Repetitive wording lowers the post's information density.";
  if (score >= 55) return "Several mild generic-writing signals appear together.";
  if (concreteSignals >= 2) return "Concrete details outweigh the post's generic phrasing.";
  if (score < 25) return "Specific wording shows few common slop signals.";
  return "Mostly ordinary phrasing with a few generic signals.";
}

function stableHash(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function buildJevRequest(text, model = JEV_CONFIG.MODEL) {
  return {
    model,
    state: text,
    questions: {
      slop_score: {
        type: "score",
        instructions: "Rate the overall AI-slop-like writing style of this LinkedIn post. Consider AI-like or reusable template wording, generic phrasing, engagement bait, low information density, excessive hype, repetition, and formulaic LinkedIn storytelling. Judge writing traits only; do not claim or infer who authored it.",
        criteria: [...SCORE_CRITERIA]
      },
      dominant_signal: {
        type: "choice",
        instructions: "Which single signal best explains the post's slop rating? Choose none when no meaningful slop signal is present.",
        criteria: { ...DOMINANT_SIGNAL_CRITERIA }
      }
    }
  };
}

export function mapJevResponse(data) {
  if (!data || typeof data !== "object" || typeof data.model !== "string") {
    throw new Error("Jev returned a malformed response.");
  }
  if (
    !data.usage
    || !Number.isInteger(data.usage.input_tokens)
    || !Number.isInteger(data.usage.output_tokens)
  ) {
    throw new Error("Jev returned malformed usage data.");
  }

  const scoreAnswer = data.answers?.slop_score;
  const signalAnswer = data.answers?.dominant_signal;
  const maxTier = SCORE_CRITERIA.length - 1;
  if (
    scoreAnswer?.type !== "score"
    || !Number.isFinite(scoreAnswer.score)
    || scoreAnswer.score < 0
    || scoreAnswer.score > maxTier
    || !isProbability(scoreAnswer.confidence)
    || !isRecord(scoreAnswer.legend)
    || !isRecord(scoreAnswer.probabilities)
  ) {
    throw new Error("Jev returned a malformed slop score answer.");
  }
  if (
    signalAnswer?.type !== "choice"
    || !Object.hasOwn(DOMINANT_SIGNAL_CRITERIA, signalAnswer.choice)
    || !isProbability(signalAnswer.confidence)
    || !isRecord(signalAnswer.probabilities)
  ) {
    throw new Error("Jev returned a malformed dominant signal answer.");
  }

  const slopScore = Math.round((scoreAnswer.score / maxTier) * 100);
  return {
    slop_score: slopScore,
    short_reason: chooseJevReason(slopScore, signalAnswer.choice)
  };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isProbability(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function chooseJevReason(score, signal) {
  if (signal !== "none") return SIGNAL_REASONS[signal];
  if (score >= 70) return "Multiple strong slop signals appear throughout the post.";
  if (score >= 35) return "Several mild generic-writing signals appear together.";
  return "Specific, information-dense writing shows few slop signals.";
}

async function classifyWithJev(text, context, fetchImpl) {
  if (!context.authToken) {
    throw new Error("Jev API key is missing. Add it in the extension popup.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), context.timeoutMs);
  let response;
  try {
    response = await fetchImpl(context.apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${context.authToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(buildJevRequest(text, context.model)),
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError" || controller.signal.aborted) {
      throw new Error(`Jev request timed out after ${Math.round(context.timeoutMs / 1000)} seconds.`);
    }
    throw new Error("Could not reach the Jev API. Check your connection and try again.");
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw createHttpError(response);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("Jev returned a non-JSON response.");
  }
  return mapJevResponse(data);
}

function createHttpError(response) {
  if (response.status === 401 || response.status === 403) {
    return new Error("Jev authentication failed. Update the API key in the extension popup.");
  }
  if (response.status === 402) {
    return new Error("The Jev account has insufficient credit.");
  }
  if (response.status === 429) {
    const retryAfter = response.headers.get("Retry-After");
    return new Error(retryAfter
      ? `Jev rate limit reached. Retry after ${retryAfter}.`
      : "Jev rate limit reached. Try again shortly.");
  }
  if (response.status === 422) {
    return new Error("Jev rejected the classification request as invalid.");
  }
  if (response.status >= 500) {
    return new Error(`Jev is temporarily unavailable (HTTP ${response.status}).`);
  }
  return new Error(`Jev request failed with HTTP ${response.status}.`);
}
