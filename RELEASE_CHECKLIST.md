# FullSnap v1.0.0 — Chrome Web Store Release Checklist

**Extension:** FullSnap - Full Page Screenshot
**Version:** 1.0.0
**Checked:** 2026-02-23
**Status:** 🟡 NEARLY READY — 5 blocking items must be completed before submission

---

## LEGEND
- ✅ PASS — verified clean, no action needed
- 🟡 WARN — minor issue, fix recommended before submission
- ❌ BLOCK — must fix before submitting to CWS
- 📋 TODO — manual action required by you (cannot be done in code)

---

## SECTION A — Code Quality

| # | Check | Result | Notes |
|---|-------|--------|-------|
| A1 | No `debugger` statements | ✅ PASS | Zero found |
| A2 | No `eval()` / `new Function()` in extension code | ✅ PASS | Zero in extension code; jsPDF library only (expected) |
| A3 | No remote code execution | ✅ PASS | All JS self-contained in package |
| A4 | No obfuscated code | ✅ PASS | Only `lib/jspdf.umd.min.js` is minified (a legitimate bundled library) |
| A5 | Version consistent across codebase | ✅ PASS | `"version": "1.0.0"` in manifest only (not displayed in UI) |
| A6 | `console.log` in production paths | 🟡 WARN | **40 console statements** in extension code. Not a hard block but noisy for users who open DevTools. Recommend wrapping in a `DEBUG` flag for v1.1. |
| A7 | Async errors all caught | ✅ PASS | All major async paths have `try/catch`; global `window.onerror` and `unhandledrejection` handlers present in viewer.js |
| A8 | Blob URLs revoked after use | ✅ PASS | `URL.revokeObjectURL()` called in 3 places in viewer.js |

---

## SECTION B — Manifest V3 Compliance

| # | Check | Result | Notes |
|---|-------|--------|-------|
| B1 | `manifest_version: 3` | ✅ PASS | Confirmed |
| B2 | Background uses `service_worker` (not persistent page) | ✅ PASS | `"background": { "service_worker": "background/service-worker.js" }` |
| B3 | No `background.persistent: true` | ✅ PASS | Not present |
| B4 | Permissions are minimal and justified | ✅ PASS | `activeTab`, `offscreen`, `scripting`, `storage` — all actively used |
| B5 | `<all_urls>` host permission present | 🟡 WARN | **Required for the product to work** (capture any tab). But this triggers CWS manual review and may add 7–14 days to first submission. You must prepare a written justification (see Section G). |
| B6 | `web_accessible_resources` minimal | ✅ PASS | Only `content/progress-overlay.css` exposed — no JS files accessible to web pages |
| B7 | Offscreen document lifecycle managed correctly | ✅ PASS | `chrome.runtime.getContexts()` checked before `createDocument()` — prevents race condition crash |
| B8 | Keyboard commands defined correctly | ✅ PASS | `capture-full-page` and `capture-visible` with platform-specific keys |

---

## SECTION C — Security & Privacy

| # | Check | Result | Notes |
|---|-------|--------|-------|
| C1 | No data sent to external servers | ✅ PASS | All `fetch()` calls consume local `dataUrl:` blobs (not external URLs) |
| C2 | No `XMLHttpRequest` to external URLs | ✅ PASS | XHR only in jsPDF library (download trigger, never called in extension flow) |
| C3 | No `localStorage` use | ✅ PASS | All persistence via `chrome.storage.local` and IndexedDB |
| C4 | No inline event handlers in HTML (CSP) | ✅ PASS | Zero `onclick=`, `onerror=`, `onload=` attributes in HTML files |
| C5 | Capture data cleaned up after viewing | ✅ PASS | `deleteCapture()` called in viewer and on capture error (service-worker.js:290) |
| C6 | All buttons have `title` attributes (no silent icon-only buttons) | ✅ PASS | All 19 toolbar buttons have `title=` text |
| C7 | Privacy policy hosted at public URL | ❌ BLOCK | **Required.** Extension uses `storage`, `activeTab`, and `scripting`. CWS will reject without a hosted privacy policy URL. |

---

## SECTION D — Performance

| # | Check | Result | Notes |
|---|-------|--------|-------|
| D1 | Service worker startup not blocked by heavy libs | ✅ PASS | jsPDF is only loaded in `viewer.html`, not in the service worker |
| D2 | Canvas pixel limits enforced | ✅ PASS | `MAX_CANVAS_DIMENSION: 16384`, `MAX_CANVAS_AREA: 100M` — segments created for large pages |
| D3 | Capture throttle prevents rate-limit errors | ✅ PASS | 550ms minimum gap between `captureVisibleTab` calls with exponential back-off retry |
| D4 | Offscreen document reused (not recreated per capture) | ✅ PASS | `ensureOffscreenDocument()` checks `getContexts()` before creating |
| D5 | Content script double-injection prevented | ✅ PASS | `window.__fullsnap_injected` guard in capture.js |
| D6 | PDF whitespace band detection | 🟡 WARN | Still has the known "text cutting on Wikipedia" issue mentioned in brief. The band detection fix from prior session is in place — **needs one final test on a Wikipedia page to verify before submission.** |

---

## SECTION E — UX & Polish

| # | Check | Result | Notes |
|---|-------|--------|-------|
| E1 | Popup shortcut display is correct | ✅ PASS | **Fixed:** now OS-aware (`⌘⇧S` on Mac, `Ctrl+Shift+S` on Windows) |
| E2 | Viewer settings shortcuts are OS-aware | ✅ PASS | **Fixed:** `updateShortcutDisplay()` runs on init, shows platform-correct symbols |
| E3 | Click-to-zoom in viewer | ✅ PASS | **New:** click = zoom to 100% (centered on click point); click again = fit to window |
| E4 | Zoom cursor feedback | ✅ PASS | **New:** `zoom-in` cursor by default, `zoom-out` when zoomed in, `crosshair` for annotation, `grabbing` for pan |
| E5 | Dark / light theme | ✅ PASS | CSS variables cover all panels, dialogs, status bar |
| E6 | Multi-part navigation (large pages) | ✅ PASS | Part X/Y indicator, Prev/Next buttons, Arrow keys |
| E7 | Error messages shown to user | ✅ PASS | Capture failure, timeout, unsupported page (chrome://) — all produce user-visible messages |
| E8 | Description text in manifest | 🟡 WARN | Current: *"One-click full-page screenshots with annotation, PDF export, and clipboard copy. No account required. Privacy-first."* — Good but only 107 chars. CWS summary field allows 132 chars. Could add a feature like "zoom + annotate". |

---

## SECTION F — Store Listing Assets

| # | Asset | Required? | Status | Spec |
|---|-------|-----------|--------|------|
| F1 | Icon 16×16 px | ✅ Yes | ✅ Present (446B) | PNG |
| F2 | Icon 32×32 px | ✅ Yes | ✅ Present (944B) | PNG |
| F3 | Icon 48×48 px | ✅ Yes | ✅ Present (1.5KB) | PNG |
| F4 | Icon 128×128 px | ✅ Yes | ✅ Present (4.4KB) | PNG — **new icon generated, much higher quality than original** |
| F5 | Screenshots (1–5) | ✅ Required | ❌ BLOCK | **Must capture at 1280×800px PNG before submission.** Minimum 1, recommend 3–5. |
| F6 | Small promo tile | Optional | 📋 TODO | 440×280px PNG — not required but strongly recommended for discoverability |
| F7 | Store summary (≤132 chars) | ✅ Required | 📋 TODO | Draft below ↓ |
| F8 | Detailed description | ✅ Required | 📋 TODO | Draft below ↓ |
| F9 | Privacy policy URL | ✅ Required | ❌ BLOCK | Must be publicly accessible before submitting |
| F10 | Category | ✅ Required | 📋 TODO | Recommend: **Productivity** (more competitive) or Photos |
| F11 | Marquee promo tile | Optional | Not needed | 1400×560px — only for featured extensions |

---

## SECTION G — Pre-submission Actions (YOU must do these)

### ❌ BLOCK 1 — Host a Privacy Policy
The extension uses `storage`, `activeTab`, and `scripting`. A hosted privacy policy URL is **mandatory** or CWS will reject the submission.

**Suggested content:**
> FullSnap does not collect, transmit, or store any personal data on external servers. All screenshots are processed entirely on your local device. Data captured (screenshots, settings) is stored locally in your browser via Chrome's built-in storage APIs and IndexedDB. No data leaves your device. No analytics or tracking of any kind is used.

Host this at any public URL (GitHub Pages, your website, a simple Notion page, etc.) and paste the URL into the CWS Developer Dashboard under "Privacy practices".

---

### ❌ BLOCK 2 — Capture Store Screenshots (1280×800px)
You need **at minimum 1**, ideally **3–5**, screenshots of the extension in action.

Suggested shots:
1. **Popup open** on a real website showing the two capture buttons
2. **Viewer with a full Wikipedia article** — showing the toolbar and the screenshot at fit-to-window
3. **Viewer zoomed in** on a portion of content — demonstrates zoom feature
4. **Annotation in use** — draw/highlight/text tool active on a screenshot
5. **PDF export dialog** — showing the page-size options

**How to capture:** Open Chrome DevTools → toggle device toolbar → set to 1280×800 → screenshot the tab. Or use macOS Screenshot at that resolution.

---

### 📋 TODO 3 — Enable 2-Step Verification
Google **requires** 2-Step Verification on your developer account before publishing. If not already enabled:
→ https://myaccount.google.com/security → 2-Step Verification → Turn On

---

### 📋 TODO 4 — Prepare `<all_urls>` Justification
When submitting, CWS will ask you to justify the `<all_urls>` host permission. Paste this text:

> "FullSnap captures full-page screenshots of any website the user is actively viewing. The extension must be able to inject a content script into the current tab to scroll the page and measure its dimensions, then call captureVisibleTab() for each viewport position. This requires access to all URLs because users may want to screenshot any website. The extension only activates when the user explicitly clicks the toolbar button or uses a keyboard shortcut — it does not run on pages passively or collect any page data."

---

### 📋 TODO 5 — Write Store Listing Copy

**Name (max 75 chars):** `FullSnap - Full Page Screenshot` ✅ (32 chars)

**Summary (max 132 chars — use every character):**
> Capture full-page or visible-area screenshots with one click. Annotate, zoom, export as PNG/JPEG/PDF. 100% local, no account needed.
*(131 chars — perfect)*

**Detailed Description (recommended ~300–500 words):**
> **FullSnap — Full Page Screenshot & Annotation Tool**
>
> Capture any webpage — from a short landing page to a 50-screen Wikipedia article — in a single click. FullSnap stitches your full page into one seamless image, even if it's taller than your screen.
>
> **Features:**
> - 📸 **Full-page capture** — captures the entire scrollable page, not just what's visible
> - 👁 **Visible area capture** — instant screenshot of your current viewport
> - ✏️ **Annotation tools** — draw, arrow, text, highlight, and blur (for redacting sensitive info)
> - 🔍 **Zoom & pan** — click to zoom to 100%, click again to fit. Smooth Ctrl+Scroll zoom.
> - 📄 **PDF export** — smart page breaking avoids cutting text mid-line
> - 🖼 **PNG / JPEG export** — with adjustable quality
> - 📋 **Copy to clipboard** — paste anywhere instantly
> - 🌓 **Dark & light theme** — follows your system or set manually
> - ⌨️ **Keyboard shortcuts** — Cmd/Ctrl+Shift+S for full page, Cmd/Ctrl+Shift+V for visible
>
> **Privacy first — 100% local processing:**
> Your screenshots never leave your device. No cloud sync, no account, no analytics, no tracking. Everything runs in your browser.
>
> **Keyboard Shortcuts:**
> - Cmd+Shift+S (Mac) / Ctrl+Shift+S (Win/Linux) — Full page
> - Cmd+Shift+V / Ctrl+Shift+V — Visible area
> - +/- — Zoom in/out in viewer
> - 0 — Fit to window
> - Cmd+Z / Ctrl+Z — Undo annotation

---

## SECTION H — Final Go/No-Go

| # | Gate | Status |
|---|------|--------|
| H1 | All ❌ BLOCK items resolved | ❌ 2 blocks remaining (Privacy Policy URL + Screenshots) |
| H2 | Extension loads cleanly in fresh Chrome profile | 📋 Test manually |
| H3 | Test on macOS — `⌘⇧S` triggers capture | 📋 Test manually |
| H4 | Test on Windows — `Ctrl+Shift+S` triggers capture | 📋 Test manually |
| H5 | PDF export on Wikipedia page — no text cutting, reasonable page count | 📋 Test manually (known issue — verify fix works) |
| H6 | Annotation tools work (draw, arrow, text, highlight, blur) | 📋 Test manually |
| H7 | Privacy policy URL live | ❌ Not done yet |
| H8 | 3+ screenshots at 1280×800 captured | ❌ Not done yet |
| H9 | 2-Step Verification on Google account | 📋 Verify |
| H10 | `<all_urls>` justification text copied and ready | ✅ Text provided above |

---

## SUMMARY

### What's done ✅
- All 4 icon sizes present (new higher-quality icons)
- MV3 compliant — service worker, no persistent background
- No security issues (no eval, no remote code, no external data transmission)
- OS-aware shortcut display in popup and viewer
- Click-to-zoom with correct cursor feedback
- All buttons have accessible title attributes
- No inline HTML event handlers (CSP safe)
- Clean async error handling with global fallback handlers

### What's blocking ❌ (2 items)
1. **Privacy policy** — write 1 paragraph, host at any public URL
2. **Store screenshots** — capture 3–5 screenshots at 1280×800

### Recommended before submission 🟡
- Test PDF export on a Wikipedia article to confirm the text-cutting fix works
- Test on both macOS and Windows if possible
- Consider adding `const DEBUG = false;` guard around `console.log` calls for cleaner production experience (can be v1.1 task)

---

*Document generated: 2026-02-23*
