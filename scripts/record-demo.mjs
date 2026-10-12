import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const debugPort = process.env.BRAVE_DEBUG_PORT || "9231";
const durationSeconds = 15;
const targetFrameRate = 60;
const targetFrameCount = durationSeconds * targetFrameRate;
const outputPath = resolve("demo/jev-slop-detector-linkedin-demo.webm");
const frameDirectory = mkdtempSync(join(tmpdir(), "jev-demo-frames-"));
const targetsUrl = `http://127.0.0.1:${debugPort}/json/list`;
const targets = await fetch(targetsUrl).then((response) => response.json());
const page = targets.find(
  (target) => target.type === "page" && target.url.startsWith("https://www.linkedin.com/feed")
);

assert.ok(page?.webSocketDebuggerUrl, "The authenticated LinkedIn feed tab was not found.");
await fetch(`http://127.0.0.1:${debugPort}/json/activate/${page.id}`);

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolveOpen, rejectOpen) => {
  socket.addEventListener("open", resolveOpen, { once: true });
  socket.addEventListener("error", rejectOpen, { once: true });
});

let nextId = 1;
let frameCount = 0;
const pending = new Map();

socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (!message.id || !pending.has(message.id)) return;
  const { resolve: resolvePending, reject: rejectPending } = pending.get(message.id);
  pending.delete(message.id);
  message.error
    ? rejectPending(new Error(message.error.message))
    : resolvePending(message.result);
});

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolveSend, rejectSend) => {
    pending.set(id, { resolve: resolveSend, reject: rejectSend });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression, awaitPromise = true) {
  const response = await send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true
  });
  if (response.exceptionDetails) {
    const details = response.exceptionDetails.exception?.description
      || response.exceptionDetails.text
      || "Evaluation failed.";
    throw new Error(details);
  }
  return response.result.value;
}

try {
  await send("Page.enable");
  await send("Runtime.enable");

  const warmup = await evaluate(`(async () => {
    const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const candidates = [document.scrollingElement, ...document.querySelectorAll("*")]
      .filter((element, index, items) => element && items.indexOf(element) === index)
      .filter((element) => element === document.scrollingElement
        || /^(auto|scroll)$/.test(getComputedStyle(element).overflowY))
      .filter((element) => element.scrollHeight - element.clientHeight > 100)
      .sort((left, right) =>
        (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight)
      );
    const scrollRoot = candidates[0] || document.scrollingElement;
    scrollRoot.scrollTo({ top: 0, behavior: "instant" });
    await delay(700);
    const highPosts = new Map();
    let loadMoreClicks = 0;

    function collectVisibleHighPosts() {
      const maxScrollTop = scrollRoot.scrollHeight - scrollRoot.clientHeight;
      for (const blocker of document.querySelectorAll(
        ".jev-slop-badge-wrap[data-level='high']:not([hidden])"
      )) {
        const key = blocker.dataset.jevPostKey;
        if (!key || highPosts.has(key)) continue;
        const rect = blocker.getBoundingClientRect();
        const idealOffset = Math.max(0, Math.min(
          maxScrollTop,
          scrollRoot.scrollTop + rect.top - 90
        ));
        highPosts.set(key, {
          key,
          offset: Math.round(idealOffset),
          label: blocker.querySelector(".jev-slop-badge")?.textContent?.trim() || "AI SLOP"
        });
      }
    }

    let scanStart = 0;
    for (let attempt = 0; attempt < 8 && highPosts.size < 3; attempt += 1) {
      const maxScrollTop = scrollRoot.scrollHeight - scrollRoot.clientHeight;
      for (let offset = scanStart; offset <= maxScrollTop; offset += 700) {
        scrollRoot.scrollTop = offset;
        await delay(750);
        collectVisibleHighPosts();
      }
      scrollRoot.scrollTop = maxScrollTop;
      await delay(900);
      collectVisibleHighPosts();
      if (highPosts.size >= 3) break;

      const previousMaxScrollTop = maxScrollTop;
      scrollRoot.scrollTo({ top: scrollRoot.scrollHeight, behavior: "smooth" });
      await delay(1200);
      const loadMore = Array.from(document.querySelectorAll("button, [role='button']"))
        .find((element) => element.textContent?.trim().toLowerCase() === "load more");
      if (loadMore) {
        loadMore.click();
        loadMoreClicks += 1;
        await delay(2400);
        scanStart = Math.max(0, previousMaxScrollTop - 700);
      } else {
        break;
      }
    }

    const highPostList = Array.from(highPosts.values()).sort((left, right) => left.offset - right.offset);
    let selectedHighPosts = highPostList;
    if (highPostList.length > 3) {
      selectedHighPosts = [
        highPostList[0],
        highPostList[Math.floor((highPostList.length - 1) / 2)],
        highPostList[highPostList.length - 1]
      ];
    }

    const maxScrollTop = scrollRoot.scrollHeight - scrollRoot.clientHeight;
    const selectedOffsets = selectedHighPosts.slice(0, 3).map((post) => post.offset);
    const firstOffset = selectedOffsets[0] || 0;
    const lastOffset = selectedOffsets[selectedOffsets.length - 1] || Math.min(5000, maxScrollTop);
    const clampOffset = (offset) => Math.max(0, Math.min(maxScrollTop, Math.round(offset)));
    const demoStops = [
      clampOffset(firstOffset - 500),
      clampOffset(selectedOffsets[0] || firstOffset),
      clampOffset((selectedOffsets[0] || firstOffset) + 70),
      clampOffset(selectedOffsets[1] || lastOffset),
      clampOffset((selectedOffsets[1] || lastOffset) + 70),
      clampOffset(selectedOffsets[2] || lastOffset),
      clampOffset((selectedOffsets[2] || lastOffset) + 70),
      clampOffset(lastOffset + 600)
    ];

    scrollRoot.scrollTop = demoStops[0];
    await delay(1200);
    globalThis.__jevDemoScrollRoot = scrollRoot;
    globalThis.__jevDemoStops = demoStops;
    return {
      badges: document.querySelectorAll(".jev-slop-badge-wrap").length,
      visibleBadges: document.querySelectorAll(".jev-slop-badge-wrap:not([hidden])").length,
      highPostsFound: highPostList.length,
      selectedHighPosts: selectedHighPosts.slice(0, 3),
      demoStops,
      loadMoreClicks,
      scrollRoot: {
        tag: scrollRoot.tagName,
        id: scrollRoot.id,
        className: typeof scrollRoot.className === "string" ? scrollRoot.className : "",
        scrollHeight: scrollRoot.scrollHeight,
        clientHeight: scrollRoot.clientHeight,
        scrollTop: scrollRoot.scrollTop
      },
      viewport: {
        innerWidth,
        innerHeight,
        devicePixelRatio
      }
    };
  })()`);

  assert.ok(
    warmup.highPostsFound >= 3,
    `The feed only produced ${warmup.highPostsFound} distinct AI SLOP post(s); refusing to record a weak demo.`
  );

  for (let frameIndex = 0; frameIndex < targetFrameCount; frameIndex += 1) {
    const timeProgress = frameIndex / (targetFrameCount - 1);
    const segmentPosition = timeProgress * 7;
    const segmentIndex = Math.min(6, Math.floor(segmentPosition));
    const segmentProgress = segmentPosition - segmentIndex;
    const easedProgress = segmentProgress * segmentProgress * (3 - 2 * segmentProgress);
    await evaluate(`new Promise((resolve) => {
      const scrollRoot = globalThis.__jevDemoScrollRoot;
      const stops = globalThis.__jevDemoStops;
      const start = stops[${segmentIndex}];
      const end = stops[${segmentIndex + 1}];
      scrollRoot.scrollTop = start + (end - start) * ${easedProgress};
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(scrollRoot.scrollTop)));
    })`);
    const screenshot = await send("Page.captureScreenshot", {
      format: "jpeg",
      quality: 82,
      fromSurface: true,
      captureBeyondViewport: false,
      optimizeForSpeed: true
    });
    const filename = `frame-${String(frameCount).padStart(5, "0")}.jpg`;
    writeFileSync(join(frameDirectory, filename), Buffer.from(screenshot.data, "base64"));
    frameCount += 1;
  }
  assert.equal(frameCount, targetFrameCount, "The deterministic demo frame count changed.");

  mkdirSync(resolve("demo"), { recursive: true });
  const frameRate = `${targetFrameRate}/1`;
  execFileSync("gst-launch-1.0", [
    "-q",
    "multifilesrc",
    `location=${join(frameDirectory, "frame-%05d.jpg")}`,
    "index=0",
    `stop-index=${frameCount - 1}`,
    `caps=image/jpeg,framerate=${frameRate}`,
    "!",
    "jpegdec",
    "!",
    "videoconvert",
    "!",
    "vp8enc",
    "deadline=1",
    "cpu-used=8",
    "target-bitrate=5000000",
    "keyframe-max-dist=120",
    "!",
    "webmmux",
    "!",
    "filesink",
    `location=${outputPath}`
  ], { stdio: "inherit" });

  console.log(JSON.stringify({
    outputPath,
    durationSeconds,
    frameRate: targetFrameRate,
    frameCount,
    warmup
  }, null, 2));
} finally {
  socket.close();
  rmSync(frameDirectory, { recursive: true, force: true });
}
