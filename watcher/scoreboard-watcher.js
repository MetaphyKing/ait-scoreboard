#!/usr/bin/env node
/*
 * Copyright 2026 Metaphy LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * AIT Scoreboard watcher. Node stdlib only.
 * Watches a Holy Grail AIT root and writes scoreboard.json (atomic tmp+rename).
 *
 *   node watcher/scoreboard-watcher.js [aitRoot] [outJson]
 *
 * Default root: C:\dev\ait
 * Default out:  <cwd>/web/scoreboard.json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const SCHEMA_VERSION = 1;
const DEFAULT_ROOT = 'C:\\dev\\ait';
const DEBOUNCE_MS = 500;
const SAFETY_MS = 30000;
const SHIPPED_CAP = 10;
const SPEED_REF_MINUTES = 240;
const TASK_NAMES = [
  'workspace',
  'preflight',
  'build_v1',
  'combine_v2',
  'quality_gates',
  'publish',
  'self_report'
];
const GATE_LINES = [
  'TEST',
  'DOCUMENTATION',
  'EXAMPLES',
  'ERROR HANDLING',
  'CODE QUALITY',
  'INTEGRATION'
];
const SEAT_LABELS = {
  quip: 'Hermes desktop',
  qwen: 'Claude Code Ollama qwen-uncensored',
  opus: 'Claude Opus',
  aura: 'Aura',
  glm: 'GLM',
  gemini: 'Gemini',
  gpt5: 'GPT-5'
};
const SKIP_DIRS = new Set([
  '.git',
  '.state',
  'encyclopedia',
  '_skill',
  '_protocols',
  '_skill',
  'tools',
  'node_modules'
]);

function log(msg) {
  const line = '[ait-scoreboard] ' + String(msg).replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '?');
  process.stdout.write(line + '\n');
}

function nowIso(d) {
  return (d || new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function parseIso(s) {
  if (!s || typeof s !== 'string') return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function minutesBetween(a, b) {
  const ta = parseIso(a);
  const tb = parseIso(b);
  if (ta == null || tb == null || tb < ta) return null;
  return (tb - ta) / 60000;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function round2(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function mean(nums) {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function median(nums) {
  if (!nums.length) return 0;
  const s = nums.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function safeStat(p) {
  try {
    return fs.statSync(p);
  } catch (e) {
    return null;
  }
}

function readText(p) {
  return fs.readFileSync(p, { encoding: 'utf8' });
}

function listDir(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true });
  } catch (e) {
    return [];
  }
}

function parseJsonSafe(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : 'json parse failed' };
  }
}

function seatLabel(seat) {
  const key = String(seat || '').toLowerCase();
  if (SEAT_LABELS[key]) return SEAT_LABELS[key];
  if (!key) return 'unknown';
  return key.charAt(0).toUpperCase() + key.slice(1);
}

function computeGrailScore(input) {
  const shipped = Math.max(0, Number(input.shipped) || 0);
  const firstTryClears = Math.max(0, Number(input.firstTryClears) || 0);
  const totalClears = Math.max(0, Number(input.totalClears) || 0);
  const noveltyScores = Array.isArray(input.noveltyScores)
    ? input.noveltyScores.filter((n) => Number.isFinite(n))
    : [];
  const minutesPerShipped = Array.isArray(input.minutesPerShipped)
    ? input.minutesPerShipped.filter((n) => Number.isFinite(n) && n >= 0)
    : [];

  const shippedPoints = 40 * Math.min(shipped, SHIPPED_CAP) / SHIPPED_CAP;
  const firstTryPoints = totalClears > 0 ? 25 * (firstTryClears / totalClears) : 0;
  const noveltyMean = noveltyScores.length ? mean(noveltyScores) : 0;
  const noveltyPoints = 20 * (clamp(noveltyMean, 0, 100) / 100);
  const medianMin = minutesPerShipped.length ? median(minutesPerShipped) : null;
  const speedPoints = medianMin == null
    ? 0
    : 15 * clamp(1 - medianMin / SPEED_REF_MINUTES, 0, 1);

  const parts = {
    shipped: round2(shippedPoints),
    first_try: round2(firstTryPoints),
    novelty: round2(noveltyPoints),
    speed: round2(speedPoints)
  };
  return {
    total: round2(parts.shipped + parts.first_try + parts.novelty + parts.speed),
    parts: parts,
    inputs: {
      shipped: shipped,
      first_try_clears: firstTryClears,
      total_clears: totalClears,
      first_try_rate: totalClears > 0 ? round2(firstTryClears / totalClears) : 0,
      novelty_mean: round2(noveltyMean),
      novelty_n: noveltyScores.length,
      median_minutes_per_shipped: medianMin == null ? null : round2(medianMin),
      shipped_cap: SHIPPED_CAP,
      speed_ref_minutes: SPEED_REF_MINUTES
    }
  };
}

function debounce(fn, ms) {
  let timer = null;
  let pending = false;
  const wrapped = function debounced() {
    pending = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () {
      timer = null;
      pending = false;
      fn();
    }, ms);
  };
  wrapped.flush = function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending) {
      pending = false;
      fn();
    }
  };
  wrapped.cancel = function cancel() {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = false;
  };
  wrapped.pending = function isPending() {
    return pending || timer != null;
  };
  return wrapped;
}

function writeAtomic(dest, data) {
  const dir = path.dirname(dest);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, '.' + path.basename(dest) + '.' + process.pid + '.tmp');
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  fs.writeFileSync(tmp, payload, { encoding: 'utf8' });
  try {
    fs.renameSync(tmp, dest);
  } catch (e) {
    const bak = dest + '.bak';
    try {
      fs.unlinkSync(bak);
    } catch (e2) {
      /* ignore */
    }
    try {
      fs.renameSync(dest, bak);
    } catch (e3) {
      /* ignore */
    }
    fs.renameSync(tmp, dest);
    try {
      fs.unlinkSync(bak);
    } catch (e4) {
      /* ignore */
    }
  }
  return dest;
}

function fileStatRecord(root, rel) {
  const abs = path.join(root, rel);
  const st = safeStat(abs);
  if (!st) {
    return {
      path: rel.replace(/\\/g, '/'),
      exists: false,
      bytes: 0,
      mtime: null
    };
  }
  return {
    path: rel.replace(/\\/g, '/'),
    exists: true,
    bytes: st.size,
    mtime: nowIso(st.mtime)
  };
}

function parseNoveltyScore(text) {
  if (!text) return null;
  const patterns = [
    /(\d+(?:\.\d+)?)\s*\/\s*100\b/,
    /novelty[^\d]{0,40}(\d+(?:\.\d+)?)/i,
    /\bscore\s*[:=]\s*(\d+(?:\.\d+)?)/i
  ];
  for (let i = 0; i < patterns.length; i++) {
    const m = text.match(patterns[i]);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n >= 0 && n <= 100) return n;
    }
  }
  return null;
}

function sectionBody(text, heading) {
  const re = new RegExp(
    '^#{1,3}\\s*' + heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$([\\s\\S]*?)(?=^#{1,3}\\s|\\Z)',
    'im'
  );
  const m = text.match(re);
  return m ? m[1].trim() : '';
}

function hasHeading(text, heading) {
  const re = new RegExp('^#{1,3}\\s*' + heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'im');
  return re.test(text);
}

function parseBuildLog(text) {
  const out = {
    tokens_text: sectionBody(text, 'Tokens') || sectionBody(text, '1.1 Parsed Tokens') || sectionBody(text, '1.1 Parsed Tokens (from start block)'),
    local_vs_github: sectionBody(text, 'Local vs GitHub') || sectionBody(text, '1.2 Local vs GitHub') || sectionBody(text, '1.2 Local vs GitHub Scan'),
    redundancy: sectionBody(text, 'Redundancy') || sectionBody(text, '1.4 Graph Search (Redundancy Check)') || sectionBody(text, '1.4 Redundancy'),
    chosen_tool: sectionBody(text, 'Chosen tool') || sectionBody(text, '1.5 Chosen Tool'),
    shoulder_angels_1: hasHeading(text, 'shoulder angels 1') || hasHeading(text, 'SHOULDER ANGELS 1'),
    shoulder_angels_2: hasHeading(text, 'shoulder angels 2') || hasHeading(text, 'SHOULDER ANGELS 2'),
    score_table: hasHeading(text, 'score table'),
    pivots: hasHeading(text, 'pivots'),
    gates: {},
    self_report_id: null,
    novelty_score: parseNoveltyScore(text)
  };
  for (let i = 0; i < GATE_LINES.length; i++) {
    const g = GATE_LINES[i];
    const re = new RegExp('GATE\\s+' + g.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*(PASS|FAIL|PENDING)', 'i');
    const m = text.match(re);
    out.gates[g] = m ? m[1].toUpperCase() : null;
  }
  const sr = text.match(/SELF-REPORT\s*:\s*(m_[A-Za-z0-9]+)/i);
  if (sr) out.self_report_id = sr[1];
  return out;
}

function parseManifest(text) {
  const rows = [];
  if (!text) return rows;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 6) continue;
    if (/^-+$/.test(cells[0].replace(/:/g, '')) || /^tool$/i.test(cells[0])) continue;
    if (!cells[0] || cells[0] === '---') continue;
    rows.push({
      tool: cells[0],
      repo: cells[1] || '',
      date: cells[2] || '',
      purpose: cells[3] || '',
      status: cells[4] || '',
      builder: (cells[5] || '').toLowerCase()
    });
  }
  return rows;
}

function parseLedger(text) {
  const rows = [];
  if (!text) return rows;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parsed = parseJsonSafe(line);
    if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') continue;
    rows.push(parsed.value);
  }
  return rows;
}

function parseEvents(text, seat) {
  const events = [];
  if (!text) return events;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parsed = parseJsonSafe(line);
    if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') {
      events.push({
        at: null,
        seat: seat,
        task: null,
        result: 'unreadable',
        missing: [parsed.error || 'bad jsonl line'],
        source: 'events.jsonl',
        raw_ok: false
      });
      continue;
    }
    const row = parsed.value;
    events.push({
      at: row.at || null,
      seat: row.seat || seat,
      task: row.task == null ? null : Number(row.task),
      result: row.result || row.event || null,
      missing: Array.isArray(row.missing) ? row.missing : [],
      source: 'events.jsonl',
      raw_ok: true
    });
  }
  return events;
}

function loadCache(cachePath) {
  const st = safeStat(cachePath);
  if (!st) return { version: 1, first_seen: {} };
  try {
    const parsed = parseJsonSafe(readText(cachePath));
    if (parsed.ok && parsed.value && parsed.value.first_seen) return parsed.value;
  } catch (e) {
    /* ignore */
  }
  return { version: 1, first_seen: {} };
}

function remember(cache, key, when) {
  if (!when) return cache.first_seen[key] || null;
  const prev = cache.first_seen[key];
  if (!prev) {
    cache.first_seen[key] = when;
    return when;
  }
  const a = parseIso(prev);
  const b = parseIso(when);
  if (b != null && (a == null || b < a)) {
    cache.first_seen[key] = when;
    return when;
  }
  return prev;
}

function discoverSeats(root) {
  const dir = path.join(root, '.state');
  const seats = [];
  const ents = listDir(dir);
  for (let i = 0; i < ents.length; i++) {
    const ent = ents[i];
    if (!ent.isFile()) continue;
    const name = ent.name;
    if (!name.endsWith('.json')) continue;
    if (name.endsWith('.events.json')) continue;
    seats.push(name.slice(0, -5));
  }
  seats.sort();
  return seats;
}

function discoverToolDirs(root) {
  const tools = [];
  const ents = listDir(root);
  for (let i = 0; i < ents.length; i++) {
    const ent = ents[i];
    if (!ent.isDirectory()) continue;
    if (SKIP_DIRS.has(ent.name) || ent.name.startsWith('.')) continue;
    const dir = path.join(root, ent.name);
    if (safeStat(path.join(dir, 'BUILD_LOG.md')) || safeStat(path.join(dir, 'PRODUCTION_V2.md'))) {
      tools.push(ent.name);
    }
  }
  return tools;
}

function readToolBundle(root, tool) {
  const rel = tool;
  const dir = path.join(root, tool);
  const buildLogPath = path.join(dir, 'BUILD_LOG.md');
  const buildLogText = safeStat(buildLogPath) ? readText(buildLogPath) : '';
  const parsedLog = parseBuildLog(buildLogText);
  let noveltyFile = null;
  let noveltyScore = parsedLog.novelty_score;
  const files = listDir(dir);
  for (let i = 0; i < files.length; i++) {
    const n = files[i].name;
    if (files[i].isFile() && /^novelty/i.test(n) && /\.md$/i.test(n)) {
      noveltyFile = tool + '/' + n;
      const score = parseNoveltyScore(readText(path.join(dir, n)));
      if (score != null) noveltyScore = score;
    }
  }
  const roads = ['v1-A', 'v1-B', 'v1-C', 'v1-D'];
  const builds = {};
  for (let i = 0; i < roads.length; i++) {
    const r = roads[i];
    const rd = path.join(dir, 'builds', r);
    builds[r] = {
      exists: !!safeStat(rd),
      production_v1: !!safeStat(path.join(rd, 'PRODUCTION_V1.md')),
      readme: !!safeStat(path.join(rd, 'README.md')),
      tests: !!(safeStat(path.join(rd, 'tests')) || listDir(rd).some((e) => /^test/i.test(e.name)))
    };
  }
  return {
    name: tool,
    build_log: parsedLog,
    novelty_file: noveltyFile,
    novelty_score: noveltyScore,
    production_v2: !!safeStat(path.join(dir, 'PRODUCTION_V2.md')),
    completion_report: !!safeStat(path.join(dir, 'COMPLETION_REPORT.md')),
    readme: !!safeStat(path.join(dir, 'README.md')),
    examples: !!safeStat(path.join(dir, 'EXAMPLES.md')),
    builds: builds,
    files: [
      fileStatRecord(root, rel + '/BUILD_LOG.md'),
      fileStatRecord(root, rel + '/PRODUCTION_V2.md'),
      fileStatRecord(root, rel + '/COMPLETION_REPORT.md'),
      fileStatRecord(root, rel + '/README.md'),
      fileStatRecord(root, rel + '/EXAMPLES.md')
    ]
  };
}

function historyToEvents(history, seat) {
  const out = [];
  if (!Array.isArray(history)) return out;
  for (let i = 0; i < history.length; i++) {
    const h = history[i] || {};
    const ev = String(h.event || '');
    const gateClear = ev.match(/^gate(\d)\s+cleared$/i);
    out.push({
      at: h.at || null,
      seat: seat,
      task: gateClear ? Number(gateClear[1]) : null,
      result: ev || null,
      missing: [],
      source: 'state.history',
      tool: h.tool || null,
      raw_ok: true
    });
  }
  return out;
}

function annotateGateAttempts(events) {
  const attempts = [];
  const loopIndex = Object.create(null);
  const refused = Object.create(null);
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.source !== 'events.jsonl') continue;
    if (e.task == null || (e.result !== 'cleared' && e.result !== 'refused')) continue;
    const seat = e.seat || '';
    if (loopIndex[seat] == null) loopIndex[seat] = 0;
    const key = seat + ':' + loopIndex[seat] + ':' + e.task;
    if (e.result === 'refused') {
      refused[key] = true;
      attempts.push({
        at: e.at,
        seat: seat,
        task: e.task,
        result: 'refused',
        missing: e.missing,
        first_try: false,
        loop_index: loopIndex[seat]
      });
      continue;
    }
    const firstTry = !refused[key];
    attempts.push({
      at: e.at,
      seat: seat,
      task: e.task,
      result: 'cleared',
      missing: [],
      first_try: firstTry,
      loop_index: loopIndex[seat]
    });
    if (e.task === 6) loopIndex[seat] += 1;
  }
  return attempts;
}

function loopTimings(history) {
  const loops = [];
  let cur = null;
  if (!Array.isArray(history)) return loops;
  for (let i = 0; i < history.length; i++) {
    const h = history[i] || {};
    const ev = String(h.event || '');
    if (ev === 'start') {
      cur = { started: h.at || null, cleared: null, tool: null };
      loops.push(cur);
    } else if (ev === 'choose' && cur) {
      cur.tool = h.tool || cur.tool;
    } else if (/^gate6\s+cleared$/i.test(ev) && cur) {
      cur.cleared = h.at || null;
    }
  }
  return loops;
}

function taskTimingFromHistory(history, cache, seat) {
  const tasks = {};
  for (let n = 0; n <= 6; n++) {
    tasks[String(n)] = {
      name: TASK_NAMES[n],
      entered_at: null,
      cleared_at: null,
      minutes: null
    };
  }
  if (!Array.isArray(history)) return tasks;
  let loop = -1;
  for (let i = 0; i < history.length; i++) {
    const h = history[i] || {};
    const ev = String(h.event || '');
    if (ev === 'start') {
      loop += 1;
      const entered = remember(cache, 'task:' + seat + ':' + loop + ':0:entered', h.at);
      if (!tasks['0'].entered_at) tasks['0'].entered_at = entered;
    }
    const cleared = ev.match(/^gate(\d)\s+cleared$/i);
    if (cleared) {
      const n = Number(cleared[1]);
      const key = 'task:' + seat + ':' + Math.max(loop, 0) + ':' + n + ':cleared';
      const when = remember(cache, key, h.at);
      tasks[String(n)].cleared_at = when;
      if (n < 6 && !tasks[String(n + 1)].entered_at) {
        tasks[String(n + 1)].entered_at = remember(
          cache,
          'task:' + seat + ':' + Math.max(loop, 0) + ':' + (n + 1) + ':entered',
          h.at
        );
      }
    }
  }
  for (let n = 0; n <= 6; n++) {
    const t = tasks[String(n)];
    t.minutes = minutesBetween(t.entered_at, t.cleared_at);
    if (t.minutes != null) t.minutes = round2(t.minutes);
  }
  return tasks;
}

function buildSeat(root, seat, ctx) {
  const relState = path.join('.state', seat + '.json');
  const relEvents = path.join('.state', seat + '.events.jsonl');
  const statePath = path.join(root, relState);
  const eventsPath = path.join(root, relEvents);
  const identity = {
    seat: seat,
    runtime: seatLabel(seat),
    runtime_key: seat,
    readable: true,
    unreadable_since: null,
    unreadable_error: null
  };

  const st = safeStat(statePath);
  if (!st) {
    identity.readable = false;
    identity.unreadable_since = remember(ctx.cache, 'unreadable:' + seat, nowIso());
    identity.unreadable_error = 'state file missing';
    return {
      identity: identity,
      loop: null,
      grail: computeGrailScore({ shipped: 0, firstTryClears: 0, totalClears: 0, noveltyScores: [], minutesPerShipped: [] }),
      task_timing: {},
      gate_attempts: [],
      tasks: {},
      tools: [],
      file_stats: [fileStatRecord(root, relState), fileStatRecord(root, relEvents)],
      events: []
    };
  }

  let state;
  try {
    const parsed = parseJsonSafe(readText(statePath));
    if (!parsed.ok) throw new Error(parsed.error);
    state = parsed.value;
    if (!state || typeof state !== 'object') throw new Error('state is not an object');
  } catch (e) {
    identity.readable = false;
    identity.unreadable_since = remember(ctx.cache, 'unreadable:' + seat, nowIso());
    identity.unreadable_error = e && e.message ? e.message : 'unreadable';
    log('seat ' + seat + ' unreadable: ' + identity.unreadable_error);
    return {
      identity: identity,
      loop: null,
      grail: computeGrailScore({ shipped: 0, firstTryClears: 0, totalClears: 0, noveltyScores: [], minutesPerShipped: [] }),
      task_timing: {},
      gate_attempts: [],
      tasks: {},
      tools: [],
      file_stats: [fileStatRecord(root, relState), fileStatRecord(root, relEvents)],
      events: []
    };
  }

  remember(ctx.cache, 'seat:' + seat, state.started || nowIso(st.mtime));
  if (ctx.cache.first_seen['unreadable:' + seat]) delete ctx.cache.first_seen['unreadable:' + seat];

  let eventsText = '';
  if (safeStat(eventsPath)) {
    try {
      eventsText = readText(eventsPath);
    } catch (e) {
      eventsText = '';
    }
  }
  const fileEvents = parseEvents(eventsText, seat);
  const histEvents = historyToEvents(state.history, seat);
  const events = fileEvents.concat(histEvents).sort(function (a, b) {
    const ta = parseIso(a.at) || 0;
    const tb = parseIso(b.at) || 0;
    return ta - tb;
  });
  const attempts = annotateGateAttempts(fileEvents);
  const clears = attempts.filter((a) => a.result === 'cleared');
  const firstTryClears = clears.filter((a) => a.first_try).length;

  const loops = loopTimings(state.history);
  const minutesPerShipped = loops
    .filter((l) => l.started && l.cleared)
    .map((l) => minutesBetween(l.started, l.cleared))
    .filter((n) => n != null);

  const seatTools = {};
  const currentTool = state.tool || null;
  if (currentTool) seatTools[currentTool] = true;
  for (let i = 0; i < ctx.manifest.length; i++) {
    if (ctx.manifest[i].builder === seat) seatTools[ctx.manifest[i].tool] = true;
  }
  for (let i = 0; i < loops.length; i++) {
    if (loops[i].tool) seatTools[loops[i].tool] = true;
  }

  const toolBundles = [];
  const noveltyScores = [];
  const toolNames = Object.keys(seatTools).sort();
  for (let i = 0; i < toolNames.length; i++) {
    const bundle = readToolBundle(root, toolNames[i]);
    bundle.manifest = ctx.manifest.filter((r) => r.tool === toolNames[i]);
    bundle.ledger = ctx.ledger.filter(function (r) {
      const id = String(r.id || '');
      return id.indexOf('Artifact/' + toolNames[i]) === 0 && !r.superseded;
    });
    if (bundle.novelty_score != null) noveltyScores.push(bundle.novelty_score);
    toolBundles.push(bundle);
  }

  const shippedFromLoops = Number(state.loops_done) || loops.filter((l) => l.cleared).length;
  const shippedFromManifest = ctx.manifest.filter(function (r) {
    return r.builder === seat && /uploaded/i.test(r.status);
  }).length;
  const shippedFromFiles = toolBundles.filter((t) => t.production_v2).length;
  const shipped = Math.max(shippedFromLoops, shippedFromManifest, shippedFromFiles);

  const grail = computeGrailScore({
    shipped: shipped,
    firstTryClears: firstTryClears,
    totalClears: clears.length,
    noveltyScores: noveltyScores,
    minutesPerShipped: minutesPerShipped
  });

  const timing = taskTimingFromHistory(state.history, ctx.cache, seat);
  const currentBundle = currentTool
    ? toolBundles.find((t) => t.name === currentTool) || readToolBundle(root, currentTool)
    : null;
  const logFields = currentBundle ? currentBundle.build_log : parseBuildLog('');

  const tasks = {
    '0': {
      name: TASK_NAMES[0],
      fields: {
        root_ok: !!safeStat(root),
        manifest: !!safeStat(path.join(root, 'PROJECT_MANIFEST.md')),
        encyclopedia: !!safeStat(path.join(root, 'encyclopedia')),
        ledger: !!safeStat(path.join(root, 'encyclopedia', 'ids', 'ledger.jsonl'))
      }
    },
    '1': {
      name: TASK_NAMES[1],
      fields: {
        tokens: state.tokens || {},
        local_vs_github: logFields.local_vs_github || '',
        redundancy: logFields.redundancy || '',
        chosen_tool: currentTool,
        novelty_file: currentBundle ? currentBundle.novelty_file : null,
        novelty_score: currentBundle ? currentBundle.novelty_score : null
      }
    },
    '2': {
      name: TASK_NAMES[2],
      fields: {
        builds: currentBundle ? currentBundle.builds : {},
        shoulder_angels_1: logFields.shoulder_angels_1,
        shoulder_angels_2: logFields.shoulder_angels_2,
        builds_token: state.tokens ? state.tokens.builds : null
      }
    },
    '3': {
      name: TASK_NAMES[3],
      fields: {
        production_v2: currentBundle ? currentBundle.production_v2 : false,
        score_table: logFields.score_table,
        pivots: logFields.pivots
      }
    },
    '4': {
      name: TASK_NAMES[4],
      fields: { gates: logFields.gates }
    },
    '5': {
      name: TASK_NAMES[5],
      fields: {
        completion_report: currentBundle ? currentBundle.completion_report : false,
        readme: currentBundle ? currentBundle.readme : false,
        manifest_row: ctx.manifest.some((r) => r.tool === currentTool),
        ledger_row: ctx.ledger.some(function (r) {
          return currentTool && String(r.id || '').indexOf('Artifact/' + currentTool) === 0 && !r.superseded;
        }),
        repo: (ctx.manifest.find((r) => r.tool === currentTool) || {}).repo || ''
      }
    },
    '6': {
      name: TASK_NAMES[6],
      fields: {
        self_report_id: logFields.self_report_id,
        stop: !!state.stop
      }
    }
  };

  const fileStats = [fileStatRecord(root, relState), fileStatRecord(root, relEvents)];
  for (let i = 0; i < toolBundles.length; i++) {
    fileStats.push.apply(fileStats, toolBundles[i].files);
  }

  return {
    identity: identity,
    loop: {
      task: Number(state.task) || 0,
      tool: currentTool,
      stop: !!state.stop,
      loops_done: Number(state.loops_done) || 0,
      started: state.started || null,
      tokens: state.tokens || {},
      history_count: Array.isArray(state.history) ? state.history.length : 0
    },
    grail: grail,
    task_timing: timing,
    gate_attempts: attempts,
    tasks: tasks,
    tools: toolBundles,
    file_stats: fileStats,
    events: events
  };
}

function headToHead(seats) {
  const pairs = [];
  for (let i = 0; i < seats.length; i++) {
    for (let j = i + 1; j < seats.length; j++) {
      const a = seats[i];
      const b = seats[j];
      if (!a.identity.readable || !b.identity.readable) continue;
      pairs.push({
        a: a.identity.seat,
        b: b.identity.seat,
        grail: {
          a: a.grail.total,
          b: b.grail.total,
          lead: a.grail.total === b.grail.total ? null : (a.grail.total > b.grail.total ? a.identity.seat : b.identity.seat)
        },
        shipped: {
          a: a.grail.inputs.shipped,
          b: b.grail.inputs.shipped,
          lead: a.grail.inputs.shipped === b.grail.inputs.shipped ? null : (a.grail.inputs.shipped > b.grail.inputs.shipped ? a.identity.seat : b.identity.seat)
        },
        first_try: {
          a: a.grail.inputs.first_try_rate,
          b: b.grail.inputs.first_try_rate,
          lead: a.grail.inputs.first_try_rate === b.grail.inputs.first_try_rate ? null : (a.grail.inputs.first_try_rate > b.grail.inputs.first_try_rate ? a.identity.seat : b.identity.seat)
        },
        novelty: {
          a: a.grail.inputs.novelty_mean,
          b: b.grail.inputs.novelty_mean,
          lead: a.grail.inputs.novelty_mean === b.grail.inputs.novelty_mean ? null : (a.grail.inputs.novelty_mean > b.grail.inputs.novelty_mean ? a.identity.seat : b.identity.seat)
        },
        speed: {
          a: a.grail.inputs.median_minutes_per_shipped,
          b: b.grail.inputs.median_minutes_per_shipped,
          lead: fastest(a, b)
        }
      });
    }
  }
  return pairs;
}

function fastest(a, b) {
  const ma = a.grail.inputs.median_minutes_per_shipped;
  const mb = b.grail.inputs.median_minutes_per_shipped;
  if (ma == null && mb == null) return null;
  if (ma == null) return b.identity.seat;
  if (mb == null) return a.identity.seat;
  if (ma === mb) return null;
  return ma < mb ? a.identity.seat : b.identity.seat;
}

function recordsOf(seats) {
  const readable = seats.filter((s) => s.identity.readable);
  function best(fn, preferLow) {
    let win = null;
    for (let i = 0; i < readable.length; i++) {
      const v = fn(readable[i]);
      if (v == null) continue;
      if (!win) {
        win = { seat: readable[i].identity.seat, value: v };
        continue;
      }
      if (preferLow ? v < win.value : v > win.value) {
        win = { seat: readable[i].identity.seat, value: v };
      }
    }
    return win;
  }
  return {
    highest_grail: best((s) => s.grail.total, false),
    most_shipped: best((s) => s.grail.inputs.shipped, false),
    highest_first_try: best((s) => s.grail.inputs.first_try_rate, false),
    highest_novelty: best((s) => (s.grail.inputs.novelty_n ? s.grail.inputs.novelty_mean : null), false),
    fastest_median: best((s) => s.grail.inputs.median_minutes_per_shipped, true)
  };
}

function buildScoreboard(root, options) {
  const opts = options || {};
  const started = performance.now();
  const cache = opts.cache || { version: 1, first_seen: {} };
  const generatedAt = opts.now || nowIso();

  let manifest = [];
  const manifestPath = path.join(root, 'PROJECT_MANIFEST.md');
  if (safeStat(manifestPath)) {
    try {
      manifest = parseManifest(readText(manifestPath));
    } catch (e) {
      log('manifest unreadable: ' + (e.message || e));
    }
  }
  let ledger = [];
  const ledgerPath = path.join(root, 'encyclopedia', 'ids', 'ledger.jsonl');
  if (safeStat(ledgerPath)) {
    try {
      ledger = parseLedger(readText(ledgerPath));
    } catch (e) {
      log('ledger unreadable: ' + (e.message || e));
    }
  }

  const ctx = { cache: cache, manifest: manifest, ledger: ledger };
  const names = discoverSeats(root);
  const seats = names.map((s) => buildSeat(root, s, ctx));
  const readable = seats.filter((s) => s.identity.readable);
  const fleet = {
    seats: seats.length,
    readable: readable.length,
    unreadable: seats.length - readable.length,
    shipped: readable.reduce((n, s) => n + s.grail.inputs.shipped, 0),
    mean_grail: readable.length ? round2(mean(readable.map((s) => s.grail.total))) : 0,
    active_loops: readable.filter((s) => s.loop && !s.loop.stop).length,
    tools_on_disk: discoverToolDirs(root).length,
    ledger_rows: ledger.length,
    manifest_rows: manifest.length
  };

  const board = {
    schema_version: SCHEMA_VERSION,
    generated_at: generatedAt,
    root: root,
    fleet: fleet,
    seats: seats,
    head_to_head: headToHead(seats),
    records: recordsOf(seats),
    grail_formula: {
      total: '40 shipped (scaled to cap) + 25 first-try + 20 novelty mean + 15 speed (median min/shipped inverted)',
      shipped_cap: SHIPPED_CAP,
      speed_ref_minutes: SPEED_REF_MINUTES
    },
    rebuild_ms: round2(performance.now() - started)
  };
  return board;
}

function defaultOutPath() {
  return path.resolve(process.cwd(), 'web', 'scoreboard.json');
}

function cachePathFor(outPath) {
  return path.join(path.dirname(outPath), 'scoreboard-cache.json');
}

function rebuildTo(root, outPath, cachePath, hooks) {
  const cache = loadCache(cachePath);
  let board;
  try {
    board = buildScoreboard(root, { cache: cache });
  } catch (e) {
    log('rebuild failed (kept last good): ' + (e && e.message ? e.message : e));
    if (hooks && hooks.onError) hooks.onError(e);
    return null;
  }
  writeAtomic(outPath, JSON.stringify(board, null, 2) + '\n');
  writeAtomic(cachePath, JSON.stringify(cache, null, 2) + '\n');
  log(
    'rebuild ok seats=' +
      board.fleet.seats +
      ' readable=' +
      board.fleet.readable +
      ' shipped=' +
      board.fleet.shipped +
      ' ms=' +
      board.rebuild_ms
  );
  if (hooks && hooks.onWrite) hooks.onWrite(board, outPath);
  return board;
}

function startWatcher(root, outPath, options) {
  const opts = options || {};
  const debounceMs = opts.debounceMs == null ? DEBOUNCE_MS : opts.debounceMs;
  const safetyMs = opts.safetyMs == null ? SAFETY_MS : opts.safetyMs;
  const cachePath = opts.cachePath || cachePathFor(outPath);
  const hooks = { onWrite: opts.onWrite, onError: opts.onError };
  const ignore = {};
  ignore[path.resolve(outPath)] = true;
  ignore[path.resolve(cachePath)] = true;

  const run = function () {
    rebuildTo(root, outPath, cachePath, hooks);
  };
  const debounced = debounce(run, debounceMs);
  run();

  let watcher = null;
  try {
    watcher = fs.watch(root, { recursive: true }, function (type, fname) {
      if (!fname) {
        debounced();
        return;
      }
      const abs = path.resolve(root, fname);
      if (ignore[abs]) return;
      const base = path.basename(fname);
      if (base.indexOf('.tmp') !== -1 || base.indexOf('.bak') !== -1) return;
      if (base === 'scoreboard.json' || base === 'scoreboard-cache.json') return;
      debounced();
    });
  } catch (e) {
    log('watch failed, safety timer only: ' + (e && e.message ? e.message : e));
  }

  const safety = setInterval(run, safetyMs);
  if (safety.unref) safety.unref();

  return {
    root: root,
    outPath: outPath,
    cachePath: cachePath,
    debounce: debounced,
    rebuild: run,
    close: function close() {
      debounced.cancel();
      clearInterval(safety);
      if (watcher) {
        try {
          watcher.close();
        } catch (e) {
          /* ignore */
        }
      }
    }
  };
}

function main(argv) {
  const args = argv || process.argv.slice(2);
  const root = path.resolve(args[0] || DEFAULT_ROOT);
  const outPath = path.resolve(args[1] || defaultOutPath());
  log('watching ' + root);
  log('writing ' + outPath);
  log('debounce_ms=' + DEBOUNCE_MS + ' safety_ms=' + SAFETY_MS);
  const handle = startWatcher(root, outPath, {});
  const stop = function () {
    handle.close();
    log('stopped');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return handle;
}

if (require.main === module) {
  main();
}

module.exports = {
  SCHEMA_VERSION: SCHEMA_VERSION,
  DEFAULT_ROOT: DEFAULT_ROOT,
  DEBOUNCE_MS: DEBOUNCE_MS,
  SAFETY_MS: SAFETY_MS,
  SHIPPED_CAP: SHIPPED_CAP,
  SPEED_REF_MINUTES: SPEED_REF_MINUTES,
  SEAT_LABELS: SEAT_LABELS,
  TASK_NAMES: TASK_NAMES,
  GATE_LINES: GATE_LINES,
  log: log,
  nowIso: nowIso,
  clamp: clamp,
  round2: round2,
  mean: mean,
  median: median,
  computeGrailScore: computeGrailScore,
  debounce: debounce,
  writeAtomic: writeAtomic,
  parseJsonSafe: parseJsonSafe,
  parseNoveltyScore: parseNoveltyScore,
  parseBuildLog: parseBuildLog,
  parseManifest: parseManifest,
  parseLedger: parseLedger,
  parseEvents: parseEvents,
  discoverSeats: discoverSeats,
  buildScoreboard: buildScoreboard,
  buildSeat: buildSeat,
  startWatcher: startWatcher,
  rebuildTo: rebuildTo,
  main: main
};
