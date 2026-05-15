'use strict';

const { parse, parseQuery } = require('./parser.js');
const { parseRdfSyntax, parseRdfDocument, rdfDocumentToProgram, looksLikeRdfRules } = require('./rdfSyntax.js');
const { evaluate } = require('./engine.js');
const { analyze } = require('./analyze.js');
const { formatTriples, sortTriples, toJSON, formatTrace, formatBindings } = require('./format.js');
const { runQuery, queryResult } = require('./query.js');

function parseInput(source, options = {}) {
  if (typeof source !== 'string') return source;
  return looksLikeRdfRules(source, options) ? parseRdfSyntax(source, options) : parse(source, options);
}

function compile(source, options = {}) {
  const parsed = parseInput(source, options);
  const program = options.resolveImports === false ? parsed : resolveImports(parsed, options);
  const analysis = analyze(program);
  const diagnostics = analysis.diagnostics;
  const fatal = analysis.errors.length > 0 || (options.strict && analysis.warnings.length > 0);
  if (fatal && options.throwOnDiagnostics !== false) {
    const details = diagnostics.map((diagnostic) => diagnostic.message).join('; ');
    throw new Error(`${analysis.errors.length > 0 ? 'Analysis failed' : 'Strict mode failed'}: ${details}`);
  }
  return { program, diagnostics, analysis };
}

function resolveImports(program, options = {}, seen = new Set()) {
  if (!program.imports || program.imports.length === 0) return cloneProgram(program);
  const importResolver = options.importResolver;
  if (!importResolver) return cloneProgram(program);

  let merged = emptyProgram(program);
  const localKey = program.baseIRI || options.filename || '<input>';
  if (localKey) seen.add(localKey);

  for (const target of program.imports) {
    if (seen.has(target)) continue;
    seen.add(target);
    const resolved = importResolver(target, { from: program.baseIRI || options.filename || null, seen });
    if (!resolved) throw new Error(`IMPORTS resolver returned no source for ${target}`);
    const importSource = typeof resolved === 'string' ? resolved : resolved.source;
    const importOptions = typeof resolved === 'string' ? {} : (resolved.options || {});
    const parsedImport = parseInput(importSource, { ...options, ...importOptions, baseIRI: importOptions.baseIRI || target, filename: importOptions.filename || target });
    const imported = resolveImports(parsedImport, { ...options, ...importOptions, importResolver }, seen);
    merged = mergePrograms(merged, imported);
  }

  return mergePrograms(merged, program);
}

function emptyProgram(program = {}) {
  return {
    baseIRI: program.baseIRI || null,
    version: program.version || null,
    imports: [],
    prefixes: { ...(program.prefixes || {}) },
    data: [],
    rules: [],
  };
}

function cloneProgram(program) {
  return {
    baseIRI: program.baseIRI || null,
    version: program.version || null,
    imports: (program.imports || []).slice(),
    prefixes: { ...(program.prefixes || {}) },
    data: (program.data || []).slice(),
    rules: (program.rules || []).slice(),
  };
}

function mergePrograms(left, right) {
  return {
    baseIRI: right.baseIRI || left.baseIRI || null,
    version: right.version || left.version || null,
    imports: Array.from(new Set([...(left.imports || []), ...(right.imports || [])])),
    prefixes: { ...(left.prefixes || {}), ...(right.prefixes || {}) },
    data: [...(left.data || []), ...(right.data || [])],
    rules: [...(left.rules || []), ...(right.rules || [])],
  };
}

function run(source, options = {}) {
  const { program, diagnostics, analysis } = compile(source, options);
  const result = evaluate(program, { ...options, analysis });
  result.diagnostics = diagnostics;
  result.analysis = analysis;
  return result;
}

function runToString(source, options = {}) {
  const result = run(source, options);
  const triples = options.all ? result.closure : result.inferred;
  return formatTriples(triples, result.prefixes);
}

module.exports = {
  parse,
  parseQuery,
  parseInput,
  parseRdfSyntax,
  parseRdfDocument,
  rdfDocumentToProgram,
  compile,
  resolveImports,
  mergePrograms,
  analyze,
  evaluate,
  run,
  runToString,
  runQuery,
  queryResult,
  formatTriples,
  formatBindings,
  sortTriples,
  toJSON,
  formatTrace,
};
