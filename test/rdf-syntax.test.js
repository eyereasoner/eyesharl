'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const { parseRdfSyntax, runToString, compile } = require('../src/index.js');

const root = path.join(__dirname, '..');

function example(name) {
  return readFileSync(path.join(root, 'examples', 'rdf-syntax', name), 'utf8');
}

test('RDF Rules syntax parses srl:RuleSet, srl:data and srl:rules lists', () => {
  const program = parseRdfSyntax(example('basic-ruleset.ttl'), { filename: 'basic-ruleset.ttl' });
  assert.equal(program.rdfSyntax, true);
  assert.deepEqual(program.ruleSets, [':familyRules']);
  assert.equal(program.data.length, 2);
  assert.equal(program.rules.length, 3);
});

test('RDF Rules syntax reuses the stratified evaluator', () => {
  const output = runToString(example('basic-ruleset.ttl'), { filename: 'basic-ruleset.ttl' });
  assert.match(output, /:bob :childOf :alice \./);
  assert.match(output, /:alice :ancestorOf :carol \./);
});

test('RDF Rules filter, assignment, negation and sparql function nodes run', () => {
  const output = runToString(example('filter-assign-negation.ttl'), { filename: 'filter-assign-negation.ttl' });
  assert.match(output, /:alice :label "score-7" \./);
  assert.doesNotMatch(output, /:bob :label/);
});

test('RDF Rules syntax supports W3C-style triple terms in data blocks', () => {
  const program = parseRdfSyntax(example('w3c-rule-set-snippet.ttl'), { filename: 'w3c-rule-set-snippet.ttl' });
  assert.equal(program.data.length, 2);
  assert.equal(program.rules.length, 3);
  assert.equal(program.data[1].s.value, 'http://example/s1');
});

test('RDF Rules W3C-style snippet derives expected triples', () => {
  const output = runToString(example('w3c-rule-set-snippet.ttl'), { filename: 'w3c-rule-set-snippet.ttl' });
  assert.match(output, /:s :q :o \./);
  assert.match(output, /:s :q 18 \./);
});

test('RDF Rules syntax can select one srl:RuleSet from a file', () => {
  const source = `
PREFIX : <http://example/>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX srl: <http://www.w3.org/ns/shacl-rules#>
:one a srl:RuleSet ; srl:data ( [ srl:subject :a ; srl:predicate :p ; srl:object :b ] ) .
:two a srl:RuleSet ; srl:data ( [ srl:subject :x ; srl:predicate :p ; srl:object :y ] ) .
`;
  const compiled = compile(source, { syntax: 'rdf', ruleSet: ':two' });
  assert.equal(compiled.program.data.length, 1);
  assert.equal(compiled.program.data[0].s.value, 'http://example/x');
});
