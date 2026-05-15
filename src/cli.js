'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const {
  compile,
  evaluate,
  parseQuery,
  queryResult,
  formatTriples,
  formatTrace,
  formatBindings,
  toJSON,
} = require('./api.js');
const { compactIRI } = require('./term.js');

const VERSION = '0.12.0';

function help() {
  return `eyesharl ${VERSION}\n\nA dependency-free JavaScript implementation experiment for the SHACL 1.2 Rules draft, including SRL and RDF Rules syntax front-ends.\n\nUsage:\n  eyesharl [options] [file ...]\n\nOptions:\n  --all                 Print the full closure, including input facts\n  --json                Print JSON instead of compact triples/bindings\n  --trace               Print derivation trace to stderr, or include it in JSON\n  --stats               Print iteration and triple counts to stderr\n  --check               Parse and analyze only; do not run rules\n  --strict              Treat static warnings as errors\n  --deps                Print rule dependency edges during --check\n  --query TEXT          Run a raw SRL body pattern over the closure\n  --query-file FILE     Read a raw SRL body pattern from a file\n  --max-iterations N    Stop after N fixpoint iterations within a recursive layer\n  --no-imports          Parse IMPORTS/owl:imports but do not load imported rule sets\n  --syntax MODE         Use srl, rdf, or auto syntax detection (default auto)\n  --ruleset TERM        In RDF syntax, run only the selected srl:RuleSet\n  --version             Print version\n  -h, --help            Print this help\n\nWith no file arguments, eyesharl reads from stdin.\n`;
}

function parseArgs(argv) {
  const options = {
    all: false,
    json: false,
    trace: false,
    stats: false,
    check: false,
    strict: false,
    deps: false,
    query: null,
    queryFile: null,
    maxIterations: 1000,
    imports: true,
    syntax: 'auto',
    ruleSet: null,
  };
  const files = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all') options.all = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--trace') options.trace = true;
    else if (arg === '--stats') options.stats = true;
    else if (arg === '--check') options.check = true;
    else if (arg === '--strict') options.strict = true;
    else if (arg === '--deps') options.deps = true;
    else if (arg === '--no-imports') options.imports = false;
    else if (arg === '--syntax') {
      i += 1;
      if (i >= argv.length) throw new Error('--syntax requires srl, rdf, or auto');
      options.syntax = argv[i];
      if (!['srl', 'rdf', 'auto'].includes(options.syntax)) throw new Error('--syntax requires srl, rdf, or auto');
    } else if (arg === '--ruleset') {
      i += 1;
      if (i >= argv.length) throw new Error('--ruleset requires an RDF term');
      options.ruleSet = argv[i];
    }
    else if (arg === '--query') {
      i += 1;
      if (i >= argv.length) throw new Error('--query requires a value');
      options.query = argv[i];
    } else if (arg === '--query-file') {
      i += 1;
      if (i >= argv.length) throw new Error('--query-file requires a file');
      options.queryFile = argv[i];
    } else if (arg === '--max-iterations') {
      i += 1;
      if (i >= argv.length) throw new Error('--max-iterations requires a value');
      options.maxIterations = Number(argv[i]);
      if (!Number.isInteger(options.maxIterations) || options.maxIterations < 1) throw new Error('--max-iterations must be a positive integer');
    } else if (arg === '--version') {
      options.version = true;
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option ${arg}`);
    } else {
      files.push(arg);
    }
  }
  if (options.query && options.queryFile) throw new Error('Use either --query or --query-file, not both');
  return { options, files };
}

function readInput(files) {
  if (files.length === 0) return { source: fs.readFileSync(0, 'utf8'), filename: '<stdin>', baseIRI: null };
  if (files.length === 1) {
    const filename = path.resolve(files[0]);
    return { source: fs.readFileSync(filename, 'utf8'), filename, baseIRI: pathToFileURL(filename).href };
  }
  return { source: files.map((file) => fs.readFileSync(file, 'utf8')).join('\n'), filename: '<input>', baseIRI: null };
}

function createFileImportResolver() {
  return function importResolver(target) {
    if (!target.startsWith('file:')) throw new Error(`Cannot import remote URL ${target}; this self-contained CLI only loads file: imports`);
    const filename = fileURLToPath(target);
    return {
      source: fs.readFileSync(filename, 'utf8'),
      options: { filename, baseIRI: pathToFileURL(filename).href },
    };
  };
}

function printDiagnostics(diagnostics, stderr) {
  for (const diagnostic of diagnostics) stderr.write(`eyesharl: ${diagnostic.severity}: ${diagnostic.message}\n`);
}

function hasFatalDiagnostics(analysis, strict) {
  return analysis.errors.length > 0 || (strict && analysis.warnings.length > 0);
}

function printDependencies(analysis, prefixes, stderr) {
  const edges = analysis.dependency.edges;
  if (edges.length === 0) {
    stderr.write('eyesharl: deps: no rule dependencies\n');
    return;
  }
  for (const edge of edges) {
    const from = formatRuleName(analysis.dependency.rules[edge.from].name, prefixes);
    const to = formatRuleName(analysis.dependency.rules[edge.to].name, prefixes);
    const kind = edge.negative ? 'NOT' : 'uses';
    stderr.write(`eyesharl: deps: ${from} --${kind} ${edge.predicate ? compactIRI(edge.predicate, prefixes) : '*'}--> ${to}\n`);
  }
  if (analysis.dependency.layers && analysis.dependency.layers.length > 0) {
    analysis.dependency.layers.forEach((layer, index) => {
      stderr.write(`eyesharl: deps: layer ${index + 1}: ${layer.join(', ')}\n`);
    });
  }
}

function formatRuleName(name, prefixes = {}) {
  return /^https?:/.test(name) ? compactIRI(name, prefixes) : name;
}

function main(argv = process.argv.slice(2), io = process) {
  try {
    const { options, files } = parseArgs(argv);
    if (options.help) {
      io.stdout.write(help());
      return 0;
    }
    if (options.version) {
      io.stdout.write(`${VERSION}\n`);
      return 0;
    }
    const input = readInput(files);
    const compiled = compile(input.source, {
      filename: input.filename,
      baseIRI: input.baseIRI,
      strict: false,
      throwOnDiagnostics: false,
      resolveImports: options.imports,
      importResolver: options.imports ? createFileImportResolver() : null,
      syntax: options.syntax === 'auto' ? undefined : options.syntax,
      ruleSet: options.ruleSet,
    });
    const fatal = hasFatalDiagnostics(compiled.analysis, options.strict);

    if (compiled.diagnostics.length > 0) printDiagnostics(compiled.diagnostics, io.stderr);
    if (options.deps) printDependencies(compiled.analysis, compiled.program.prefixes, io.stderr);

    if (options.check) {
      if (compiled.diagnostics.length === 0) io.stderr.write('eyesharl: ok\n');
      return fatal ? 1 : 0;
    }
    if (fatal) return 1;

    const result = evaluate(compiled.program, { ...options, analysis: compiled.analysis });
    result.diagnostics = compiled.diagnostics;
    result.analysis = compiled.analysis;

    const queryText = options.queryFile ? fs.readFileSync(options.queryFile, 'utf8') : options.query;
    const querySpec = queryText
      ? parseQuery(queryText, { filename: options.queryFile || '<query>', prefixes: compiled.program.prefixes, baseIRI: compiled.program.baseIRI })
      : null;
    if (querySpec) result.query = queryResult(result, querySpec, options);

    if (options.json) {
      io.stdout.write(`${JSON.stringify(toJSON(result, { all: options.all, trace: options.trace, analysis: options.deps }), null, 2)}\n`);
    } else if (result.query) {
      const out = formatBindings(result.query.bindings, result.prefixes, result.query.select);
      if (out) io.stdout.write(`${out}\n`);
    } else {
      if (options.trace && result.trace.length > 0) io.stderr.write(`${formatTrace(result.trace, result.prefixes)}\n`);
      const triples = options.all ? result.closure : result.inferred;
      const out = formatTriples(triples, result.prefixes);
      if (out) io.stdout.write(`${out}\n`);
    }

    if (options.stats) {
      io.stderr.write(`eyesharl: iterations=${result.iterations} layers=${result.layers.length} input=${result.input.length} inferred=${result.inferred.length} closure=${result.closure.length} ruleApplications=${result.ruleApplications}\n`);
      for (const rule of result.perRule) {
        if (rule.applications > 0 || rule.added > 0) io.stderr.write(`eyesharl: rule ${rule.name}: applications=${rule.applications} added=${rule.added}${rule.runOnce ? ' runOnce=true' : ''}\n`);
      }
    }
    return 0;
  } catch (error) {
    io.stderr.write(`eyesharl: ${error.message}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { main, parseArgs, help, VERSION, createFileImportResolver };
