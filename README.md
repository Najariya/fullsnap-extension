# FullSnap — Full Page Screenshot & Annotation Tool

A Chrome extension (Manifest V3) for capturing full-page and visible-area screenshots with annotation, PDF export, zoom, and clipboard support. **100% local — no account required, no data leaves your device.**

---

## Features

- 📸 **Full-page capture** — stitches the entire scrollable page into one image
- 👁 **Visible area capture** — instant screenshot of the current viewport
- ✏️ **Annotation tools** — draw, arrow, text, highlight, blur (redact)
- 🔍 **Click-to-zoom viewer** — click to zoom to 100%, click again to fit; Ctrl+Scroll for smooth zoom
- 📄 **Smart PDF export** — auto-detects whitespace to avoid cutting text mid-line
- 🖼 **PNG / JPEG export** — adjustable JPEG quality
- 📋 **Copy to clipboard** — paste anywhere instantly
- 🌓 **Dark & light theme** — follows system or set manually
- ⌨️ **OS-aware keyboard shortcuts** — ⌘⇧S on Mac, Ctrl+Shift+S on Windows/Linux

---

## Keyboard Shortcuts

| Action | Mac | Windows / Linux |
|---|---|---|
| Full page screenshot | ⌘ Shift S | Ctrl+Shift+S |
| Visible area | ⌘ Shift V | Ctrl+Shift+V |
| Undo annotation | ⌘ Z | Ctrl+Z |
| Download PNG | ⌘ S | Ctrl+S |
| Zoom in / out | + / - | + / - |
| Fit to window | 0 | 0 |

---

## Installation (Development)

1. Clone this repository
2. Open Chrome → chrome://extensions
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** → select this folder
5. The FullSnap icon appears in your toolbar

---

## Architecture

```
Chrome extension/
├── manifest.json           # MV3 config, permissions, keyboard commands
├── background/
│   └── service-worker.js   # Capture orchestration, IndexedDB, offscreen doc
├── content/
│   └── capture.js          # Page scroll + measurement content script
├── popup/
│   ├── popup.html/js/css   # Toolbar popup UI
├── viewer/
│   ├── viewer.html/js/css  # Screenshot viewer (zoom, annotate, export)
│   └── annotation.js       # Annotation engine (draw, arrow, text, highlight, blur)
├── offscreen/
│   └── offscreen.js        # Canvas stitching (MV3 offscreen document)
├── shared/
│   ├── constants.js        # Message types, defaults
│   └── capture-store.js    # IndexedDB wrapper
├── icons/
│   ├── icon-source.svg     # Master SVG icon
│   └── icon-{16,32,48,128}.png
└── docs/
    └── index.html          # Privacy policy (GitHub Pages)
```

---

## Privacy

FullSnap collects no data. All processing is local. See the full [Privacy Policy](https://Najariya.github.io/fullsnap-extension/).

---

## License

MIT
