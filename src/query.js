'use strict';

const { parseQuery } = require('./parser.js');
const { TripleStore, bindingKey } = require('./store.js');
const { evaluateBody } = require('./engine.js');

function queryResult(result, querySpec, options = {}) {
  const store = new TripleStore(result.closure || []);
  const bindings = evaluateBody(querySpec.body, store, {}, options);
  const select = normalizeSelect(querySpec.select, bindings);
  return {
    baseIRI: result.baseIRI,
    prefixes: result.prefixes,
    select,
    bindings: projectBindings(bindings, select),
  };
}

function runQuery(source, querySource = null, options = {}) {
  const { run, compile } = require('./api.js');
  const { program, diagnostics } = compile(source, options);
  const result = run(program, options);
  result.diagnostics = diagnostics;

  let querySpec;
  if (querySource) querySpec = parseQuery(querySource, { ...options, prefixes: program.prefixes, baseIRI: program.baseIRI });
  else throw new Error('No query supplied. Use --query or --query-file with a raw body pattern.');

  const query = queryResult(result, querySpec, options);
  return { ...result, query };
}

function normalizeSelect(select, bindings) {
  if (select && select.length > 0) return select.slice();
  const vars = new Set();
  for (const binding of bindings) for (const key of Object.keys(binding)) vars.add(key);
  return Array.from(vars).sort();
}

function projectBindings(bindings, select) {
  const seen = new Set();
  const out = [];
  for (const binding of bindings) {
    const projected = {};
    for (const name of select) if (binding[name]) projected[name] = binding[name];
    const key = bindingKey(projected);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(projected);
    }
  }
  return out;
}

module.exports = { runQuery, queryResult, parseQuery, normalizeSelect, projectBindings };
