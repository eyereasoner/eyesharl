'use strict';

const { tokenize, SyntaxErrorWithLocation } = require('./tokenizer.js');
const { isBuiltinName } = require('./builtins.js');
const {
  iri,
  variable,
  blankNode,
  literal,
  tripleTerm,
  RDF_TYPE,
  RDF_FIRST,
  RDF_REST,
  RDF_NIL,
  RDF_REIFIES,
  XSD_BOOLEAN,
  XSD_INTEGER,
  XSD_DECIMAL,
  XSD_DOUBLE,
} = require('./term.js');

class Parser {
  constructor(source, options = {}) {
    this.tokens = Array.isArray(source) ? source : tokenize(source, options.filename);
    this.pos = 0;
    this.baseIRI = options.baseIRI || null;
    this.version = null;
    this.imports = [];
    this.bnodeCounter = 0;
    this.prefixes = {
      rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
      sh: 'http://www.w3.org/ns/shacl#',
      srl: 'http://www.w3.org/ns/shacl-rules#',
      xsd: 'http://www.w3.org/2001/XMLSchema#',
      ...options.prefixes,
    };
  }

  parseProgram() {
    const data = [];
    const rules = [];
    while (!this.is('eof')) {
      if (this.matchWord('PREFIX')) {
        this.parsePrefix(false);
      } else if (this.matchWord('BASE')) {
        this.parseBase(false);
      } else if (this.matchWord('VERSION')) {
        this.parseVersion();
      } else if (this.matchWord('IMPORTS')) {
        this.parseImports();
      } else if (this.matchWord('DATA')) {
        this.expectValue('{');
        data.push(...this.parseTriplesBlock({ allowPath: false, context: 'data' }));
      } else if (this.matchWord('RULE')) {
        rules.push(this.parseRule());
      } else if (this.matchWord('IF')) {
        rules.push(this.parseIfThenRule());
      } else if (this.checkDeclarationKeyword()) {
        rules.push(...this.parseDeclaration());
      } else {
        throw this.error(`Expected PREFIX, BASE, VERSION, IMPORTS, DATA, RULE, IF, TRANSITIVE, SYMMETRIC, or INVERSE; got ${this.peek().value}`);
      }
    }
    return {
      baseIRI: this.baseIRI,
      version: this.version,
      imports: this.imports.slice(),
      prefixes: { ...this.prefixes },
      data,
      rules,
    };
  }

  parseBase(wasAtBase = false) {
    const iriToken = this.expectType('iri');
    this.baseIRI = iriToken.value;
    if (wasAtBase) this.consumeOptionalDot();
  }

  parsePrefix(wasAtPrefix = false) {
    const nameToken = this.advance();
    if (nameToken.type !== 'word') throw this.error('Expected prefix name', nameToken);
    let name = nameToken.value;
    if (!name.endsWith(':')) throw this.error('Prefix name must end with :', nameToken);
    name = name.slice(0, -1);
    const iriToken = this.expectType('iri');
    this.prefixes[name] = this.resolveIRI(iriToken.value, iriToken);
    if (wasAtPrefix) this.consumeOptionalDot();
  }

  parseVersion() {
    const token = this.expectType('string');
    this.version = token.value;
  }

  parseImports() {
    const target = this.parseIRIValue();
    this.imports.push(target.value);
    this.consumeOptionalDot();
  }

  parseRule() {
    this.expectValue('{');
    const head = this.parseTriplesBlock({ allowPath: false, context: 'head' });
    this.expectWord('WHERE');
    this.expectValue('{');
    const body = this.parseBodyBlockAlreadyOpen();
    return { name: null, head, body, runOnce: body.some((clause) => clause.type === 'set') };
  }

  parseIfThenRule() {
    this.expectValue('{');
    const body = this.parseBodyBlockAlreadyOpen();
    this.expectWord('THEN');
    this.expectValue('{');
    const head = this.parseTriplesBlock({ allowPath: false, context: 'head' });
    return { name: null, head, body, runOnce: body.some((clause) => clause.type === 'set') };
  }

  checkDeclarationKeyword() {
    return this.checkType('word') && ['TRANSITIVE', 'SYMMETRIC', 'INVERSE'].includes(this.peek().value.toUpperCase());
  }

  parseDeclaration() {
    if (this.matchWord('TRANSITIVE')) {
      this.expectValue('(');
      const pred = this.parseIRIValue();
      this.expectValue(')');
      this.consumeOptionalDot();
      return [{
        name: `TRANSITIVE(${pred.lexical})`,
        head: [{ s: variable('x'), p: iri(pred.value), o: variable('z') }],
        body: [
          { type: 'triple', triple: { s: variable('x'), p: iri(pred.value), o: variable('y') } },
          { type: 'triple', triple: { s: variable('y'), p: iri(pred.value), o: variable('z') } },
        ],
        runOnce: false,
      }];
    }
    if (this.matchWord('SYMMETRIC')) {
      this.expectValue('(');
      const pred = this.parseIRIValue();
      this.expectValue(')');
      this.consumeOptionalDot();
      return [{
        name: `SYMMETRIC(${pred.lexical})`,
        head: [{ s: variable('y'), p: iri(pred.value), o: variable('x') }],
        body: [{ type: 'triple', triple: { s: variable('x'), p: iri(pred.value), o: variable('y') } }],
        runOnce: false,
      }];
    }
    if (this.matchWord('INVERSE')) {
      this.expectValue('(');
      const left = this.parseIRIValue();
      this.expectValue(',');
      const right = this.parseIRIValue();
      this.expectValue(')');
      this.consumeOptionalDot();
      return [
        {
          name: `INVERSE(${left.lexical},${right.lexical})#1`,
          head: [{ s: variable('y'), p: iri(right.value), o: variable('x') }],
          body: [{ type: 'triple', triple: { s: variable('x'), p: iri(left.value), o: variable('y') } }],
          runOnce: false,
        },
        {
          name: `INVERSE(${left.lexical},${right.lexical})#2`,
          head: [{ s: variable('y'), p: iri(left.value), o: variable('x') }],
          body: [{ type: 'triple', triple: { s: variable('x'), p: iri(right.value), o: variable('y') } }],
          runOnce: false,
        },
      ];
    }
    throw this.error(`Expected declaration, got ${this.peek().value}`);
  }

  parseIRIValue() {
    const token = this.advance();
    if (token.type === 'iri') return { value: this.resolveIRI(token.value, token), lexical: `<${token.value}>` };
    if (token.type === 'word') {
      if (token.value === 'a') return { value: RDF_TYPE, lexical: 'a' };
      if (!token.value.includes(':')) throw this.error(`Expected IRI or prefixed name, got ${token.value}`, token);
      return { value: this.expandPrefixedName(token.value, token), lexical: token.value };
    }
    throw this.error(`Expected IRI or prefixed name, got ${token.value}`, token);
  }

  parseTriplesBlock(options = {}) {
    const triples = [];
    while (!this.matchValue('}')) {
      triples.push(...this.parseTripleStatement(options));
      this.consumeOptionalDot();
    }
    return triples;
  }

  parseTripleStatement(options = {}) {
    const subjectNode = this.parseGraphNode(options);
    const triples = [...subjectNode.triples];
    triples.push(...this.parsePropertyListForSubject(subjectNode.term, options));
    return triples;
  }

  parsePropertyListForSubject(subject, options = {}, terminators = ['}', '|}', ']']) {
    const triples = [];
    let keepParsingPredicates = true;

    while (keepParsingPredicates) {
      if (terminators.some((value) => this.checkValue(value)) || this.checkValue('.')) break;
      const predicate = options.allowPath ? this.parseVerbPathOrSimple() : this.parseVerbTerm();
      do {
        const objectNode = this.parseGraphNode(options);
        triples.push(...objectNode.triples);
        const baseTriple = { s: subject, p: predicate, o: objectNode.term };
        triples.push(baseTriple);
        triples.push(...this.parseAnnotationsForTriple(baseTriple, options));
      } while (this.matchValue(','));

      if (this.matchValue(';')) {
        keepParsingPredicates = !(this.checkValue('.') || terminators.some((value) => this.checkValue(value)));
      } else {
        keepParsingPredicates = false;
      }
    }

    return triples;
  }

  parseGraphNode(options = {}) {
    if (this.checkValue('[')) return this.parseBlankNodePropertyList(options);
    if (this.checkValue('(')) return this.parseCollection(options);
    if (this.checkValue('<<')) return this.parseReifiedTripleNode(options);
    return { term: this.parseTerm(options), triples: [] };
  }

  parseBlankNodePropertyList(options = {}) {
    this.expectValue('[');
    const node = this.freshGraphNode(options);
    if (this.matchValue(']')) return { term: node, triples: [] };
    const triples = this.parsePropertyListForSubject(node, options, [']']);
    this.expectValue(']');
    return { term: node, triples };
  }

  parseCollection(options = {}) {
    this.expectValue('(');
    if (this.matchValue(')')) return { term: iri(RDF_NIL), triples: [] };

    const items = [];
    while (!this.checkValue(')')) items.push(this.parseGraphNode(options));
    this.expectValue(')');

    const triples = [];
    for (const item of items) triples.push(...item.triples);
    const cells = items.map(() => this.freshGraphNode(options));
    for (let i = 0; i < items.length; i += 1) {
      triples.push({ s: cells[i], p: iri(RDF_FIRST), o: items[i].term });
      triples.push({ s: cells[i], p: iri(RDF_REST), o: i + 1 < cells.length ? cells[i + 1] : iri(RDF_NIL) });
    }
    return { term: cells[0], triples };
  }

  freshGraphNode(options = {}) {
    this.bnodeCounter += 1;
    const id = `b${this.bnodeCounter}`;
    return options.context === 'body' ? variable(`__${id}`) : blankNode(id);
  }

  parseAnnotationsForTriple(baseTriple, options = {}) {
    const triples = [];
    const reified = tripleTerm(baseTriple.s, baseTriple.p, baseTriple.o);
    let currentReifier = null;

    while (this.checkValue('~') || this.checkValue('{|')) {
      if (this.matchValue('~')) {
        currentReifier = this.parseOptionalReifier(options);
        triples.push({ s: currentReifier, p: iri(RDF_REIFIES), o: reified });
      } else if (this.matchValue('{|')) {
        const annotationSubject = currentReifier || this.freshGraphNode(options);
        triples.push({ s: annotationSubject, p: iri(RDF_REIFIES), o: reified });
        triples.push(...this.parsePropertyListForSubject(annotationSubject, options, ['|}']));
        this.expectValue('|}');
      }
    }
    return triples;
  }

  parseOptionalReifier(options = {}) {
    if (this.checkValue('{|') || this.checkValue('.') || this.checkValue(';') || this.checkValue(',') || this.checkValue('}') || this.checkValue('|}') || this.checkValue('>>')) {
      return this.freshGraphNode(options);
    }
    return this.parseVarOrReifierId();
  }

  parseVarOrReifierId() {
    const token = this.peek();
    if (token.type === 'variable') return this.parseTerm();
    if (token.type === 'iri') return this.parseTerm();
    if (token.type === 'word' && (token.value.startsWith('_:') || token.value.includes(':'))) return this.parseTerm();
    throw this.error(`Expected variable, IRI, or blank node after ~; got ${token.value}`, token);
  }

  parseReifiedTripleNode(options = {}) {
    this.expectValue('<<');
    const subjectNode = this.parseReifiedTripleComponent(options);
    const p = this.parseVerbTerm();
    const objectNode = this.parseReifiedTripleComponent(options);
    let reifier = null;
    if (this.matchValue('~')) reifier = this.parseOptionalReifier(options);
    this.expectValue('>>');
    reifier = reifier || this.freshGraphNode(options);
    return {
      term: reifier,
      triples: [
        ...subjectNode.triples,
        ...objectNode.triples,
        { s: reifier, p: iri(RDF_REIFIES), o: tripleTerm(subjectNode.term, p, objectNode.term) },
      ],
    };
  }

  parseReifiedTripleComponent(options = {}) {
    if (this.checkValue('<<')) return this.parseReifiedTripleNode(options);
    return { term: this.parseTerm(options), triples: [] };
  }

  parseVerbTerm() {
    const term = this.parseTerm();
    if (term.type !== 'iri' && term.type !== 'var') throw this.error('Expected IRI or variable as predicate');
    return term;
  }

  parseVerbPathOrSimple() {
    if (this.checkType('variable')) return this.parseTerm();
    return this.parsePathSequence();
  }

  parsePathSequence() {
    const parts = [this.parsePathEltOrInverse()];
    while (this.matchValue('/')) parts.push(this.parsePathEltOrInverse());
    return parts.length === 1 ? parts[0] : { type: 'path', kind: 'sequence', parts };
  }

  parsePathEltOrInverse() {
    if (this.matchValue('^')) return { type: 'path', kind: 'inverse', path: this.parsePathPrimary() };
    return this.parsePathPrimary();
  }

  parsePathPrimary() {
    if (this.matchValue('(')) {
      const path = this.parsePathSequence();
      this.expectValue(')');
      return path;
    }
    const token = this.peek();
    if (token.type === 'iri' || token.type === 'word') {
      const value = this.parseIRIValue();
      return iri(value.value);
    }
    throw this.error(`Expected path IRI, a, ^, or (, got ${token.value}`, token);
  }

  parseFilterClause() {
    // SRL FILTER accepts a bracketted expression, a built-in call, or an IRI-named function call.
    // The bracketted-expression form is the familiar FILTER(?x > 10).
    const expr = this.parseExpression();
    return { type: 'filter', expr };
  }

  parseBodyBlockAlreadyOpen() {
    const clauses = [];
    while (!this.matchValue('}')) {
      if (this.matchWord('FILTER')) {
        clauses.push(this.parseFilterClause());
      } else if (this.matchWord('SET')) {
        this.expectValue('(');
        const variableToken = this.expectType('variable');
        this.expectValue(':=');
        const expr = this.parseExpression();
        this.expectValue(')');
        clauses.push({ type: 'set', variable: variableToken.value, expr });
      } else if (this.matchWord('NOT')) {
        this.expectValue('{');
        const body = this.parseBodyBasicAlreadyOpen();
        clauses.push({ type: 'not', body });
      } else {
        for (const triple of this.parseTripleStatement({ allowPath: true, context: 'body' })) {
          if (triple.p && triple.p.type === 'path') clauses.push({ type: 'path', triple });
          else clauses.push({ type: 'triple', triple });
        }
      }
      this.consumeOptionalDot();
    }
    return clauses;
  }

  parseBodyBasicAlreadyOpen() {
    const clauses = [];
    while (!this.matchValue('}')) {
      if (this.matchWord('FILTER')) {
        clauses.push(this.parseFilterClause());
      } else if (this.matchWord('SET')) {
        throw this.error('SET is not allowed inside NOT blocks by the SRL grammar');
      } else if (this.matchWord('NOT')) {
        throw this.error('Nested NOT is not allowed inside NOT blocks by the SRL grammar');
      } else {
        for (const triple of this.parseTripleStatement({ allowPath: true, context: 'body' })) {
          if (triple.p && triple.p.type === 'path') clauses.push({ type: 'path', triple });
          else clauses.push({ type: 'triple', triple });
        }
      }
      this.consumeOptionalDot();
    }
    return clauses;
  }

  parseTerm() {
    const token = this.advance();
    if (token.type === 'operator' && (token.value === '+' || token.value === '-') && this.peek().type === 'number') {
      const numberToken = this.advance();
      return numericLiteral(token.value === '-' ? -numberToken.value : numberToken.value);
    }
    if (token.type === 'variable') return variable(token.value);
    if (token.type === 'iri') return iri(this.resolveIRI(token.value, token));
    if (token.type === 'string') return this.parseLiteralAfterToken(token);
    if (token.type === 'number') return numericLiteral(token.value);
    if (token.value === '<<(') return this.parseTripleTermAfterOpen();
    if (token.value === '<<') throw this.error('Use << s p o >> as a graph node reifier; use <<( s p o )>> for a triple term', token);
    if (token.type === 'word') {
      if (token.value === 'a') return iri(RDF_TYPE);
      if (token.value === 'true') return literal(true, XSD_BOOLEAN);
      if (token.value === 'false') return literal(false, XSD_BOOLEAN);
      if (token.value.startsWith('_:')) return blankNode(token.value.slice(2));
      return iri(this.expandPrefixedName(token.value, token));
    }
    throw this.error(`Expected term, got ${token.value}`, token);
  }

  parseTripleTermAfterOpen() {
    const s = this.parseTerm();
    const p = this.parseVerbTerm();
    const o = this.parseTerm();
    this.expectValue(')>>');
    return tripleTerm(s, p, o);
  }

  parseReifiedTripleAfterOpen() {
    const s = this.parseTerm();
    const p = this.parseVerbTerm();
    const o = this.parseTerm();
    if (this.matchValue('~')) {
      if (!this.checkValue('>>')) this.parseVarOrReifierId();
    }
    this.expectValue('>>');
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
    if (token.type === 'word') return this.expandPrefixedName(token.value, token);
    throw this.error(`Expected datatype IRI, got ${token.value}`, token);
  }

  expandPrefixedName(value, token) {
    const colon = value.indexOf(':');
    if (colon < 0) throw this.error(`Expected IRI, prefixed name, literal, blank node, or variable; got ${value}`, token);
    const prefix = value.slice(0, colon);
    const local = value.slice(colon + 1);
    if (!(prefix in this.prefixes)) throw this.error(`Unknown prefix ${prefix}:`, token);
    return this.prefixes[prefix] + local;
  }

  resolveIRI(value, token = null) {
    if (!this.baseIRI || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return value;
    try {
      return new URL(value, this.baseIRI).href;
    } catch (_) {
      if (token) throw this.error(`Could not resolve IRI ${value} against BASE ${this.baseIRI}`, token);
      return value;
    }
  }

  parseExpression(minPrec = 0) {
    let left = this.parseUnaryExpression();
    while (true) {
      const info = this.peekBinaryOperator();
      if (!info || info.prec < minPrec) break;
      this.consumeBinaryOperator(info.op);
      if (info.op === 'IN' || info.op === 'NOT IN') {
        const items = this.parseExpressionListItems();
        left = { type: 'binary', op: info.op, left, right: { type: 'list', items } };
      } else {
        const right = this.parseExpression(info.prec + 1);
        left = { type: 'binary', op: info.op, left, right };
      }
    }
    return left;
  }

  parseExpressionListItems() {
    this.expectValue('(');
    const items = [];
    if (!this.checkValue(')')) {
      do { items.push(this.parseExpression()); }
      while (this.matchValue(','));
    }
    this.expectValue(')');
    return items;
  }

  peekBinaryOperator() {
    const token = this.peek();
    if (token.type === 'operator') {
      const prec = binaryPrecedence(token.value);
      return prec >= 0 ? { op: token.value, prec } : null;
    }
    if (token.type === 'word' && token.value.toUpperCase() === 'IN') return { op: 'IN', prec: 3 };
    if (token.type === 'word' && token.value.toUpperCase() === 'NOT' && this.peekN(1).type === 'word' && this.peekN(1).value.toUpperCase() === 'IN') return { op: 'NOT IN', prec: 3 };
    return null;
  }

  consumeBinaryOperator(op) {
    if (op === 'NOT IN') { this.expectWord('NOT'); this.expectWord('IN'); return; }
    if (op === 'IN') { this.expectWord('IN'); return; }
    this.expectValue(op);
  }

  parseUnaryExpression() {
    if (this.peek().type === 'operator' && (this.peek().value === '!' || this.peek().value === '-' || this.peek().value === '+')) {
      const op = this.advance().value;
      return { type: 'unary', op, expr: this.parseUnaryExpression() };
    }
    return this.parsePrimaryExpression();
  }

  parsePrimaryExpression() {
    const token = this.advance();
    if (token.type === 'variable') return { type: 'var', name: token.value };
    if (token.type === 'string') return this.parseLiteralExpressionAfterToken(token);
    if (token.type === 'number') return { type: 'literal', value: token.value };
    if (token.type === 'iri') {
      const name = this.resolveIRI(token.value, token);
      if (this.checkValue('(')) return this.parseFunctionCallAfterName(name);
      return { type: 'term', value: iri(name) };
    }
    if (token.value === '<<(') return { type: 'term', value: this.parseTripleTermAfterOpen() };
    if (token.value === '<<') throw this.error('Use <<( s p o )>> for triple terms inside expressions', token);
    if (token.type === 'word') {
      if (token.value === 'true') return { type: 'literal', value: true };
      if (token.value === 'false') return { type: 'literal', value: false };
      if (token.value.startsWith('_:')) return { type: 'term', value: blankNode(token.value.slice(2)) };
      if (this.checkValue('(')) {
        if (token.value.includes(':') && token.value !== 'a') {
          const name = this.expandPrefixedName(token.value, token);
          return this.parseFunctionCallAfterName(name);
        }
        if (isBuiltinName(token.value)) return this.parseFunctionCallAfterName(token.value);
        throw this.error(`Unknown built-in or unprefixed function call ${token.value}; use an IRI such as :${token.value} for custom functions`, token);
      }
      if (token.value.includes(':') || token.value === 'a') {
        const value = token.value === 'a' ? RDF_TYPE : this.expandPrefixedName(token.value, token);
        return { type: 'term', value: iri(value) };
      }
    }
    if (token.value === '(') {
      const expr = this.parseExpression();
      this.expectValue(')');
      return expr;
    }
    throw this.error(`Expected expression, got ${token.value}`, token);
  }

  parseFunctionCallAfterName(name) {
    this.expectValue('(');
    const args = [];
    if (!this.checkValue(')')) {
      do { args.push(this.parseExpression()); }
      while (this.matchValue(','));
    }
    this.expectValue(')');
    return { type: 'call', name, args };
  }

  parseLiteralExpressionAfterToken(token) {
    const term = this.parseLiteralAfterToken(token);
    if (term.datatype || term.lang) return { type: 'term', value: term };
    return { type: 'literal', value: term.value };
  }

  consumeOptionalDot() { this.matchValue('.'); }

  matchWord(value) {
    if (this.checkType('word') && this.peek().value.toUpperCase() === value.toUpperCase()) {
      this.advance();
      return true;
    }
    return false;
  }

  expectWord(value) {
    if (this.matchWord(value)) return this.previous();
    throw this.error(`Expected ${value}, got ${this.peek().value}`);
  }

  matchValue(value) {
    const token = this.peek();
    if ((token.type === 'punct' || token.type === 'operator') && token.value === value) { this.advance(); return true; }
    return false;
  }

  expectValue(value) {
    if (this.matchValue(value)) return this.previous();
    throw this.error(`Expected ${value}, got ${this.peek().value}`);
  }

  checkValue(value) { const token = this.peek(); return (token.type === 'punct' || token.type === 'operator') && token.value === value; }
  checkType(type) { return this.peek().type === type; }
  is(type) { return this.peek().type === type; }

  expectType(type) {
    if (this.peek().type === type) return this.advance();
    throw this.error(`Expected ${type}, got ${this.peek().value}`);
  }

  advance() { if (!this.is('eof')) this.pos += 1; return this.previous(); }
  peek() { return this.tokens[this.pos]; }
  peekN(n) { return this.tokens[this.pos + n] || this.tokens[this.tokens.length - 1]; }
  previous() { return this.tokens[this.pos - 1]; }
  error(message, token = this.peek()) { return new SyntaxErrorWithLocation(message, token); }
}

function numericLiteral(value) {
  if (Number.isInteger(value)) return literal(value, XSD_INTEGER);
  return literal(value, XSD_DECIMAL);
}

function coerceLexicalLiteral(value, datatype) {
  if (datatype === XSD_INTEGER) return Number.parseInt(value, 10);
  if (datatype === XSD_DECIMAL || datatype === XSD_DOUBLE) return Number.parseFloat(value);
  if (datatype === XSD_BOOLEAN) return value === 'true' || value === '1';
  return value;
}

function binaryPrecedence(op) {
  return {
    '||': 1,
    '&&': 2,
    '=': 3,
    '!=': 3,
    'IN': 3,
    'NOT IN': 3,
    '<': 4,
    '<=': 4,
    '>': 4,
    '>=': 4,
    '+': 5,
    '-': 5,
    '*': 6,
    '/': 6,
  }[op] ?? -1;
}

function parse(source, options = {}) {
  return new Parser(source, options).parseProgram();
}

function parseQuery(source, options = {}) {
  if (/^\s*(QUERY|SELECT)\b/i.test(source)) {
    throw new Error('QUERY/SELECT concrete syntax is not part of the SHACL Rules SRL grammar; pass a raw body pattern instead');
  }
  const trimmed = String(source).trim();
  const text = trimmed.startsWith('{') ? `RULE { } WHERE ${trimmed}` : `RULE { } WHERE { ${source} }`;
  const program = new Parser(text, options).parseProgram();
  if (program.rules.length !== 1 || program.data.length !== 0) {
    throw new Error('Expected exactly one raw body pattern');
  }
  return { select: null, body: program.rules[0].body, prefixes: program.prefixes, baseIRI: program.baseIRI };
}

module.exports = { Parser, parse, parseQuery };
