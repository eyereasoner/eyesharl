'use strict';

const { tokenize, SyntaxErrorWithLocation } = require('./tokenizer.js');
const {
  iri,
  variable,
  blankNode,
  literal,
  tripleTerm,
  termKey,
  termEquals,
  formatTerm,
  RDF_TYPE,
  RDF_FIRST,
  RDF_REST,
  RDF_NIL,
  XSD_BOOLEAN,
  XSD_INTEGER,
  XSD_DECIMAL,
  XSD_DOUBLE,
} = require('./term.js');

const RDF_NS = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const SRL_NS = 'http://www.w3.org/ns/shacl-rules#';
const SHNEX_NS = 'http://www.w3.org/ns/shacl-node-expr#';
const SPARQL_NS = 'http://www.w3.org/ns/sparql#';
const OWL_IMPORTS = 'http://www.w3.org/2002/07/owl#imports';
const SRL_RULE_SET = `${SRL_NS}RuleSet`;
const SRL_RULE = `${SRL_NS}Rule`;
const SRL_DATA = `${SRL_NS}data`;
const SRL_RULES = `${SRL_NS}rules`;
const SRL_BODY = `${SRL_NS}body`;
const SRL_HEAD = `${SRL_NS}head`;
const SRL_SUBJECT = `${SRL_NS}subject`;
const SRL_PREDICATE = `${SRL_NS}predicate`;
const SRL_OBJECT = `${SRL_NS}object`;
const SRL_FILTER = `${SRL_NS}filter`;
const SRL_EXPR = `${SRL_NS}expr`;
const SRL_ASSIGN = `${SRL_NS}assign`;
const SRL_ASSIGN_VAR = `${SRL_NS}assignVar`;
const SRL_ASSIGN_VALUE = `${SRL_NS}assignValue`;
const SRL_NOT = `${SRL_NS}not`;
const SRL_VAR_NAME = `${SRL_NS}varName`;
const SHNEX_VAR = `${SHNEX_NS}var`;

class TurtleParser {
  constructor(source, options = {}) {
    this.tokens = Array.isArray(source) ? source : tokenize(source, options.filename || '<rdf>');
    this.pos = 0;
    this.baseIRI = options.baseIRI || null;
    this.bnodeCounter = 0;
    this.prefixes = {
      '': 'http://example/',
      rdf: RDF_NS,
      srl: SRL_NS,
      shnex: SHNEX_NS,
      sparql: SPARQL_NS,
      xsd: 'http://www.w3.org/2001/XMLSchema#',
      owl: 'http://www.w3.org/2002/07/owl#',
      ...options.prefixes,
    };
    this.triples = [];
    this.imports = [];
  }

  parseDocument() {
    while (!this.is('eof')) {
      if (this.matchDirective('PREFIX', '@prefix')) this.parsePrefix(this.previous().value.startsWith('@'));
      else if (this.matchDirective('BASE', '@base')) this.parseBase(this.previous().value.startsWith('@'));
      else this.parseTriplesStatement();
    }
    return {
      baseIRI: this.baseIRI,
      prefixes: { ...this.prefixes },
      triples: this.triples,
      imports: this.imports.slice(),
    };
  }

  parsePrefix(atStyle = false) {
    const nameToken = this.advance();
    if (nameToken.type !== 'word' || !nameToken.value.endsWith(':')) throw this.error('Expected prefix label ending in :', nameToken);
    const iriToken = this.expectType('iri');
    this.prefixes[nameToken.value.slice(0, -1)] = this.resolveIRI(iriToken.value, iriToken);
    if (atStyle) this.expectValue('.');
  }

  parseBase(atStyle = false) {
    const iriToken = this.expectType('iri');
    this.baseIRI = this.resolveIRI(iriToken.value, iriToken);
    if (atStyle) this.expectValue('.');
  }

  parseTriplesStatement() {
    const subjectNode = this.parseNode();
    this.triples.push(...subjectNode.triples);
    this.triples.push(...this.parsePredicateObjectList(subjectNode.term, ['.']));
    this.expectValue('.');
  }

  parsePredicateObjectList(subject, terminators = [']']) {
    const triples = [];
    while (!terminators.some((value) => this.checkValue(value))) {
      const predicate = this.parseVerb();
      do {
        const objectNode = this.parseNode();
        triples.push(...objectNode.triples);
        triples.push({ s: subject, p: predicate, o: objectNode.term });
        if (predicate.type === 'iri' && predicate.value === OWL_IMPORTS && objectNode.term.type === 'iri') this.imports.push(objectNode.term.value);
      } while (this.matchValue(','));
      if (this.matchValue(';')) {
        while (this.matchValue(';')) { /* tolerate repeated semicolons */ }
        if (terminators.some((value) => this.checkValue(value))) break;
      } else break;
    }
    return triples;
  }

  parseNode() {
    if (this.checkValue('[')) return this.parseBlankNodePropertyList();
    if (this.checkValue('(')) return this.parseCollection();
    return { term: this.parseTerm(), triples: [] };
  }

  parseBlankNodePropertyList() {
    this.expectValue('[');
    const node = this.freshBlankNode();
    if (this.matchValue(']')) return { term: node, triples: [] };
    const triples = this.parsePredicateObjectList(node, [']']);
    this.expectValue(']');
    return { term: node, triples };
  }

  parseCollection() {
    this.expectValue('(');
    if (this.matchValue(')')) return { term: iri(RDF_NIL), triples: [] };
    const items = [];
    while (!this.checkValue(')')) items.push(this.parseNode());
    this.expectValue(')');
    const triples = [];
    for (const item of items) triples.push(...item.triples);
    const cells = items.map(() => this.freshBlankNode());
    for (let i = 0; i < items.length; i += 1) {
      triples.push({ s: cells[i], p: iri(RDF_FIRST), o: items[i].term });
      triples.push({ s: cells[i], p: iri(RDF_REST), o: i + 1 < cells.length ? cells[i + 1] : iri(RDF_NIL) });
    }
    return { term: cells[0], triples };
  }

  parseVerb() {
    if (this.checkType('word') && this.peek().value === 'a') { this.advance(); return iri(RDF_TYPE); }
    const term = this.parseTerm();
    if (term.type !== 'iri') throw this.error('Expected IRI as Turtle predicate');
    return term;
  }

  parseTerm() {
    const token = this.advance();
    if (token.type === 'operator' && (token.value === '+' || token.value === '-') && this.peek().type === 'number') {
      const numberToken = this.advance();
      return numericLiteral(token.value === '-' ? -numberToken.value : numberToken.value);
    }
    if (token.type === 'iri') return iri(this.resolveIRI(token.value, token));
    if (token.type === 'string') return this.parseLiteralAfterToken(token);
    if (token.type === 'number') return numericLiteral(token.value);
    if (token.value === '<<(') return this.parseTripleTermAfterOpen();
    if (token.type === 'word') {
      const word = token.value.includes(':') || token.value.startsWith('_:') ? this.consumeHyphenatedWord(token.value) : token.value;
      if (word === 'a') return iri(RDF_TYPE);
      if (word === 'true') return literal(true, XSD_BOOLEAN);
      if (word === 'false') return literal(false, XSD_BOOLEAN);
      if (word.startsWith('_:')) return blankNode(word.slice(2));
      if (word.includes(':')) return iri(this.expandPrefixedName(word, token));
    }
    throw this.error(`Expected RDF term, got ${token.value}`, token);
  }

  parseTripleTermAfterOpen() {
    const s = this.parseTerm();
    const p = this.parseVerb();
    const o = this.parseTerm();
    this.expectValue(')>>');
    return tripleTerm(s, p, o);
  }

  parseLiteralAfterToken(token) {
    if (this.matchValue('^^')) {
      const datatype = this.parseDatatypeIRI();
      return literal(coerceLexicalLiteral(token.value, datatype), datatype, null);
    }
    if (this.checkType('word') && /^@[A-Za-z]+(?:-[A-Za-z0-9]+)*(?:--[A-Za-z]+)?$/.test(this.peek().value)) {
      const tag = this.advance().value.slice(1).toLowerCase();
      const [lang, langDir = null] = tag.split('--');
      return literal(token.value, null, lang, langDir);
    }
    return literal(token.value);
  }

  parseDatatypeIRI() {
    const token = this.advance();
    if (token.type === 'iri') return this.resolveIRI(token.value, token);
    if (token.type === 'word' && token.value.includes(':')) return this.expandPrefixedName(token.value, token);
    throw this.error(`Expected datatype IRI, got ${token.value}`, token);
  }

  freshBlankNode() {
    this.bnodeCounter += 1;
    return blankNode(`rdf${this.bnodeCounter}`);
  }

  consumeHyphenatedWord(value) {
    let out = value;
    while (this.checkValue('-') && (this.peekN(1).type === 'word' || this.peekN(1).type === 'number')) {
      this.advance();
      out += `-${this.advance().value}`;
    }
    return out;
  }

  expandPrefixedName(value, token) {
    const colon = value.indexOf(':');
    if (colon < 0) throw this.error(`Expected prefixed name, got ${value}`, token);
    const prefix = value.slice(0, colon);
    const local = value.slice(colon + 1);
    if (!Object.hasOwn(this.prefixes, prefix)) throw this.error(`Unknown prefix ${prefix}:`, token);
    return this.prefixes[prefix] + local;
  }

  resolveIRI(value) {
    if (!this.baseIRI || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return value;
    try { return new URL(value, this.baseIRI).href; } catch (_) { return value; }
  }

  matchDirective(...names) {
    if (this.checkType('word')) {
      const value = this.peek().value;
      if (names.some((name) => value.toUpperCase() === name.toUpperCase())) { this.advance(); return true; }
    }
    return false;
  }

  previous() { return this.tokens[this.pos - 1]; }
  peek() { return this.tokens[this.pos]; }
  peekN(n) { return this.tokens[this.pos + n]; }
  is(type) { return this.peek().type === type; }
  checkType(type) { return this.peek().type === type; }
  checkValue(value) { return this.peek().value === value; }
  matchValue(value) { if (this.checkValue(value)) { this.advance(); return true; } return false; }
  advance() { return this.tokens[this.pos++]; }
  expectType(type) { const token = this.advance(); if (token.type !== type) throw this.error(`Expected ${type}, got ${token.value}`, token); return token; }
  expectValue(value) { const token = this.advance(); if (token.value !== value) throw this.error(`Expected ${value}, got ${token.value}`, token); return token; }
  error(message, token = this.peek()) { return new SyntaxErrorWithLocation(message, token); }
}

function parseRdfDocument(source, options = {}) {
  return new TurtleParser(source, options).parseDocument();
}

function parseRdfSyntax(source, options = {}) {
  const document = parseRdfDocument(source, options);
  return rdfDocumentToProgram(document, options);
}

function rdfDocumentToProgram(document, options = {}) {
  const graph = new RdfGraph(document.triples, document.prefixes);
  const ruleSetNodes = chooseRuleSets(graph, options.ruleSet);
  if (ruleSetNodes.length === 0) throw new Error('No srl:RuleSet found in RDF Rules syntax input');

  const program = {
    baseIRI: document.baseIRI || null,
    version: null,
    imports: options.rdfImportsAsImports ? document.imports.slice() : [],
    prefixes: { ...document.prefixes },
    data: [],
    rules: [],
    rdfSyntax: true,
    ruleSets: ruleSetNodes.map((term) => formatTerm(term, document.prefixes)),
  };

  for (const ruleSet of ruleSetNodes) {
    for (const dataList of graph.objects(ruleSet, SRL_DATA)) {
      for (const item of graph.list(dataList)) program.data.push(toDataTriple(item, graph));
    }
    for (const rulesList of graph.objects(ruleSet, SRL_RULES)) {
      for (const ruleNode of graph.list(rulesList)) program.rules.push(toRule(ruleNode, graph));
    }
  }
  return program;
}

function chooseRuleSets(graph, selected) {
  if (selected) {
    const term = graph.parseReference(selected);
    return [term];
  }
  const typed = graph.subjects(RDF_TYPE, iri(SRL_RULE_SET));
  if (typed.length > 0) return uniqueTerms(typed);
  const byData = graph.subjectsWithPredicate(SRL_DATA);
  const byRules = graph.subjectsWithPredicate(SRL_RULES);
  return uniqueTerms([...byData, ...byRules]).filter((term) => graph.objects(term, SRL_RULES).length > 0 || graph.objects(term, SRL_DATA).length > 0);
}

function toDataTriple(item, graph) {
  if (item.type === 'triple') return { s: item.s, p: item.p, o: item.o };
  const triple = toTripleLike(item, graph);
  if ([triple.s, triple.p, triple.o].some((term) => term.type === 'var')) throw new Error('RDF Rules srl:data may not contain variables');
  if (triple.p.type !== 'iri') throw new Error('RDF Rules data triple predicate must be an IRI');
  return triple;
}

function toRule(ruleNode, graph) {
  const bodyLists = graph.objects(ruleNode, SRL_BODY);
  const headLists = graph.objects(ruleNode, SRL_HEAD);
  if (bodyLists.length !== 1 || headLists.length !== 1) throw new Error(`RDF Rule ${graph.label(ruleNode)} must have exactly one srl:body and one srl:head`);
  const body = graph.list(bodyLists[0]).map((item) => toBodyElement(item, graph));
  const head = graph.list(headLists[0]).map((item) => toTripleLike(item, graph));
  return { name: graph.label(ruleNode), head, body, runOnce: body.some((clause) => clause.type === 'set') };
}

function toBodyElement(node, graph) {
  if (hasTripleShape(node, graph)) return { type: 'triple', triple: toTripleLike(node, graph) };
  const filters = graph.objects(node, SRL_FILTER).concat(graph.objects(node, SRL_EXPR));
  if (filters.length > 0) {
    if (filters.length !== 1) throw new Error(`Filter element ${graph.label(node)} must have exactly one srl:filter`);
    return { type: 'filter', expr: toExpression(filters[0], graph) };
  }
  const assigns = graph.objects(node, SRL_ASSIGN);
  if (assigns.length > 0) {
    if (assigns.length !== 1) throw new Error(`Assignment element ${graph.label(node)} must have exactly one srl:assign`);
    const assign = assigns[0];
    const vars = graph.objects(assign, SRL_ASSIGN_VAR);
    const values = graph.objects(assign, SRL_ASSIGN_VALUE);
    if (vars.length !== 1 || values.length !== 1) throw new Error(`Assignment ${graph.label(assign)} must have exactly one srl:assignVar and srl:assignValue`);
    const variableTerm = toVarOrTerm(vars[0], graph);
    if (variableTerm.type !== 'var') throw new Error('srl:assignVar must point to a variable node');
    return { type: 'set', variable: variableTerm.value, expr: toExpression(values[0], graph) };
  }
  const negations = graph.objects(node, SRL_NOT);
  if (negations.length > 0) {
    if (negations.length !== 1) throw new Error(`Negation element ${graph.label(node)} must have exactly one srl:not`);
    const body = graph.list(negations[0]).map((item) => {
      const clause = toBodyElement(item, graph);
      if (clause.type === 'set' || clause.type === 'not') throw new Error('RDF Rules srl:not may contain only triple patterns and filters');
      return clause;
    });
    return { type: 'not', body };
  }
  throw new Error(`Unsupported RDF Rules body element ${graph.label(node)}`);
}

function toTripleLike(node, graph) {
  if (node.type === 'triple') return { s: node.s, p: node.p, o: node.o };
  const subjects = graph.objects(node, SRL_SUBJECT);
  const predicates = graph.objects(node, SRL_PREDICATE);
  const objects = graph.objects(node, SRL_OBJECT);
  if (subjects.length !== 1 || predicates.length !== 1 || objects.length !== 1) {
    throw new Error(`Triple node ${graph.label(node)} must have exactly one srl:subject, srl:predicate and srl:object`);
  }
  return {
    s: toVarOrTerm(subjects[0], graph),
    p: toVarOrTerm(predicates[0], graph),
    o: toVarOrTerm(objects[0], graph),
  };
}

function hasTripleShape(node, graph) {
  return graph.objects(node, SRL_SUBJECT).length > 0 || graph.objects(node, SRL_PREDICATE).length > 0 || graph.objects(node, SRL_OBJECT).length > 0;
}

function toVarOrTerm(node, graph) {
  const varNames = graph.objects(node, SRL_VAR_NAME);
  if (varNames.length > 0) {
    if (varNames.length !== 1 || varNames[0].type !== 'literal') throw new Error(`Variable node ${graph.label(node)} must have exactly one string srl:varName`);
    return variable(String(varNames[0].value));
  }
  return node;
}

function toExpression(node, graph) {
  const varNames = graph.objects(node, SHNEX_VAR).concat(graph.objects(node, SRL_VAR_NAME));
  if (varNames.length > 0) {
    if (varNames.length !== 1 || varNames[0].type !== 'literal') throw new Error(`Expression variable ${graph.label(node)} must name one variable`);
    return { type: 'var', name: String(varNames[0].value) };
  }
  if (node.type === 'literal') {
    if (node.datatype || node.lang) return { type: 'term', value: node };
    return { type: 'literal', value: node.value };
  }
  if (node.type === 'iri' || node.type === 'blank' || node.type === 'triple') {
    const call = graph.functionCall(node);
    if (call) return toFunctionExpression(call.name, call.args.map((arg) => toExpression(arg, graph)));
    if (node.type === 'blank' && graph.hasOutgoing(node)) return { type: 'term', value: node };
    return { type: 'term', value: toVarOrTerm(node, graph) };
  }
  return { type: 'term', value: node };
}

function toFunctionExpression(name, args) {
  if (name.startsWith(SPARQL_NS)) {
    const local = name.slice(SPARQL_NS.length);
    if (local === 'less-than' || local === 'lessThan') return binary('<', args);
    if (local === 'less-than-or-equal' || local === 'lessThanOrEqual') return binary('<=', args);
    if (local === 'greater-than' || local === 'greaterThan') return binary('>', args);
    if (local === 'greater-than-or-equal' || local === 'greaterThanOrEqual') return binary('>=', args);
    if (local === 'equal' || local === 'equals') return binary('=', args);
    if (local === 'not-equal' || local === 'notEqual') return binary('!=', args);
    if (local === 'add') return foldBinary('+', args);
    if (local === 'subtract') return binary('-', args);
    if (local === 'multiply') return foldBinary('*', args);
    if (local === 'divide') return binary('/', args);
    if (local === 'and' || local === 'function-and') return foldBinary('&&', args);
    if (local === 'or' || local === 'function-or') return foldBinary('||', args);
    if (local === 'not') return { type: 'unary', op: '!', expr: args[0] };
    const builtin = sparqlLocalToBuiltin(local);
    return { type: 'call', name: builtin, args };
  }
  return { type: 'call', name, args };
}

function binary(op, args) {
  if (args.length !== 2) throw new Error(`sparql operator ${op} expects 2 arguments`);
  return { type: 'binary', op, left: args[0], right: args[1] };
}

function foldBinary(op, args) {
  if (args.length < 2) throw new Error(`sparql operator ${op} expects at least 2 arguments`);
  return args.slice(1).reduce((left, right) => ({ type: 'binary', op, left, right }), args[0]);
}

function sparqlLocalToBuiltin(local) {
  return local.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase()).replace(/^./, (ch) => ch.toUpperCase());
}

class RdfGraph {
  constructor(triples, prefixes = {}) {
    this.triples = triples;
    this.prefixes = prefixes;
    this.bySubject = new Map();
    for (const triple of triples) {
      const key = termKey(triple.s);
      if (!this.bySubject.has(key)) this.bySubject.set(key, []);
      this.bySubject.get(key).push(triple);
    }
  }

  objects(subject, predicateIRI) {
    const rows = this.bySubject.get(termKey(subject)) || [];
    return rows.filter((triple) => triple.p.type === 'iri' && triple.p.value === predicateIRI).map((triple) => triple.o);
  }

  subjects(predicateIRI, object) {
    return this.triples.filter((triple) => triple.p.type === 'iri' && triple.p.value === predicateIRI && termEquals(triple.o, object)).map((triple) => triple.s);
  }

  subjectsWithPredicate(predicateIRI) {
    return this.triples.filter((triple) => triple.p.type === 'iri' && triple.p.value === predicateIRI).map((triple) => triple.s);
  }

  hasOutgoing(subject) {
    return (this.bySubject.get(termKey(subject)) || []).length > 0;
  }

  list(head) {
    const out = [];
    let node = head;
    const seen = new Set();
    while (!(node.type === 'iri' && node.value === RDF_NIL)) {
      const key = termKey(node);
      if (seen.has(key)) throw new Error(`Cycle in RDF list at ${this.label(node)}`);
      seen.add(key);
      const first = this.objects(node, RDF_FIRST);
      const rest = this.objects(node, RDF_REST);
      if (first.length !== 1 || rest.length !== 1) throw new Error(`Expected RDF list node at ${this.label(node)}`);
      out.push(first[0]);
      node = rest[0];
    }
    return out;
  }

  functionCall(node) {
    if (node.type !== 'blank') return null;
    const rows = (this.bySubject.get(termKey(node)) || []).filter((triple) => triple.p.type === 'iri');
    const calls = rows.filter((triple) => triple.p.value.startsWith(SPARQL_NS) || triple.p.value.includes('#') || triple.p.value.includes('/'));
    const viable = calls.filter((triple) => isRdfListHead(triple.o, this));
    if (viable.length !== 1) return null;
    return { name: viable[0].p.value, args: this.list(viable[0].o) };
  }

  parseReference(text) {
    if (typeof text !== 'string') return text;
    if (text.startsWith('<') && text.endsWith('>')) return iri(text.slice(1, -1));
    if (text.startsWith('_:')) return blankNode(text.slice(2));
    const colon = text.indexOf(':');
    if (colon >= 0) {
      const prefix = text.slice(0, colon);
      const local = text.slice(colon + 1);
      const ns = this.prefixes[prefix] || (prefix === 'srl' ? SRL_NS : null);
      if (ns) return iri(ns + local);
    }
    return iri(text);
  }

  label(term) { return formatTerm(term, this.prefixes); }
}

function isRdfListHead(term, graph) {
  return (term.type === 'iri' && term.value === RDF_NIL) || graph.objects(term, RDF_FIRST).length === 1;
}

function uniqueTerms(terms) {
  const seen = new Set();
  const out = [];
  for (const term of terms) {
    const key = termKey(term);
    if (!seen.has(key)) { seen.add(key); out.push(term); }
  }
  return out;
}

function numericLiteral(value) {
  if (Number.isInteger(value)) return literal(value, XSD_INTEGER);
  if (String(value).includes('e') || String(value).includes('E')) return literal(value, XSD_DOUBLE);
  return literal(value, XSD_DECIMAL);
}

function coerceLexicalLiteral(value, datatype) {
  if (datatype === XSD_INTEGER) return Number.parseInt(value, 10);
  if (datatype === XSD_DECIMAL || datatype === XSD_DOUBLE) return Number(value);
  if (datatype === XSD_BOOLEAN) return value === true || value === 'true' || value === '1';
  return value;
}

function looksLikeRdfRules(source, options = {}) {
  if (options.syntax === 'rdf') return true;
  if (options.syntax === 'srl') return false;
  if (options.filename && /\.(ttl|trig|nt|n3)$/i.test(options.filename)) return true;
  return /\bsrl:RuleSet\b|\bsrl:rules\b|http:\/\/www\.w3\.org\/ns\/shacl-rules#RuleSet/.test(source);
}

module.exports = {
  parseRdfDocument,
  parseRdfSyntax,
  rdfDocumentToProgram,
  looksLikeRdfRules,
  TurtleParser,
  RdfGraph,
  constants: {
    SRL_NS,
    SHNEX_NS,
    SPARQL_NS,
    SRL_RULE_SET,
    SRL_RULE,
  },
};
