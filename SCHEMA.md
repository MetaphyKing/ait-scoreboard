# scoreboard.json schema

Copyright 2026 Metaphy LLC. SPDX-License-Identifier: Apache-2.0.

Watcher output written atomically to `web/scoreboard.json` (or argv[3]).
`schema_version` is `1`. Unknown fields must be ignored by readers.

## Root

| Field | Type | Meaning |
|---|---|---|
| `schema_version` | number | `1` |
| `generated_at` | string | UTC ISO-8601, seconds |
| `root` | string | AIT tree that was scanned |
| `rebuild_ms` | number | last rebuild duration |
| `fleet` | object | totals across seats |
| `seats` | array | every `.state/<seat>.json`, including unreadable |
| `head_to_head` | array | pairwise leads |
| `records` | object | gold-row winners |
| `grail_formula` | object | documented constants |

## Fleet

`seats`, `readable`, `unreadable`, `shipped`, `mean_grail`, `active_loops`,
`tools_on_disk`, `ledger_rows`, `manifest_rows`.

## Seat

```
identity   seat, runtime, runtime_key, readable, unreadable_since, unreadable_error
loop       task, tool, stop, loops_done, started, tokens, history_count
grail      total, parts, inputs
task_timing  "0".."6" → { name, entered_at, cleared_at, minutes }
gate_attempts  from .state/<seat>.events.jsonl (may be absent)
tasks      "0".."6" field bags parsed from disk
tools      per-tool BUILD_LOG / novelty* / builds / stamps
file_stats path, exists, bytes, mtime
events     forever merge of events.jsonl + state.history
```

A bad or missing state file never aborts the rebuild. That seat is
`readable=false` and `unreadable_since` is the first time the watcher saw it fail
(persisted in `scoreboard-cache.json`).

## Grail Score (0-100)

```
total = shipped_points + first_try_points + novelty_points + speed_points
```

| Part | Max | Arithmetic |
|---|---|---|
| shipped | 40 | `40 * min(shipped, 10) / 10` |
| first-try | 25 | `25 * first_try_clears / total_clears` (0 if no clears) |
| novelty | 20 | `20 * mean(novelty scores 0-100) / 100` (0 if none) |
| speed | 15 | `15 * clamp(1 - median_min_per_shipped / 240, 0, 1)` (0 if none shipped) |

Each part and the total are rounded to 2 decimals. The total is the sum of the
rounded parts.

- **shipped** is `max(loops_done, Uploaded manifest rows for the seat, tools with PRODUCTION_V2.md)`.
- **first-try clear** = a `result=cleared` events.jsonl row whose same seat+loop+task
  had no earlier `refused`. Loop index increments after task 6 clears.
- **novelty scores** are parsed from `novelty*.md` (and BUILD_LOG) as `N/100` or `Score: N`.
- **minutes per shipped** = history `start` → `gate6 cleared` for each completed loop.
- Cap `10` and ref `240` minutes are conventions, not measured fleet par. They are
  in `grail.inputs` so the board can explain a tap.

## Runtime labels

| Seat | Label |
|---|---|
| quip | Hermes desktop |
| qwen | Claude Code Ollama qwen-uncensored |
| opus | Claude Opus |
| aura | Aura |
| glm | GLM |
| gemini | Gemini |
| gpt5 | GPT-5 |
| other | Title-cased seat id |

## Inputs the watcher reads

```
<root>/
  PROJECT_MANIFEST.md
  encyclopedia/ids/ledger.jsonl
  .state/<seat>.json
  .state/<seat>.events.jsonl          # optional
  <Tool>/BUILD_LOG.md
  <Tool>/novelty*.md
  <Tool>/PRODUCTION_V2.md
  <Tool>/COMPLETION_REPORT.md
  <Tool>/README.md
  <Tool>/EXAMPLES.md
  <Tool>/builds/v1-A..D/              # PRODUCTION_V1.md, README, test*
```

## Example (trimmed)

```json
{
  "schema_version": 1,
  "generated_at": "2026-09-05T16:00:00Z",
  "root": "watcher/fixtures/ait-root",
  "fleet": {
    "seats": 3,
    "readable": 2,
    "unreadable": 1,
    "shipped": 3,
    "mean_grail": 51.37,
    "active_loops": 2
  },
  "seats": [
    {
      "identity": {
        "seat": "quip",
        "runtime": "Hermes desktop",
        "readable": true
      },
      "loop": { "task": 3, "tool": "CognitiveFit", "loops_done": 2, "stop": false },
      "grail": {
        "total": 58.91,
        "parts": { "shipped": 8, "first_try": 23.33, "novelty": 17.27, "speed": 10.31 },
        "inputs": {
          "shipped": 2,
          "first_try_clears": 14,
          "total_clears": 15,
          "novelty_mean": 86.33,
          "median_minutes_per_shipped": 75,
          "shipped_cap": 10,
          "speed_ref_minutes": 240
        }
      }
    }
  ]
}
```

The committed `web/scoreboard.json` is this fixture snapshot so Pages has something
to poll before a live watcher overwrites it.
