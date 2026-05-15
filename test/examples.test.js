'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { execFileSync, spawnSync } = require('node:child_process');
const { run, runToString } = require('../src/index.js');

const root = path.join(__dirname, '..');
const examplesDir = path.join(root, 'examples');

function example(name) {
  return fs.readFileSync(path.join(examplesDir, name), 'utf8');
}

function relativeExample(filename) {
  return path.relative(examplesDir, filename).split(path.sep).join('/');
}

function collectExampleFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'README.md') continue;
    const filename = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectExampleFiles(filename));
    else if (/\.(srl|ttl)$/i.test(entry.name)) out.push(filename);
  }
  return out.sort((a, b) => relativeExample(a).localeCompare(relativeExample(b)));
}

function importResolver(target) {
  if (!target.startsWith('file:')) throw new Error(`test import resolver only supports file: imports, got ${target}`);
  const filename = fileURLToPath(target);
  return {
    source: fs.readFileSync(filename, 'utf8'),
    options: { filename, baseIRI: pathToFileURL(filename).href },
  };
}

function runExampleFile(filename) {
  const source = fs.readFileSync(filename, 'utf8');
  return run(source, {
    filename,
    baseIRI: pathToFileURL(filename).href,
    importResolver,
    syntax: filename.endsWith('.ttl') ? 'rdf' : undefined,
  });
}

const expectedCheckExamples = new Map([
  ['check-unsafe.srl', { status: 0, pattern: /unsafe-head-variable|unbound head variable/ }],
  ['unstratified-negation.srl', { status: 1, pattern: /unstratified-negation|Unstratified negation/ }],
  ['variable-predicate-dependency.srl', { status: 1, pattern: /unstratified-negation|Unstratified negation/ }],
  ['well-formedness-error.srl', { status: 1, pattern: /unbound-filter-variable|FILTER uses \?score/ }],
]);

for (const filename of collectExampleFiles(examplesDir)) {
  const rel = relativeExample(filename);
  test(`example file runs: ${rel}`, () => {
    const expectedCheck = expectedCheckExamples.get(rel);
    if (expectedCheck) {
      const result = spawnSync(process.execPath, [path.join(root, 'eyesharl.js'), '--check', filename], { encoding: 'utf8' });
      assert.equal(result.status, expectedCheck.status, `${rel}\nSTDERR:\n${result.stderr}`);
      assert.match(result.stderr, expectedCheck.pattern, rel);
      return;
    }

    const result = runExampleFile(filename);
    assert.ok(Array.isArray(result.closure), rel);
    assert.ok(result.closure.length >= result.input.length, rel);
  });
}

test('family example derives descendants', () => {
  const output = runToString(example('family.srl'));
  assert.match(output, /:X :descendedFrom :A \./);
  assert.match(output, /:X :descendedFrom :B \./);
  assert.match(output, /:X :descendedFrom :C \./);
});

test('negation example excludes blocked people', () => {
  const output = runToString(example('negation.srl'));
  assert.match(output, /:alice :eligible true \./);
  assert.doesNotMatch(output, /:bob :eligible true \./);
});

test('assignment example creates deterministic literals', () => {
  const output = runToString(example('assignment.srl'));
  assert.match(output, /:alice :grade "pass-7" \./);
  assert.doesNotMatch(output, /:bob :grade/);
});

test('IF THEN example works', () => {
  const stdout = execFileSync(process.execPath, [path.join(root, 'src', 'cli.js'), path.join(examplesDir, 'if-then.srl')], { encoding: 'utf8' });
  assert.match(stdout, /:Socrates a :Mortal \./);
});

test('declarations example expands TRANSITIVE, SYMMETRIC, and INVERSE', () => {
  const output = runToString(example('declarations.srl'));
  assert.match(output, /:alice :parentOf :carol \./);
  assert.match(output, /:dora :spouseOf :alice \./);
  assert.match(output, /:bob :childOf :alice \./);
});

test('turtle-shortcuts example derives abbreviated head triples', () => {
  const output = runToString(example('turtle-shortcuts.srl'));
  assert.match(output, /:bob :knownBy :alice \./);
  assert.match(output, /:carol :scoredFor 8 \./);
});

test('base-and-literals example derives adult slug', () => {
  const output = runToString(example('base-and-literals.srl'));
  assert.match(output, /:alice :adult true \./);
  assert.match(output, /:alice :slug "alice-smith" \./);
  assert.doesNotMatch(output, /:bob :adult true/);
});

test('CLI --check reports unsafe example without running rules', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'src', 'cli.js'), '--check', path.join(examplesDir, 'check-unsafe.srl')], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /unsafe-head-variable|unbound head variable/);
  assert.equal(result.stdout, '');
});

test('bundled CLI can run with trace and stats', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'eyesharl.js'), '--trace', '--stats', path.join(examplesDir, 'if-then.srl')], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /:Socrates a :Mortal \./);
  assert.match(result.stderr, /rule#1|iterations=/);
});

test('query example prints projected bindings only when CLI --query is used', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'eyesharl.js'), '--query', '?person :ancestorOf ?descendant . FILTER(?person = :alice)', path.join(examplesDir, 'query.srl')], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\?descendant = :bob; \?person = :alice|\?person = :alice; \?descendant = :bob/);
  assert.match(result.stdout, /:carol/);
});

test('CLI --query-file evaluates the query-body example', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'eyesharl.js'), '--query-file', path.join(examplesDir, 'query-body.txt'), path.join(examplesDir, 'query.srl')], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\?x = :alice; \?y = :bob/);
  assert.match(result.stdout, /\?x = :alice; \?y = :carol/);
});

test('CLI --check --deps reports unstratified negation as an error', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'eyesharl.js'), '--check', '--deps', path.join(examplesDir, 'unstratified-negation.srl')], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unstratified-negation|Unstratified negation/);
  assert.match(result.stderr, /deps:/);
});

test('property-paths example derives sequence and inverse path facts', () => {
  const output = runToString(example('property-paths.srl'));
  assert.match(output, /:alice :grandparentOf :carol \./);
  assert.match(output, /:bob :hasParent :alice \./);
});

test('version-and-in example supports VERSION and IN operators', () => {
  const output = runToString(example('version-and-in.srl'));
  assert.match(output, /:alice :priority true \./);
  assert.match(output, /:carol :priority true \./);
  assert.match(output, /:bob :ordinary true \./);
});

test('stratified-negation example evaluates negative dependencies by layer', () => {
  const output = runToString(example('stratified-negation.srl'));
  assert.match(output, /:bob :eligible true \./);
  assert.match(output, /:carol :blocked true \./);
  assert.doesNotMatch(output, /:carol :eligible true/);
});

test('CLI loads local IMPORTS before evaluation', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'src', 'cli.js'), path.join(examplesDir, 'import-main.srl')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /:alice :ancestorOf :carol \./);
});

test('collections-and-blank-nodes example runs', () => {
  const output = runToString(example('collections-and-blank-nodes.srl'));
  assert.match(output, /:alice :knowsNamed "Bob" \./);
  assert.match(output, /:team :firstMember :alice \./);
});

test('reification-and-annotations example runs', () => {
  const output = runToString(example('reification-and-annotations.srl'));
  assert.match(output, /:alice :statementSource :chat \./);
  assert.match(output, /:bob :statementSource :email \./);
});

test('spec-builtins example runs', () => {
  const output = runToString(example('spec-builtins.srl'));
  assert.match(output, /:event :year 2026 \./);
  assert.match(output, /:event :month 5 \./);
  assert.match(output, /:event :tripleSubject :subject \./);
});

test('filter-function-and-langdir example runs', () => {
  const output = runToString(example('filter-function-and-langdir.srl'));
  assert.match(output, /:n1 :negative true \./);
  assert.match(output, /:msg :languageDirection "ltr" \./);
});

test('unicode-and-signed-numbers example runs', () => {
  const output = runToString(example('unicode-and-signed-numbers.srl'));
  assert.match(output, /:sample :unicodeDecoded true \./);
  assert.match(output, /:thermo :belowZero true \./);
});

test('reifiers example runs with rdf:reifies-based matching', () => {
  const output = runToString(example('reifiers.srl'));
  assert.match(output, /:alice :statementSource :chat \./);
  assert.match(output, /:bob :statementSource :email \./);
  assert.match(output, /:claim1 :isClaim true \./);
});

test('NOW and language builtins example runs', () => {
  const output = runToString(example('now-and-language-builtins.srl'), { now: new Date('2026-05-15T12:34:56Z') });
  assert.match(output, /:msg :sameLanguageLiteral true \./);
  assert.match(output, /:clock :snapshot "2026-05-15T12:34:56\.000Z"\^\^xsd:dateTime \./);
});
