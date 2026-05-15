# eyesharl

`eyesharl` is a JavaScript implementation of SHACL 1.2 Rules, including SRL and RDF Rules syntax front-ends.

## Quick start

```sh
npm test
./eyesharl.js examples/family.srl
./eyesharl.js examples/w3c/spec-2-2-recursion.srl
./eyesharl.js examples/deep-taxonomy-100.srl
./eyesharl.js examples/rdf-syntax/basic-ruleset.ttl
./eyesharl.js --syntax rdf examples/rdf-syntax/w3c-rule-set-snippet.ttl
./eyesharl.js --check --deps examples/stratified-negation.srl
```

## Read next

Read [HANDBOOK.md](./HANDBOOK.md) for the full explanation of Eyesharl as code and as a reasoning machine.

The examples live in [examples/](./examples/). Draft SRL examples are in [examples/w3c/](./examples/w3c/), RDF Rules syntax examples are in [examples/rdf-syntax/](./examples/rdf-syntax/), and deep taxonomy benchmarks are in `examples/deep-taxonomy-*.srl`.

Status: Eyesharl runs a growing implementation of the SHACL 1.2 Rules draft surface. It is not a conformance claim and does not implement SHACL validation.
