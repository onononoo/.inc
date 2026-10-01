/**
 * A tiny "when clause" language for enabling keybindings and commands.
 *
 *   expr  := or
 *   or    := and ( "||" and )*
 *   and   := unary ( "&&" unary )*
 *   unary := "!" unary | "(" expr ")" | key [ ("==" | "!=") value ]
 *   value := 'string' | "string" | identifier | number | true | false
 *
 * A bare key is true when its context value is truthy. Evaluating an empty clause yields true.
 * Well-known context keys: editorFocus, inputFocus, explorerFocus, terminalFocus, searchFocus,
 * scmFocus, sidebarVisible, panelVisible, quickInputVisible, hasWorkspace, workspaceTrusted,
 * gitAvailable, hasDirtyEditors, activeSidebar, activePanel, isMac, isWindows, isLinux.
 */

export type ContextValue = string | number | boolean | null | undefined;
export type ContextLookup = (key: string) => ContextValue;

type Node =
  | { t: 'key'; key: string }
  | { t: 'cmp'; key: string; op: '==' | '!='; value: string }
  | { t: 'not'; e: Node }
  | { t: 'and'; l: Node; r: Node }
  | { t: 'or'; l: Node; r: Node };

const cache = new Map<string, Node | null>();

function tokenize(src: string): string[] | null {
  const tokens: string[] = [];
  const re = /\s*(&&|\|\||==|!=|!|\(|\)|'[^']*'|"[^"]*"|[A-Za-z0-9_.-]+)/y;
  let pos = 0;
  while (pos < src.length) {
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) return src.slice(pos).trim() === '' ? tokens : null;
    tokens.push(m[1] as string);
    pos = re.lastIndex;
  }
  return tokens;
}

function parse(src: string): Node | null {
  const tokens = tokenize(src);
  if (!tokens) return null;
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];

  const unary = (): Node | null => {
    const tok = next();
    if (tok === undefined) return null;
    if (tok === '!') {
      const e = unary();
      return e ? { t: 'not', e } : null;
    }
    if (tok === '(') {
      const e = or();
      if (next() !== ')') return null;
      return e;
    }
    if (/^[A-Za-z0-9_.-]+$/.test(tok)) {
      const op = peek();
      if (op === '==' || op === '!=') {
        next();
        const v = next();
        if (v === undefined) return null;
        const value = v.startsWith("'") || v.startsWith('"') ? v.slice(1, -1) : v;
        return { t: 'cmp', key: tok, op, value };
      }
      return { t: 'key', key: tok };
    }
    return null;
  };
  const and = (): Node | null => {
    let l = unary();
    while (l && peek() === '&&') {
      next();
      const r = unary();
      if (!r) return null;
      l = { t: 'and', l, r };
    }
    return l;
  };
  const or = (): Node | null => {
    let l = and();
    while (l && peek() === '||') {
      next();
      const r = and();
      if (!r) return null;
      l = { t: 'or', l, r };
    }
    return l;
  };

  const root = or();
  return root && i === tokens.length ? root : null;
}

function evalNode(n: Node, get: ContextLookup): boolean {
  switch (n.t) {
    case 'key':
      return Boolean(get(n.key));
    case 'cmp': {
      const v = get(n.key);
      const same = String(v ?? '') === n.value;
      return n.op === '==' ? same : !same;
    }
    case 'not':
      return !evalNode(n.e, get);
    case 'and':
      return evalNode(n.l, get) && evalNode(n.r, get);
    case 'or':
      return evalNode(n.l, get) || evalNode(n.r, get);
  }
}

/** Returns true when the clause is empty; an unparsable clause evaluates to false. */
export function evaluateWhen(clause: string | undefined, get: ContextLookup): boolean {
  const src = clause?.trim();
  if (!src) return true;
  let node = cache.get(src);
  if (node === undefined) {
    node = parse(src);
    cache.set(src, node);
  }
  return node ? evalNode(node, get) : false;
}

/** True when the clause parses. Used to validate user keybindings. */
export function isValidWhen(clause: string): boolean {
  return !clause.trim() || parse(clause.trim()) !== null;
}
