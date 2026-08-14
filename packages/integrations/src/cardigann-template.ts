// SPDX-License-Identifier: MIT
/**
 * Cardigann Go-template subset (D4 Stage 1).
 *
 * Upstream Cardigann definitions substitute values with Go text/template syntax: `{{ .X }}`,
 * `{{ if ... }}...{{ else }}...{{ end }}`, `{{ range .Categories }}...{{ end }}`, plus the
 * function calls actually used across the 542-def corpus — measured, not guessed (see
 * RESEARCH/CARDIGANN_V11_SPEC.md): `eq`, `or`, `and`, `ne`, `join`, and the filter
 * functions (e.g. `re_replace`), which are callable in templates as `(value, ...args)`.
 *
 * Deliberately NOT implemented (0 occurrences in the corpus): pipes (`|`), `$` variables,
 * `with`, `{{- -}}` whitespace trim. Any of those render as unsupported and throw.
 */
export type TplValue = unknown;

/** A function usable inside a template action. */
export type TplFunc = (...args: TplValue[]) => TplValue;

/** The value a dotted path resolves against at any point. */
export interface TplScope {
  value: TplValue;
}

type Node =
  | { t: "text"; s: string }
  | { t: "action"; cmd: Atom[] }
  | { t: "if" | "range"; cond?: Atom[]; over?: Atom[]; then: Node[]; els: Node[] | null };

type Atom =
  | { kind: "dot" }
  | { kind: "field"; path: string[] } // relative to dot
  | { kind: "string"; v: string }
  | { kind: "number"; v: number }
  | { kind: "bool"; v: boolean }
  | { kind: "ident"; name: string }
  | { kind: "command"; args: Atom[] };

const truthy = (v: TplValue): boolean => {
  if (v === undefined || v === null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
};

/** Lowercase the first letter, Go-template style (`.config.x` == `.Config.x`). */
function normKey(k: string): string {
  if (!k) return k;
  return k[0].toLowerCase() + k.slice(1);
}

// ---------- parsing ----------

/** Tokenize a template into interleaved text + raw action strings. */
function tokenize(tpl: string): Array<{ text: string } | { action: string }> {
  const out: Array<{ text: string } | { action: string }> = [];
  let i = 0;
  let textStart = 0;
  while (i < tpl.length) {
    const open = tpl.indexOf("{{", i);
    if (open === -1) break;
    if (open > textStart) out.push({ text: tpl.slice(textStart, open) });
    const close = tpl.indexOf("}}", open);
    if (close === -1) throw new Error(`unterminated template action in Cardigann YAML: "${tpl.slice(open)}"`);
    out.push({ action: tpl.slice(open + 2, close).trim() });
    i = close + 2;
    textStart = i;
  }
  if (textStart < tpl.length) out.push({ text: tpl.slice(textStart) });
  return out;
}

/** Split an action body into atoms, respecting balanced parens + quotes. */
function lexAtoms(body: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === '"') {
      cur += ch;
      i++;
      while (i < body.length && body[i] !== '"') {
        if (body[i] === "\\" && i + 1 < body.length) { cur += body[i] + body[i + 1]; i += 2; continue; }
        cur += body[i];
        i++;
      }
      if (i < body.length) { cur += body[i]; i++; }
      continue;
    }
    if (ch === "`") {
      cur += ch;
      i++;
      while (i < body.length && body[i] !== "`") { cur += body[i]; i++; }
      if (i < body.length) { cur += body[i]; i++; }
      continue;
    }
    if (ch === "(") { depth++; cur += ch; i++; continue; }
    if (ch === ")") { depth--; cur += ch; i++; continue; }
    if (/\s/.test(ch) && depth === 0) {
      if (cur) { out.push(cur); cur = ""; }
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  if (cur) out.push(cur);
  return out;
}

function parseAtom(tok: string): Atom {
  if (tok === ".") return { kind: "dot" };
  if (tok.startsWith(".")) {
    return { kind: "field", path: tok.slice(1).split(".").filter(Boolean) };
  }
  if (tok.startsWith('"')) {
    // strip quotes, decode Go-style escapes
    return { kind: "string", v: unescapeGo(tok.slice(1, -1)) };
  }
  if (tok.startsWith("`") && tok.endsWith("`")) {
    return { kind: "string", v: tok.slice(1, -1) };
  }
  if (tok === "true" || tok === "false") return { kind: "bool", v: tok === "true" };
  if (/^-?\d+$/.test(tok)) return { kind: "number", v: Number(tok) };
  if (/^-?\d+\.\d+$/.test(tok)) return { kind: "number", v: Number(tok) };
  return { kind: "ident", name: tok };
}

function unescapeGo(s: string): string {
  return s.replace(/\\(["\\nrt])/g, (_m, c: string) => {
    switch (c) {
      case "n": return "\n";
      case "r": return "\r";
      case "t": return "\t";
      default: return c;
    }
  });
}

function parseCommand(toks: string[]): Atom[] {
  const atoms: Atom[] = [];
  for (const tok of toks) {
    if (tok.startsWith("(") && tok.endsWith(")")) {
      const inner = lexAtoms(tok.slice(1, -1));
      atoms.push({ kind: "command", args: parseCommand(inner) });
    } else {
      atoms.push(parseAtom(tok));
    }
  }
  return atoms;
}

/** Parse a full template body into a node tree. */
export function parseTemplate(tpl: string): Node[] {
  const toks = tokenize(tpl);
  const root: Node[] = [];
  // Each frame describes an open {{ if }} / {{ range }} block. `prevItems` is the array
  // siblings get pushed into after this block closes (restored on {{ end }}).
  type BlockNode = Extract<Node, { t: "if" | "range" }>;
  const stack: Array<{ node: BlockNode; inElse: boolean; prevItems: Node[] }> = [];
  let items = root;

  for (const t of toks) {
    if ("text" in t) {
      if (t.text) items.push({ t: "text", s: t.text });
      continue;
    }
    const body = t.action;
    const sp = body.indexOf(" ");
    const kw = (sp === -1 ? body : body.slice(0, sp)).trim();
    if (kw === "if" || kw === "range") {
      const rest = sp === -1 ? "" : body.slice(sp + 1).trim();
      const node: Node = {
        t: kw,
        cond: kw === "if" ? parseCommand(lexAtoms(rest)) : undefined,
        over: kw === "range" ? parseCommand(lexAtoms(rest)) : undefined,
        then: [],
        els: null,
      };
      items.push(node);
      stack.push({ node, inElse: false, prevItems: items });
      items = node.then;
      continue;
    }
    if (kw === "else") {
      const frame = stack[stack.length - 1];
      if (!frame) throw new Error(`{{ else }} without a matching {{ if }}/${"{{"}range}} in Cardigann template: "${tpl}"`);
      if (frame.inElse) throw new Error(`double {{ else }} in Cardigann template: "${tpl}"`);
      frame.inElse = true;
      frame.node.els = [];
      items = frame.node.els;
      continue;
    }
    if (kw === "end") {
      const frame = stack.pop();
      if (!frame) throw new Error(`unbalanced {{ end }} in Cardigann template: "${tpl}"`);
      items = frame.prevItems;
      continue;
    }
    items.push({ t: "action", cmd: parseCommand(lexAtoms(body)) });
  }
  if (stack.length) throw new Error(`unterminated {{ ${stack[stack.length - 1].node.t} }} in Cardigann template: "${tpl}"`);
  return root;
}

// ---------- evaluation ----------

export interface TemplateContext {
  [key: string]: TplValue;
}

function stringify(v: TplValue): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.map(stringify).join(" ");
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    // Go prints map[string]X as map[...] — render as keys joined, but rarely used; best-effort
    return Object.entries(v as Record<string, TplValue>).map(([_k, val]) => stringify(val)).join(" ");
  }
  return String(v);
}

/**
 * A compiled template: parse once, render many times with different contexts.
 * Injected funcs let the caller surface `eq`/`join`/filter functions.
 */
export class CompiledTemplate {
  private readonly nodes: Node[];
  constructor(private readonly tpl: string, private readonly funcs: Record<string, TplFunc> = {}) {
    this.nodes = parseTemplate(tpl);
  }

  render(ctx: TemplateContext): string {
    return this.renderNodes(this.nodes, ctx, ctx);
  }

  private renderNodes(nodes: Node[], dot: TplValue, root: TplValue): string {
    let out = "";
    for (const n of nodes) {
      switch (n.t) {
        case "text":
          out += n.s;
          break;
        case "action":
          out += stringify(this.evalCommand(n.cmd, dot, root));
          break;
        case "if":
          out += truthy(this.evalCommand(n.cond as Atom[], dot, root)) ? this.renderNodes(n.then, dot, root) : (n.els ? this.renderNodes(n.els, dot, root) : "");
          break;
        case "range": {
          const over = this.evalCommand(n.over as Atom[], dot, root);
          const arr = Array.isArray(over) ? over : [];
          if (arr.length) {
            for (const el of arr) out += this.renderNodes(n.then, el, root);
          } else if (n.els) {
            out += this.renderNodes(n.els, dot, root);
          }
          break;
        }
      }
    }
    return out;
  }

  private evalAtom(a: Atom, dot: TplValue, root: TplValue): TplValue {
    switch (a.kind) {
      case "dot": return dot;
      case "field": return lookupField(dot, a.path);
      case "string": return a.v;
      case "number": return a.v;
      case "bool": return a.v;
      case "ident": return undefined; // a bare ident not leading a command is an error; handled in evalCommand
      case "command": return this.evalCommand(a.args, dot, root);
    }
  }

  private evalCommand(atoms: Atom[], dot: TplValue, root: TplValue): TplValue {
    if (atoms.length === 0) return "";
    const head = atoms[0];
    // Function application: leading identifier resolves to a registered/known func.
    if (head.kind === "ident") {
      const name = head.name;
      if (name === "and" || name === "or") {
        return name === "and" ? this.evalAndOr(atoms, dot, root, true) : this.evalAndOr(atoms, dot, root, false);
      }
      const args = atoms.slice(1).map((a) => this.evalAtom(a, dot, root));
      const handler = this.funcs[name] ?? BUILTIN_FUNCS[name];
      if (!handler) throw new Error(`unsupported Cardigann template function "${name}"`);
      return handler(...args);
    }
    // Single-value action: `{{ .X }}`, `{{ "str" }}`, `{{ (eq ...) }}`
    if (atoms.length !== 1) throw new Error(`invalid multi-value Cardigann template action: ${JSON.stringify(atoms)}`);
    return this.evalAtom(atoms[0], dot, root);
  }

  /** Go `and`/`or`, which short-circuit and return a non-bool (first deciding) arg. */
  private evalAndOr(atoms: Atom[], dot: TplValue, root: TplValue, isAnd: boolean): TplValue {
    for (const a of atoms.slice(1)) {
      const v = this.evalAtom(a, dot, root);
      if (isAnd ? !truthy(v) : truthy(v)) return v;
    }
    // Go: and returns last arg; or returns last arg
    return this.evalAtom(atoms[atoms.length - 1], dot, root);
  }
}

/** Case-insensitive dotted-path lookup (Go templates: .Config == .config). */
function lookupField(base: TplValue, path: string[]): TplValue {
  let cur = base;
  const first = path[0];
  // At root, the first segment addresses a root context key.
  cur = getKey(cur, first);
  for (let i = 1; i < path.length; i++) cur = getKey(cur, path[i]);
  return cur;
}

function getKey(obj: TplValue, key: string): TplValue {
  if (obj === undefined || obj === null) return undefined;
  if (typeof obj === "object" || typeof obj === "function") {
    const r = obj as Record<string, TplValue>;
    if (key in r) return r[key];
    // Go is case-insensitive on keys; try normalized
    const nk = normKey(key);
    // find matching key case-insensitively
    for (const k of Object.keys(r)) {
      if (k.toLowerCase() === nk.toLowerCase()) return r[k];
    }
    return undefined;
  }
  return undefined;
}

// ---------- builtins ----------
const BUILTIN_FUNCS: Record<string, TplFunc> = {
  eq: (a, b) => eq(a, b),
  ne: (a, b) => !eq(a, b),
  join: (list, sep) => {
    const arr = Array.isArray(list) ? list : [];
    return arr.map((x) => stringify(x)).join(stringify(sep));
  },
};

function eq(a: TplValue, b: TplValue): boolean {
  if (a === undefined) a = "";
  if (b === undefined) b = "";
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (typeof a === "boolean" && typeof b === "boolean") return a === b;
  if (a === null) a = "";
  if (b === null) b = "";
  return String(a) === String(b);
}

/** Convenience: compile + render in one call. */
export function renderTemplate(tpl: string, ctx: TemplateContext, funcs: Record<string, TplFunc> = {}): string {
  return new CompiledTemplate(tpl, funcs).render(ctx);
}

/**
 * Return the template functions referenced by `tpl` (used to validate that a definition only
 * calls functions this interpreter supports). Also reports a malformed-template error when the
 * body fails to parse (unbalanced blocks etc.).
 */
export function templateFunctionNames(tpl: string): { functions: string[]; error?: string } {
  let nodes: Node[];
  try { nodes = parseTemplate(tpl); } catch (e) { return { functions: [], error: (e as Error).message }; }
  const out = new Set<string>();
  const walkAtoms = (atoms: Atom[]): void => {
    for (const a of atoms) {
      if (a.kind === "ident") out.add(a.name);
      else if (a.kind === "command") walkAtoms(a.args);
    }
  };
  const walk = (ns: Node[]): void => {
    for (const n of ns) {
      if (n.t === "text") continue;
      if (n.t === "action") { walkAtoms(n.cmd); continue; }
      if (n.cond) walkAtoms(n.cond);
      if (n.over) walkAtoms(n.over);
      walk(n.then);
      if (n.els) walk(n.els);
    }
  };
  walk(nodes);
  return { functions: [...out] };
}
