# Jev Slop Detector

Jev Slop Detector is a Chrome Manifest V3 extension that adds an experimental
"SLOP" score to visible LinkedIn feed posts. It is an opinionated signal, not a
claim that a post was written by AI.

The MVP now uses TypeSafe's Jev System One API when a local API key is
configured. With no key, it falls back to deterministic mock scoring so the
extension remains testable without network access. Jev scores writing traits;
the result is not a claim about who authored a post.

## Load the extension

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** in the top-right corner.
3. Click **Load unpacked**.
4. Select this project directory (the directory containing `manifest.json`).
5. Open or refresh `https://www.linkedin.com/feed/`.
6. Scroll the feed. Low and medium scores receive a compact result chip near
   the post text. Scores of 70 or higher are covered by a full-card
   `AI SLOP (score)` warning with the reason and a **Show post anyway** action.
   Revealed posts retain a compact warning that can hide the post again. All
   overlays scroll naturally with their cards and stay outside LinkedIn's
   React-owned DOM.

Click the extension's toolbar button to open live diagnostics. It reports
whether the content script is connected, how many current feed posts were
recognized, and how many were classified, skipped, or errored. Expand an item
under **Extracted text** to inspect exactly what the classifier received.

To inspect logs, open DevTools on LinkedIn for content-script logs. On
`chrome://extensions`, click **service worker** under this extension for
background/cache logs.

## How it works

- `src/linkedin-dom.js` contains all LinkedIn-specific selectors and DOM
  extraction behavior.
- `src/content.js` discovers dynamically inserted posts, observes visibility,
  extracts text, requests classification, and positions badges in an
  extension-owned, document-positioned card overlay. It never inserts UI into
  LinkedIn's React tree.
- `src/background.js` validates requests, coalesces concurrent requests, and
  keeps up to 500 classifications in `chrome.storage.local` for 30 days. It is
  the only extension component that can read the saved Jev key or call Jev.
- `src/classifier.js` exposes `classifyPost(text)`, implements the official Jev
  request/response mapping, and retains the deterministic mock fallback.
- `src/styles.css` contains the isolated badge and tooltip styles.

Image-only, empty, and extremely short posts are skipped without an API call.
Post URNs are preferred as cache keys; when none is available, the content
script uses a deterministic FNV-1a hash plus text length.

For collapsed posts, the adapter reads LinkedIn's complete `textContent` from
the `expandable-text-box`; the user does not need to click **more** first.

## Configure Jev

The integration follows the current [official TypeSafe OpenAPI
contract](https://api.typesafe.ai/openapi.json):

- Endpoint: `POST https://api.typesafe.ai/v1/systemone`
- Authentication: `Authorization: Bearer <API_KEY>`
- Model: `jev-latest`
- Content type: `application/json`

To enter the key for this local MVP:

1. Reload the unpacked extension after updating the project.
2. Open LinkedIn and click the **Jev Slop Detector** toolbar icon.
3. Under **Jev API**, paste the key into **TypeSafe API key**.
4. Click **Save key and enable Jev**.
5. Refresh the LinkedIn tab. The popup will report `Jev scoring` after the next
   visible post is classified.

The key is stored as `jevSettings.authToken` in `chrome.storage.local`.
Storage access is restricted to trusted extension pages and the background
service worker, so the content script cannot read it. **Remove key and use
mock** deletes the saved token and restores the fallback.

### Jev request

For each post, `state` contains only the normalized extracted post text. The
questions are fixed application configuration:

```json
{
  "model": "jev-latest",
  "state": "<extracted LinkedIn post text>",
  "questions": {
    "slop_score": {
      "type": "score",
      "instructions": "Rate the overall AI-slop-like writing style of this LinkedIn post. Consider AI-like or reusable template wording, generic phrasing, engagement bait, low information density, excessive hype, repetition, and formulaic LinkedIn storytelling. Judge writing traits only; do not claim or infer who authored it.",
      "criteria": [
        "No slop signals: specific, concrete, original, and information-dense writing.",
        "Minimal slop signals: mostly substantive writing with only faint generic or formulaic phrasing.",
        "Mild slop signals: some generic, templated, hype-driven, or low-information wording.",
        "Moderate slop signals: several clear patterns of engagement bait, hype, repetition, or formulaic LinkedIn writing.",
        "Strong slop signals: predominantly generic, AI-like, templated, engagement-driven, or low-information writing.",
        "Overwhelming slop signals: highly formulaic, repetitive, hype-heavy, engagement-baiting writing with little concrete information."
      ]
    },
    "dominant_signal": {
      "type": "choice",
      "instructions": "Which single signal best explains the post's slop rating? Choose none when no meaningful slop signal is present.",
      "criteria": {
        "none": "The post is specific, original, and information-dense with no meaningful slop signal.",
        "ai_like_template": "The wording resembles generic AI-assisted or reusable template prose; do not infer authorship.",
        "generic_phrasing": "The post relies mainly on broad abstractions, clichés, or interchangeable generic claims.",
        "engagement_bait": "The post prioritizes likes, comments, agreement, suspense, or repost prompts over substance.",
        "low_information_density": "The post uses many words or repeated ideas to communicate little concrete information.",
        "hype": "The post makes inflated, superlative, or transformative claims without concrete support.",
        "formulaic_linkedin": "The post follows familiar LinkedIn storytelling, announcement, lesson, or motivational formulas."
      }
    }
  }
}
```

Jev returns a decimal expected score on rubric levels `0` through `5`. The
extension maps it to the displayed integer with
`Math.round((answer.score / 5) * 100)`. The `dominant_signal.choice` value maps
to a fixed, short local explanation because Jev returns typed decisions rather
than generated prose.

Authentication failures, exhausted credit, rate limits, timeouts, validation
errors, server failures, non-JSON bodies, and malformed typed answers produce a
clear error badge and are never cached as successful classifications.

Do not ship a reusable Jev secret inside a Chrome extension. Users can inspect
the extension package, its storage, and its network traffic. A production build
should call a backend proxy you control; that proxy should hold the Jev secret,
authenticate/rate-limit extension users, validate request sizes, and return only
the normalized `{ slop_score, short_reason }` result. If Jev supports safe
short-lived, user-specific tokens, those may be another option.

## Development checks

Node.js is only needed for checks, not to run the extension:

```bash
npm run check
npm test
```

## Known limitations

- LinkedIn's DOM is private and changes frequently. When detection breaks,
  update only `src/linkedin-dom.js` and reload the extension.
- Jev and mock scores are writing-style judgments, not reliable authorship
  classifiers. Mock results are cached separately from real Jev results.
- The MVP classifies the complete text LinkedIn keeps in its expandable text
  node, including content visually collapsed behind **more**. Text available
  only inside images, video, documents, and comments is not included.
- LinkedIn may recycle or replace feed DOM nodes. The persistent cache prevents
  repeat classification, while a replacement card can receive a fresh badge.
- Cached results are local to one Chrome profile and are capped at 500 entries.

## Privacy

In mock mode, post text is processed locally in the service worker and is not
stored; only the cache key, numeric score, short reason, and timestamp persist.
With Jev enabled, each visible post's normalized text is sent to
`api.typesafe.ai`; the post text itself is still not persisted by this
extension. Update user-facing privacy disclosures before distributing it.
