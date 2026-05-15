# Eyesharl Handbook

This handbook explains Eyesharl both as JavaScript code and as a reasoning machine. It is written for a computer science student who knows basic programming, data structures, and logic, but may not yet know RDF, SHACL Rules, or forward-chaining reasoners.

The chapters are meant to be read linearly. Each chapter also stands on its own, so you can jump directly to the parser, the evaluator, dependency analysis, imports, or the command-line interface when you need that part.

## 1. What Eyesharl Is

Eyesharl is a compact JavaScript implementation experiment for the Shape Rules Language, or SRL, from the SHACL 1.2 Rules draft.

A tiny Eyesharl program looks like this:

```srl
PREFIX : <http://example/>

DATA {
  :Socrates a :Man .
}

RULE { ?x a :Mortal } WHERE { ?x a :Man }
```

The data says that Socrates is a man. The rule says that every man is mortal. Eyesharl applies the rule and derives:

```srl
:Socrates a :Mortal .
```

Eyesharl is deliberately small. It has no runtime dependencies and avoids parser generators, RDF databases, and SPARQL engines. The point is that the whole reasoning pipeline can be read as ordinary JavaScript.

The main pieces are:

1. tokenization,
2. parsing,
3. RDF-like term representation,
4. triple storage and indexing,
5. pattern matching,
6. expression evaluation,
7. dependency analysis and stratification,
8. forward-chaining evaluation,
9. query-as-an-operation,
10. CLI output and bundling.

Eyesharl is not a standards conformance claim. It is a learning implementation that follows the SRL draft where it implements a feature, while staying honest about missing features.

## 2. The Reasoning Model

Eyesharl reasons over triples. A triple has this shape:

```text
subject predicate object
```

For example:

```srl
:alice :parentOf :bob .
```

means:

```text
subject   = :alice
predicate = :parentOf
object    = :bob
```

A rule has a body and a head:

```srl
RULE { head } WHERE { body }
```

The body is a pattern to match against known triples. The head is a template for new triples. When the body matches, variables in the head are replaced by values from the match.

For example:

```srl
RULE { ?child :childOf ?parent } WHERE { ?parent :parentOf ?child }
```

If the graph contains:

```srl
:alice :parentOf :bob .
```

then the body matches with:

```text
?parent = :alice
?child  = :bob
```

Substitution into the head creates:

```srl
:bob :childOf :alice .
```

The closure is the set of all facts known after all rules have fired until no new triples can be added.

## 3. Project Layout

The project is organized as small CommonJS modules:

```text
src/tokenizer.js   source text -> tokens
src/parser.js      tokens -> program object
src/term.js        terms, keys, equality, formatting
src/store.js       triple set, predicate index, matching, paths
src/builtins.js    expression evaluation and built-in functions
src/analyze.js     static diagnostics, dependencies, strata
src/engine.js      layered forward-chaining evaluator
src/query.js       external raw-body query operation
src/format.js      text and JSON output
src/api.js         public JavaScript API and import merging
src/cli.js         command-line interface
tools/bundle.js    self-contained bundle generator
test/*.test.js     Node built-in test suite
examples/*.srl     runnable SRL examples
```

A good reading order is:

1. `term.js`, because all other modules manipulate terms.
2. `tokenizer.js`, because it defines lexical units.
3. `parser.js`, because it builds the program object.
4. `store.js`, because matching is the core data operation.
5. `builtins.js`, because filters and assignments use expressions.
6. `analyze.js`, because rule dependencies control safe execution.
7. `engine.js`, because it performs inference.
8. `api.js` and `cli.js`, because they connect the machine to users.

## 4. Terms: The Atoms of the Machine

The file `src/term.js` defines the values that can appear in triples and bindings.

Eyesharl uses plain JavaScript objects:

```js
{ type: 'iri', value: 'http://example/alice' }
{ type: 'var', value: 'x' }
{ type: 'blank', value: 'b1' }
{ type: 'literal', value: 22, datatype: 'http://www.w3.org/2001/XMLSchema#integer', lang: null }
```

It also has a representation for triple terms:

```js
{ type: 'triple', s, p, o }
```

The important operations are:

- `termKey(term)`, which creates a stable string key,
- `termEquals(a, b)`, which compares terms by key,
- `formatTerm(term, prefixes)`, which prints a compact SRL-like form,
- `valueToTerm(value)`, which turns JavaScript values into literal terms.

Reasoning depends on exact identity. Two IRIs match only if their expanded strings match. Two literals match only if their lexical value, datatype, and language tag match.

## 5. Tokenization

The tokenizer reads characters and emits tokens. A token is a record such as:

```js
{ type: 'word', value: 'RULE', line: 5, column: 1 }
```

The tokenizer recognizes:

- comments beginning with `#`,
- IRI references such as `<http://example/alice>`,
- single, double, and long string literals,
- variables such as `?x` and `$x`,
- numbers,
- punctuation such as `{`, `}`, `(`, `)`, `.`, `,`, and `;`,
- operators such as `:=`, `=`, `!=`, `<`, `<=`, `>=`, `&&`, `||`, `/`, and `^`,
- triple-term delimiters `<<(` and `)>>`.

The tokenizer does not know what a valid rule is. It only turns raw text into a stream of pieces. Grammar decisions are made by the parser.

Location data is preserved so syntax errors can point to useful line and column positions.

## 6. Parsing a Rule Set

The parser turns tokens into a program object:

```js
{
  baseIRI,
  version,
  imports,
  prefixes,
  data,
  rules
}
```

The supported top-level SRL forms include:

```srl
BASE <http://example/base/>
PREFIX : <http://example/>
VERSION "1.2"
IMPORTS <other-rules.srl>

DATA { :alice :parentOf :bob . }
RULE { ?x :ancestorOf ?y } WHERE { ?x :parentOf ?y }
IF { ?x a :Man } THEN { ?x a :Mortal }
TRANSITIVE(:parentOf)
SYMMETRIC(:spouseOf)
INVERSE(:hasChild, :childOf)
```

The parser expands `TRANSITIVE`, `SYMMETRIC`, and `INVERSE` into ordinary rules. This keeps the evaluator simple: it evaluates rules, not special declarations.

The parser intentionally rejects optional rule-name syntax such as:

```srl
RULE :myRule { ... } WHERE { ... }
```

That form was useful in earlier prototypes, but it is not part of the SRL grammar used by Eyesharl now.

## 7. Data, Heads, and Bodies

A `DATA` block contributes input triples.

A rule head is a list of triple templates:

```srl
RULE {
  ?x :q ?y .
  ?x :seen true .
}
WHERE { ?x :p ?y }
```

A rule body is a list of clauses. Eyesharl uses these internal shapes:

```js
{ type: 'triple', triple }
{ type: 'path', triple }
{ type: 'filter', expr }
{ type: 'not', body }
{ type: 'set', variable: 'x', expr }
```

A normal triple body clause matches one triple. A path body clause matches a restricted property path. A filter keeps or rejects bindings. A `NOT` clause performs negation as failure. A `SET` clause computes a new variable.

## 8. Turtle-Style Abbreviations

SRL’s grammar uses Turtle-like predicate and object lists. Eyesharl supports examples such as:

```srl
DATA {
  :alice :knows :bob, :carol ;
         :score 9 .
}
```

This expands to three triples:

```srl
:alice :knows :bob .
:alice :knows :carol .
:alice :score 9 .
```

The same abbreviation works in rule heads and bodies:

```srl
RULE {
  ?friend :knownBy ?person ;
          :scoredFor ?score .
}
WHERE {
  ?person :knows ?friend ;
          :score ?score .
}
```

This syntax makes examples shorter, but internally Eyesharl still stores plain triples.

## 9. Property Paths in Bodies

The SRL grammar includes restricted property paths. Eyesharl supports sequence `/` and inverse `^` paths in rule bodies.

Example:

```srl
RULE { ?x :grandparentOf ?z }
WHERE { ?x :parentOf/:parentOf ?z }
```

This means: find a path from `?x` to `?z` through two `:parentOf` edges.

Inverse paths flip direction:

```srl
RULE { ?child :hasParent ?parent }
WHERE { ?child ^:parentOf ?parent }
```

This matches when `?parent :parentOf ?child` exists.

Internally, `store.js` computes path pairs and then matches the subject and object against the current binding. The implementation is intentionally simple and finite. It does not implement arbitrary-length `*` or `+` paths.

## 10. Triple Storage and Matching

The triple store in `src/store.js` has two jobs:

1. remember which triples already exist,
2. find triples that match a pattern.

It uses a map from stable triple keys to triples. This prevents duplicates and lets the engine ask, “Is this inferred triple new?”

It also keeps indexes by predicate, by predicate plus subject, and by predicate plus object. When the pattern is:

```srl
?x :parentOf ?y
```

Eyesharl only scans triples whose predicate is `:parentOf`. If the subject or object is already fixed by the pattern or by previous bindings, the more specific index is used. This is much cheaper than scanning the whole graph for every pattern and is especially important for type-heavy rule sets.

Matching a pattern against a triple either fails or produces a binding. Pattern:

```srl
?x :parentOf ?y
```

Triple:

```srl
:alice :parentOf :bob
```

Binding:

```js
{
  x: { type: 'iri', value: 'http://example/alice' },
  y: { type: 'iri', value: 'http://example/bob' }
}
```

A later clause must be compatible with the existing binding. This is the same idea as joining rows in a database query.

## 11. Expressions and Builtins

Filters and assignments use expressions:

```srl
FILTER(?age >= 18 && LANG(?name) = "en")
SET(?slug := REPLACE(LCASE(STR(?name)), " ", "-"))
```

Expressions are parsed into trees and evaluated by `src/builtins.js`.

Supported expression features include:

- arithmetic: `+`, `-`, `*`, `/`,
- comparisons: `=`, `!=`, `<`, `<=`, `>`, `>=`,
- logic: `&&`, `||`, `!`,
- membership: `IN` and `NOT IN`,
- strings: `CONCAT`, `SUBSTR`, `STRLEN`, `REPLACE`, `UCASE`, `LCASE`, `CONTAINS`, `STRSTARTS`, `STRENDS`, `STRBEFORE`, `STRAFTER`,
- term functions: `STR`, `IRI`, `URI`, `BNODE`, `DATATYPE`, `LANG`, `STRDT`, `STRLANG`,
- tests: `sameTerm`, `isIRI`, `isURI`, `isBLANK`, `isLITERAL`, `isNUMERIC`, `hasLANG`, `REGEX`,
- triple-term helpers: `TRIPLE`, `SUBJECT`, `PREDICATE`, `OBJECT`,
- deterministic process helpers for this implementation: `NOW`, `UUID`, `STRUUID`.

This is not a full SPARQL expression engine. It is a practical subset plus a few functions from the grammar that are useful for examples and tests.

## 12. Evaluating a Rule Body

`evaluateBody` in `src/engine.js` evaluates a list of clauses from left to right.

It starts with one empty binding:

```js
[{}]
```

Each clause transforms the current bindings:

```text
bindings = [{}]
for clause in body:
  bindings = apply(clause, bindings)
return bindings
```

For a triple or path clause, the store returns compatible matches.

For a filter, the expression must evaluate to true.

For `SET`, the expression result is converted to a term and assigned to a variable.

For `NOT`, Eyesharl tries to evaluate the inner body. If the inner body has no matches, the outer binding survives.

The order of clauses can matter for safety and performance. A filter or assignment should normally use variables that have already been bound by previous positive clauses.

## 13. Forward Chaining

The core inference loop is forward chaining. Conceptually, a recursive stratum is evaluated like this:

```text
store = base data + DATA blocks
repeat:
  added = 0
  for each rule in the recursive stratum:
    bindings = evaluate body against store
    for each binding:
      instantiate head triples
      add new triples to store
until added == 0
```

A fixpoint is reached when a full pass over the recursive stratum adds no new triples.

Acyclic strata are different. After lower strata have reached their fixpoints, each acyclic rule component only needs one pass. This matters for deep taxonomies: a chain of thousands of non-recursive classification rules should not consume recursive-fixpoint attempts and should not be mistaken for non-termination.

Recursive rules are allowed when they are monotonic. For example:

```srl
RULE { ?x :ancestorOf ?y } WHERE { ?x :parentOf ?y }
RULE { ?x :ancestorOf ?z } WHERE { ?x :parentOf ?y . ?y :ancestorOf ?z }
```

These rules compute ancestry. If the input graph is finite and the rules do not create endlessly new terms, the closure is finite.

`--max-iterations` is a safety guard for recursive strata that do not terminate. It is applied within a recursive layer, not across the total number of acyclic dependency layers.

## 14. Dependency Analysis

Negation and assignment make rule order important. Eyesharl therefore analyzes dependencies before evaluation.

A rule depends on another rule when a body triple pattern can possibly be generated by a head template of the other rule. The analyzer indexes head templates before comparing them, using fixed subject, predicate, and object positions when available. Without that index, a deep taxonomy with thousands of rules would spend most of its time comparing every rule body with every rule head.

The evaluator also precomputes which dependency layers are genuinely recursive. A deep taxonomy can have tens of thousands of acyclic layers, and checking each layer by scanning every dependency edge would turn a linear benchmark into a quadratic one. Eyesharl therefore computes layer recursion once and then evaluates each acyclic layer in a single pass.

A positive dependency looks like this:

```srl
RULE { ?x :q ?y } WHERE { ?x :p ?y }
RULE { ?x :r ?y } WHERE { ?x :q ?y }
```

The second rule depends positively on the first.

A negative dependency looks like this:

```srl
RULE { ?x :ok true } WHERE { ?x a :Thing . NOT { ?x :bad true } }
RULE { ?x :bad true } WHERE { ?x :flagged true }
```

The first rule depends negatively on the second, because the meaning of `NOT { ?x :bad true }` is only stable after all possible `:bad` triples have been derived.

`src/analyze.js` builds this dependency graph. The CLI can print it with:

```sh
./eyesharl.js --check --deps examples/stratified-negation.srl
```

## 15. Stratified Evaluation

Stratification turns the dependency graph into evaluation layers.

If rule A has `NOT` over a predicate that rule B can produce, then B must finish before A runs. Otherwise A could infer something based on missing information and never retract it.

Eyesharl’s evaluator now uses layers from the dependency analysis. Each layer is evaluated to a fixpoint before moving to the next layer.

This matters when source order is misleading:

```srl
RULE { ?x :eligible true }
WHERE { ?x a :Person . NOT { ?x :blocked true } }

RULE { ?x :blocked true }
WHERE { ?x :flagged true }
```

Even though the `:eligible` rule appears first, Eyesharl runs the `:blocked` producer in an earlier layer. That prevents incorrect `:eligible` triples.

If a dependency cycle contains a negative edge, Eyesharl reports `unstratified-negation` and refuses to evaluate by default.

## 16. Assignment Rules

`SET` assigns the result of an expression to a variable:

```srl
RULE { ?x :distanceKm ?km }
WHERE {
  ?x :distanceMiles ?miles .
  SET(?km := ?miles * 1.60934)
}
```

Eyesharl marks rules containing `SET` as run-once rules. They are evaluated at their layer position after ordinary rules in that layer have reached a fixpoint.

This is a compact approximation of the draft’s warning that assignment rules need special ordering. It avoids repeatedly creating different values for the same conceptual assignment.

If a `SET` rule is recursive, the analyzer warns because recursive assignment is often a sign that the program can be non-obvious or non-terminating.

## 17. Imports

The parser records `IMPORTS` declarations:

```srl
IMPORTS <library.srl>
```

The API can merge imported rule sets when you provide an `importResolver`. The CLI has a built-in resolver for local `file:` imports. When you run:

```sh
./eyesharl.js examples/import-main.srl
```

and `import-main.srl` contains:

```srl
IMPORTS <import-lib.srl>
```

Eyesharl resolves the relative IRI against the importing file, reads the imported file, recursively processes its imports, and merges imported rules and data before local evaluation.

Import cycles are tracked with a visited set, so a cycle does not cause infinite loading.

The self-contained CLI intentionally does not fetch remote HTTP imports. API users can provide their own resolver for that.

## 18. Static Diagnostics

Static analysis reports warnings and errors before evaluation.

Warnings include:

- a head variable is not bound by the body,
- a filter may use an unbound variable,
- a `SET` expression may use an unbound variable,
- a variable appears only inside `NOT`,
- a recursive assignment rule was detected.

Errors include:

- unstratified negation,
- invalid non-IRI/non-variable head predicates.

By default, warnings do not stop execution. With `--strict`, warnings become fatal. Errors stop execution unless an internal caller explicitly opts out.

Static analysis prevents the engine from silently doing something meaningless. For example:

```srl
RULE { ?x :bad true } WHERE { :alice :knows :bob }
```

The body never binds `?x`, so the head cannot be instantiated. Eyesharl warns about that.

## 19. Query as an Operation

The SHACL Rules draft describes a query operation, but Eyesharl does not add top-level `QUERY` or SPARQL `SELECT` syntax to `.srl` files.

Instead, query mode is external:

```sh
./eyesharl.js --query '?person :ancestorOf ?descendant . FILTER(?person = :alice)' examples/query.srl
```

The steps are:

1. parse and compile the rule set,
2. process imports,
3. compute the closure,
4. parse the query text as a raw SRL body pattern,
5. evaluate that pattern against the closure,
6. print bindings.

This keeps `.srl` files focused on SRL rule sets while still making the query operation available from the CLI and API.

## 20. The CLI

`src/cli.js` is a thin wrapper around the API.

Common commands:

```sh
./eyesharl.js examples/family.srl
./eyesharl.js --all examples/family.srl
./eyesharl.js --check --deps examples/stratified-negation.srl
./eyesharl.js --json --trace --stats examples/if-then.srl
./eyesharl.js --query-file examples/query-body.txt examples/query.srl
```

Important options:

```text
--check       parse and analyze only
--strict      warnings become fatal
--deps        print dependency edges and layers
--trace       show rule firings
--stats       show iteration and rule counts
--json        structured output
--max-iterations N
              recursive-layer fixpoint safety guard
--query       run a raw body pattern over the closure
--no-imports  parse imports but do not load them
```

The CLI should remain boring. The core logic lives in `src/api.js`, `src/analyze.js`, and `src/engine.js` so tests and other programs can use the same behavior without spawning a process.

## 21. The Public API

Typical API use:

```js
const { run, formatTriples } = require('./src/index.js');

const result = run(`
PREFIX : <http://example/>
DATA { :Socrates a :Man . }
RULE { ?x a :Mortal } WHERE { ?x a :Man }
`);

console.log(formatTriples(result.inferred, result.prefixes));
```

For query mode:

```js
const { runQuery, formatBindings } = require('./src/index.js');

const result = runQuery(source, '?x :ancestorOf ?y');
console.log(formatBindings(result.query.bindings, result.prefixes));
```

For imports:

```js
const result = run(source, {
  baseIRI: 'file:///main.srl',
  importResolver(target) {
    return {
      source: readSomehow(target),
      options: { baseIRI: target, filename: target }
    };
  }
});
```

The public API returns structured objects: parsed programs, diagnostics, inferred triples, closure triples, traces, stats, and query bindings.

## 22. The Bundle

`tools/bundle.js` generates `eyesharl.js`.

The bundler starts at `src/cli.js`, follows local `require('./...')` calls, places modules into a small runtime table, and writes one executable file.

The generated file starts with:

```text
#!/usr/bin/env node
```

This lets users run it directly on Unix-like systems.

The source modules remain the real implementation. The bundle is a distribution artifact. Run:

```sh
npm run bundle
```

or simply:

```sh
npm test
```

because the test script rebuilds the bundle first.

## 23. Tests as Executable Documentation

The tests use Node’s built-in `node:test` module.

`test/api.test.js` covers core behavior:

- parsing,
- recursion,
- filters,
- negation,
- assignment,
- typed and language literals,
- `VERSION`, blank nodes, and string forms,
- `IN` and `NOT IN`,
- property paths,
- stratified negation,
- imports through the API,
- rejection of non-SRL syntax.

`test/examples.test.js` runs real examples and CLI commands:

- `family.srl`,
- `negation.srl`,
- `assignment.srl`,
- `if-then.srl`,
- `declarations.srl`,
- `property-paths.srl`,
- `version-and-in.srl`,
- `stratified-negation.srl`,
- `import-main.srl`,
- query and diagnostics examples.

`test/deep-taxonomy.test.js` covers generated taxonomy benchmarks at multiple depths. The small examples are useful for reading. The larger examples guard against accidental quadratic behavior in dependency analysis or evaluation.

Tests are both regression checks and a compact specification of current behavior.

## 24. Walking Through a Complete Run

Consider:

```srl
PREFIX : <http://example/>

DATA {
  :alice :parentOf :bob .
  :bob :parentOf :carol .
}

RULE { ?x :ancestorOf ?y } WHERE { ?x :parentOf ?y }
RULE { ?x :ancestorOf ?z } WHERE { ?x :parentOf ?y . ?y :ancestorOf ?z }
```

The tokenizer emits tokens such as `PREFIX`, `DATA`, `:alice`, `RULE`, and `?x`.

The parser creates two data triples and two rules.

The analyzer sees positive recursion through `:ancestorOf`, which is allowed. It places the recursive rules into a layer.

The engine loads the `:parentOf` triples into the store.

In the first fixpoint pass, the base rule derives:

```srl
:alice :ancestorOf :bob .
:bob :ancestorOf :carol .
```

The recursive rule then derives:

```srl
:alice :ancestorOf :carol .
```

The next pass adds nothing. The layer has reached a fixpoint, and the program is finished.

## 25. W3C Draft Examples

The directory `examples/w3c/` mirrors the examples from the SHACL 1.2 Rules Working Draft. These files serve two purposes.

First, the `.srl` files are executable regression examples. They cover the introductory rule examples: basic inference, recursion, filtering, negation, assignment, assignment guarded by negation, and the SRL syntax comparison example from section 4.

Second, the `.ttl` files preserve Turtle/RDF examples from the draft. Eyesharl can execute the RDF Rules syntax subset that maps `srl:RuleSet`, `srl:data`, `srl:rules`, `srl:body`, and `srl:head` into the same internal rule-set model used by SRL.

When adding future draft examples, keep this distinction clear:

```text
examples/w3c/*.srl  executable SRL examples
examples/w3c/*.ttl  captured RDF/Turtle sketches from the draft
```

The test file `test/w3c-examples.test.js` checks that all runnable W3C `.srl` examples execute through both the API and the bundled CLI.

## 26. Known Limitations

Eyesharl still lacks many features needed for a complete implementation:

- full general-purpose RDF/Turtle parsing,
- complete RDF-star reifier semantics beyond the rule syntax front-end,
- complete SPARQL expression behavior,
- remote import loading in the CLI,
- SHACL validation integration,
- official conformance test integration,
- production-grade indexing and query planning.

These limitations are part of the design goal. Eyesharl should remain small enough to read and modify.

## 27. How to Extend Eyesharl Safely

A good extension follows this path:

1. Add tokens only if new characters are needed.
2. Add parser support and choose a simple object shape.
3. Add static checks if the feature can be unsafe.
4. Add store or engine behavior.
5. Add formatting only if output changes.
6. Add API tests.
7. Add an example if users should learn the feature from the CLI.
8. Rebuild the bundle.
9. Update the README only if the quick-start changes.
10. Update this handbook when the mental model changes.

Avoid pushing core behavior into the CLI. The CLI should expose the machine, not become the machine.


## 28. Advanced SRL Grammar Features

The SRL grammar is not only `RULE`, `WHERE`, and simple triples. Eyesharl also supports several RDF-style term forms that make rule sets closer to the draft grammar.

Collections are written with parentheses:

```srl
DATA { :list :items ( :a :b :c ) . }
```

Internally, the parser expands the collection into RDF list triples using `rdf:first`, `rdf:rest`, and `rdf:nil`. The original compact syntax is only surface syntax; the reasoner still works over triples.

Blank-node property lists are written with square brackets:

```srl
DATA { :alice :knows [ :name "Bob" ; :age 22 ] . }
```

The parser creates a fresh blank node, asserts the surrounding triple, and asserts the property-list triples about that blank node. Anonymous blank nodes can also be written as `[]`.

Variables may use either `?x` or `$x`. Both spellings create the same internal variable representation. Supporting both matters because the SRL grammar permits both forms.

Language-direction literals preserve both the language and the direction:

```srl
DATA { :message :text "bonjour"@fr--ltr . }
```

The `LANG`, `LANGDIR`, and related builtins can inspect those fields.

Signed numeric literals and Unicode string escapes are parsed as RDF terms. Examples such as `-12`, `-3.5`, `"A\u0042"`, and `"A\U00000042"` work in data, rule heads, and expressions.

Triple terms use the parenthesized spelling:

```srl
<<( :alice :says :hello )>>
```

Triple terms can appear in data and patterns. Matching is recursive, so a pattern such as `<<(?s :p ?o)>>` can bind variables inside the triple term.

## 29. Reifiers, Triple Terms, and Annotations

Eyesharl distinguishes triple terms from reifiers.

A triple term is a term whose value is a triple:

```srl
<<( :alice :says :hello )>>
```

A reified triple can introduce a reifier:

```srl
<< :alice :says :hello ~ :claim1 >>
```

Eyesharl expands that into a reifier relationship:

```srl
:claim1 rdf:reifies <<( :alice :says :hello )>> .
```

Annotation blocks use the same model. This input:

```srl
:alice :says :hello ~ :claim1 {| :source :chat |} .
```

asserts the base triple and also creates metadata about `:claim1`:

```srl
:alice :says :hello .
:claim1 rdf:reifies <<( :alice :says :hello )>> .
:claim1 :source :chat .
```

That makes rule bodies explicit and readable:

```srl
RULE { ?speaker :statementSource ?source }
WHERE {
  ?claim rdf:reifies <<(?speaker :says ?object)>> .
  ?claim :source ?source .
}
```

This feature shows why Eyesharl has both parser tests and reasoning tests. It is not enough to accept the surface syntax. The parser must expand the syntax into triples that the engine can match.

## 30. BuiltInCall Coverage

The SRL grammar has a production named `BuiltInCall`. Eyesharl represents that production directly in `src/builtins.js` with `BUILTIN_SIGNATURES`.

The registry maps each grammar-level built-in name to its arity. That gives a clear path from syntax to execution:

```text
name in grammar -> registry entry -> parser accepts it -> evaluator checks arity -> implementation runs it
```

Built-ins sit at the boundary between syntax and reasoning. A rule body such as:

```srl
FILTER STRSTARTS(STR(?label), "A")
```

is not a triple pattern. It is a condition over the current solution mapping. The engine first binds `?label` by matching triples, then evaluates the built-in call. If the call returns true, the solution survives. If it returns false or raises an evaluation error, the solution is discarded.

Assignments use the same expression machinery:

```srl
SET(?slug := REPLACE(LCASE(STR(?name)), " ", "-"))
```

The assignment result becomes a new variable binding. Later body elements and the rule head can use `?slug`.

The parser treats unprefixed function names strictly. A bare function such as `LCASE(...)` is accepted because it is a grammar built-in. A custom function must be an IRI-named function call, such as `:startsWithA(...)` or `<http://example/fn>(...)`. This keeps Eyesharl close to the grammar instead of quietly accepting JavaScript-style helper names.

The most subtle built-in is `IF`. It is lazy. Only the selected branch is evaluated. That means this is safe when the condition is false:

```srl
SET(?value := IF(false, :missingFunction(), "safe"))
```

The missing function is part of the unchosen branch, so it is not evaluated.

`examples/builtin-call-complete.srl` exercises every built-in named by the grammar. `test/builtins.test.js` compares Eyesharl's registry against the complete BuiltInCall name list and runs the example as an executable smoke test.

## 31. RDF Rules Syntax Front-End

Eyesharl has two front-ends for rule sets: SRL text and RDF Rules syntax in Turtle. The RDF front-end does not replace the SRL parser. It translates an RDF graph that uses the `srl:` vocabulary into the same internal program shape that the SRL parser produces.

The important idea is this:

```text
Turtle/RDF input -> RDF graph -> srl:RuleSet translator -> internal program -> analyzer -> engine
```

That keeps the reasoning machine small. Once RDF syntax has been translated, the rest of Eyesharl does not care whether a rule originally came from this SRL text:

```srl
RULE { ?y :childOf ?x } WHERE { ?x :parentOf ?y }
```

or from this RDF description:

```turtle
[ a srl:Rule ;
  srl:body (
    [ srl:subject [ srl:varName "x" ] ;
      srl:predicate :parentOf ;
      srl:object [ srl:varName "y" ] ]
  ) ;
  srl:head (
    [ srl:subject [ srl:varName "y" ] ;
      srl:predicate :childOf ;
      srl:object [ srl:varName "x" ] ]
  )
]
```

The RDF front-end lives in `src/rdfSyntax.js`. It has two layers.

First, `TurtleParser` reads a practical Turtle subset: prefixes, IRIs, prefixed names, literals, blank-node property lists, RDF collections, `a`, semicolon/comma abbreviation, and triple terms written as `<<(... )>>`. It expands collections into `rdf:first` and `rdf:rest` triples, just like the SRL parser does for collection syntax.

Second, `rdfDocumentToProgram` searches the parsed graph for `srl:RuleSet` nodes. For each rule set it reads:

- `srl:data`, whose value is an RDF list of data triples or triple terms,
- `srl:rules`, whose value is an RDF list of rule nodes,
- each rule's `srl:body` and `srl:head` lists,
- `srl:filter`, `srl:assign`, and `srl:not` body elements,
- variable nodes written with `srl:varName`, and expression variables written with `shnex:var`.

RDF expression nodes such as:

```turtle
[ sparql:less-than ( [ shnex:var "age" ] 18 ) ]
```

become the same expression AST used by SRL `FILTER(?age < 18)`. Supported operator nodes include comparison, arithmetic, boolean connectives, and calls that map onto Eyesharl's BuiltInCall registry.

The CLI auto-detects `.ttl` input as RDF syntax, and also accepts explicit syntax selection:

```sh
./eyesharl.js --syntax rdf examples/rdf-syntax/basic-ruleset.ttl
```

If a Turtle file contains several rule sets, select one with `--ruleset`:

```sh
./eyesharl.js --syntax rdf --ruleset :familyRules examples/rdf-syntax/basic-ruleset.ttl
```

The examples in `examples/rdf-syntax/` are executable regression files. One of them, `w3c-rule-set-snippet.ttl`, is adapted from the W3C `data-shapes` repository's `shacl12-rules/rules-rdf-syntax/test-rules.ttl` file and exercises the same core vocabulary shape: `srl:RuleSet`, RDF lists, rule nodes, triple objects, filters, assignments, and triple terms in data blocks.

This front-end is intentionally not a full SHACL validator. It can execute RDF Rules syntax rule sets, but it does not validate arbitrary RDF files against the `srl-sh:` SHACL shapes from the repository.

## 32. Known Limitations

Eyesharl is not a standards conformance claim. The most important remaining limitations are:

- it does not implement SHACL validation or validation reports,
- it does not implement a complete RDF 1.2 parser,
- it does not implement every SPARQL expression edge case,
- it keeps property paths deliberately restricted,
- RDF Rules syntax support is a practical front-end rather than a full SHACL shapes validation layer,
- performance-critical paths are indexed for common rule workloads, but this remains a compact implementation rather than a production RDF database.

The best way to read these limitations is as architectural boundaries. The rule engine derives triples. A SHACL validator checks shapes and emits validation reports. Those can be connected later, but they are different machines.

## 33. How to Extend Eyesharl Safely

When adding a feature, preserve the pipeline:

```text
syntax -> AST/program -> analysis -> evaluation -> formatting
```

Avoid making the evaluator parse strings. Parsing belongs in `parser.js` or `rdfSyntax.js`. Avoid making the parser derive triples. Inference belongs in `engine.js`.

A safe extension usually needs:

1. syntax support,
2. one focused example,
3. a parser/API test,
4. an execution test,
5. a handbook update,
6. bundle regeneration.

Useful extension directions include:

- more RDF Rules syntax vocabulary coverage,
- more RDF 1.2 parser coverage,
- more SPARQL-compatible expression behavior,
- better diagnostics for non-well-formed rule sets,
- more specialized indexes and query planning for larger graphs.

## 34. The Big Picture

Eyesharl is a Datalog-like forward reasoner over RDF-style triples.

The heart of the system is:

```text
match rule bodies
instantiate rule heads
add new triples
repeat by dependency layer until stable
```

Everything else supports that loop:

- the tokenizer and parser create rules and data,
- the RDF syntax front-end translates Turtle rule sets,
- terms define equality,
- the store makes matching possible,
- builtins make conditions and assignments useful,
- analysis makes negation deterministic,
- imports assemble rule sets,
- formatting explains results,
- tests preserve behavior,
- the bundle makes the tool easy to run.

Understanding Eyesharl means understanding how a declarative rule set becomes a deterministic computation over a growing set of facts.
