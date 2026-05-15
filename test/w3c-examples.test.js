'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runToString } = require('../src/index.js');

const root = path.join(__dirname, '..');
const w3cDir = path.join(root, 'examples', 'w3c');

function read(name) {
  return fs.readFileSync(path.join(w3cDir, name), 'utf8');
}

test('W3C draft example files are present', () => {
  const names = new Set(fs.readdirSync(w3cDir));
  for (const name of [
    'spec-2-1-basic-usage.srl',
    'spec-2-1-descended-from.srl',
    'spec-2-2-recursion.srl',
    'spec-2-3-filtering.srl',
    'spec-2-4-negation.srl',
    'spec-2-5-assignment.srl',
    'spec-2-5-assignment-with-negation.srl',
    'spec-4-1-srl-syntax.srl',
    'spec-4-2-rdf-rules-syntax.ttl',
  ]) {
    assert.equal(names.has(name), true, `${name} should exist`);
  }
});

test('W3C section 2.1 basic usage example runs', () => {
  const output = runToString(read('spec-2-1-basic-usage.srl'));
  assert.match(output, /:X :childOf :A \./);
  assert.match(output, /:X :childOf :B \./);
  assert.match(output, /:A :childOf :C \./);
});

test('W3C section 2.1 descendedFrom example runs', () => {
  const output = runToString(read('spec-2-1-descended-from.srl'));
  assert.match(output, /:A :descendedFrom :C \./);
  assert.match(output, /:X :descendedFrom :A \./);
  assert.match(output, /:X :descendedFrom :B \./);
});

test('W3C section 2.2 recursion example runs', () => {
  const output = runToString(read('spec-2-2-recursion.srl'));
  assert.match(output, /:X :descendedFrom :C \./);
});

test('W3C section 2.3 filtering example runs', () => {
  const output = runToString(read('spec-2-3-filtering.srl'));
  assert.match(output, /:town2 a :largeTown \./);
  assert.doesNotMatch(output, /:town1 a :largeTown/);
});

test('W3C section 2.4 negation example runs', () => {
  const output = runToString(read('spec-2-4-negation.srl'));
  assert.match(output, /:X3 a :UnclassifiedSize \./);
  assert.doesNotMatch(output, /:X1 a :UnclassifiedSize/);
  assert.doesNotMatch(output, /:X2 a :UnclassifiedSize/);
});

test('W3C section 2.5 assignment examples run', () => {
  const plain = runToString(read('spec-2-5-assignment.srl'));
  assert.match(plain, /:route1 :distanceKm 16\.0934 \./);
  assert.match(plain, /:route2 :distanceKm 8\.0467 \./);

  const guarded = runToString(read('spec-2-5-assignment-with-negation.srl'));
  assert.match(guarded, /:route1 :distanceKm 16\.0934 \./);
  assert.doesNotMatch(guarded, /:route2 :distanceKm/);
});

test('W3C section 4.1 SRL syntax example runs', () => {
  const output = runToString(read('spec-4-1-srl-syntax.srl'));
  assert.match(output, /:x :bothPositive true \./);
  assert.doesNotMatch(output, /:x :oneIsZero true/);
});

test('W3C section 4.2 RDF Rules syntax example runs', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'eyesharl.js'), '--syntax', 'rdf', path.join(w3cDir, 'spec-4-2-rdf-rules-syntax.ttl')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /:x :bothPositive true \./);
  assert.doesNotMatch(result.stdout, /:x :oneIsZero true/);
});

test('bundled CLI runs every W3C example file', () => {
  const files = fs.readdirSync(w3cDir).filter((name) => /\.(srl|ttl)$/i.test(name)).sort();
  for (const file of files) {
    const args = [path.join(root, 'eyesharl.js')];
    if (file.endsWith('.ttl')) args.push('--syntax', 'rdf');
    args.push(path.join(w3cDir, file));
    const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, `${file}\nSTDERR:\n${result.stderr}`);
    assert.equal(result.stderr, '', `${file} should not emit warnings`);
  }
});
