#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const entry = 'src/cli.js';
const output = 'eyesharl.js';
const modules = new Map();
const mappings = new Map();

function toPosix(file) {
  return file.split(path.sep).join('/');
}

function resolveModule(fromId, request) {
  if (!request.startsWith('.')) return null;
  const fromDir = path.dirname(fromId);
  let resolved = toPosix(path.normalize(path.join(fromDir, request)));
  if (!resolved.endsWith('.js')) resolved += '.js';
  return resolved;
}

function collect(id) {
  if (modules.has(id)) return;
  const abs = path.join(root, id);
  let source = fs.readFileSync(abs, 'utf8');
  source = source.replace(/^#!.*\n/, '');
  modules.set(id, source);

  const map = {};
  const re = /require\(['"]([^'"]+)['"]\)/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const request = match[1];
    const resolved = resolveModule(id, request);
    if (resolved) {
      map[request] = resolved;
      collect(resolved);
    }
  }
  mappings.set(id, map);
}

function js(value) {
  return JSON.stringify(value);
}

function build() {
  collect(entry);
  const chunks = [];
  chunks.push('#!/usr/bin/env node');
  chunks.push("'use strict';");
  chunks.push('(function () {');
  chunks.push('  const __nativeRequire = require;');
  chunks.push('  const __modules = {');
  for (const [id, source] of modules.entries()) {
    chunks.push(`    ${js(id)}: function (require, module, exports) {`);
    chunks.push(indent(source, 6));
    chunks.push('    },');
  }
  chunks.push('  };');
  chunks.push(`  const __mappings = ${js(Object.fromEntries(mappings.entries()))};`);
  chunks.push('  const __cache = {};');
  chunks.push('  function __require(id) {');
  chunks.push('    if (!id.startsWith("src/")) return __nativeRequire(id);');
  chunks.push('    if (__cache[id]) return __cache[id].exports;');
  chunks.push('    if (!__modules[id]) throw new Error("Bundled module not found: " + id);');
  chunks.push('    const module = { exports: {} };');
  chunks.push('    __cache[id] = module;');
  chunks.push('    const localRequire = function (request) {');
  chunks.push('      const mapped = (__mappings[id] && __mappings[id][request]) || request;');
  chunks.push('      return __require(mapped);');
  chunks.push('    };');
  chunks.push('    __modules[id](localRequire, module, module.exports);');
  chunks.push('    return module.exports;');
  chunks.push('  }');
  chunks.push(`  process.exitCode = __require(${js(entry)}).main(process.argv.slice(2));`);
  chunks.push('}());');
  chunks.push('');

  const outPath = path.join(root, output);
  fs.writeFileSync(outPath, chunks.join('\n'), 'utf8');
  fs.chmodSync(outPath, 0o755);
  console.log(`wrote ${output}`);
}

function indent(source, spaces) {
  const prefix = ' '.repeat(spaces);
  return source.split('\n').map((line) => prefix + line).join('\n');
}

build();
