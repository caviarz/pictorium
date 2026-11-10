# Pictorium

**GPT-Image on an infinite canvas** — a self-hosted AI image generation workbench.

Bring your own OpenAI-compatible provider, generate images with GPT-Image (or any compatible
model) by typing a prompt, optionally attach reference images, and keep every result organized
on a pannable, zoomable canvas. Text-to-image, image-to-image, batch generation and animated GIFs.

> **Keywords:** GPT-Image · gpt-image-1 · AI image generation · text-to-image · image-to-image ·
> infinite canvas · image editor · OpenAI-compatible · self-hosted · animated GIF · zero dependencies

Works with GPT-Image out of the box, and with any OpenAI-compatible endpoint you point it at.

No install step, no build step, no framework. **Zero runtime dependencies** — just Node.js and a browser.

English ｜ [中文](README.zh-CN.md)

---

## Features

- **Bring your own provider** — any OpenAI-compatible endpoint (GPT-Image, Flux gateways, local
  Ollama, proxies). Base URL, API key, auth style, model names and extra headers are all set in the UI.
- **Infinite canvas** — pan, zoom, box-select, drag, resize, multi-select. Everything persists.
- **Text-to-image & image-to-image** — attach any number of reference images for editing.
- **Animated GIF support** — detected at the byte level, stored losslessly, playable and pausable,
  downloaded with the correct extension.
- **Chat mode** — talk to a chat model with streaming responses (including `reasoning_content`).
- **Persists locally** — image bytes live in IndexedDB, metadata in localStorage.
  Nothing is uploaded anywhere except to your own provider.
- **Resilient** — a slow generation shows staged progress; failures keep your prompt and offer retry;
  corrupted local data degrades gracefully instead of blank-screening.

---

## Quick start

```bash
git clone https://github.com/caviarz/pictorium.git
cd pictorium
node server.js
```

Open **http://127.0.0.1:8787** — the settings panel opens automatically on first run.

On Windows you can also double-click `start.bat`.

**Requirements:** Node.js 18+ (uses the built-in `fetch`). No `npm install` needed to run the app.

---

## Configuration

Click the **⚙** button (top right). Nothing is stored on any server — config lives in your browser's localStorage.

| Field | Notes |
|---|---|
| **Base URL** | OpenAI-compatible endpoint, up to and including `/v1`. `/v1` is appended if missing. |
| **API Key** | Your key. Stored locally only. |
| **Auth style** | `bearer` (`Authorization: Bearer …`), `x-api-key`, `both`, or `none` (local Ollama). |
| **Image model** | e.g. `gpt-image-1`. Click **Fetch models** to list `/models`, or type any model name. |
| **Chat model** | Optional. Leave blank to reuse the image model (most image models don't chat). |
| **Extra headers** | Optional JSON, for gateways that need additional headers. |

Three presets are available: OpenAI, generic compatible, and local Ollama.
Use **Test connection** before saving.

The server derives `/models`, `/chat/completions`, `/images/generations`, and `/images/edits` automatically.

---

## Generating images

**Text-to-image** — type a prompt, press **Generate** (`Enter`, or `Shift+Enter` for a newline).
Each result lands on the canvas with its prompt and true pixel dimensions.

**Image-to-image** — add one or more reference images (drag into the reference strip, or hover a card
and click **＋**). With references attached, the app routes to `/images/edits`.

**Parameters**

| Parameter | Values |
|---|---|
| Size | `auto`, `1024x1024`, `1536x1024`, `1024x1536` |
| Quality | `auto` / `low` / `medium` / `high` |
| Format | `png` / `jpeg` / `webp` |
| Count | 1–4 images, laid out in a row |
| Match reference ratio | Picks the closest supported size to your reference image |

### Animated GIFs

**Getting a real animation requires `size: auto`.** This is a measured result, not a guess:

| Size parameter | Result |
|---|---|
| `auto` or omitted | **Animated GIF**, typically 10–18 frames |
| `1024x1024` | **Static PNG**, zero animation frames |

A fixed size forces the output onto a single canvas, so the model can only return a still.
With `auto` it is free to choose the canvas and frame count.

The app detects animation-related words in your prompt (`GIF`, `animated`, `frames`, `looping`, …)
and switches to `auto` automatically. You can turn this off with **Use auto size for animations**.

How the animation survives the whole pipeline:

| Stage | Approach |
|---|---|
| **Detection** | Byte-level magic numbers (`GIF`, `RIFF..WEBP`, PNG `acTL`). Never trusts `blob.type` or a data-URL prefix. |
| **Normalization** | Animated images **never** go through a canvas resize — a canvas can only sample frame 1, which would destroy the animation. |
| **Storage** | Original bytes go into IndexedDB; metadata records `animated` / `frames` / `format`. |
| **Restore** | Flags are read back from metadata; older records are re-sniffed from bytes. |
| **Display** | A `GIF · N frames` badge with a pulsing dot. Click it (or double-click the image) to pause. |
| **Download** | Extension decided from the real bytes. |
| **Copy** | Written as `image/gif`; falls back to a first-frame PNG with an explicit notice. |

---

## Canvas controls

| Action | Shortcut |
|---|---|
| Pan | **Space + drag**, middle-drag, or drag empty space to box-select |
| Zoom | **Wheel** (zooms toward cursor) |
| Zoom in / out / reset | `Ctrl` + `=` / `-` / `0` |
| Fit all content | `F`, or the **Fit** button (bottom left) |
| Move card | Drag its header or body |
| Resize card | Drag the bottom-right handle |
| Multi-select | `Shift`-click, or drag a box on empty space |
| Delete selected | `Delete` / `Backspace` |
| Select all | `Ctrl` + `A` |
| Set as reference | Double-click a card, or hover and click **＋** |
| More | Card **⋯** menu (download / copy to clipboard / copy prompt / bring to front / delete) |

### Feedback during generation

A single image often takes 40–120 seconds, so the UI keeps you informed:

- **Staged progress** — `Connecting… → Submitted, waiting for model… → Model is drawing… → Still generating…`.
  The bar stops at 95% rather than pretending to be done; after 90 seconds it suggests cancelling.
- **Empty state clears immediately** — the placeholder replaces it the instant you click Generate.
- **Failures keep your prompt** — a failed or cancelled card stays on the canvas with the reason.
  Click **↻ Retry** to regenerate in place with the same prompt. Failed cards are never persisted.
- **Sane placement** — new cards always land fully inside the visible area and are offset from each other.
  When the viewport genuinely cannot fit them all, they cascade with clickable edges rather than
  being pushed off-screen or stacked on one pixel.
- **Clickable when zoomed out** — card buttons have expanded hit areas, so they remain usable at 50% zoom.

---

## Data & privacy

Nothing leaves your machine except requests to the provider you configure.

| What | Where |
|---|---|
| API key, base URL, model names | `localStorage` (`aic.provider.v1`) |
| Card metadata (position, size, prompt) | `localStorage` (`aic.cards.v1`) |
| Image bytes | IndexedDB database `ai-canvas` (kept from the project's earlier name so existing images aren't lost) |
| Chat history, UI state, viewport | `localStorage` |

Images are written to IndexedDB **before** the metadata that references them, so a refresh can never
leave metadata pointing at missing bytes. If IndexedDB fails, the app falls back to inline data URLs
and warns you when storage runs low.

To wipe everything, clear site data for `127.0.0.1:8787` in your browser.

---

## How it works

The app is three plain ES modules plus a small server. There is no bundler.

**Why a local server at all?** Browsers can't call most image APIs directly because of CORS,
and providers usually reject requests that lack their origin. `server.js` proxies requests
and normalizes the many response shapes providers return.

- **Image-edit fallback chain** — tries JSON `images: [dataURL]`, then multipart `image[]`,
  then multipart `image`, then plain generations. Different gateways accept different shapes;
  the app finds one that works.
- **Reference images via temp files** — large references are uploaded to a temp directory first,
  keeping request bodies small.
- **SSE pass-through** — reasoning content and text are streamed separately, and providers that
  ignore `stream: true` are still handled.
- **Long timeouts** — 15 minutes, so GIF and large-image generations aren't cut off.

### Project layout

```
pictorium/
├─ server.js            # Zero-dependency Node server (static hosting + API proxy)
├─ start.bat            # One-click launcher for Windows
├─ public/
│  ├─ index.html        # UI structure
│  ├─ style.css         # Dark theme
│  ├─ app.js            # Canvas, generation, chat, persistence
│  ├─ animutil.js       # Animation detection (magic bytes, frame counts)
│  └─ imagestore.js     # IndexedDB image storage
├─ test-ux.js           # 15 UX checks (local mock, no API key needed)
├─ test-robustness.js   # 13 corrupt-data checks (no API key needed)
├─ run-regression.js    # 16 UI/persistence checks (no API key needed)
├─ test-animated.js     # 10 animated-GIF checks (needs a real provider)
├─ test-helpers.js      # Cross-platform browser lookup shared by the tests
├─ verify.js            # Server API checks (needs a real provider)
└─ mock-provider.js     # Local SSE mock for chat testing
```

### Environment variables

```bash
PORT=9000 node server.js      # change port
HOST=0.0.0.0 node server.js   # expose on LAN — see the security note below
LOG_ALL=1 node server.js      # log every request
```

---

## Testing

Tests that need no external API:

```bash
npm install                 # only needed for the browser-driven tests (playwright-core)
npm test                    # runs all three suites below (~2 minutes)
# or individually:
npm run test:ux             # 15 checks: empty state, progress, retry, placement, hit areas
npm run test:regression     # 16 checks: persistence, IndexedDB, coordinates, modes
npm run test:robustness     # 13 checks: corrupted localStorage must not break the app
```

Tests that call a real provider (see `.env.example`):

```bash
API_BASE_URL=https://api.openai.com/v1 \
API_KEY=sk-... \
API_MODEL=gpt-image-1 \
npm run test:animated
```

Both suites skip cleanly (exit code 0) when the environment variables are absent, so they are CI-safe.

Each script starts and stops its own server on a free port — nothing is left running.

---

## Security notes

This is a **local-first developer tool**, not a hardened public service.

- The server binds to `127.0.0.1` by default. Keep it that way.
- `/api/*` sets `Access-Control-Allow-Origin: *` so you can develop a frontend on another port.
  Combined with `HOST=0.0.0.0`, **any website could call your local API and spend your credits**.
  If you expose it, put authentication in front of it.
- Your API key is stored in browser localStorage in plaintext. That is normal for local tools,
  but don't do it on a shared machine.
- Static file serving rejects path traversal, but the server is not intended to face the internet.

---

## Contributing

Issues and pull requests are welcome. Please run the test suites above before submitting;
they cover the behaviors most likely to regress.

A few conventions worth knowing:

- `public/app.js` is a single IIFE and is intentionally dependency-free.
- Card placement must always keep new cards inside the visible area — there are tests for this.
- Animated images must never pass through canvas rendering.
- Anything touching localStorage reads should tolerate wrong types, not just invalid JSON.

---

## License

[MIT](LICENSE)
