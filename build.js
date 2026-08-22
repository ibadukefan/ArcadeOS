#!/usr/bin/env node
/*
 * ArcadeOS build — plain Node, zero dependencies.
 *
 * Concatenates src/ into a single self-contained dist/arcade.html.
 * Source order matters: util defines the registry, games push onto it,
 * shell consumes it, boot starts the loop.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

/** Concatenation order. Games sit between render and shell. */
const CORE_PRE = [
  'core/util.js',
  'core/storage.js',
  'core/audio.js',
  'core/input.js',
  'core/render.js',
  'core/system.js',
];

/* Dashboard order. */
const GAMES = [
  'games/tetris.js',
  'games/ascent.js',
  'games/stack.js',
  'games/snake.js',
  'games/breakout.js',
  'games/climb.js',
  'games/pulse.js',
  'games/drop.js',
  'games/merge.js',
  'games/flap.js',
  'games/versus.js',
];

const CORE_POST = [
  'core/shell.js',
  'core/boot.js',
];

const SOURCES = [...CORE_PRE, ...GAMES, ...CORE_POST];

function read(rel) {
  const p = path.join(SRC, rel);
  if (!fs.existsSync(p)) throw new Error(`missing source file: ${rel}`);
  return fs.readFileSync(p, 'utf8');
}

/**
 * Build the JS bundle. Each module is wrapped in a labelled comment so stack
 * traces and `view-source:` stay navigable in the field.
 */
function bundleJs() {
  const parts = SOURCES.map((rel) => {
    let code = read(rel);
    // Strip a leading 'use strict' from modules; the bundle declares one.
    code = code.replace(/^\s*['"]use strict['"];?\s*\n/, '');
    return `/* ===== ${rel} ${'='.repeat(Math.max(0, 58 - rel.length))} */\n${code.trim()}\n`;
  });
  return `(function(){\n'use strict';\n\n${parts.join('\n')}\n})();\n`;
}

function bundleCss() {
  return read('styles.css').trim();
}

/**
 * Conservative minifier. Only does things that are safe without a parser:
 * strips full-line block comments and collapses leading indentation. We do not
 * touch identifiers, string contents, or line structure — a broken cabinet at
 * 2am is worth far more than the bytes saved.
 */
function minify(js) {
  return js
    .split('\n')
    .map((l) => l.replace(/^[ \t]+/, ''))
    .filter((l) => l !== '' && !/^\/\/ /.test(l) && !/^\/\* =====/.test(l))
    .join('\n');
}

function bundle(opts) {
  opts = opts || {};
  let js = bundleJs();
  if (opts.minify) js = minify(js);
  /*
   * Build id: a hash of the source, not a timestamp — the committed bundle
   * must rebuild byte-identically in CI, and a clock would break that. Shown
   * on the ABOUT and SOFTWARE UPDATE screens so a cabinet can say exactly
   * what it is running.
   */
  const buildId = crypto.createHash('sha256').update(js).digest('hex').slice(0, 8);
  js = `window.ARCADEOS_BUILD='${buildId}';\n` + js;
  const css = bundleCss();
  const html = read('index.html')
    .replace('/*{{CSS}}*/', () => css)
    .replace('/*{{JS}}*/', () => js);
  return { html, js, css };
}

function main() {
  const minifyFlag = process.argv.includes('--minify');
  const out = bundle({ minify: minifyFlag });
  fs.mkdirSync(DIST, { recursive: true });
  const target = path.join(DIST, 'arcade.html');
  fs.writeFileSync(target, out.html, 'utf8');

  const kb = (Buffer.byteLength(out.html, 'utf8') / 1024).toFixed(1);
  // A stray http(s) URL in the bundle means something reaches for the network.
  const external = out.html.match(/\b(?:https?:)?\/\/[a-z0-9-]+\.[a-z]{2,}/gi) || [];
  const offenders = external.filter((u) => !/\/\/(?:www\.)?(?:example|localhost)/i.test(u));

  console.log(`built dist/arcade.html  ${kb} KB  (${SOURCES.length} modules${minifyFlag ? ', minified' : ''})`);
  if (offenders.length) {
    console.error(`FAIL: external references found: ${[...new Set(offenders)].join(', ')}`);
    process.exit(1);
  }
}

module.exports = { bundle, bundleJs, bundleCss, SOURCES, SRC, DIST };

if (require.main === module) main();
