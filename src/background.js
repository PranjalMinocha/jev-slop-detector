import {
  classifyPost,
  getClassifierCacheNamespace,
  getClassifierContext
} from "./classifier.js";

const LOG_PREFIX = "[Jev Slop Detector]";
const CACHE_STORAGE_KEY = "jevSlopCacheV2";
const MAX_CACHE_ENTRIES = 500;
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const cache = new Map();
const inFlight = new Map();
let persistQueue = Promise.resolve();

const storageReady = restrictStorageAccess();
const cacheReady = storageReady.then(loadCache);

chrome.runtime.onInstalled.addListener(() => {
  console.info(LOG_PREFIX, "Installed. Jev is used when a key is configured; mock mode is the fallback.");
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "JEV_CLASSIFY_POST") {
    return false;
  }

  handleClassification(message.payload, sender)
    .then((response) => sendResponse({ ok: true, ...response }))
    .catch((error) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn(LOG_PREFIX, "Classification failed:", errorMessage);
      sendResponse({ ok: false, error: errorMessage });
    });

  return true;
});

async function handleClassification(payload, sender) {
  if (!sender.tab?.url?.startsWith("https://www.linkedin.com/")) {
    throw new Error("Rejected classification request from an unsupported page.");
  }

  const text = typeof payload?.text === "string" ? payload.text.trim() : "";
  const cacheKey = typeof payload?.cacheKey === "string" ? payload.cacheKey : "";
  if (!text || !cacheKey || text.length > 12000 || cacheKey.length > 300) {
    throw new Error("Invalid classification request.");
  }

  await cacheReady;
  const context = await getClassifierContext();
  const namespacedCacheKey = `${getClassifierCacheNamespace(context)}|${cacheKey}`;
  const cachedEntry = cache.get(namespacedCacheKey);
  if (cachedEntry && Date.now() - cachedEntry.cachedAt < CACHE_MAX_AGE_MS) {
    return { result: cachedEntry.result, cached: true, source: context.mode };
  }

  if (inFlight.has(namespacedCacheKey)) {
    return { result: await inFlight.get(namespacedCacheKey), cached: true, source: context.mode };
  }

  const classification = classifyAndCache(namespacedCacheKey, text, context);
  inFlight.set(namespacedCacheKey, classification);
  try {
    return { result: await classification, cached: false, source: context.mode };
  } finally {
    inFlight.delete(namespacedCacheKey);
  }
}

async function classifyAndCache(cacheKey, text, context) {
  const result = await classifyPost(text, context);
  cache.set(cacheKey, { result, cachedAt: Date.now() });
  trimCache();
  await persistCache();
  return result;
}

async function restrictStorageAccess() {
  try {
    if (typeof chrome.storage.local.setAccessLevel === "function") {
      await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    }
  } catch (error) {
    console.warn(LOG_PREFIX, "Could not restrict storage access to extension contexts:", error);
  }
}

async function loadCache() {
  try {
    const stored = await chrome.storage.local.get(CACHE_STORAGE_KEY);
    const entries = stored[CACHE_STORAGE_KEY] || {};
    const now = Date.now();
    for (const [key, entry] of Object.entries(entries)) {
      if (entry?.result && now - entry.cachedAt < CACHE_MAX_AGE_MS) {
        cache.set(key, entry);
      }
    }
    trimCache();
    console.debug(LOG_PREFIX, `Loaded ${cache.size} cached classifications.`);
  } catch (error) {
    console.warn(LOG_PREFIX, "Could not load cache:", error);
  }
}

function trimCache() {
  if (cache.size <= MAX_CACHE_ENTRIES) return;
  const oldestFirst = Array.from(cache.entries()).sort(
    ([, left], [, right]) => left.cachedAt - right.cachedAt
  );
  for (const [key] of oldestFirst.slice(0, cache.size - MAX_CACHE_ENTRIES)) {
    cache.delete(key);
  }
}

function persistCache() {
  persistQueue = persistQueue
    .catch(() => undefined)
    .then(() => chrome.storage.local.set({
      [CACHE_STORAGE_KEY]: Object.fromEntries(cache)
    }));
  return persistQueue;
}
