// Shared by the architecture and comment tests so both agree on what a comment is:
// the architecture test needs the code without comments, the comment test needs the
// comments with their lines.

export interface Comment {
  start: number;
  end: number;
  line: number;
  endLine: number;
  kind: "line" | "block";
  body: string;
}

export interface Scanned {
  comments: Comment[];
  code: string;
  firstCode: number | null;
  lineStarts: number[];
}

// A slash starts a regular expression only in operand position; elsewhere it divides.
const REGEX_AFTER_CHAR = /[(,=:[!&|?{};~%^>]/;
const REGEX_AFTER_WORD = /^(?:return|case|typeof|instanceof|in|of|new|delete|void|throw|yield|await)$/;

function startsRegex(text: string, pos: number): boolean {
  const before = text.slice(0, pos).trimEnd();
  const char = before.charAt(before.length - 1);
  if (char === "") return true;
  if (REGEX_AFTER_CHAR.test(char)) return true;
  const word = /[A-Za-z_$][\w$]*$/.exec(before)?.[0] ?? "";
  return REGEX_AFTER_WORD.test(word);
}

function lineIndex(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charAt(i) === "\n") starts.push(i + 1);
  return starts;
}

type State =
  | { kind: "code"; braces: number; template: boolean }
  | { kind: "template" }
  | { kind: "string"; quote: string }
  | { kind: "regex"; inClass: boolean };

export function scan(text: string): Scanned {
  const lineStarts = lineIndex(text);
  const lineAt = (pos: number): number => {
    let low = 1;
    let high = lineStarts.length;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if ((lineStarts[middle - 1] ?? 0) <= pos) low = middle;
      else high = middle - 1;
    }
    return low;
  };

  const comments: Comment[] = [];
  const out: string[] = [];
  const stack: State[] = [{ kind: "code", braces: 0, template: false }];
  let firstCode: number | null = null;
  let i = 0;

  const capture = (start: number, stop: number, kind: Comment["kind"], body: string): void => {
    comments.push({ start, end: stop, line: lineAt(start), endLine: lineAt(Math.max(start, stop - 1)), kind, body });
  };

  while (i < text.length) {
    const state = stack[stack.length - 1];
    if (!state) break;
    const char = text.charAt(i);
    const next = text.charAt(i + 1);

    if (state.kind === "string") {
      out.push(char);
      if (char === "\\") {
        out.push(next);
        i += 2;
      } else {
        if (char === state.quote) stack.pop();
        i += 1;
      }
      continue;
    }

    if (state.kind === "template") {
      if (char === "\\") {
        out.push(char, next);
        i += 2;
        continue;
      }
      if (char === "`") {
        out.push(char);
        stack.pop();
        i += 1;
        continue;
      }
      if (char === "$" && next === "{") {
        out.push(char, next);
        stack.push({ kind: "code", braces: 0, template: true });
        i += 2;
        continue;
      }
      out.push(char);
      i += 1;
      continue;
    }

    if (state.kind === "regex") {
      out.push(char);
      if (char === "\\") {
        out.push(next);
        i += 2;
        continue;
      }
      if (char === "\n") {
        stack.pop();
        continue;
      }
      if (char === "[") state.inClass = true;
      else if (char === "]") state.inClass = false;
      else if (char === "/" && !state.inClass) stack.pop();
      i += 1;
      continue;
    }

    if (char === "/" && next === "/") {
      const breakAt = text.indexOf("\n", i);
      const stop = breakAt === -1 ? text.length : breakAt;
      capture(i, stop, "line", text.slice(i + 2, stop));
      i = stop;
      continue;
    }

    if (char === "/" && next === "*") {
      const close = text.indexOf("*/", i + 2);
      const stop = close === -1 ? text.length : close + 2;
      capture(i, stop, "block", text.slice(i + 2, stop - 2));
      i = stop;
      continue;
    }

    if (i === 0 && char === "#" && next === "!") {
      const breakAt = text.indexOf("\n", i);
      const stop = breakAt === -1 ? text.length : breakAt;
      out.push(text.slice(i, stop));
      i = stop;
      continue;
    }

    if (firstCode === null && !/\s/.test(char)) firstCode = i;
    out.push(char);

    // An apostrophe or quote right after a letter or digit is JSX text (`It's`, `5"`),
    // not the start of a string.
    if ((char === '"' || char === "'") && !/[A-Za-z0-9]/.test(text.charAt(i - 1))) {
      stack.push({ kind: "string", quote: char });
      i += 1;
      continue;
    }

    if (char === "`") {
      stack.push({ kind: "template" });
      i += 1;
      continue;
    }

    if (char === "/" && startsRegex(text, i)) {
      stack.push({ kind: "regex", inClass: false });
      i += 1;
      continue;
    }

    // Inside `${...}` the braces belong to the expression until the matching close.
    if (state.template) {
      if (char === "{") state.braces += 1;
      else if (char === "}") {
        if (state.braces === 0) stack.pop();
        else state.braces -= 1;
      }
    }

    i += 1;
  }

  return { comments, code: out.join(""), firstCode, lineStarts };
}
