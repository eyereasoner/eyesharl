'use strict';

const RDF_NS = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDF_TYPE = `${RDF_NS}type`;
const RDF_FIRST = `${RDF_NS}first`;
const RDF_REST = `${RDF_NS}rest`;
const RDF_NIL = `${RDF_NS}nil`;
const RDF_REIFIES = `${RDF_NS}reifies`;
const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const XSD_BOOLEAN = 'http://www.w3.org/2001/XMLSchema#boolean';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const XSD_DECIMAL = 'http://www.w3.org/2001/XMLSchema#decimal';
const XSD_DOUBLE = 'http://www.w3.org/2001/XMLSchema#double';

function iri(value) {
  return { type: 'iri', value: String(value) };
}

function variable(name) {
  return { type: 'var', value: String(name).replace(/^[?$]/, '') };
}

function blankNode(value) {
  return { type: 'blank', value: String(value).replace(/^_:/, '') };
}

function literal(value, datatype = null, lang = null, langDir = null) {
  return { type: 'literal', value, datatype, lang, langDir };
}

function tripleTerm(s, p, o) {
  return { type: 'triple', s, p, o };
}

function isVariable(term) {
  return term && term.type === 'var';
}

function isIRI(term) {
  return term && term.type === 'iri';
}

function isBlank(term) {
  return term && term.type === 'blank';
}

function isLiteral(term) {
  return term && term.type === 'literal';
}

function isTripleTerm(term) {
  return term && term.type === 'triple';
}

function termEquals(a, b) {
  return termKey(a) === termKey(b);
}

function termKey(term) {
  if (!term) return 'null';
  if (term.type === 'iri') return `I:${term.value}`;
  if (term.type === 'blank') return `B:${term.value}`;
  if (term.type === 'var') return `V:${term.value}`;
  if (term.type === 'literal') return `L:${JSON.stringify(term.value)}^^${term.datatype || ''}@${term.lang || ''}--${term.langDir || ''}`;
  if (term.type === 'triple') return `T:${termKey(term.s)} ${termKey(term.p)} ${termKey(term.o)}`;
  return JSON.stringify(term);
}

function tripleKey(triple) {
  return `${termKey(triple.s)} ${termKey(triple.p)} ${termKey(triple.o)}`;
}

function cloneTerm(term) {
  if (!term) return term;
  if (term.type === 'triple') return tripleTerm(cloneTerm(term.s), cloneTerm(term.p), cloneTerm(term.o));
  return { ...term };
}

function valueToTerm(value) {
  if (value && typeof value === 'object' && value.type) return value;
  return literal(value, inferDatatype(value));
}

function inferDatatype(value) {
  if (typeof value === 'boolean') return XSD_BOOLEAN;
  if (typeof value === 'number' && Number.isInteger(value)) return XSD_INTEGER;
  if (typeof value === 'number') return XSD_DECIMAL;
  if (typeof value === 'string') return XSD_STRING;
  return null;
}

function termToPrimitive(term) {
  if (!term) return undefined;
  if (term.type === 'literal') return term.value;
  if (term.type === 'iri') return term.value;
  if (term.type === 'blank') return `_:${term.value}`;
  if (term.type === 'var') return undefined;
  if (term.type === 'triple') return term;
  return term;
}

function termToString(term) {
  const value = termToPrimitive(term);
  if (value === undefined || value === null) return '';
  if (value && value.type === 'triple') return formatTerm(value);
  return String(value);
}

function booleanValue(value) {
  const primitive = value && value.type ? termToPrimitive(value) : value;
  if (primitive === undefined || primitive === null) return false;
  if (typeof primitive === 'boolean') return primitive;
  if (typeof primitive === 'number') return primitive !== 0 && !Number.isNaN(primitive);
  if (typeof primitive === 'string') return primitive.length > 0 && primitive !== 'false';
  return Boolean(primitive);
}

function comparePrimitives(a, b) {
  const av = a && a.type ? termToPrimitive(a) : a;
  const bv = b && b.type ? termToPrimitive(b) : b;
  if (typeof av === 'number' && typeof bv === 'number') return av - bv;
  const as = String(av);
  const bs = String(bv);
  if (as < bs) return -1;
  if (as > bs) return 1;
  return 0;
}

function escapeString(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/"/g, '\\"');
}

function compactIRI(value, prefixes = {}) {
  if (value === RDF_TYPE) return 'a';
  const entries = Object.entries(prefixes)
    .filter(([, iriPrefix]) => iriPrefix && value.startsWith(iriPrefix))
    .sort((a, b) => b[1].length - a[1].length);
  if (entries.length > 0) {
    const [prefix, iriPrefix] = entries[0];
    const local = value.slice(iriPrefix.length);
    if (/^[A-Za-z_][A-Za-z0-9_\-]*$/.test(local) || /^[A-Za-z0-9_\-]+$/.test(local)) {
      return `${prefix}:${local}`;
    }
  }
  return `<${value}>`;
}

function formatTerm(term, prefixes = {}) {
  if (term.type === 'iri') return compactIRI(term.value, prefixes);
  if (term.type === 'blank') return `_:${term.value}`;
  if (term.type === 'var') return `?${term.value}`;
  if (term.type === 'triple') return `<<(${formatTerm(term.s, prefixes)} ${formatTerm(term.p, prefixes)} ${formatTerm(term.o, prefixes)})>>`;
  if (term.type === 'literal') {
    const v = term.value;
    if (typeof v === 'number' && Number.isFinite(v) && !term.lang && (!term.datatype || term.datatype === XSD_INTEGER || term.datatype === XSD_DECIMAL || term.datatype === XSD_DOUBLE)) return String(v);
    if (typeof v === 'boolean' && !term.lang && (!term.datatype || term.datatype === XSD_BOOLEAN)) return v ? 'true' : 'false';
    const lexical = `"${escapeString(v)}"`;
    if (term.lang) return `${lexical}@${term.lang}${term.langDir ? `--${term.langDir}` : ''}`;
    if (term.datatype && term.datatype !== XSD_STRING) return `${lexical}^^${compactIRI(term.datatype, prefixes)}`;
    return lexical;
  }
  return String(term.value ?? term);
}

function formatTriple(triple, prefixes = {}) {
  return `${formatTerm(triple.s, prefixes)} ${formatTerm(triple.p, prefixes)} ${formatTerm(triple.o, prefixes)} .`;
}

module.exports = {
  RDF_NS,
  RDF_TYPE,
  RDF_FIRST,
  RDF_REST,
  RDF_NIL,
  RDF_REIFIES,
  XSD_STRING,
  XSD_BOOLEAN,
  XSD_INTEGER,
  XSD_DECIMAL,
  XSD_DOUBLE,
  iri,
  variable,
  blankNode,
  literal,
  tripleTerm,
  isVariable,
  isIRI,
  isBlank,
  isLiteral,
  isTripleTerm,
  termEquals,
  termKey,
  tripleKey,
  cloneTerm,
  valueToTerm,
  inferDatatype,
  termToPrimitive,
  termToString,
  booleanValue,
  comparePrimitives,
  compactIRI,
  formatTerm,
  formatTriple,
};
