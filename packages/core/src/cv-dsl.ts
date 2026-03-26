/**
 * Construction-Verification DSL parser and evaluator.
 *
 * Grammar (EBNF):
 *   rule    = expr ;
 *   expr    = term { "AND" term } ;
 *   term    = factor { "OR" factor } ;
 *   factor  = "NOT" factor | "(" expr ")" | atom ;
 *   atom    = "requires:" IDENT
 *           | "absent:" IDENT
 *           | "before:" IDENT "," IDENT
 *           | "after:" IDENT "," IDENT
 *           | "count:" IDENT ">=" NUMBER
 *           | "section:" STRING ;
 *
 * Parser: recursive-descent, tokenizer-first.
 * Evaluator: mock executor semantic contract (case-insensitive substring matching).
 */

// ---------------------------------------------------------------------------
// AST types
// ---------------------------------------------------------------------------

export type RuleNode =
  | { type: "and"; children: RuleNode[] }
  | { type: "or"; children: RuleNode[] }
  | { type: "not"; child: RuleNode }
  | { type: "requires"; ident: string }
  | { type: "absent"; ident: string }
  | { type: "before"; first: string; second: string }
  | { type: "after"; first: string; second: string }
  | { type: "count"; ident: string; min: number }
  | { type: "section"; title: string };

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Token = { value: string; pos: number };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    // Skip whitespace
    if (/\s/.test(input[i]!)) {
      i++;
      continue;
    }
    // Parentheses
    if (input[i] === "(" || input[i] === ")") {
      tokens.push({ value: input[i]!, pos: i });
      i++;
      continue;
    }
    // Quoted string (for section:"...")
    if (input[i] === '"') {
      const start = i;
      i++; // skip opening quote
      let str = "";
      while (i < input.length && input[i] !== '"') {
        str += input[i];
        i++;
      }
      if (i >= input.length) {
        throw new Error(`Unterminated string starting at position ${start}`);
      }
      i++; // skip closing quote
      tokens.push({ value: `"${str}"`, pos: start });
      continue;
    }
    // Regular token (keyword, identifier, operator, atom)
    const start = i;
    while (i < input.length && !/[\s()"]/.test(input[i]!)) {
      i++;
    }
    tokens.push({ value: input.slice(start, i), pos: start });
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export class DSLParseError extends Error {
  constructor(
    message: string,
    public readonly position: number
  ) {
    super(message);
    this.name = "DSLParseError";
  }
}

export function parseRule(input: string): RuleNode {
  const tokens = tokenize(input);
  if (tokens.length === 0) {
    throw new DSLParseError("Empty rule", 0);
  }
  let cursor = 0;

  function peek(): Token | undefined {
    return tokens[cursor];
  }

  function advance(): Token {
    const t = tokens[cursor];
    if (!t) throw new DSLParseError(`Unexpected end of input at position ${input.length}`, input.length);
    cursor++;
    return t;
  }

  function expect(value: string): Token {
    const t = peek();
    if (!t) throw new DSLParseError(`Expected '${value}' but reached end of input`, input.length);
    if (t.value !== value) throw new DSLParseError(`Expected '${value}' at position ${t.pos}`, t.pos);
    return advance();
  }

  // expr = term { "AND" term }
  function parseExpr(): RuleNode {
    const children: RuleNode[] = [parseTerm()];
    while (peek()?.value === "AND") {
      advance(); // consume AND
      children.push(parseTerm());
    }
    return children.length === 1 ? children[0]! : { type: "and", children };
  }

  // term = factor { "OR" factor }
  function parseTerm(): RuleNode {
    const children: RuleNode[] = [parseFactor()];
    while (peek()?.value === "OR") {
      advance(); // consume OR
      children.push(parseFactor());
    }
    return children.length === 1 ? children[0]! : { type: "or", children };
  }

  // factor = "NOT" factor | "(" expr ")" | atom
  function parseFactor(): RuleNode {
    const t = peek();
    if (!t) throw new DSLParseError(`Unexpected end of input`, input.length);

    if (t.value === "NOT") {
      advance();
      return { type: "not", child: parseFactor() };
    }

    if (t.value === "(") {
      const openPos = t.pos;
      advance(); // consume (
      const node = parseExpr();
      const closing = peek();
      if (!closing || closing.value !== ")") {
        throw new DSLParseError(`Unmatched '(' at position ${openPos}`, openPos);
      }
      advance(); // consume )
      return node;
    }

    return parseAtom();
  }

  // atom = "requires:" IDENT | "absent:" IDENT | ...
  function parseAtom(): RuleNode {
    const t = advance();
    const val = t.value;

    if (val.startsWith("requires:")) {
      const ident = val.slice("requires:".length);
      if (!ident) throw new DSLParseError(`Expected identifier after 'requires:' at position ${t.pos + 9}`, t.pos + 9);
      return { type: "requires", ident };
    }

    if (val.startsWith("absent:")) {
      const ident = val.slice("absent:".length);
      if (!ident) throw new DSLParseError(`Expected identifier after 'absent:' at position ${t.pos + 7}`, t.pos + 7);
      return { type: "absent", ident };
    }

    if (val.startsWith("before:")) {
      const args = val.slice("before:".length);
      const parts = args.split(",");
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new DSLParseError(`Expected 'before:IDENT,IDENT' at position ${t.pos}`, t.pos);
      }
      return { type: "before", first: parts[0], second: parts[1] };
    }

    if (val.startsWith("after:")) {
      const args = val.slice("after:".length);
      const parts = args.split(",");
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new DSLParseError(`Expected 'after:IDENT,IDENT' at position ${t.pos}`, t.pos);
      }
      return { type: "after", first: parts[0], second: parts[1] };
    }

    if (val.startsWith("count:")) {
      const rest = val.slice("count:".length);
      const match = rest.match(/^([a-zA-Z_][a-zA-Z0-9_]*)>=(\d+)$/);
      if (!match) {
        throw new DSLParseError(`Expected 'count:IDENT>=NUMBER' at position ${t.pos}`, t.pos);
      }
      return { type: "count", ident: match[1]!, min: parseInt(match[2]!, 10) };
    }

    if (val.startsWith("section:")) {
      // section:"Title" — the quoted string may be the remainder of this token or the next token
      let title = val.slice("section:".length);
      if (title.startsWith('"') && title.endsWith('"') && title.length >= 2) {
        title = title.slice(1, -1);
      } else if (title === "") {
        // Title is in next token as a quoted string
        const next = peek();
        if (next && next.value.startsWith('"') && next.value.endsWith('"')) {
          advance();
          title = next.value.slice(1, -1);
        } else {
          throw new DSLParseError(`Expected quoted string after 'section:' at position ${t.pos + 8}`, t.pos + 8);
        }
      }
      if (!title) {
        throw new DSLParseError(`Expected non-empty title in section at position ${t.pos}`, t.pos);
      }
      return { type: "section", title };
    }

    throw new DSLParseError(`Unknown atom '${val}' at position ${t.pos}`, t.pos);
  }

  const result = parseExpr();

  // Verify all tokens consumed
  if (cursor < tokens.length) {
    const leftover = tokens[cursor]!;
    throw new DSLParseError(`Unexpected token '${leftover.value}' at position ${leftover.pos}`, leftover.pos);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Evaluator (mock executor semantic contract)
// ---------------------------------------------------------------------------

/**
 * Escape a string for use as a regex literal.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Count non-overlapping case-insensitive occurrences of `needle` in `text`.
 */
function countOccurrences(text: string, needle: string): number {
  const lower = text.toLowerCase();
  const target = needle.toLowerCase();
  let count = 0;
  let idx = 0;
  while (true) {
    idx = lower.indexOf(target, idx);
    if (idx === -1) break;
    count++;
    idx += target.length;
  }
  return count;
}

/**
 * Evaluate a parsed rule AST against bundle text.
 *
 * Mock executor semantic contract:
 * - requires:X  → case-insensitive substring match
 * - absent:X    → NOT case-insensitive substring match
 * - before:X,Y  → first occurrence of X < first occurrence of Y (both must exist)
 * - after:X,Y   → first occurrence of X > first occurrence of Y (both must exist)
 * - count:X>=N  → non-overlapping case-insensitive occurrences >= N
 * - section:"T" → regex /^#{1,6}\s+.*T/mi (title escaped for regex metacharacters)
 * - AND         → all children true
 * - OR          → any child true
 * - NOT         → negate child
 */
export function evaluateRule(node: RuleNode, text: string): boolean {
  switch (node.type) {
    case "and":
      return node.children.every(c => evaluateRule(c, text));

    case "or":
      return node.children.some(c => evaluateRule(c, text));

    case "not":
      return !evaluateRule(node.child, text);

    case "requires":
      return text.toLowerCase().includes(node.ident.toLowerCase());

    case "absent":
      return !text.toLowerCase().includes(node.ident.toLowerCase());

    case "before": {
      const lower = text.toLowerCase();
      const idxFirst = lower.indexOf(node.first.toLowerCase());
      const idxSecond = lower.indexOf(node.second.toLowerCase());
      if (idxFirst === -1 || idxSecond === -1) return false;
      return idxFirst < idxSecond;
    }

    case "after": {
      const lower = text.toLowerCase();
      const idxFirst = lower.indexOf(node.first.toLowerCase());
      const idxSecond = lower.indexOf(node.second.toLowerCase());
      if (idxFirst === -1 || idxSecond === -1) return false;
      return idxFirst > idxSecond;
    }

    case "count":
      return countOccurrences(text, node.ident) >= node.min;

    case "section": {
      const escaped = escapeRegex(node.title);
      const pattern = new RegExp(`^#{1,6}\\s+.*${escaped}`, "mi");
      return pattern.test(text);
    }
  }
}
