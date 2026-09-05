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

test('JSON shape from fixture tree', () => {
  const board = w.buildScoreboard(FIXTURE, { now: '2026-09-05T16:00:00Z' });
  assert.equal(board.schema_version, 1);
  assert.equal(board.generated_at, '2026-09-05T16:00:00Z');
  assert.ok(board.root);
  for (const key of ['fleet', 'seats', 'head_to_head', 'records', 'grail_formula']) {
    assert.ok(board[key], 'missing ' + key);
  }
  assert.equal(board.fleet.seats, 3);
  assert.equal(board.fleet.readable, 2);
  assert.equal(board.fleet.unreadable, 1);
  assert.equal(board.seats.length, 3);

  const quip = seatByName(board, 'quip');
  const opus = seatByName(board, 'opus');
  const broken = seatByName(board, 'broken');
  assert.ok(quip && opus && broken);
  assert.equal(quip.identity.runtime, 'Hermes desktop');
  assert.equal(opus.identity.runtime, 'Claude Opus');
  assert.equal(quip.identity.readable, true);
  assert.equal(broken.identity.readable, false);
  assert.ok(broken.identity.unreadable_since);
  assert.ok(broken.identity.unreadable_error);

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
  assert.ok(quip.events.length > 50 || quip.events.length >= 16);
  assert.ok(Array.isArray(quip.file_stats));
  assert.ok(quip.file_stats.some((f) => f.path.indexOf('.state/quip.json') !== -1 && f.exists));
  assert.ok(quip.tools.some((t) => t.name === 'WindowSnap' && t.production_v2));
  assert.ok(quip.tasks['4'].fields.gates.TEST === 'PASS' || quip.tools.find((t) => t.name === 'WindowSnap').build_log.gates.TEST === 'PASS');

  assert.ok(board.head_to_head.length >= 1);
  assert.equal(board.head_to_head[0].grail.lead, 'quip');
  assert.equal(board.records.highest_grail.seat, 'quip');
  assert.equal(board.records.most_shipped.seat, 'quip');
  assert.equal(board.records.fastest_median.seat, 'quip');
});

test('Grail Score arithmetic (pure and from fixture)', () => {
  const pure = w.computeGrailScore({
    shipped: 2,
    firstTryClears: 14,
    totalClears: 15,
    noveltyScores: [93, 78, 88],
    minutesPerShipped: [60, 90]
  });
  const shipped = 40 * 2 / 10;
  const first = 25 * 14 / 15;
  const novelty = 20 * ((93 + 78 + 88) / 3) / 100;
  const speed = 15 * (1 - 75 / 240);
  assert.equal(pure.parts.shipped, round2(shipped));
  assert.equal(pure.parts.first_try, round2(first));
  assert.equal(pure.parts.novelty, round2(novelty));
  assert.equal(pure.parts.speed, round2(speed));
  assert.equal(pure.total, round2(round2(shipped) + round2(first) + round2(novelty) + round2(speed)));
  assert.equal(pure.inputs.median_minutes_per_shipped, 75);
  assert.equal(pure.inputs.shipped_cap, 10);
  assert.equal(pure.inputs.speed_ref_minutes, 240);

  const empty = w.computeGrailScore({
    shipped: 0,
    firstTryClears: 0,
    totalClears: 0,
    noveltyScores: [],
    minutesPerShipped: []
  });
  assert.equal(empty.total, 0);

  const board = w.buildScoreboard(FIXTURE);
  const quip = seatByName(board, 'quip');
  const opus = seatByName(board, 'opus');
  assert.equal(quip.grail.inputs.shipped, 2);
  assert.equal(quip.grail.inputs.total_clears, 15);
  assert.equal(quip.grail.inputs.first_try_clears, 14);
  assert.equal(quip.grail.inputs.median_minutes_per_shipped, 75);
  assert.equal(quip.grail.inputs.novelty_n, 3);
  assert.equal(quip.grail.total, pure.total);

  const opusPure = w.computeGrailScore({
    shipped: 1,
    firstTryClears: 7,
    totalClears: 8,
    noveltyScores: [71],
    minutesPerShipped: [180]
  });
  assert.equal(opus.grail.inputs.shipped, 1);
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

test('never crashes on a bad seat file', () => {
  const board = w.buildScoreboard(FIXTURE);
  const broken = seatByName(board, 'broken');
  assert.equal(broken.identity.readable, false);
  assert.ok(broken.identity.unreadable_error);
  assert.equal(broken.grail.total, 0);
  const quip = seatByName(board, 'quip');
  assert.equal(quip.identity.readable, true);
});
