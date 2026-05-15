'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { run } = require('../src/index.js');

const root = path.join(__dirname, '..');
const deepTaxonomy10 = path.join(root, 'examples', 'deep-taxonomy-10.srl');
const deepTaxonomy100 = path.join(root, 'examples', 'deep-taxonomy-100.srl');
const deepTaxonomy = path.join(root, 'examples', 'deep-taxonomy-1000.srl');
const deepTaxonomy10000 = path.join(root, 'examples', 'deep-taxonomy-10000.srl');

test('small deep taxonomy examples reach the success flag', () => {
  for (const filename of [deepTaxonomy10, deepTaxonomy100]) {
    const result = run(readFileSync(filename, 'utf8'));
    const hasSuccess = result.closure.some((triple) => (
      triple.s.type === 'iri' && triple.s.value === 'http://example/test'
      && triple.p.type === 'iri' && triple.p.value === 'http://example/is'
      && triple.o.type === 'literal' && triple.o.value === true
    ));
    assert.equal(hasSuccess, true, filename);
  }
});


test('deep acyclic taxonomy does not trip the recursive fixpoint fuse', () => {
  const result = run(readFileSync(deepTaxonomy, 'utf8'));
  const hasSuccess = result.closure.some((triple) => (
    triple.s.type === 'iri' && triple.s.value === 'http://example/test'
    && triple.p.type === 'iri' && triple.p.value === 'http://example/is'
    && triple.o.type === 'literal' && triple.o.value === true
  ));
  assert.equal(hasSuccess, true);
  assert.ok(result.iterations > 1000, 'the acyclic layer count may exceed the recursive iteration fuse');
});

test('bundled CLI runs the deep taxonomy benchmark with default options', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'eyesharl.js'), deepTaxonomy], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /:test :is true \./);
  assert.match(result.stdout, /Deep Taxonomy - deep classification benchmark/);
  assert.doesNotMatch(result.stderr, /maxIterations/);
});


test('ten-thousand-step taxonomy is stack-safe and reaches the success flag', () => {
  const result = run(readFileSync(deepTaxonomy10000, 'utf8'));
  const hasTerminalClass = result.closure.some((triple) => (
    triple.s.type === 'iri' && triple.s.value === 'http://example/ind'
    && triple.p.type === 'iri' && triple.p.value === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
    && triple.o.type === 'iri' && triple.o.value === 'http://example/A2'
  ));
  const hasSuccess = result.closure.some((triple) => (
    triple.s.type === 'iri' && triple.s.value === 'http://example/test'
    && triple.p.type === 'iri' && triple.p.value === 'http://example/is'
    && triple.o.type === 'literal' && triple.o.value === true
  ));
  assert.equal(hasTerminalClass, true);
  assert.equal(hasSuccess, true);
  assert.equal(result.inferred.length, 30009);
});
