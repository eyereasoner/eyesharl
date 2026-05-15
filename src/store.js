'use strict';

const { tripleKey, termKey, termEquals, cloneTerm } = require('./term.js');

class TripleStore {
  constructor(triples = []) {
    this.map = new Map();
    this.byPredicate = new Map();
    this.byPredicateSubject = new Map();
    this.byPredicateObject = new Map();
    for (const triple of triples) this.add(triple);
  }

  add(triple) {
    const normalized = normalizeTriple(triple);
    const key = tripleKey(normalized);
    if (this.map.has(key)) return false;
    this.map.set(key, normalized);
    const predicate = termKey(normalized.p);
    const subject = termKey(normalized.s);
    const object = termKey(normalized.o);
    addIndex(this.byPredicate, predicate, key, normalized);
    addNestedIndex(this.byPredicateSubject, predicate, subject, key, normalized);
    addNestedIndex(this.byPredicateObject, predicate, object, key, normalized);
    return true;
  }

  has(triple) {
    return this.map.has(tripleKey(normalizeTriple(triple)));
  }

  values() {
    return Array.from(this.map.values());
  }

  size() {
    return this.map.size;
  }

  candidates(pattern, binding = {}) {
    const p = instantiateTerm(pattern.p, binding);
    if (p && p.type !== 'var') {
      const predicate = termKey(p);
      const s = instantiateTerm(pattern.s, binding);
      const o = instantiateTerm(pattern.o, binding);
      const bySubject = s && s.type !== 'var' ? nestedLookup(this.byPredicateSubject, predicate, termKey(s)) : null;
      const byObject = o && o.type !== 'var' ? nestedLookup(this.byPredicateObject, predicate, termKey(o)) : null;
      if (bySubject && byObject) return smallerValues(bySubject, byObject);
      if (bySubject) return Array.from(bySubject.values());
      if (byObject) return Array.from(byObject.values());
      const indexed = this.byPredicate.get(predicate);
      return indexed ? Array.from(indexed.values()) : [];
    }
    return this.values();
  }

  match(pattern, binding = {}) {
    const out = [];
    for (const triple of this.candidates(pattern, binding)) {
      const matched = matchTriple(pattern, triple, binding);
      if (matched) out.push(matched);
    }
    return out;
  }

  matchPath(pattern, binding = {}) {
    const out = [];
    for (const pair of pathPairs(this, pattern.p)) {
      let next = mergeBindingTerm(binding, pattern.s, pair.s);
      if (!next) continue;
      next = mergeBindingTerm(next, pattern.o, pair.o);
      if (next) out.push(next);
    }
    return out;
  }
}

function addIndex(index, key, tripleKeyValue, triple) {
  if (!index.has(key)) index.set(key, new Map());
  index.get(key).set(tripleKeyValue, triple);
}

function addNestedIndex(index, outerKey, innerKey, tripleKeyValue, triple) {
  if (!index.has(outerKey)) index.set(outerKey, new Map());
  const inner = index.get(outerKey);
  if (!inner.has(innerKey)) inner.set(innerKey, new Map());
  inner.get(innerKey).set(tripleKeyValue, triple);
}

function nestedLookup(index, outerKey, innerKey) {
  const inner = index.get(outerKey);
  return inner ? inner.get(innerKey) || null : null;
}

function smallerValues(left, right) {
  const small = left.size <= right.size ? left : right;
  const large = small === left ? right : left;
  const out = [];
  for (const [key, triple] of small) if (large.has(key)) out.push(triple);
  return out;
}

function normalizeTriple(triple) {
  return { s: cloneTerm(triple.s), p: cloneTerm(triple.p), o: cloneTerm(triple.o) };
}

function bindingKey(binding) {
  return Object.keys(binding).sort().map((name) => `${name}=${termKey(binding[name])}`).join(';');
}

function mergeBindingTerm(binding, patternTerm, dataTerm) {
  if (!patternTerm || !dataTerm) return null;
  if (patternTerm.type === 'var') {
    const name = patternTerm.value;
    if (!binding[name]) return { ...binding, [name]: dataTerm };
    return termEquals(binding[name], dataTerm) ? binding : null;
  }
  if (patternTerm.type === 'triple') {
    if (dataTerm.type !== 'triple') return null;
    let next = mergeBindingTerm(binding, patternTerm.s, dataTerm.s);
    if (!next) return null;
    next = mergeBindingTerm(next, patternTerm.p, dataTerm.p);
    if (!next) return null;
    return mergeBindingTerm(next, patternTerm.o, dataTerm.o);
  }
  return termEquals(patternTerm, dataTerm) ? binding : null;
}

function matchTriple(pattern, triple, binding = {}) {
  let next = mergeBindingTerm(binding, pattern.s, triple.s);
  if (!next) return null;
  next = mergeBindingTerm(next, pattern.p, triple.p);
  if (!next) return null;
  next = mergeBindingTerm(next, pattern.o, triple.o);
  return next;
}

function instantiateTerm(term, binding) {
  if (term.type === 'var') return binding[term.value] || null;
  if (term.type === 'triple') {
    const s = instantiateTerm(term.s, binding);
    const p = instantiateTerm(term.p, binding);
    const o = instantiateTerm(term.o, binding);
    if (!s || !p || !o) return null;
    return { type: 'triple', s, p, o };
  }
  return term;
}

function instantiateTriple(pattern, binding) {
  const s = instantiateTerm(pattern.s, binding);
  const p = instantiateTerm(pattern.p, binding);
  const o = instantiateTerm(pattern.o, binding);
  if (!s || !p || !o) return null;
  if (p.type !== 'iri') return null;
  return { s, p, o };
}

function pathPairs(store, path) {
  if (!path || path.type !== 'path') {
    return store.match({ s: { type: 'var', value: '__s' }, p: path, o: { type: 'var', value: '__o' } })
      .map((binding) => ({ s: binding.__s, o: binding.__o }));
  }

  if (path.kind === 'iri') {
    return pathPairs(store, path.iri);
  }

  if (path.kind === 'inverse') {
    return pathPairs(store, path.path).map((pair) => ({ s: pair.o, o: pair.s }));
  }

  if (path.kind === 'sequence') {
    let pairs = pathPairs(store, path.parts[0]);
    for (const part of path.parts.slice(1)) {
      const right = pathPairs(store, part);
      const joined = [];
      for (const leftPair of pairs) {
        for (const rightPair of right) {
          if (termEquals(leftPair.o, rightPair.s)) joined.push({ s: leftPair.s, o: rightPair.o });
        }
      }
      pairs = uniquePairs(joined);
    }
    return pairs;
  }

  throw new Error(`Unsupported path kind ${path.kind}`);
}

function uniquePairs(pairs) {
  const seen = new Set();
  const out = [];
  for (const pair of pairs) {
    const key = `${termKey(pair.s)} ${termKey(pair.o)}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(pair);
    }
  }
  return out;
}

module.exports = {
  TripleStore,
  normalizeTriple,
  bindingKey,
  matchTriple,
  instantiateTerm,
  instantiateTriple,
  pathPairs,
};
