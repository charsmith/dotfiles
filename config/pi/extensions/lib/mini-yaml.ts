/**
 * mini-yaml — a tiny, dependency-free YAML parser for the constrained subset
 * the agent chain/team definitions use. NOT a general YAML implementation.
 *
 * pi bundles `yaml` but it isn't resolvable from an extension, and the dotfiles
 * repo deliberately avoids a node_modules install step for extensions, so we
 * parse the small schema ourselves.
 *
 * Supported:
 *   - 2-space (or any consistent) indentation; nesting by indent depth
 *   - block mappings:        key: value   /   key:\n  nested...
 *   - block sequences:       - item   /   - key: value\n  morekey: value
 *   - flow sequences:        [a, b, c]   (scalars only)
 *   - scalars:               plain, 'single'-quoted, "double"-quoted (with
 *                            \n \t \" \\ escapes), and | literal block scalars
 *   - comments (# ...) on their own line or trailing a plain scalar
 *   - booleans (true/false), null (null/~), integers; everything else is string
 *
 * NOT supported (intentionally): anchors, aliases, tags, >-folded scalars,
 * flow mappings ({a: 1}), multi-doc (---). Keep the chain schema within the
 * supported subset.
 */

type Line = { indent: number; content: string; raw: string; blank?: boolean };

function tokenize(text: string): Line[] {
  const out: Line[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const noTab = raw.replace(/\t/g, "  ");
    const trimmedStart = noTab.replace(/^\s+/, "");
    // Blank lines are kept (as markers) so | block scalars preserve paragraph
    // breaks; structural parsing skips them. Whole-line comments are dropped.
    if (trimmedStart === "") { out.push({ indent: -1, content: "", raw, blank: true }); continue; }
    if (trimmedStart.startsWith("#")) continue;
    const indent = noTab.length - trimmedStart.length;
    out.push({ indent, content: trimmedStart.replace(/\s+$/, ""), raw });
  }
  return out;
}

// Index of the next non-blank line at or after i (or lines.length).
function nextStructural(lines: Line[], i: number): number {
  while (i < lines.length && lines[i].blank) i++;
  return i;
}

function parseScalar(s: string): any {
  const t = s.trim();
  if (t === "") return "";
  // Quoted strings
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    return t.slice(1, -1)
      .replace(/\\n/g, "\n").replace(/\\t/g, "\t")
      .replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) {
    return t.slice(1, -1).replace(/''/g, "'");
  }
  // Flow sequence [a, b, c]
  if (t.startsWith("[") && t.endsWith("]")) {
    const inner = t.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((x) => parseScalar(x.trim()));
  }
  // Strip a trailing comment from a plain scalar (space + #...).
  const noComment = t.replace(/\s+#.*$/, "").trim();
  if (noComment === "null" || noComment === "~") return null;
  if (noComment === "true") return true;
  if (noComment === "false") return false;
  if (/^-?\d+$/.test(noComment)) return parseInt(noComment, 10);
  if (/^-?\d*\.\d+$/.test(noComment)) return parseFloat(noComment);
  return noComment;
}

// Collect a `|` literal block scalar: all lines indented deeper than `minIndent`.
// Returns [text, nextIndex].
function readBlockScalar(lines: Line[], start: number, minIndent: number): [string, number] {
  const body: string[] = [];
  let i = start;
  let baseIndent = -1;
  while (i < lines.length && (lines[i].blank || lines[i].indent > minIndent)) {
    if (lines[i].blank) { body.push(""); i++; continue; }
    if (baseIndent === -1) baseIndent = lines[i].indent;
    // Preserve relative indentation within the block.
    const pad = " ".repeat(Math.max(0, lines[i].indent - baseIndent));
    body.push(pad + lines[i].content);
    i++;
  }
  // Trailing blank lines (e.g. the separator before a dedented sibling) are not
  // part of the scalar.
  while (body.length && body[body.length - 1] === "") body.pop();
  return [body.join("\n"), i];
}

// Parse a block (mapping or sequence) of lines at exactly `indent`, recursing
// into deeper-indented children. Returns [value, nextIndex].
function parseBlock(lines: Line[], start: number, indent: number): [any, number] {
  let i = nextStructural(lines, start);
  const isSeq = lines[i].content.startsWith("- ") || lines[i].content === "-";

  if (isSeq) {
    const arr: any[] = [];
    while ((i = nextStructural(lines, i)) < lines.length && lines[i].indent === indent &&
           (lines[i].content.startsWith("- ") || lines[i].content === "-")) {
      const afterDash = lines[i].content === "-" ? "" : lines[i].content.slice(2);
      if (afterDash === "") {
        // Nested block starts on the next line.
        i = nextStructural(lines, i + 1);
        if (i < lines.length && lines[i].indent > indent) {
          const [val, next] = parseBlock(lines, i, lines[i].indent);
          arr.push(val);
          i = next;
        } else {
          arr.push(null);
        }
      } else if (/^[\w.-]+:(\s|$)/.test(afterDash)) {
        // "- key: value" — an inline mapping whose first key sits on the dash
        // line; subsequent keys are indented to the column after "- ".
        const itemIndent = indent + 2;
        // Rewrite the current line as a plain mapping line at itemIndent so the
        // mapping parser picks it up uniformly with the following keys.
        const synthetic: Line[] = lines.slice();
        synthetic[i] = { indent: itemIndent, content: afterDash, raw: lines[i].raw };
        const [val, next] = parseBlock(synthetic, i, itemIndent);
        arr.push(val);
        i = next;
      } else {
        // "- scalar"
        arr.push(parseScalar(afterDash));
        i++;
      }
    }
    return [arr, i];
  }

  // Mapping
  const map: Record<string, any> = {};
  while ((i = nextStructural(lines, i)) < lines.length && lines[i].indent === indent &&
         !lines[i].content.startsWith("- ")) {
    const line = lines[i].content;
    const colon = findKeyColon(line);
    if (colon === -1) { i++; continue; } // not a key line; skip defensively
    const key = line.slice(0, colon).trim();
    const rest = line.slice(colon + 1).trim();

    if (rest === "|" || rest === "|-" || rest === "|+") {
      const [text, next] = readBlockScalar(lines, i + 1, indent);
      map[key] = text;
      i = next;
    } else if (rest === "") {
      // Value is a nested block on following deeper-indented lines.
      const j = nextStructural(lines, i + 1);
      if (j < lines.length && lines[j].indent > indent) {
        const [val, next] = parseBlock(lines, j, lines[j].indent);
        map[key] = val;
        i = next;
      } else {
        map[key] = null;
        i = j;
      }
    } else {
      map[key] = parseScalar(rest);
      i++;
    }
  }
  return [map, i];
}

// Find the colon that separates a mapping key from its value, ignoring colons
// inside quoted strings or flow sequences.
function findKeyColon(line: string): number {
  let inSingle = false, inDouble = false, depth = 0;
  for (let j = 0; j < line.length; j++) {
    const c = line[j];
    if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (!inSingle && !inDouble) {
      if (c === "[") depth++;
      else if (c === "]") depth--;
      else if (c === ":" && depth === 0 && (j + 1 >= line.length || line[j + 1] === " ")) {
        return j;
      }
    }
  }
  return -1;
}

export function parseYaml(text: string): any {
  const lines = tokenize(text);
  const start = nextStructural(lines, 0);
  if (start >= lines.length) return {};
  const [val] = parseBlock(lines, start, lines[start].indent);
  return val;
}
