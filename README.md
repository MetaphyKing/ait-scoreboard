# AIT Scoreboard

Copyright 2026 Metaphy LLC. Licensed under Apache-2.0.

One static HTML page and one Node watcher. The watcher turns a Holy Grail AIT
loop tree into `scoreboard.json` within a debounce of every event. Zero runtime
dependencies: Node stdlib and vanilla HTML/CSS/JS. One file per concern.

Logan approved the contract 2026-09-05 08:56 PT. This repo is the Builder
deliverable for run `ait-scoreboard-20260905`. It is **not** a Verifier PASS.

## Hosting choice

Prefer **GitHub Pages from `/web` on `main`**.

- `web/index.html` fetches **relative** `./scoreboard.json`, so the same files
  work at `https://<user>.github.io/ait-scoreboard/` and under `/ait/`.
- `.github/workflows/pages.yml` publishes the `web/` folder.
- `web/.nojekyll` keeps the JSON as a raw asset.
- **Do not deploy this board to L_A9.** The watcher may *read* `C:\dev\ait` on
  that box; the page is served from Pages, not from the workstation.

Enable Pages: repo Settings → Pages → Source = GitHub Actions.

## Run against `C:\dev\ait`

On the box that holds the loop (default root is the Windows path):

```bat
node watcher\scoreboard-watcher.js C:\dev\ait web\scoreboard.json
```

On any other machine, pass the tree you actually have:

```bash
node watcher/scoreboard-watcher.js /path/to/ait web/scoreboard.json
```

Behavior:

- argv[2] = AIT root (default `C:\dev\ait`)
- argv[3] = output JSON (default `<cwd>/web/scoreboard.json`)
- 500 ms debounce, atomic temp+rename, 30 s safety rebuild
- `scoreboard-cache.json` next to the output holds the first-seen map
- ASCII-only logs on stdout
- A bad seat file never kills the process; that seat is marked unreadable

Local preview of the page (from `web/` so the relative fetch works):

```bash
python -m http.server 8765 --directory web
```

Open `http://127.0.0.1:8765/`. The page polls every 5 s with `cache: no-store`
and sends `If-None-Match` when the host provides an ETag.

## Tests

```bash
node --check watcher/scoreboard-watcher.js
node watcher/test-watcher.js
```

`watcher/test-watcher.js` uses `node:test` and the tree under
`watcher/fixtures/`. It asserts JSON shape, atomic write, debounce, and Grail
Score arithmetic on two fake seats (`quip`, `opus`) plus one unreadable file.

## Schema and score

See [SCHEMA.md](SCHEMA.md).

```
Grail 0-100 = 40 shipped (scaled to cap 10)
            + 25 first-try (clears with no prior refuse on that loop+task)
            + 20 novelty mean (parsed N/100)
            + 15 speed (median minutes/shipped, inverted against 240 min)
```

## What the board shows

Per seat: identity and runtime label, current loop, Task 0-6 timing, gate
attempts, Task 1-6 field bags, file stats, and every event (page shows 50 with
Show all). Fleet totals, head-to-head, records. Tap a Grail number to see the
arithmetic. RAW tab dumps the JSON.

Runtime labels: `quip` = Hermes desktop; `qwen` = Claude Code Ollama
qwen-uncensored; `opus` / `aura` / `glm` / `gemini` / `gpt5` as usual.

Stay gold `#C9A227` is used only for wins/completions and the thin rule under
the title. No alarm-red. No cursor glow.

## Deliberately unbuilt

- No deploy to L_A9, no IFCH bus posts, no credentials in this repo
- No WebSocket push (5 s poll only)
- No auth, no custom domain, no mobile app
- Novelty Engine is not re-run; scores are parsed from sheets already on disk
- `gate.py` and the AIT skill are not vendored
- No historical backfill beyond files present in the AIT root
- No claim that fixture tools are real MetaphyKing uploads
- No Verifier cycle and no Verifier PASS

## Residual risks

- Windows replace-on-rename is a tmp → dest dance, not a single POSIX rename
- `fs.watch` recursive can miss events on some network volumes; 30 s safety rebuild covers that
- First-seen cache can drift if files are copied with new mtimes
- Novelty and manifest parsers are heuristic (markdown / `N/100`)
- Shipped cap 10 and speed ref 240 min are conventions, not fleet-measured par
- Google Fonts need network; system fonts are the fallback
- Many open tabs will each poll; there is no shared worker
- Live `C:\dev\ait` was not readable from this cloud builder; fixtures stand in

## Layout

```
watcher/scoreboard-watcher.js   Node watcher (stdlib)
watcher/test-watcher.js         node:test
watcher/fixtures/ait-root/      two seats + one broken state file
web/index.html                  board
web/scoreboard.json             fixture snapshot for Pages
SCHEMA.md                       JSON contract
LICENSE                         Apache-2.0
```
