# AIT Scoreboard

Copyright 2026 Metaphy LLC. Licensed under Apache-2.0.

One static HTML page and one Node watcher. The watcher turns a Holy Grail AIT
loop tree into `scoreboard.json` within a debounce of every event. Zero runtime
dependencies: Node stdlib and vanilla HTML/CSS/JS. One file per concern.

Logan approved the contract 2026-09-05 08:56 PT. This repo is the Builder
deliverable for run `ait-scoreboard-20260905`. It is **not** a Verifier PASS.

## Hosting

Logan approved **both** hosts (not Pages-only; the board is meant to run on L_A9):

1. **Live:** L_A9 tunnel `/ait/` (Cloudflare Access). The watcher writes
   `scoreboard.json` into that folder via **argv[3]**. The page stays a
   relative `./scoreboard.json` fetch so it works under `/ait/`.
2. **Mirror:** public GitHub Pages from `/web` on `main`.
   `.github/workflows/pages.yml` is that mirror. A mirror push happens on
   **AIT-DONE** — Vesper's deploy lane does that push; this repo does not
   build the push automation.

- `web/index.html` fetches **relative** `./scoreboard.json?t=<now>` with
  `cache: no-store`. It compares the JSON `etag` field (the `/ait/` origin
  sends no HTTP ETag).
- `web/.nojekyll` keeps the JSON as a raw asset on the Pages mirror.

Enable the Pages mirror: repo Settings → Pages → Source = GitHub Actions.

## Run against `C:\dev\ait`

On L_A9 (argv[2] is the AIT tree; argv[3] is the `/ait/` folder that the
tunnel serves — write `scoreboard.json` there):

```bat
node watcher\scoreboard-watcher.js C:\dev\ait C:\path\to\ait-web\scoreboard.json
```

On any other machine, pass the tree you actually have:

```bash
node watcher/scoreboard-watcher.js /path/to/ait web/scoreboard.json
```

Behavior:

- argv[2] = AIT root (default `C:\dev\ait`)
- argv[3] = output JSON (default `<cwd>/web/scoreboard.json`)
- 500 ms debounce, atomic temp+rename, 30 s safety rebuild
- `scoreboard-cache.json` next to the output holds the first-seen map and the
  previous fleet payload (for deltas)
- ASCII-only logs on stdout
- A bad seat file or a bad BUILD_LOG marks **only that seat** unreadable

Local preview of the page (from `web/` so the relative fetch works):

```bash
python3 -m http.server 8765 --directory web
```

Open `http://127.0.0.1:8765/`. The page polls every 5 s. Before the first good
JSON it shows **waiting for the first event**. After 30 s without a good fetch
it shows a **stale** badge. It re-renders only when the JSON `etag` field
changes.

## Tests

```bash
node --check watcher/scoreboard-watcher.js
node watcher/test-watcher.js
```

`watcher/test-watcher.js` uses `node:test` and the tree under
`watcher/fixtures/`. It asserts JSON shape (including `generated`, `etag`,
`watcher`, `events`), atomic write, debounce, Grail Score arithmetic (field
max), novelty `TOTAL:` parse, fleet deltas, per-seat isolation, and the
named **invent-seat** test (Stage 10.2: seats come from `.state/*.json`
only; invented / phantom / nope stay absent).

## Schema and score

See [SCHEMA.md](SCHEMA.md).

```
Grail 0-100 = 40 shipped (scaled to the field max; field of 0 = 0 for all)
            + 25 first-try (clears with no prior refuse on that loop+task)
            + 20 novelty mean (TOTAL: n/100 from novelty*.md only)
            + 15 speed (median minutes/shipped, inverted against 240 min)
```

## What the board shows

Per seat: identity and runtime label, current loop, Task 0-6 timing, gate
attempts, Task 1-6 field bags, file stats, and every event (page shows 50 with
Show all). Fleet totals with deltas vs the previous build, head-to-head,
records. Tap a Grail number to see the arithmetic. RAW tab dumps the JSON.

Runtime labels: `quip` = Hermes desktop; `qwen` = Claude Code Ollama
qwen-uncensored; `opus` / `aura` / `glm` / `gemini` / `gpt5` as usual.

Stay gold `#C9A227` is used only for wins/completions and the thin rule under
the title. No alarm-red. No cursor glow.

## Deliberately unbuilt

- No IFCH bus posts, no credentials in this repo
- No WebSocket push (5 s poll only)
- No auth, no custom domain, no mobile app
- Novelty Engine is not re-run; only `TOTAL: n/100` lines on `novelty*.md` count
- `gate.py` and the AIT skill are not vendored
- No historical backfill beyond files present in the AIT root
- No claim that fixture tools are real MetaphyKing uploads
- No Verifier cycle and no Verifier PASS

## Residual risks

- Windows replace-on-rename is a tmp → dest dance, not a single POSIX rename
- `fs.watch` recursive can miss events on some network volumes; 30 s safety rebuild covers that
- First-seen cache can drift if files are copied with new mtimes
- Manifest table parse is markdown-fragile
- Speed ref 240 min is a convention, not fleet-measured par
- Google Fonts need network; system fonts are the fallback
- Many open tabs will each poll; there is no shared worker
- Live `C:\dev\ait` was not readable from this cloud builder; fixtures stand in

## Layout

```
watcher/scoreboard-watcher.js   Node watcher (stdlib)
watcher/test-watcher.js         node:test
watcher/fixtures/ait-root/      two live seats + unreadable state + bad BUILD_LOG
web/index.html                  board
web/scoreboard.json             fixture snapshot for /ait/ and the Pages mirror
SCHEMA.md                       JSON contract
LICENSE                         Apache-2.0
```
