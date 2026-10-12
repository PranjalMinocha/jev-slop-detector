import assert from "node:assert/strict";

const debugPort = process.env.BRAVE_DEBUG_PORT || "9231";
const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
const page = targets.find(
  (target) => target.type === "page" && target.url.startsWith("https://www.linkedin.com/")
);

assert.ok(page?.webSocketDebuggerUrl, "The LinkedIn test tab was not found.");
await fetch(`http://127.0.0.1:${debugPort}/json/activate/${page.id}`);

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let nextId = 1;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (!message.id || !pending.has(message.id)) return;
  const { resolve, reject } = pending.get(message.id);
  pending.delete(message.id);
  message.error ? reject(new Error(message.error.message)) : resolve(message.result);
});

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

try {
  await send("Runtime.enable");
  const evaluated = await send("Runtime.evaluate", {
    expression: `(async () => {
      const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
      const nextLayout = () => new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      );
      const candidates = [document.scrollingElement, ...document.querySelectorAll("*")]
        .filter((element, index, items) => element && items.indexOf(element) === index)
        .filter((element) => element === document.scrollingElement
          || /^(auto|scroll)$/.test(getComputedStyle(element).overflowY))
        .filter((element) => element.scrollHeight - element.clientHeight > 100)
        .sort((left, right) =>
          (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight)
        );
      const scrollRoot = candidates[0] || document.scrollingElement;
      const maxSearch = Math.min(9000, scrollRoot.scrollHeight - scrollRoot.clientHeight);
      let blocker = null;

      scrollRoot.scrollTop = 0;
      await nextLayout();
      await delay(1500);

      for (let offset = 0; offset <= maxSearch; offset += 350) {
        scrollRoot.scrollTop = offset;
        await nextLayout();
        await delay(350);
        blocker = Array.from(document.querySelectorAll(
          ".jev-slop-badge-wrap:not([hidden])"
        ))[0];
        if (blocker) break;
      }

      if (!blocker) {
        return {
          found: false,
          root: scrollRoot.tagName + (scrollRoot.id ? "#" + scrollRoot.id : ""),
          maxSearch
        };
      }

      const beforeTop = blocker.getBoundingClientRect().top;
      const beforeScrollTop = scrollRoot.scrollTop;
      const requestedDelta = Math.min(180, scrollRoot.scrollHeight - scrollRoot.clientHeight - beforeScrollTop);
      scrollRoot.scrollTop = beforeScrollTop + requestedDelta;
      await nextLayout();
      await delay(120);
      const afterTop = blocker.getBoundingClientRect().top;
      const appliedDelta = scrollRoot.scrollTop - beforeScrollTop;
      const hiddenAfterAlignmentScroll = blocker.hidden;
      const offscreenDelta = Math.min(
        blocker.getBoundingClientRect().height + innerHeight,
        scrollRoot.scrollHeight - scrollRoot.clientHeight - scrollRoot.scrollTop
      );
      scrollRoot.scrollTop += offscreenDelta;
      await nextLayout();
      await delay(120);

      return {
        found: true,
        level: blocker.dataset.level,
        root: scrollRoot.tagName + (scrollRoot.id ? "#" + scrollRoot.id : ""),
        beforeTop,
        afterTop,
        appliedDelta,
        overlayDelta: afterTop - beforeTop,
        alignmentError: Math.abs((afterTop - beforeTop) + appliedDelta),
        hiddenAfterAlignmentScroll,
        offscreenDelta,
        hiddenWhenOffscreen: blocker.hidden
      };
    })()`,
    awaitPromise: true,
    returnByValue: true
  });

  if (evaluated.exceptionDetails) {
    throw new Error(evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text);
  }
  const result = evaluated.result.value;
  assert.equal(result.found, true, "No visible score overlay was available for the live test.");
  assert.ok(result.appliedDelta > 0, "The nested LinkedIn scroller did not move.");
  assert.ok(
    result.alignmentError <= 3,
    `The blocker detached from its post by ${result.alignmentError}px during nested scrolling.`
  );
  assert.equal(result.hiddenWhenOffscreen, true, "The overlay remained visible after its post left the viewport.");
  console.log(JSON.stringify(result, null, 2));
} finally {
  socket.close();
}
