'use strict';

const { compactIRI, iri, variable, termEquals } = require('./term.js');

function analyze(program) {
  const diagnostics = [];
  const dependency = dependencyGraph(program);

  program.rules.forEach((rule, index) => {
    const name = ruleName(rule, index);
    const label = displayRuleName(name, program.prefixes || {});
    const bound = boundVariables(rule.body);
    const positive = positiveVariables(rule.body);
    const head = new Set();
    for (const triple of rule.head) collectTripleVars(triple, head);

    for (const variable of head) {
      if (!bound.has(variable)) {
        diagnostics.push({
          code: 'unsafe-head-variable',
          severity: 'warning',
          rule: name,
          message: `${label} has unbound head variable ?${variable}`,
        });
      }
    }

    for (const triple of rule.head) {
      if (triple.p.type !== 'iri' && triple.p.type !== 'var') {
        diagnostics.push({
          code: 'invalid-head-predicate',
          severity: 'error',
          rule: name,
          message: `${label} has a non-IRI/non-variable predicate in the head`,
        });
      }
    }

    diagnostics.push(...sequentialWellFormednessDiagnostics(rule.body, name, label));

    if (rule.runOnce && recursiveRuleIndexes(dependency).has(index)) {
      diagnostics.push({
        code: 'recursive-assignment-rule',
        severity: 'warning',
        rule: name,
        message: `${label} contains SET and is recursive; assignment rules are run once in Eyesharl`,
      });
    }

  });

  for (const cycle of dependency.unstratifiedCycles) {
    diagnostics.push({
      code: 'unstratified-negation',
      severity: 'error',
      rules: cycle.rules,
      message: `Unstratified negation through ${cycle.rules.map((name) => displayRuleName(name, program.prefixes || {})).join(' -> ')} using ${cycle.predicate ? compactIRI(cycle.predicate, program.prefixes || {}) : '*'}`,
    });
  }

  return {
    warnings: diagnostics.filter((diagnostic) => diagnostic.severity === 'warning'),
    errors: diagnostics.filter((diagnostic) => diagnostic.severity === 'error'),
    diagnostics,
    dependency,
  };
}

function ruleName(rule, index) {
  return rule.name || `rule#${index + 1}`;
}

function displayRuleName(name, prefixes = {}) {
  return /^https?:/.test(name) ? compactIRI(name, prefixes) : name;
}

function dependencyGraph(program) {
  const rules = program.rules.map((rule, index) => {
    const positivePatterns = bodyTriplePatterns(rule.body, false);
    const negativePatterns = bodyTriplePatterns(rule.body, true);
    return {
      index,
      name: ruleName(rule, index),
      headTemplates: rule.head.slice(),
      positivePatterns,
      negativePatterns,
      headPredicates: new Set(rule.head.map((triple) => predicateIRI(triple)).filter(Boolean)),
      positivePredicates: new Set(positivePatterns.flatMap((triple) => predicateIRIs(triple))),
      negativePredicates: new Set(negativePatterns.flatMap((triple) => predicateIRIs(triple))),
      runOnce: !!rule.runOnce,
    };
  });

  const edgeMap = new Map();
  function addEdge(from, to, negative, predicate) {
    const label = predicate || '*';
    const key = `${from.index}->${to.index}:${label}`;
    const existing = edgeMap.get(key);
    if (existing) {
      existing.negative = existing.negative || negative;
      return;
    }
    edgeMap.set(key, { from: from.index, to: to.index, negative, predicate });
  }

  const headIndex = buildHeadTemplateIndex(rules);

  for (const from of rules) {
    for (const pattern of from.positivePatterns) {
      for (const candidate of candidateHeadTemplates(headIndex, pattern)) {
        if (canPossiblyGenerate(candidate.template, pattern)) addEdge(from, rules[candidate.ruleIndex], false, dependencyPredicateLabel(pattern));
      }
    }
    for (const pattern of from.negativePatterns) {
      for (const candidate of candidateHeadTemplates(headIndex, pattern)) {
        if (canPossiblyGenerate(candidate.template, pattern)) addEdge(from, rules[candidate.ruleIndex], true, dependencyPredicateLabel(pattern));
      }
    }
  }

  const edges = Array.from(edgeMap.values()).sort((a, b) => a.from - b.from || a.to - b.to || String(a.predicate || '').localeCompare(String(b.predicate || '')));

  const components = stronglyConnectedComponents(rules.length, edges);
  const componentOf = new Map();
  components.forEach((component, index) => {
    for (const ruleIndex of component) componentOf.set(ruleIndex, index);
  });

  const unstratifiedCycles = [];
  const seen = new Set();
  for (const edge of edges) {
    if (!edge.negative) continue;
    if (edge.from === edge.to && rules[edge.from] && rules[edge.from].runOnce) continue;
    if (componentOf.get(edge.from) !== componentOf.get(edge.to)) continue;
    const component = components[componentOf.get(edge.from)];
    const key = `${component.slice().sort((a, b) => a - b).join(',')}|${edge.predicate || '*'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unstratifiedCycles.push({
      predicate: edge.predicate,
      rules: component.map((ruleIndex) => rules[ruleIndex].name),
    });
  }

  const layers = stratificationLayers(rules.length, components, componentOf, edges);

  return {
    rules: rules.map((rule) => ({
      index: rule.index,
      name: rule.name,
      headPredicates: Array.from(rule.headPredicates),
      positivePredicates: Array.from(rule.positivePredicates),
      negativePredicates: Array.from(rule.negativePredicates),
      runOnce: rule.runOnce,
    })),
    edges,
    components: components.map((component) => component.map((ruleIndex) => rules[ruleIndex].name)),
    layers: layers.map((layer) => layer.map((ruleIndex) => rules[ruleIndex].name)),
    layerIndexes: layers,
    unstratifiedCycles,
  };
}

function buildHeadTemplateIndex(rules) {
  const templates = [];
  const positions = ['s', 'p', 'o'];
  const byPosition = {
    s: new Map(),
    p: new Map(),
    o: new Map(),
  };
  const flexibleByPosition = {
    s: new Set(),
    p: new Set(),
    o: new Set(),
  };

  for (const rule of rules) {
    for (const template of rule.headTemplates) {
      const entry = { id: templates.length, ruleIndex: rule.index, template };
      templates.push(entry);
      for (const position of positions) {
        const key = fixedTermIndexKey(template[position]);
        if (key === null) flexibleByPosition[position].add(entry.id);
        else {
          let bucket = byPosition[position].get(key);
          if (!bucket) {
            bucket = new Set();
            byPosition[position].set(key, bucket);
          }
          bucket.add(entry.id);
        }
      }
    }
  }

  return { templates, byPosition, flexibleByPosition };
}

function candidateHeadTemplates(index, pattern) {
  const positions = ['s', 'p', 'o'];
  let selected = null;

  for (const position of positions) {
    const key = fixedTermIndexKey(pattern[position]);
    if (key === null) continue;
    const exact = index.byPosition[position].get(key) || null;
    const flexible = index.flexibleByPosition[position];
    const estimatedSize = (exact ? exact.size : 0) + flexible.size;
    if (selected === null || estimatedSize < selected.estimatedSize) selected = { exact, flexible, estimatedSize };
    if (estimatedSize === 0) break;
  }

  if (selected === null) return index.templates;
  const ids = [];
  if (selected.exact) for (const id of selected.exact) ids.push(id);
  for (const id of selected.flexible) ids.push(id);
  const out = [];
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(index.templates[id]);
  }
  return out;
}

function fixedTermIndexKey(term) {
  if (!term) return null;
  if (term.type === 'var') return null;
  if (term.type === 'path') return null;
  if (term.type === 'triple' && containsVariableTerm(term)) return null;
  return termIndexKey(term);
}

function containsVariableTerm(term) {
  if (!term) return false;
  if (term.type === 'var') return true;
  if (term.type === 'triple') return containsVariableTerm(term.s) || containsVariableTerm(term.p) || containsVariableTerm(term.o);
  if (term.type === 'path') {
    if (term.kind === 'inverse') return containsVariableTerm(term.path);
    if (term.kind === 'sequence') return term.parts.some(containsVariableTerm);
  }
  return false;
}

function termIndexKey(term) {
  if (!term) return 'null';
  if (term.type === 'iri') return `I:${term.value}`;
  if (term.type === 'blank') return `B:${term.value}`;
  if (term.type === 'literal') return `L:${JSON.stringify(term.value)}^^${term.datatype || ''}@${term.lang || ''}--${term.langDir || ''}`;
  if (term.type === 'triple') return `T:${termIndexKey(term.s)} ${termIndexKey(term.p)} ${termIndexKey(term.o)}`;
  return JSON.stringify(term);
}

function unionSets(a, b) {
  const out = new Set();
  if (a) for (const value of a) out.add(value);
  if (b) for (const value of b) out.add(value);
  return out;
}

function allTemplateIds(length) {
  const out = new Set();
  for (let i = 0; i < length; i += 1) out.add(i);
  return out;
}

function stratificationLayers(ruleCount, components, componentOf, edges) {
  if (ruleCount === 0) return [];
  const outgoing = Array.from({ length: components.length }, () => new Set());
  const indegree = Array(components.length).fill(0);

  for (const edge of edges) {
    const dependent = componentOf.get(edge.from);
    const dependency = componentOf.get(edge.to);
    if (dependent === dependency) continue;
    // Rule edge means "from depends on to". Evaluation must run dependency before dependent.
    if (!outgoing[dependency].has(dependent)) {
      outgoing[dependency].add(dependent);
      indegree[dependent] += 1;
    }
  }

  let ready = [];
  for (let i = 0; i < indegree.length; i += 1) if (indegree[i] === 0) ready.push(i);
  const layers = [];
  const emitted = new Set();
  while (ready.length > 0) {
    ready.sort((a, b) => componentMin(components[a]) - componentMin(components[b]));
    const layerComponents = ready;
    ready = [];
    const layer = [];
    for (const componentIndex of layerComponents) {
      emitted.add(componentIndex);
      layer.push(...components[componentIndex]);
      for (const next of outgoing[componentIndex]) {
        indegree[next] -= 1;
        if (indegree[next] === 0) ready.push(next);
      }
    }
    layers.push(layer.sort((a, b) => a - b));
  }

  if (emitted.size !== components.length) return [Array.from({ length: ruleCount }, (_, i) => i)];
  return layers;
}


function componentMin(component) {
  let min = Infinity;
  for (const value of component) if (value < min) min = value;
  return min;
}

function recursiveRuleIndexes(dependency) {
  const out = new Set();
  for (const component of dependency.components) {
    if (component.length <= 1) continue;
    for (const name of component) {
      const rule = dependency.rules.find((item) => item.name === name);
      if (rule) out.add(rule.index);
    }
  }
  for (const edge of dependency.edges) {
    const rule = dependency.rules.find((item) => item.index === edge.from);
    if (edge.from === edge.to && !(edge.negative && rule && rule.runOnce)) out.add(edge.from);
  }
  return out;
}

function stronglyConnectedComponents(size, edges) {
  const adjacency = Array.from({ length: size }, () => []);
  const reverse = Array.from({ length: size }, () => []);
  for (const edge of edges) {
    adjacency[edge.from].push(edge.to);
    reverse[edge.to].push(edge.from);
  }

  const visited = Array(size).fill(false);
  const order = [];
  for (let start = 0; start < size; start += 1) {
    if (visited[start]) continue;
    const stack = [[start, 0]];
    visited[start] = true;
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const v = frame[0];
      let nextIndex = frame[1];
      if (nextIndex < adjacency[v].length) {
        const w = adjacency[v][nextIndex];
        frame[1] = nextIndex + 1;
        if (!visited[w]) {
          visited[w] = true;
          stack.push([w, 0]);
        }
      } else {
        order.push(v);
        stack.pop();
      }
    }
  }

  const assigned = Array(size).fill(false);
  const components = [];
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const start = order[i];
    if (assigned[start]) continue;
    const component = [];
    const stack = [start];
    assigned[start] = true;
    while (stack.length > 0) {
      const v = stack.pop();
      component.push(v);
      for (const w of reverse[v]) {
        if (!assigned[w]) {
          assigned[w] = true;
          stack.push(w);
        }
      }
    }
    components.push(component.sort((a, b) => a - b));
  }
  return components;
}

function sequentialWellFormednessDiagnostics(clauses, ruleNameValue, label) {
  const diagnostics = [];

  function visit(items, initialBound, scopeLabel) {
    const bound = new Set(initialBound);
    for (const clause of items) {
      if (clause.type === 'triple' || clause.type === 'path') {
        collectTripleVars(clause.triple, bound);
      } else if (clause.type === 'filter') {
        for (const variable of expressionVariables(clause.expr)) {
          if (!bound.has(variable)) {
            diagnostics.push({
              code: 'unbound-filter-variable',
              severity: 'error',
              rule: ruleNameValue,
              message: `${label} FILTER uses ?${variable} before it is bound${scopeLabel}`,
            });
          }
        }
      } else if (clause.type === 'set') {
        if (bound.has(clause.variable)) {
          diagnostics.push({
            code: 'assignment-variable-already-bound',
            severity: 'error',
            rule: ruleNameValue,
            message: `${label} SET assigns ?${clause.variable}, but that variable is already bound${scopeLabel}`,
          });
        }
        for (const variable of expressionVariables(clause.expr)) {
          if (!bound.has(variable)) {
            diagnostics.push({
              code: 'unbound-assignment-variable',
              severity: 'error',
              rule: ruleNameValue,
              message: `${label} SET expression uses ?${variable} before it is bound${scopeLabel}`,
            });
          }
        }
        bound.add(clause.variable);
      } else if (clause.type === 'not') {
        visit(clause.body, bound, ' inside NOT');
      }
    }
    return bound;
  }

  visit(clauses, new Set(), '');
  return diagnostics;
}

function bodyTriplePatterns(clauses, wantNegative, inNegativeContext = false) {
  const out = [];
  for (const clause of clauses) {
    if ((clause.type === 'triple' || clause.type === 'path') && wantNegative === inNegativeContext) {
      if (clause.type === 'path') out.push(...pathTriplePatterns(clause.triple));
      else out.push(clause.triple);
    } else if (clause.type === 'not') {
      out.push(...bodyTriplePatterns(clause.body, wantNegative, true));
    }
  }
  return out;
}

function pathTriplePatterns(triple) {
  const predicates = predicateIRIs(triple);
  if (predicates.length === 0) return [];
  return predicates.map((predicate, index) => ({
    s: variable(`__path_s_${index}`),
    p: iri(predicate),
    o: variable(`__path_o_${index}`),
  }));
}

function dependencyPredicateLabel(pattern) {
  return pattern && pattern.p && pattern.p.type === 'iri' ? pattern.p.value : null;
}

function canPossiblyGenerate(template, pattern) {
  if (!template || !pattern) return false;
  if (!compatibleTerm(template.s, pattern.s)) return false;
  if (!compatibleTerm(template.p, pattern.p)) return false;
  if (!compatibleTerm(template.o, pattern.o)) return false;

  const constraints = new Map();
  if (!recordTemplateVariableConstraints(template.s, pattern.s, constraints)) return false;
  if (!recordTemplateVariableConstraints(template.p, pattern.p, constraints)) return false;
  if (!recordTemplateVariableConstraints(template.o, pattern.o, constraints)) return false;
  return true;
}

function compatibleTerm(templateTerm, patternTerm) {
  if (!templateTerm || !patternTerm) return false;
  if (templateTerm.type === 'var' || patternTerm.type === 'var') return true;
  if (templateTerm.type === 'triple' || patternTerm.type === 'triple') {
    if (templateTerm.type !== 'triple' || patternTerm.type !== 'triple') return false;
    return compatibleTerm(templateTerm.s, patternTerm.s)
      && compatibleTerm(templateTerm.p, patternTerm.p)
      && compatibleTerm(templateTerm.o, patternTerm.o);
  }
  return termEquals(templateTerm, patternTerm);
}

function recordTemplateVariableConstraints(templateTerm, patternTerm, constraints) {
  if (!templateTerm || !patternTerm) return false;
  if (templateTerm.type === 'var') {
    const existing = constraints.get(templateTerm.value);
    if (!existing) {
      constraints.set(templateTerm.value, patternTerm);
      return true;
    }
    return possiblySameTerm(existing, patternTerm);
  }
  if (templateTerm.type === 'triple' && patternTerm.type === 'triple') {
    return recordTemplateVariableConstraints(templateTerm.s, patternTerm.s, constraints)
      && recordTemplateVariableConstraints(templateTerm.p, patternTerm.p, constraints)
      && recordTemplateVariableConstraints(templateTerm.o, patternTerm.o, constraints);
  }
  return true;
}

function possiblySameTerm(a, b) {
  if (!a || !b) return false;
  if (a.type === 'var' || b.type === 'var') return true;
  if (a.type === 'triple' || b.type === 'triple') {
    if (a.type !== 'triple' || b.type !== 'triple') return false;
    return possiblySameTerm(a.s, b.s) && possiblySameTerm(a.p, b.p) && possiblySameTerm(a.o, b.o);
  }
  return termEquals(a, b);
}

function bodyPredicates(clauses, wantNegative, inNegativeContext = false) {
  const out = [];
  for (const clause of clauses) {
    if ((clause.type === 'triple' || clause.type === 'path') && wantNegative === inNegativeContext) {
      out.push(...predicateIRIs(clause.triple));
    } else if (clause.type === 'not') {
      out.push(...bodyPredicates(clause.body, wantNegative, true));
    }
  }
  return out;
}

function predicateIRI(triple) {
  return triple && triple.p && triple.p.type === 'iri' ? triple.p.value : null;
}

function predicateIRIs(triple) {
  if (!triple || !triple.p) return [];
  if (triple.p.type === 'iri') return [triple.p.value];
  if (triple.p.type === 'path') return pathPredicateIRIs(triple.p);
  return [];
}

function pathPredicateIRIs(path) {
  if (!path) return [];
  if (path.type === 'iri') return [path.value];
  if (path.type !== 'path') return [];
  if (path.kind === 'inverse') return pathPredicateIRIs(path.path);
  if (path.kind === 'sequence') return path.parts.flatMap(pathPredicateIRIs);
  if (path.kind === 'iri') return pathPredicateIRIs(path.iri);
  return [];
}

function boundVariables(clauses) {
  const vars = new Set();
  for (const clause of clauses) {
    if (clause.type === 'triple' || clause.type === 'path') collectTripleVars(clause.triple, vars);
    if (clause.type === 'set') vars.add(clause.variable);
  }
  return vars;
}

function positiveVariables(clauses) {
  const vars = new Set();
  for (const clause of clauses) {
    if (clause.type === 'triple' || clause.type === 'path') collectTripleVars(clause.triple, vars);
    if (clause.type === 'set') vars.add(clause.variable);
    if (clause.type === 'filter') for (const v of expressionVariables(clause.expr)) vars.add(v);
  }
  return vars;
}

function bodyVariables(clauses) {
  const vars = new Set();
  for (const clause of clauses) {
    if (clause.type === 'triple' || clause.type === 'path') collectTripleVars(clause.triple, vars);
    if (clause.type === 'set') {
      vars.add(clause.variable);
      for (const v of expressionVariables(clause.expr)) vars.add(v);
    }
    if (clause.type === 'filter') for (const v of expressionVariables(clause.expr)) vars.add(v);
    if (clause.type === 'not') for (const v of bodyVariables(clause.body)) vars.add(v);
  }
  return vars;
}

function collectTripleVars(triple, vars) {
  for (const term of [triple.s, triple.p, triple.o]) collectTermVars(term, vars);
}

function collectTermVars(term, vars) {
  if (!term) return;
  if (term.type === 'var') vars.add(term.value);
  if (term.type === 'triple') {
    collectTermVars(term.s, vars);
    collectTermVars(term.p, vars);
    collectTermVars(term.o, vars);
  }
  if (term.type === 'path') {
    if (term.kind === 'inverse') collectTermVars(term.path, vars);
    if (term.kind === 'sequence') for (const part of term.parts) collectTermVars(part, vars);
  }
}

function expressionVariables(expr, vars = new Set()) {
  if (!expr) return vars;
  if (expr.type === 'var') vars.add(expr.name);
  else if (expr.type === 'unary') expressionVariables(expr.expr, vars);
  else if (expr.type === 'binary') {
    expressionVariables(expr.left, vars);
    expressionVariables(expr.right, vars);
  } else if (expr.type === 'call') {
    for (const arg of expr.args) expressionVariables(arg, vars);
  } else if (expr.type === 'list') {
    for (const item of expr.items) expressionVariables(item, vars);
  } else if (expr.type === 'term') {
    collectTermVars(expr.value, vars);
  }
  return vars;
}

module.exports = {
  analyze,
  dependencyGraph,
  stratificationLayers,
  boundVariables,
  positiveVariables,
  bodyVariables,
  collectTripleVars,
  expressionVariables,
  pathPredicateIRIs,
  bodyTriplePatterns,
  canPossiblyGenerate,
};
