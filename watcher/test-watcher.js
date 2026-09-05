#!/usr/bin/env node
/*
 * Copyright 2026 Metaphy LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 *   node watcher/test-watcher.js
 *   node --test watcher/test-watcher.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const w = require('./scoreboard-watcher.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'ait-root');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function seatByName(board, name) {
  return board.seats.find((s) => s.identity.seat === name);
}

test('node syntax of watcher is loadable', () => {
  assert.equal(typeof w.buildScoreboard, 'function');
  assert.equal(w.DEFAULT_ROOT, 'C:\\dev\\ait');
  assert.equal(w.DEBOUNCE_MS, 500);
  assert.equal(w.SAFETY_MS, 30000);
  assert.equal(w.SEAT_LABELS.quip, 'Hermes desktop');
  assert.equal(w.SEAT_LABELS.qwen, 'Claude Code Ollama qwen-uncensored');
});

test('novelty parses ONLY TOTAL: n/100 from novelty sheets', () => {
  assert.equal(w.parseNoveltyScore('TOTAL: 93/100'), 93);
  assert.equal(w.parseNoveltyScore('total: 71/100\n'), 71);
  assert.equal(w.parseNoveltyScore('novelty=on depth=standard difficulty=3'), null);
  assert.equal(w.parseNoveltyScore('Final novelty score: 93/100'), null);
  assert.equal(w.parseNoveltyScore('Score: 78/100'), null);
  assert.equal(w.parseNoveltyScore('Candidate scored 88/100 in STANDARD.'), null);
  const log = w.parseBuildLog('# BUILD_LOG\n\n## Tokens\nnovelty=on depth=standard difficulty=3\n');
  assert.equal(log.novelty_score, undefined);
});

test('JSON shape from fixture tree includes contract fields', () => {
  const board = w.buildScoreboard(FIXTURE, { now: '2026-09-05T16:00:00Z' });
  assert.equal(board.schema_version, 1);
  assert.equal(board.generated, '2026-09-05T16:00:00Z');
  assert.equal(board.generated_at, '2026-09-05T16:00:00Z');
  assert.equal(typeof board.etag, 'string');
  assert.ok(board.etag.length >= 16);
  assert.equal(typeof board.watcher.pid, 'number');
  assert.ok(board.watcher.builtAt);
  assert.ok(Array.isArray(board.events));
  assert.ok(board.events.length >= 1);
  if (board.events.length >= 2 && board.events[0].at && board.events[1].at) {
    assert.ok(Date.parse(board.events[0].at) >= Date.parse(board.events[1].at));
  }
  assert.ok(board.root);
  for (const key of ['fleet', 'seats', 'head_to_head', 'records', 'grail_formula', 'generated', 'etag', 'watcher', 'events']) {
    assert.ok(board[key] != null, 'missing ' + key);
  }
  assert.ok(board.fleet.deltas);
  assert.equal(board.fleet.seats, 4);
  assert.equal(board.fleet.readable, 2);
  assert.equal(board.fleet.unreadable, 2);
  assert.equal(board.seats.length, 4);

  const quip = seatByName(board, 'quip');
  const opus = seatByName(board, 'opus');
  const broken = seatByName(board, 'broken');
  const glm = seatByName(board, 'glm');
  assert.ok(quip && opus && broken && glm);
  assert.equal(quip.identity.runtime, 'Hermes desktop');
  assert.equal(opus.identity.runtime, 'Claude Opus');
  assert.equal(quip.identity.readable, true);
  assert.equal(broken.identity.readable, false);
  assert.ok(broken.identity.unreadable_since);
  assert.ok(broken.identity.unreadable_error);
  assert.equal(glm.identity.readable, false);
  assert.match(String(glm.identity.unreadable_error), /BUILD_LOG|not a file|tool BadLog/i);

  assert.equal(quip.loop.task, 3);
  assert.equal(quip.loop.tool, 'CognitiveFit');
  assert.equal(quip.loop.loops_done, 2);
  assert.equal(opus.loop.task, 2);
  assert.equal(opus.loop.tool, 'DiffPilot');

  for (let n = 0; n <= 6; n++) {
    assert.ok(quip.tasks[String(n)], 'quip missing task ' + n);
    assert.ok(quip.task_timing[String(n)], 'quip missing timing ' + n);
  }
  assert.ok(Array.isArray(quip.gate_attempts));
  assert.ok(quip.gate_attempts.length >= 7);
  assert.ok(Array.isArray(quip.events));
  assert.ok(quip.events.length >= 16);
  assert.ok(Array.isArray(quip.file_stats));
  assert.ok(quip.file_stats.some((f) => f.path.indexOf('.state/quip.json') !== -1 && f.exists));
  assert.ok(quip.tools.some((t) => t.name === 'WindowSnap' && t.production_v2));
  assert.ok(quip.tools.find((t) => t.name === 'WindowSnap').build_log.gates.TEST === 'PASS');
  assert.equal(quip.tools.find((t) => t.name === 'CognitiveFit').novelty_score, null);

  assert.ok(board.head_to_head.length >= 1);
  assert.equal(board.head_to_head[0].grail.lead, 'quip');
  assert.equal(board.records.highest_grail.seat, 'quip');
  assert.equal(board.records.most_shipped.seat, 'quip');
  assert.equal(board.records.fastest_median.seat, 'quip');
});

test('Grail Score arithmetic uses field max, not a cap of 10', () => {
  const pure = w.computeGrailScore({
    shipped: 2,
    fieldMax: 2,
    firstTryClears: 14,
    totalClears: 15,
    noveltyScores: [93, 78],
    minutesPerShipped: [60, 90]
  });
  const shipped = 40 * 2 / 2;
  const first = 25 * 14 / 15;
  const novelty = 20 * ((93 + 78) / 2) / 100;
  const speed = 15 * (1 - 75 / 240);
  assert.equal(pure.parts.shipped, round2(shipped));
  assert.equal(pure.parts.first_try, round2(first));
  assert.equal(pure.parts.novelty, round2(novelty));
  assert.equal(pure.parts.speed, round2(speed));
  assert.equal(pure.total, round2(round2(shipped) + round2(first) + round2(novelty) + round2(speed)));
  assert.equal(pure.inputs.median_minutes_per_shipped, 75);
  assert.equal(pure.inputs.shipped_field_max, 2);
  assert.equal(pure.inputs.speed_ref_minutes, 240);

  const emptyField = w.computeGrailScore({
    shipped: 0,
    fieldMax: 0,
    firstTryClears: 3,
    totalClears: 3,
    noveltyScores: [],
    minutesPerShipped: []
  });
  assert.equal(emptyField.parts.shipped, 0);
  assert.equal(emptyField.parts.first_try, 25);

  const board = w.buildScoreboard(FIXTURE);
  const quip = seatByName(board, 'quip');
  const opus = seatByName(board, 'opus');
  assert.equal(quip.grail.inputs.shipped, 2);
  assert.equal(quip.grail.inputs.shipped_field_max, 2);
  assert.equal(quip.grail.inputs.total_clears, 15);
  assert.equal(quip.grail.inputs.first_try_clears, 14);
  assert.equal(quip.grail.inputs.median_minutes_per_shipped, 75);
  assert.equal(quip.grail.inputs.novelty_n, 2);
  assert.equal(quip.grail.parts.shipped, 40);
  assert.equal(quip.grail.total, pure.total);

  const opusPure = w.computeGrailScore({
    shipped: 1,
    fieldMax: 2,
    firstTryClears: 7,
    totalClears: 8,
    noveltyScores: [71],
    minutesPerShipped: [180]
  });
  assert.equal(opus.grail.inputs.shipped, 1);
  assert.equal(opus.grail.parts.shipped, 20);
  assert.equal(opus.grail.inputs.total_clears, 8);
  assert.equal(opus.grail.inputs.first_try_clears, 7);
  assert.equal(opus.grail.inputs.median_minutes_per_shipped, 180);
  assert.equal(opus.grail.total, opusPure.total);
  assert.ok(quip.grail.total > opus.grail.total);
});

test('atomic write uses temp then rename', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-atomic-'));
  const dest = path.join(dir, 'scoreboard.json');
  const writes = [];
  const renames = [];
  const origWrite = fs.writeFileSync;
  const origRename = fs.renameSync;
  fs.writeFileSync = function (p, data, opt) {
    writes.push(String(p));
    return origWrite.call(fs, p, data, opt);
  };
  fs.renameSync = function (from, to) {
    renames.push([String(from), String(to)]);
    return origRename.call(fs, from, to);
  };
  try {
    w.writeAtomic(dest, '{"ok":true}\n');
    assert.equal(fs.readFileSync(dest, 'utf8'), '{"ok":true}\n');
    assert.ok(writes.length >= 1);
    assert.ok(writes.every((p) => p !== dest), 'must not write dest directly');
    assert.ok(writes.some((p) => p.indexOf('.tmp') !== -1));
    assert.ok(renames.some((pair) => pair[1] === dest && pair[0].indexOf('.tmp') !== -1));
    const leftover = fs.readdirSync(dir).filter((n) => n.indexOf('.tmp') !== -1);
    assert.deepEqual(leftover, []);
  } finally {
    fs.writeFileSync = origWrite;
    fs.renameSync = origRename;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('debounce collapses bursts to one call', async () => {
  let n = 0;
  const d = w.debounce(() => {
    n += 1;
  }, 80);
  d();
  d();
  d();
  await sleep(30);
  assert.equal(n, 0);
  await sleep(70);
  assert.equal(n, 1);
  d();
  d();
  await sleep(100);
  assert.equal(n, 2);
  d.cancel();
});

test('watcher debounce on a fixture tree', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-watch-'));
  const root = path.join(dir, 'ait');
  const out = path.join(dir, 'scoreboard.json');
  fs.cpSync(FIXTURE, root, { recursive: true });
  let writes = 0;
  const handle = w.startWatcher(root, out, {
    debounceMs: 90,
    safetyMs: 60 * 60 * 1000,
    onWrite: function () {
      writes += 1;
    }
  });
  try {
    await sleep(40);
    const afterBoot = writes;
    assert.ok(afterBoot >= 1, 'initial rebuild');
    const statePath = path.join(root, '.state', 'quip.json');
    const raw = fs.readFileSync(statePath, 'utf8');
    fs.writeFileSync(statePath, raw.replace('"task": 3', '"task": 4'));
    fs.writeFileSync(statePath, raw.replace('"task": 3', '"task": 4'));
    await sleep(40);
    assert.equal(writes, afterBoot, 'burst must still be inside debounce window');
    await sleep(120);
    assert.ok(writes >= afterBoot + 1, 'one rebuild after debounce');
    const board = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(seatByName(board, 'quip').loop.task, 4);
    const tmpLeft = fs.readdirSync(dir).filter((n) => n.indexOf('.tmp') !== -1);
    assert.deepEqual(tmpLeft, []);
  } finally {
    handle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unreadable seat or BUILD_LOG never freezes the fleet', () => {
  const board = w.buildScoreboard(FIXTURE);
  const broken = seatByName(board, 'broken');
  const glm = seatByName(board, 'glm');
  const quip = seatByName(board, 'quip');
  const opus = seatByName(board, 'opus');
  assert.equal(broken.identity.readable, false);
  assert.equal(glm.identity.readable, false);
  assert.ok(glm.identity.unreadable_error);
  assert.equal(broken.grail.total, 0);
  assert.equal(quip.identity.readable, true);
  assert.equal(opus.identity.readable, true);
  assert.ok(quip.grail.total > 0);
});

test('page waits, marks stale, busts cache, compares JSON etag field', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  assert.match(html, /waiting for the first event/);
  assert.match(html, /class="badge stale hidden"/);
  assert.match(html, /STALE_MS = 30000/);
  assert.match(html, /\?t=" \+ Date\.now\(\)/);
  assert.match(html, /json\.etag && json\.etag === seenEtag/);
  assert.match(html, /cache:\s*"no-store"/);
  assert.doesNotMatch(html, /fetch failed/i);
  assert.doesNotMatch(html, /headers\.get\(\s*["']etag["']/i);
  assert.match(html, /a\.missing && a\.missing\.length/);
  assert.match(html, /\["Ledger rows"/);
  assert.match(html, /\["Manifest rows"/);
  assert.match(html, /\["Tools on disk"/);
  assert.match(html, /\["Readable"/);
  assert.match(html, /\["Unreadable"/);
});

test('invent-seat: board.seats equals .state/*.json only', () => {
  const stateDir = path.join(FIXTURE, '.state');
  const fromState = fs
    .readdirSync(stateDir)
    .filter((n) => n.endsWith('.json') && !n.endsWith('.events.json'))
    .map((n) => n.slice(0, -5))
    .sort();
  assert.deepEqual(w.discoverSeats(FIXTURE), fromState);

  const board = w.buildScoreboard(FIXTURE);
  const seats = board.seats.map((s) => s.identity.seat).sort();
  assert.deepEqual(seats, fromState);
  for (const name of ['invented', 'phantom', 'nope', 'quip.events', 'opus.events']) {
    assert.equal(seats.includes(name), false, name + ' must be absent');
  }
  for (const name of Object.keys(w.SEAT_LABELS)) {
    if (!fromState.includes(name)) {
      assert.equal(seats.includes(name), false, 'label without state: ' + name);
    }
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-invent-seat-'));
  try {
    const root = path.join(dir, 'ait');
    fs.cpSync(FIXTURE, root, { recursive: true });
    fs.appendFileSync(
      path.join(root, 'PROJECT_MANIFEST.md'),
      '| PhantomTool | | 2026-09-05 | invented seat probe | Uploaded | invented |\n' +
        '| NopeTool | | 2026-09-05 | invented seat probe | Uploaded | phantom |\n' +
        '| GhostTool | | 2026-09-05 | invented seat probe | Uploaded | nope |\n'
    );
    fs.appendFileSync(
      path.join(root, 'encyclopedia', 'ids', 'ledger.jsonl'),
      '{"id":"Artifact/PhantomTool/p-001","lemma":"PhantomTool","kind":"ait","builder":"invented"}\n'
    );
    const probed = w.buildScoreboard(root);
    const probedSeats = probed.seats.map((s) => s.identity.seat).sort();
    assert.deepEqual(probedSeats, fromState);
    assert.deepEqual(probedSeats, w.discoverSeats(root));
    for (const name of ['invented', 'phantom', 'nope']) {
      assert.equal(probedSeats.includes(name), false, 'invented via manifest: ' + name);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fleet deltas compare to the previous payload in cache', () => {
  const cache = { version: 1, first_seen: {}, previous_fleet: null };
  const first = w.buildScoreboard(FIXTURE, { cache: cache, now: '2026-09-05T16:00:00Z' });
  assert.equal(first.fleet.deltas.shipped, null);
  cache.previous_fleet = {
    seats: first.fleet.seats,
    readable: first.fleet.readable,
    unreadable: first.fleet.unreadable,
    shipped: first.fleet.shipped,
    mean_grail: first.fleet.mean_grail,
    active_loops: first.fleet.active_loops,
    tools_on_disk: first.fleet.tools_on_disk,
    ledger_rows: first.fleet.ledger_rows,
    manifest_rows: first.fleet.manifest_rows
  };
  const second = w.buildScoreboard(FIXTURE, { cache: cache, now: '2026-09-05T16:01:00Z' });
  assert.equal(second.fleet.deltas.shipped, 0);
  assert.equal(second.fleet.deltas.seats, 0);
  cache.previous_fleet.shipped = first.fleet.shipped - 1;
  const third = w.buildScoreboard(FIXTURE, { cache: cache, now: '2026-09-05T16:02:00Z' });
  assert.equal(third.fleet.deltas.shipped, 1);
});

test('D1: unreadable BUILD_LOG etag is stable across rebuilds', () => {
  const cache = { version: 1, first_seen: {}, previous_fleet: null };
  const first = w.buildScoreboard(FIXTURE, { cache: cache, now: '2026-09-05T16:00:00Z' });
  const glm = seatByName(first, 'glm');
  assert.equal(glm.identity.readable, false);
  assert.match(String(glm.identity.unreadable_error), /BUILD_LOG|not a file/i);
  const since = glm.identity.unreadable_since;
  assert.ok(since);
  assert.ok(first.etag);
  const second = w.buildScoreboard(FIXTURE, { cache: cache, now: '2026-09-05T16:30:00Z' });
  assert.equal(seatByName(second, 'glm').identity.unreadable_since, since);
  assert.equal(second.etag, first.etag);
  const third = w.buildScoreboard(FIXTURE, { cache: cache, now: '2026-09-05T17:00:00Z' });
  assert.equal(third.etag, first.etag);
  assert.equal(seatByName(third, 'glm').identity.unreadable_since, since);
  assert.ok(seatByName(third, 'quip').identity.readable);
});

test('A_B4: string first_seen does not break rebuild', () => {
  const shapes = ['oops', 'corrupt-string', 3, true, null, [], 'x'];
  for (const bad of shapes) {
    const cache = { version: 1, first_seen: bad, previous_fleet: null };
    const board = w.buildScoreboard(FIXTURE, { cache: cache, now: '2026-09-05T16:00:00Z' });
    assert.ok(board);
    assert.ok(Array.isArray(board.seats));
    assert.ok(board.fleet.seats >= 1);
    assert.equal(typeof cache.first_seen, 'object');
    assert.equal(Array.isArray(cache.first_seen), false);
    assert.ok(seatByName(board, 'quip').identity.readable);
    assert.ok(seatByName(board, 'opus').identity.readable);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-ab4-'));
  try {
    const cachePath = path.join(dir, 'scoreboard-cache.json');
    const outPath = path.join(dir, 'scoreboard.json');
    fs.writeFileSync(
      cachePath,
      JSON.stringify({ version: 1, first_seen: 'oops', previous_fleet: null })
    );
    const loaded = w.loadCache(cachePath);
    assert.deepEqual(loaded.first_seen, {});
    const board = w.rebuildTo(FIXTURE, outPath, cachePath, {});
    assert.ok(board, 'rebuildTo must not return null on string first_seen');
    assert.ok(board.fleet.seats >= 1);
    assert.ok(seatByName(board, 'quip').identity.readable);
    assert.ok(fs.existsSync(outPath));

    const garbagePath = path.join(dir, 'garbage-cache.json');
    fs.writeFileSync(garbagePath, '{not json');
    const recovered = w.loadCache(garbagePath);
    assert.deepEqual(recovered.first_seen, {});
    const recoveredBoard = w.rebuildTo(FIXTURE, path.join(dir, 'from-garbage.json'), garbagePath, {});
    assert.ok(recoveredBoard);
    assert.ok(recoveredBoard.fleet.seats >= 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('A_B2: BUILD_LOG stray bytes use UTF-8 replacement', () => {
  const src = fs.readFileSync(path.join(__dirname, 'scoreboard-watcher.js'), 'utf8');
  assert.match(src, /TextDecoder\(\s*['"]utf-8['"]\s*,\s*\{\s*fatal:\s*false\s*\}\s*\)/);
  assert.match(src, /UTF8_REPLACE\.decode\(fs\.readFileSync\(p\)\)/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-ab2-'));
  try {
    const root = path.join(dir, 'ait');
    fs.cpSync(FIXTURE, root, { recursive: true });
    const logPath = path.join(root, 'WindowSnap', 'BUILD_LOG.md');
    const payload = Buffer.concat([
      Buffer.from('# BUILD_LOG\n\nGATE TEST: PASS\n', 'utf8'),
      Buffer.from([0xff, 0xfe, 0xc0, 0x80]),
      Buffer.from('\nGATE DOCUMENTATION: PASS\nGATE EXAMPLES: PASS\n', 'utf8')
    ]);
    fs.writeFileSync(logPath, payload);
    const text = w.readText(logPath);
    assert.ok(text.includes('\uFFFD'));
    assert.match(text, /GATE TEST: PASS/);
    const board = w.buildScoreboard(root);
    assert.ok(board.fleet.seats >= 1);
    const quip = seatByName(board, 'quip');
    assert.equal(quip.identity.readable, true);
    const snap = quip.tools.find((t) => t.name === 'WindowSnap');
    assert.ok(snap);
    assert.equal(snap.build_log.gates.TEST, 'PASS');
    const rebuilt = w.rebuildTo(root, path.join(dir, 'scoreboard.json'), path.join(dir, 'scoreboard-cache.json'), {});
    assert.ok(rebuilt, 'rebuild must stay up on stray BUILD_LOG bytes');
    assert.ok(rebuilt.fleet.seats >= 1);
    assert.equal(seatByName(rebuilt, 'quip').identity.readable, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
