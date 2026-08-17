#!/usr/bin/env node
/*
 * Minimal test runner. Zero dependencies, same as everything else here.
 *
 * Discovers test/*.test.js, runs them, prints a summary and exits non-zero on
 * the first failure so `npm test` is usable as a gate.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const results = [];
let currentSuite = '(root)';
let failures = 0;
let passes = 0;

function describe(name, fn) {
  const prev = currentSuite;
  currentSuite = prev === '(root)' ? name : `${prev} › ${name}`;
  try { fn(); } finally { currentSuite = prev; }
}

function it(name, fn) {
  const label = `${currentSuite} › ${name}`;
  const started = Date.now();
  try {
    fn();
    passes++;
    results.push({ ok: true, label, ms: Date.now() - started });
  } catch (err) {
    failures++;
    results.push({ ok: false, label, err, ms: Date.now() - started });
  }
}

/* ------------------------------------------------------------ asserts --- */

function fail(msg) { throw new Error(msg); }

const assert = {
  ok(v, msg) { if (!v) fail(msg || `expected truthy, got ${String(v)}`); },
  notOk(v, msg) { if (v) fail(msg || `expected falsy, got ${String(v)}`); },
  equal(a, b, msg) {
    if (a !== b) fail(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  },
  notEqual(a, b, msg) {
    if (a === b) fail(msg || `expected value to differ from ${JSON.stringify(b)}`);
  },
  close(a, b, tol, msg) {
    if (typeof a !== 'number' || !isFinite(a) || Math.abs(a - b) > tol) {
      fail(msg || `expected ${a} to be within ${tol} of ${b}`);
    }
  },
  deep(a, b, msg) {
    const sa = JSON.stringify(a), sb = JSON.stringify(b);
    if (sa !== sb) fail(msg || `expected ${sb}, got ${sa}`);
  },
  throws(fn, msg) {
    let threw = false;
    try { fn(); } catch (e) { threw = true; }
    if (!threw) fail(msg || 'expected function to throw');
  },
  doesNotThrow(fn, msg) {
    try { fn(); } catch (e) {
      fail(`${msg || 'expected no throw'}: ${e && e.message}\n${e && e.stack}`);
    }
  },
};

global.describe = describe;
global.it = it;
global.assert = assert;

/* --------------------------------------------------------------- run --- */

const dir = __dirname;
const files = fs.readdirSync(dir)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

if (!files.length) {
  console.error('no test files found');
  process.exit(1);
}

const started = Date.now();
for (const f of files) {
  require(path.join(dir, f));
}
const elapsed = Date.now() - started;

for (const r of results) {
  if (!r.ok) {
    console.log(`  ✗ ${r.label}`);
    const lines = String(r.err && r.err.stack ? r.err.stack : r.err).split('\n');
    for (const l of lines.slice(0, 8)) console.log(`      ${l}`);
  }
}

const slow = results.filter((r) => r.ok && r.ms > 1500).sort((a, b) => b.ms - a.ms);
if (slow.length) {
  console.log('  slowest:');
  for (const r of slow.slice(0, 5)) console.log(`      ${r.ms}ms  ${r.label}`);
}

console.log('');
console.log(`  ${passes} passed, ${failures} failed  (${files.length} files, ${elapsed}ms)`);
process.exit(failures ? 1 : 0);
