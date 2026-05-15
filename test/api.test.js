'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, compile, run, runToString } = require('../src/index.js');

test('parse reads prefixes, data, and rules', () => {
  const program = parse(`
PREFIX : <http://example/>
DATA { :A :p :B . }
RULE { ?x :q ?y } WHERE { ?x :p ?y }
`);
  assert.equal(program.prefixes[''], 'http://example/');
  assert.equal(program.data.length, 1);
  assert.equal(program.rules.length, 1);
  assert.equal(Object.hasOwn(program, 'queries'), false);
});

test('forward chaining derives a recursive closure', () => {
  const source = `
PREFIX : <http://example/>
DATA { :A :parentOf :B . :B :parentOf :C . }
RULE { ?x :ancestorOf ?y } WHERE { ?x :parentOf ?y }
RULE { ?x :ancestorOf ?z } WHERE { ?x :parentOf ?y . ?y :ancestorOf ?z }
`;
  const output = runToString(source);
  assert.match(output, /:A :ancestorOf :B \./);
  assert.match(output, /:A :ancestorOf :C \./);
});

test('FILTER, NOT, and SET work together', () => {
  const source = `
PREFIX : <http://example/>
DATA { :alice :score 7 . :bob :score 2 . :bob :blocked true . }
RULE { ?x :label ?label } WHERE {
  ?x :score ?score .
  FILTER(?score >= 5) .
  NOT { ?x :blocked true } .
  SET(?label := concat("score-", str(?score)))
}
`;
  const output = runToString(source);
  assert.match(output, /:alice :label "score-7" \./);
  assert.doesNotMatch(output, /:bob :label/);
});

test('API returns inferred and closure separately', () => {
  const result = run(`
PREFIX : <http://example/>
DATA { :Socrates a :Man . }
RULE { ?x a :Mortal } WHERE { ?x a :Man }
`);
  assert.equal(result.input.length, 1);
  assert.equal(result.inferred.length, 1);
  assert.equal(result.closure.length, 2);
});

test('BASE resolves relative IRIs and default prefix', () => {
  const output = runToString(`
BASE <http://example/base/>
PREFIX : <>
DATA { <alice> :knows <bob> . }
RULE { ?x :friend ?y } WHERE { ?x :knows ?y }
`);
  assert.match(output, /:alice :friend :bob \./);
});

test('Turtle-style semicolon and comma abbreviations expand triples', () => {
  const output = runToString(`
PREFIX : <http://example/>
DATA { :alice :knows :bob, :carol ; :score 9 . }
RULE { ?friend :knownBy ?person ; :scoredFor ?score } WHERE {
  ?person :knows ?friend ; :score ?score .
}
`);
  assert.match(output, /:bob :knownBy :alice \./);
  assert.match(output, /:carol :knownBy :alice \./);
  assert.match(output, /:bob :scoredFor 9 \./);
});

test('typed and language-tagged literals work with builtins', () => {
  const output = runToString(`
PREFIX : <http://example/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
DATA { :alice :name "Alice Smith"@en ; :age "22"^^xsd:integer . }
RULE { :alice :slug ?slug } WHERE {
  :alice :name ?name ; :age ?age .
  FILTER(datatype(?age) = xsd:integer && ?age >= 18 && lang(?name) = "en") .
  SET(?slug := REPLACE(LCASE(STR(?name)), " ", "-"))
}
`);
  assert.match(output, /:alice :slug "alice-smith" \./);
});

test('compile reports unsafe head variables and strict mode rejects them', () => {
  const source = `
PREFIX : <http://example/>
DATA { :alice :knows :bob . }
RULE { ?x :bad true } WHERE { :alice :knows :bob }
`;
  const { diagnostics } = compile(source);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, 'unsafe-head-variable');
  assert.throws(() => compile(source, { strict: true }), /Strict mode failed/);
});


test('CLI-style raw query body projects bindings over the closure', () => {
  const { runQuery, formatBindings } = require('../src/index.js');
  const result = runQuery(`
PREFIX : <http://example/>
DATA { :alice :parentOf :bob . :bob :parentOf :carol . }
RULE { ?x :ancestorOf ?y } WHERE { ?x :parentOf ?y }
RULE { ?x :ancestorOf ?z } WHERE { ?x :parentOf ?y . ?y :ancestorOf ?z }
`, ':alice :ancestorOf ?d');
  const output = formatBindings(result.query.bindings, result.prefixes, result.query.select);
  assert.match(output, /\?d = :bob/);
  assert.match(output, /\?d = :carol/);
});

test('parseQuery accepts raw body text and rejects non-SRL QUERY/SELECT syntax', () => {
  const { parseQuery } = require('../src/index.js');
  const raw = parseQuery('?x :p ?y', { prefixes: { '': 'http://example/' } });
  assert.equal(raw.body.length, 1);
  const braced = parseQuery('{ ?x :p :y }', { prefixes: { '': 'http://example/' } });
  assert.equal(braced.body.length, 1);
  assert.throws(() => parseQuery('QUERY ?x WHERE { ?x :p :y }'), /not part of the SHACL Rules SRL grammar/);
  assert.throws(() => parseQuery('SELECT ?x WHERE { ?x :p :y }'), /not part of the SHACL Rules SRL grammar/);
});

test('top-level QUERY, SELECT, and N3 implication are not accepted as SRL', () => {
  assert.throws(() => parse('PREFIX : <http://example/> QUERY ?x WHERE { ?x :p :y }'), /Expected PREFIX, BASE, VERSION, IMPORTS, DATA, RULE, IF, TRANSITIVE, SYMMETRIC, or INVERSE/);
  assert.throws(() => parse('PREFIX : <http://example/> SELECT ?x WHERE { ?x :p :y }'), /Expected PREFIX, BASE, VERSION, IMPORTS, DATA, RULE, IF, TRANSITIVE, SYMMETRIC, or INVERSE/);
  assert.throws(() => parse('PREFIX : <http://example/> { ?x :p :y } => { ?x :q :y }'), /Expected PREFIX, BASE, VERSION, IMPORTS, DATA, RULE, IF, TRANSITIVE, SYMMETRIC, or INVERSE/);
});

test('IF THEN rule form works', () => {
  const output = runToString(`
PREFIX : <http://example/>
DATA { :Socrates a :Man . }
IF { ?x a :Man } THEN { ?x a :Mortal }
`);
  assert.match(output, /:Socrates a :Mortal \./);
});

test('declaration abbreviations expand to rules', () => {
  const output = runToString(`
PREFIX : <http://example/>
DATA { :alice :parentOf :bob . :bob :parentOf :carol . :alice :spouseOf :dora . :alice :hasChild :bob . }
TRANSITIVE(:parentOf)
SYMMETRIC(:spouseOf)
INVERSE(:hasChild, :childOf)
`);
  assert.match(output, /:alice :parentOf :carol \./);
  assert.match(output, /:dora :spouseOf :alice \./);
  assert.match(output, /:bob :childOf :alice \./);
});

test('analysis rejects recursive negation through dependency graph', () => {
  const source = `
PREFIX : <http://example/>
DATA { :alice :person true . }
RULE { ?x :in true } WHERE { ?x :person true . NOT { ?x :out true } }
RULE { ?x :out true } WHERE { ?x :person true . NOT { ?x :in true } }
`;
  const { compile } = require('../src/index.js');
  assert.throws(() => compile(source), /Unstratified negation/);
  const unchecked = compile(source, { throwOnDiagnostics: false });
  assert.equal(unchecked.analysis.errors[0].code, 'unstratified-negation');
});

test('VERSION, blank nodes, single-quoted strings, and IN/NOT IN expressions parse and run', () => {
  const result = run(`
VERSION "1.2"
PREFIX : <http://example/>
DATA { _:a :level 'gold' . :bob :level 'bronze' . }
RULE { ?x :priority true } WHERE { ?x :level ?level . FILTER(?level IN ('gold', 'platinum')) }
RULE { ?x :ordinary true } WHERE { ?x :level ?level . FILTER(?level NOT IN ('gold', 'platinum')) }
`);
  const output = require('../src/index.js').formatTriples(result.inferred, result.prefixes);
  assert.equal(result.version, '1.2');
  assert.match(output, /_:a :priority true \./);
  assert.match(output, /:bob :ordinary true \./);
});

test('body property paths support sequence and inverse paths', () => {
  const output = runToString(`
PREFIX : <http://example/>
DATA { :alice :parentOf :bob . :bob :parentOf :carol . }
RULE { ?x :grandparentOf ?z } WHERE { ?x :parentOf/:parentOf ?z }
RULE { ?child :hasParent ?parent } WHERE { ?child ^:parentOf ?parent }
`);
  assert.match(output, /:alice :grandparentOf :carol \./);
  assert.match(output, /:bob :hasParent :alice \./);
  assert.match(output, /:carol :hasParent :bob \./);
});

test('stratified evaluation prevents source-order negation mistakes', () => {
  const output = runToString(`
PREFIX : <http://example/>
DATA { :bob a :Person . :carol a :Person ; :flagged true . }
RULE { ?x :eligible true } WHERE { ?x a :Person . NOT { ?x :blocked true } }
RULE { ?x :blocked true } WHERE { ?x :flagged true }
`);
  assert.match(output, /:bob :eligible true \./);
  assert.match(output, /:carol :blocked true \./);
  assert.doesNotMatch(output, /:carol :eligible true/);
});

test('IMPORTS can be resolved by the API without duplicate cycles', () => {
  const files = {
    'file:///main.srl': 'PREFIX : <http://example/> IMPORTS <lib.srl> DATA { :alice :parentOf :bob . :bob :parentOf :carol . }',
    'file:///lib.srl': 'PREFIX : <http://example/> IMPORTS <main.srl> RULE { ?x :ancestorOf ?y } WHERE { ?x :parentOf ?y } RULE { ?x :ancestorOf ?z } WHERE { ?x :parentOf ?y . ?y :ancestorOf ?z }',
  };
  const output = runToString(files['file:///main.srl'], {
    baseIRI: 'file:///main.srl',
    importResolver(target) {
      return { source: files[target], options: { baseIRI: target, filename: target } };
    },
  });
  assert.match(output, /:alice :ancestorOf :carol \./);
});


test('non-spec optional rule names are rejected', () => {
  assert.throws(() => parse('PREFIX : <http://example/> RULE :named { ?x :q ?y } WHERE { ?x :p ?y }'), /Expected \{/);
});

test('blank-node property lists and RDF collections expand into graph patterns', () => {
  const output = runToString(`
PREFIX : <http://example/>
DATA {
  :alice :knows [ :name "Bob" ; :tag "friend" ] .
  :team :members ( :alice :bob ) .
}
RULE { ?x :knowsNamed ?name } WHERE { ?x :knows [ :name ?name ] }
RULE { :team :firstMember ?first } WHERE { :team :members/rdf:first ?first }
`);
  assert.match(output, /:alice :knowsNamed "Bob" \./);
  assert.match(output, /:team :firstMember :alice \./);
});

test('reified triple terms and annotation blocks can be matched', () => {
  const output = runToString(`
PREFIX : <http://example/>
DATA {
  :alice :says :hello {| :source :chat |} .
  << :bob :says :hi >> :source :email .
}
RULE { ?speaker :statementSource ?source } WHERE { << ?speaker :says ?object >> :source ?source }
`);
  assert.match(output, /:alice :statementSource :chat \./);
  assert.match(output, /:bob :statementSource :email \./);
});

test('$ variables, BNODE, TRIPLE accessors, and date builtins work', () => {
  const output = runToString(`
PREFIX : <http://example/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
DATA { :event :when "2026-05-15T10:20:30Z"^^xsd:dateTime . }
RULE { :event :year $year ; :blank $blank ; :tripleSubject $subject } WHERE {
  :event :when $when .
  SET($year := YEAR($when))
  SET($blank := BNODE("event"))
  SET($triple := TRIPLE(:subject, :predicate, :object))
  SET($subject := SUBJECT($triple))
}
`);
  assert.match(output, /:event :year 2026 \./);
  assert.match(output, /:event :blank _:event \./);
  assert.match(output, /:event :tripleSubject :subject \./);
});

test('sequential well-formedness rejects variables used before binding', () => {
  const source = `
PREFIX : <http://example/>
DATA { :alice :score 10 . }
RULE { :alice :bad true } WHERE { FILTER(?score > 5) . :alice :score ?score }
`;
  assert.throws(() => compile(source), /FILTER uses \?score before it is bound/);
  const checked = compile(source, { throwOnDiagnostics: false });
  assert.equal(checked.analysis.errors[0].code, 'unbound-filter-variable');
});


test('FILTER accepts direct built-in calls and language-direction literals retain direction', () => {
  const output = runToString(`
PREFIX : <http://example/>
DATA { :n1 :value -3.5 . :n2 :value 7 . :msg :text "bonjour"@fr--ltr . }
RULE { ?x :negative true } WHERE { ?x :value ?v . FILTER isNUMERIC(?v) . FILTER(?v < 0) }
RULE { :msg :dir ?dir } WHERE { :msg :text ?text . SET(?dir := LANGDIR(?text)) }
`);
  assert.match(output, /:n1 :negative true \./);
  assert.doesNotMatch(output, /:n2 :negative true/);
  assert.match(output, /:msg :dir "ltr" \./);
});

test('IRI-named function calls can be supplied as custom API builtins', () => {
  const output = runToString(`
PREFIX : <http://example/>
DATA { :alice :name "Alice" . :bob :name "Bob" . }
RULE { ?x :aName true } WHERE { ?x :name ?name . FILTER :startsWithA(?name) }
`, {
    builtins: {
      'http://example/startsWithA': ([value], helpers) => helpers.termToString(value).startsWith('A'),
    },
  });
  assert.match(output, /:alice :aName true \./);
  assert.doesNotMatch(output, /:bob :aName true/);
});

test('Unicode escapes and signed numeric RDF terms parse in data blocks', () => {
  const output = runToString(`
PREFIX : <http://example/>
DATA { :sample :text "A\\u0042\\U00000043" . :thermo :delta -12 . }
RULE { :sample :unicodeDecoded true } WHERE { :sample :text "ABC" }
RULE { :thermo :belowZero true } WHERE { :thermo :delta ?d . FILTER(?d < 0) }
`);
  assert.match(output, /:sample :unicodeDecoded true \./);
  assert.match(output, /:thermo :belowZero true \./);
});

test('dependency analysis accounts for variable predicates in rule heads and bodies', () => {
  const source = `
PREFIX : <http://example/>
DATA { :a :source :blocked . }
RULE { ?x ?p true } WHERE { ?x :source ?p . NOT { ?x :blocked true } }
RULE { ?x :blocked true } WHERE { ?x ?anyPredicate true }
`;
  assert.throws(() => compile(source), /Unstratified negation/);
  const checked = compile(source, { throwOnDiagnostics: false });
  assert.equal(checked.analysis.errors[0].code, 'unstratified-negation');
});

test('RDF 1.2 reifiers expand through rdf:reifies and can be bound', () => {
  const output = runToString(`
PREFIX : <http://example/>
DATA {
  :alice :says :hello ~ :claim1 {| :source :chat |} .
  << :bob :says :hi ~ :claim2 >> :source :email .
}
RULE { ?speaker :statementSource ?source } WHERE {
  ?claim rdf:reifies <<(?speaker :says ?object)>> .
  ?claim :source ?source .
}
RULE { ?claim :isClaim true } WHERE { ?claim rdf:reifies <<(?speaker :says ?object)>> }
`);
  assert.match(output, /:alice :statementSource :chat \./);
  assert.match(output, /:bob :statementSource :email \./);
  assert.match(output, /:claim1 :isClaim true \./);
  assert.match(output, /:claim2 :isClaim true \./);
});

test('STRLANG and STRLANGDIR produce language-tagged literals comparable with parsed literals', () => {
  const output = runToString(`
PREFIX : <http://example/>
DATA { :msg :plain "hello"@en ; :directed "bonjour"@fr--ltr . }
RULE { :msg :plainRoundTrip true } WHERE {
  :msg :plain ?text .
  SET(?copy := STRLANG("hello", "en"))
  FILTER sameTerm(?text, ?copy)
}
RULE { :msg :directedRoundTrip true } WHERE {
  :msg :directed ?text .
  SET(?copy := STRLANGDIR("bonjour", "fr", "ltr"))
  FILTER sameTerm(?text, ?copy)
}
`);
  assert.match(output, /:msg :plainRoundTrip true \./);
  assert.match(output, /:msg :directedRoundTrip true \./);
});

test('NOW uses the same timestamp throughout one evaluation when supplied by the caller', () => {
  const output = runToString(`
PREFIX : <http://example/>
RULE { :clock :consistent true ; :snapshot ?t1 } WHERE {
  SET(?t1 := NOW())
  SET(?t2 := NOW())
  FILTER sameTerm(?t1, ?t2)
}
`, { now: new Date('2026-05-15T12:34:56Z') });
  assert.match(output, /:clock :consistent true \./);
  assert.match(output, /:clock :snapshot "2026-05-15T12:34:56\.000Z"\^\^xsd:dateTime \./);
});
