'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readFileSync } = require('node:fs');

const { parse, runToString } = require('../src/index.js');
const { builtinNames, validateArity, callBuiltin } = require('../src/builtins.js');

const root = path.join(__dirname, '..');

const SPEC_BUILTIN_CALL_NAMES = [
  'STR', 'LANG', 'LANGMATCHES', 'LANGDIR', 'DATATYPE', 'IRI', 'URI', 'BNODE',
  'ABS', 'CEIL', 'FLOOR', 'ROUND', 'CONCAT', 'SUBSTR', 'STRLEN', 'REPLACE',
  'UCASE', 'LCASE', 'ENCODE_FOR_URI', 'CONTAINS', 'STRSTARTS', 'STRENDS',
  'STRBEFORE', 'STRAFTER', 'YEAR', 'MONTH', 'DAY', 'HOURS', 'MINUTES',
  'SECONDS', 'TIMEZONE', 'TZ', 'NOW', 'UUID', 'STRUUID', 'IF', 'STRLANG',
  'STRLANGDIR', 'STRDT', 'sameTerm', 'isIRI', 'isURI', 'isBLANK', 'isLITERAL',
  'isNUMERIC', 'hasLANG', 'hasLANGDIR', 'REGEX', 'isTRIPLE', 'TRIPLE',
  'SUBJECT', 'PREDICATE', 'OBJECT',
];

test('BuiltInCall registry exactly covers the draft grammar names', () => {
  assert.deepEqual([...builtinNames()].sort(), [...SPEC_BUILTIN_CALL_NAMES].sort());
});

test('BuiltInCall arities are checked at the registry boundary', () => {
  assert.doesNotThrow(() => validateArity('CONCAT', 0));
  assert.doesNotThrow(() => validateArity('CONCAT', 4));
  assert.doesNotThrow(() => validateArity('BNODE', 0));
  assert.doesNotThrow(() => validateArity('BNODE', 1));
  assert.doesNotThrow(() => validateArity('SUBSTR', 2));
  assert.doesNotThrow(() => validateArity('SUBSTR', 3));
  assert.doesNotThrow(() => validateArity('REPLACE', 3));
  assert.doesNotThrow(() => validateArity('REGEX', 3));
  assert.throws(() => validateArity('NOW', 1), /NOW expects 0/);
  assert.throws(() => validateArity('STR', 0), /STR expects 1/);
  assert.throws(() => validateArity('SUBSTR', 4), /SUBSTR expects 2..3/);
});

test('unprefixed non-spec function names are rejected in expressions', () => {
  assert.throws(() => parse(`
PREFIX : <http://example/>
DATA { :x :label "Hello" . }
RULE { :x :bad true } WHERE { :x :label ?label . FILTER lower(?label) }
`), /Unknown built-in or unprefixed function call lower/);
});

test('the full BuiltInCall example runs and exercises representative results', () => {
  const source = readFileSync(path.join(root, 'examples', 'builtin-call-complete.srl'), 'utf8');
  const output = runToString(source, { now: new Date('2026-05-15T12:34:56Z') });
  assert.match(output, /:thing :datatype rdf:langString \./);
  assert.match(output, /:thing :iri <http:\/\/example\/base\/local> \./);
  assert.match(output, /:thing :timezone "PT2H30M"\^\^xsd:dayTimeDuration \./);
  assert.match(output, /:thing :tz "\+02:30" \./);
  assert.match(output, /:thing :ifResult "negative" \./);
  assert.match(output, /:thing :strlang "hello"@en \./);
  assert.match(output, /:thing :strlangdir "bonjour"@fr--ltr \./);
  assert.match(output, /:thing :triple <<\(:s :p :o\)>> \./);
  assert.match(output, /:thing :now "2026-05-15T12:34:56\.000Z"\^\^xsd:dateTime \./);
});

test('IF is lazy, so the unchosen branch may contain an erroring call', () => {
  const result = callBuiltin('IF', [false, () => { throw new Error('should not run'); }, 'safe']);
  assert.equal(result, 'safe');
  const output = runToString(`
PREFIX : <http://example/>
RULE { :x :ok ?value } WHERE { SET(?value := IF(false, :missingFunction(), "safe")) }
`);
  assert.match(output, /:x :ok "safe" \./);
});
