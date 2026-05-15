'use strict';

const {
  iri,
  blankNode,
  literal,
  tripleTerm,
  termEquals,
  termToPrimitive,
  termToString,
  booleanValue,
  comparePrimitives,
  isIRI,
  isBlank,
  isLiteral,
  isTripleTerm,
  valueToTerm,
  inferDatatype,
  XSD_STRING,
  RDF_NS,
  XSD_INTEGER,
  XSD_DECIMAL,
  XSD_DOUBLE,
} = require('./term.js');

const XSD_DATETIME = 'http://www.w3.org/2001/XMLSchema#dateTime';
const XSD_DAYTIME_DURATION = 'http://www.w3.org/2001/XMLSchema#dayTimeDuration';
const RDF_LANGSTRING = `${RDF_NS}langString`;
const RDF_DIRLANGSTRING = `${RDF_NS}dirLangString`;
const NUMERIC_DATATYPES = new Set([XSD_INTEGER, XSD_DECIMAL, XSD_DOUBLE]);

// This table is intentionally shaped by the SHACL 1.2 Rules grammar production BuiltInCall.
// Keys are the canonical spellings used by the draft; lookup is case-insensitive so examples
// may use SPARQL-style uppercase or lowercase spellings while still being checked against the
// grammar's finite set of built-ins.
const BUILTIN_SIGNATURES = Object.freeze({
  STR: { min: 1, max: 1 },
  LANG: { min: 1, max: 1 },
  LANGMATCHES: { min: 2, max: 2 },
  LANGDIR: { min: 1, max: 1 },
  DATATYPE: { min: 1, max: 1 },
  IRI: { min: 1, max: 1 },
  URI: { min: 1, max: 1 },
  BNODE: { min: 0, max: 1 },
  ABS: { min: 1, max: 1 },
  CEIL: { min: 1, max: 1 },
  FLOOR: { min: 1, max: 1 },
  ROUND: { min: 1, max: 1 },
  CONCAT: { min: 0, max: Infinity },
  SUBSTR: { min: 2, max: 3 },
  STRLEN: { min: 1, max: 1 },
  REPLACE: { min: 3, max: 4 },
  UCASE: { min: 1, max: 1 },
  LCASE: { min: 1, max: 1 },
  ENCODE_FOR_URI: { min: 1, max: 1 },
  CONTAINS: { min: 2, max: 2 },
  STRSTARTS: { min: 2, max: 2 },
  STRENDS: { min: 2, max: 2 },
  STRBEFORE: { min: 2, max: 2 },
  STRAFTER: { min: 2, max: 2 },
  YEAR: { min: 1, max: 1 },
  MONTH: { min: 1, max: 1 },
  DAY: { min: 1, max: 1 },
  HOURS: { min: 1, max: 1 },
  MINUTES: { min: 1, max: 1 },
  SECONDS: { min: 1, max: 1 },
  TIMEZONE: { min: 1, max: 1 },
  TZ: { min: 1, max: 1 },
  NOW: { min: 0, max: 0 },
  UUID: { min: 0, max: 0 },
  STRUUID: { min: 0, max: 0 },
  IF: { min: 3, max: 3, lazy: true },
  STRLANG: { min: 2, max: 2 },
  STRLANGDIR: { min: 3, max: 3 },
  STRDT: { min: 2, max: 2 },
  sameTerm: { min: 2, max: 2 },
  isIRI: { min: 1, max: 1 },
  isURI: { min: 1, max: 1 },
  isBLANK: { min: 1, max: 1 },
  isLITERAL: { min: 1, max: 1 },
  isNUMERIC: { min: 1, max: 1 },
  hasLANG: { min: 1, max: 1 },
  hasLANGDIR: { min: 1, max: 1 },
  REGEX: { min: 2, max: 3 },
  isTRIPLE: { min: 1, max: 1 },
  TRIPLE: { min: 3, max: 3 },
  SUBJECT: { min: 1, max: 1 },
  PREDICATE: { min: 1, max: 1 },
  OBJECT: { min: 1, max: 1 },
});

const BUILTIN_BY_LOWER = new Map(Object.keys(BUILTIN_SIGNATURES).map((name) => [name.toLowerCase(), name]));

function canonicalBuiltinName(name) {
  return BUILTIN_BY_LOWER.get(String(name).toLowerCase()) || null;
}

function isBuiltinName(name) {
  return canonicalBuiltinName(name) !== null;
}

function builtinNames() {
  return Object.keys(BUILTIN_SIGNATURES);
}

function evalExpression(expr, binding, options = {}) {
  switch (expr.type) {
    case 'literal':
      return expr.value;
    case 'term':
      return expr.value;
    case 'var':
      return binding[expr.name];
    case 'list':
      return expr.items.map((item) => evalExpression(item, binding, options));
    case 'unary': {
      const value = evalExpression(expr.expr, binding, options);
      if (expr.op === '!') return !booleanValue(value);
      if (expr.op === '-') return -Number(termToPrimitive(valueToTermIfNeeded(value)));
      if (expr.op === '+') return Number(termToPrimitive(valueToTermIfNeeded(value)));
      throw new Error(`Unsupported unary operator ${expr.op}`);
    }
    case 'binary': {
      const left = evalExpression(expr.left, binding, options);
      if (expr.op === '&&') return booleanValue(left) && booleanValue(evalExpression(expr.right, binding, options));
      if (expr.op === '||') return booleanValue(left) || booleanValue(evalExpression(expr.right, binding, options));
      const right = evalExpression(expr.right, binding, options);
      return evalBinary(expr.op, left, right);
    }
    case 'call':
      return evalCallExpression(expr, binding, options);
    default:
      throw new Error(`Unsupported expression type ${expr.type}`);
  }
}

function evalCallExpression(expr, binding, options) {
  const canonical = canonicalBuiltinName(expr.name);
  if (canonical === 'IF') {
    validateArity(canonical, expr.args.length);
    const condition = evalExpression(expr.args[0], binding, options);
    return evalExpression(booleanValue(condition) ? expr.args[1] : expr.args[2], binding, options);
  }
  return callBuiltin(expr.name, expr.args.map((arg) => evalExpression(arg, binding, options)), binding, options);
}

function evalBinary(op, left, right) {
  if (op === '=') return termishEquals(left, right);
  if (op === '!=') return !termishEquals(left, right);
  if (op === 'IN' || op === 'NOT IN') {
    const list = Array.isArray(right) ? right : [];
    const found = list.some((item) => termishEquals(left, item));
    return op === 'IN' ? found : !found;
  }
  if (['<', '<=', '>', '>='].includes(op)) {
    const cmp = comparePrimitives(left, right);
    if (op === '<') return cmp < 0;
    if (op === '<=') return cmp <= 0;
    if (op === '>') return cmp > 0;
    if (op === '>=') return cmp >= 0;
  }
  const lp = termToPrimitive(valueToTermIfNeeded(left));
  const rp = termToPrimitive(valueToTermIfNeeded(right));
  if (op === '+') {
    if (typeof lp === 'number' && typeof rp === 'number') return lp + rp;
    return String(lp) + String(rp);
  }
  if (op === '-') return Number(lp) - Number(rp);
  if (op === '*') return Number(lp) * Number(rp);
  if (op === '/') return Number(lp) / Number(rp);
  throw new Error(`Unsupported binary operator ${op}`);
}

function valueToTermIfNeeded(value) {
  return value && value.type ? value : literal(value, inferDatatype(value));
}

function termishEquals(left, right) {
  if (left && left.type && right && right.type) return termEquals(left, right);
  const lp = left && left.type ? termToPrimitive(left) : left;
  const rp = right && right.type ? termToPrimitive(right) : right;
  return lp === rp;
}

function callBuiltin(name, args, binding = {}, options = {}) {
  const injected = options.builtins && (options.builtins[name] || options.builtins[String(name).toLowerCase()]);
  if (injected) return injected(args, { binding, iri, blankNode, literal, tripleTerm, termToString, booleanValue, termToPrimitive });

  const canonical = canonicalBuiltinName(name);
  if (!canonical) throw new Error(`Unknown builtin ${name}`);
  validateArity(canonical, args.length);
  const key = canonical.toLowerCase();

  if (key === 'str') return termToString(args[0]);
  if (key === 'iri' || key === 'uri') return makeIRI(termToString(args[0]), options);
  if (key === 'bnode') return makeBlankNode(args, options);
  if (key === 'concat') return args.map(termToString).join('');
  if (key === 'lcase') return termToString(args[0]).toLowerCase();
  if (key === 'ucase') return termToString(args[0]).toUpperCase();
  if (key === 'contains') return termToString(args[0]).includes(termToString(args[1]));
  if (key === 'strstarts') return termToString(args[0]).startsWith(termToString(args[1]));
  if (key === 'strends') return termToString(args[0]).endsWith(termToString(args[1]));
  if (key === 'strbefore') {
    const s = termToString(args[0]);
    const needle = termToString(args[1]);
    const index = s.indexOf(needle);
    return index < 0 ? '' : s.slice(0, index);
  }
  if (key === 'strafter') {
    const s = termToString(args[0]);
    const needle = termToString(args[1]);
    const index = s.indexOf(needle);
    return index < 0 ? '' : s.slice(index + needle.length);
  }
  if (key === 'encode_for_uri') return encodeURIComponent(termToString(args[0]));
  if (key === 'regex') return regex(args);
  if (key === 'replace') return replace(args);
  if (key === 'substr') return substr(args);
  if (key === 'sameterm') return termishEquals(args[0], args[1]);
  if (key === 'isiri' || key === 'isuri') return isIRI(args[0]);
  if (key === 'isblank') return isBlank(args[0]);
  if (key === 'isliteral') return isLiteral(args[0]);
  if (key === 'istriple') return isTripleTerm(args[0]);
  if (key === 'isnumeric') return isNumericValue(args[0]);
  if (key === 'datatype') return datatypeOf(args[0]);
  if (key === 'lang') return args[0] && args[0].type === 'literal' ? (args[0].lang || '') : '';
  if (key === 'langmatches') return langMatches(termToString(args[0]), termToString(args[1]));
  if (key === 'haslang') return !!(args[0] && args[0].type === 'literal' && args[0].lang);
  if (key === 'langdir') return args[0] && args[0].type === 'literal' ? (args[0].langDir || '') : '';
  if (key === 'haslangdir') return !!(args[0] && args[0].type === 'literal' && args[0].langDir);
  if (key === 'strlen') return termToString(args[0]).length;
  if (key === 'abs') return Math.abs(Number(termToPrimitive(valueToTermIfNeeded(args[0]))));
  if (key === 'floor') return Math.floor(Number(termToPrimitive(valueToTermIfNeeded(args[0]))));
  if (key === 'ceil') return Math.ceil(Number(termToPrimitive(valueToTermIfNeeded(args[0]))));
  if (key === 'round') return Math.round(Number(termToPrimitive(valueToTermIfNeeded(args[0]))));
  if (key === 'if') return booleanValue(args[0]) ? args[1] : args[2];
  if (key === 'strdt') return literal(termToString(args[0]), termToString(args[1]));
  if (key === 'strlang') return literal(termToString(args[0]), null, termToString(args[1]).toLowerCase());
  if (key === 'strlangdir') return literal(termToString(args[0]), null, termToString(args[1]).toLowerCase(), termToString(args[2]).toLowerCase());
  if (key === 'triple') return tripleTerm(valueToTermIfNeeded(args[0]), valueToTermIfNeeded(args[1]), valueToTermIfNeeded(args[2]));
  if (key === 'subject') return isTripleTerm(args[0]) ? args[0].s : null;
  if (key === 'predicate') return isTripleTerm(args[0]) ? args[0].p : null;
  if (key === 'object') return isTripleTerm(args[0]) ? args[0].o : null;
  if (key === 'year') return datePart(args[0], 'year');
  if (key === 'month') return datePart(args[0], 'month');
  if (key === 'day') return datePart(args[0], 'day');
  if (key === 'hours') return datePart(args[0], 'hours');
  if (key === 'minutes') return datePart(args[0], 'minutes');
  if (key === 'seconds') return datePart(args[0], 'seconds');
  if (key === 'timezone') return timezoneDuration(args[0]);
  if (key === 'tz') return timezoneLexical(args[0]);
  if (key === 'now') return literal((options.now || new Date()).toISOString(), XSD_DATETIME);
  if (key === 'uuid') return iri(`urn:uuid:${freshUuid(options)}`);
  if (key === 'struuid') return freshUuid(options);
  throw new Error(`Unimplemented builtin ${name}`);
}

function validateArity(canonical, actual) {
  const sig = BUILTIN_SIGNATURES[canonical];
  if (!sig) throw new Error(`Unknown builtin ${canonical}`);
  const tooFew = actual < sig.min;
  const tooMany = actual > sig.max;
  if (tooFew || tooMany) {
    const expected = sig.min === sig.max ? `${sig.min}` : `${sig.min}${sig.max === Infinity ? '+' : `..${sig.max}`}`;
    throw new Error(`${canonical} expects ${expected} argument${expected === '1' ? '' : 's'}, got ${actual}`);
  }
}

function makeIRI(value, options) {
  if (options.baseIRI && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) {
    try { return iri(new URL(value, options.baseIRI).href); } catch (_) { /* fall through */ }
  }
  return iri(value);
}

function makeBlankNode(args, options) {
  if (args.length === 0) return blankNode(freshId(options));
  const label = termToString(args[0]);
  if (!options.__bnodeLabels) options.__bnodeLabels = new Map();
  if (!options.__bnodeLabels.has(label)) options.__bnodeLabels.set(label, label || freshId(options));
  return blankNode(options.__bnodeLabels.get(label));
}

function regex(args) {
  const flags = regexFlags(termToString(args[2] || ''));
  return new RegExp(termToString(args[1]), flags).test(termToString(args[0]));
}

function replace(args) {
  const flags = regexFlags(termToString(args[3] || ''));
  const effectiveFlags = flags.includes('g') ? flags : `${flags}g`;
  return termToString(args[0]).replace(new RegExp(termToString(args[1]), effectiveFlags), termToString(args[2]));
}

function regexFlags(flags) {
  let out = '';
  for (const ch of String(flags)) {
    // JavaScript RegExp has no direct SPARQL/xpath "x" free-spacing flag, so ignore it.
    if (ch === 'x') continue;
    if ('imsuyg'.includes(ch) && !out.includes(ch)) out += ch;
  }
  return out;
}

function substr(args) {
  const value = termToString(args[0]);
  const start = Math.max(0, Number(termToPrimitive(valueToTermIfNeeded(args[1]))) - 1);
  if (args.length >= 3) return value.substring(start, start + Number(termToPrimitive(valueToTermIfNeeded(args[2]))));
  return value.substring(start);
}

function datatypeOf(value) {
  const term = valueToTermIfNeeded(value);
  if (term.type !== 'literal') return null;
  if (term.langDir) return iri(RDF_DIRLANGSTRING);
  if (term.lang) return iri(RDF_LANGSTRING);
  return iri(term.datatype || inferDatatype(term.value) || XSD_STRING);
}

function isNumericValue(value) {
  const term = valueToTermIfNeeded(value);
  if (typeof termToPrimitive(term) === 'number') return true;
  return term.type === 'literal' && NUMERIC_DATATYPES.has(term.datatype);
}

function datePart(value, part) {
  const lexical = termToString(value);
  const match = lexical.match(/^(-?\d{4,})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)(Z|[+-]\d{2}:?\d{2})?)?/);
  if (!match) return null;
  const [, year, month, day, hours = '0', minutes = '0', seconds = '0'] = match;
  if (part === 'year') return Number(year);
  if (part === 'month') return Number(month);
  if (part === 'day') return Number(day);
  if (part === 'hours') return Number(hours);
  if (part === 'minutes') return Number(minutes);
  if (part === 'seconds') return Number(seconds);
  return null;
}

function timezoneLexical(value) {
  const lexical = termToString(value);
  const match = lexical.match(/(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}:?\d{2})$/);
  return match ? match[1] : '';
}

function timezoneDuration(value) {
  const zone = timezoneLexical(value);
  if (!zone) return null;
  if (zone === 'Z') return literal('PT0S', XSD_DAYTIME_DURATION);
  const match = zone.match(/^([+-])(\d{2}):?(\d{2})$/);
  if (!match) return null;
  const [, sign, hh, mm] = match;
  const hours = Number(hh);
  const minutes = Number(mm);
  const body = `${hours ? `${hours}H` : ''}${minutes ? `${minutes}M` : ''}` || '0S';
  return literal(`${sign === '-' ? '-' : ''}PT${body}`, XSD_DAYTIME_DURATION);
}

function langMatches(lang, range) {
  if (range === '*') return lang.length > 0;
  return lang.toLowerCase() === range.toLowerCase() || lang.toLowerCase().startsWith(`${range.toLowerCase()}-`);
}

function freshUuid(options) {
  if (typeof options.uuidGenerator === 'function') return String(options.uuidGenerator());
  options.__eyesharlUuidCounter = (options.__eyesharlUuidCounter || 0) + 1;
  return `00000000-0000-4000-8000-${String(options.__eyesharlUuidCounter).padStart(12, '0')}`;
}

function freshId(options) {
  options.__eyesharlCounter = (options.__eyesharlCounter || 0) + 1;
  return `eyesharl-${options.__eyesharlCounter}`;
}

function asTerm(value) {
  return valueToTerm(value);
}

module.exports = {
  BUILTIN_SIGNATURES,
  builtinNames,
  canonicalBuiltinName,
  isBuiltinName,
  validateArity,
  evalExpression,
  booleanValue,
  asTerm,
  callBuiltin,
  evalBinary,
};
