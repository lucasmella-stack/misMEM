import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { scan, type Comment } from "./support/source-scan";

const ENGINE = fileURLToPath(new URL("../", import.meta.url));

type Rule = "header" | "block" | "lang" | "todo" | "dead" | "sup";

interface Violation {
  key: string;
  detail: string;
}

interface Exception {
  reason: string;
  count: number;
}

// Spanish words frequent enough to separate prose from identifiers; one match is not
// enough because several are also English words (`son`, `era`, `todo`, `solo`).
const FUNCTION_WORDS = new Set(
  (
    "el la los las un una unos unas de del al en es son era fue ser esta está estan están " +
    "hay no se su sus lo le les y o que qué quien quién como cómo para por con sin pero porque " +
    "cuando cuándo donde dónde mas más menos muy ya tambien también tampoco esto esta este estos " +
    "estas eso esa ese esos esas aquel aquella todo toda todos todas otro otra otros otras entre " +
    "desde hasta sobre tras segun según mientras aunque si solo sólo aun aún asi así cada tanto " +
    "poco mucho mucha hace hacer tiene tienen tenia tenía puede pueden debe deben vez veces"
  ).split(" "),
);
const URL_PATTERN = /\bhttps?:\/\/\S+/gi;
const QUOTED = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\\n]|\\.)*`/g;
const ACCENTED_WORD = /[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]*[áéíóúüñ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ]*/g;
const SPANISH_MARK = /[¿¡]/;
const CAPITALIZED = /^[A-ZÁÉÍÓÚÜÑ]/;
const TODO = /\b(?:TODO|FIXME)\b/;
const ISSUE = /\(#\d+\)/;
const BIOME_IGNORE = /biome-ignore\b[^:]*:\s+\S/;
const DEAD: RegExp[] = [
  /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\([^)]*\)\s*;?$/,
  /^(?:if|for|while|switch)\s*\(/,
  /^(?:async\s+)?function\b/,
  /^await\b[^;]*[;(]/,
  /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[[^\]]*\])*\s*(?:[-+*/%&|^]|\*\*|<<|>>>?|\?\?)?=[^;]*;\s*$/,
  /^return\b[^;]*[(){}[\]]\s*;/,
  /^return\s+[A-Za-z_$][\w$.]*\s*;/,
  /^(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*(?::\s*[^=]+)?=(?!=)/,
  /^import\s+(?:.+from\s+)?["']/,
  /^export\s+(?:const|let|var|function|class|interface|type)\b/,
];

// A capitalized accented token is usually a loan or a proper noun in English prose
// (Bézier), so only a lowercase accented word counts as a signal on its own.
function isSpanish(body: string): boolean {
  const text = body.replace(URL_PATTERN, " ").replace(QUOTED, " ");
  if (SPANISH_MARK.test(text)) return true;
  const accents = [...text.matchAll(ACCENTED_WORD)];
  if (accents.some(([word]) => !CAPITALIZED.test(word))) return true;
  const words = new Set(
    (text.toLowerCase().match(/[a-záéíóúüñ]+/g) ?? []).filter((word) => FUNCTION_WORDS.has(word)),
  );
  return words.size >= 2;
}

function bodyLines(comment: Comment): string[] {
  if (comment.kind === "line") return [comment.body.trim()];
  return comment.body.split("\n").map((line) => line.replace(/^\s*\*?/, "").trim());
}

function violationsOf(rel: string, text: string): Violation[] {
  const { comments, firstCode } = scan(text);
  const found: Violation[] = [];
  const add = (rule: Rule, detail: string): void => {
    found.push({ key: `${rel} (${rule})`, detail });
  };

  // Only the first contiguous group before the first statement is the module header;
  // later groups are ordinary blocks and are measured with the block rule below.
  const header: Comment[] = [];
  for (const comment of comments) {
    if (firstCode !== null && comment.end > firstCode) break;
    const last = header[header.length - 1];
    if (last && comment.line > last.endLine + 1) break;
    header.push(comment);
  }
  const firstHeader = header[0];
  const lastHeader = header[header.length - 1];
  if (firstHeader && lastHeader) {
    const lines = lastHeader.endLine - firstHeader.line + 1;
    if (lines > 3) add("header", `${lines} lines before the first statement`);
  }

  const inHeader = new Set(header);
  let runStart = -1;
  let runEnd = -1;
  const flush = (): void => {
    if (runStart >= 0 && runEnd - runStart + 1 > 5) add("block", `lines ${runStart}-${runEnd}`);
    runStart = -1;
  };
  for (const comment of comments) {
    if (inHeader.has(comment)) continue;
    if (runStart >= 0 && comment.line <= runEnd + 1) runEnd = Math.max(runEnd, comment.endLine);
    else {
      flush();
      runStart = comment.line;
      runEnd = comment.endLine;
    }
  }
  flush();

  for (const comment of comments) {
    if (isSpanish(comment.body)) add("lang", `line ${comment.line}`);
    if (TODO.test(comment.body) && !ISSUE.test(comment.body)) add("todo", `line ${comment.line}`);
    for (const line of bodyLines(comment)) {
      if (line.includes("biome-ignore") && !BIOME_IGNORE.test(line)) add("sup", `line ${comment.line}: ${line}`);
      if (DEAD.some((pattern) => pattern.test(line))) add("dead", `line ${comment.line}: ${line}`);
    }
  }

  return found;
}

function compareExceptions(
  violations: Violation[],
  exceptions: Record<string, Exception>,
): { unexpected: string[]; changed: string[]; stale: string[] } {
  const counts = new Map<string, { count: number; detail: string }>();
  for (const violation of violations) {
    const current = counts.get(violation.key);
    if (current) current.count += 1;
    else counts.set(violation.key, { count: 1, detail: violation.detail });
  }
  const unexpected = [...counts.entries()]
    .filter(([key]) => !(key in exceptions))
    .map(([key, { count, detail }]) => `${key}: ${count}x ${detail}`);
  const changed = Object.keys(exceptions)
    .filter((key) => counts.has(key) && counts.get(key)?.count !== exceptions[key]?.count)
    .map((key) => `${key}: expected ${exceptions[key]?.count}, found ${counts.get(key)?.count}`);
  const stale = Object.keys(exceptions).filter((key) => !counts.has(key));
  return { unexpected, changed, stale };
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

function sources(): { rel: string; text: string }[] {
  const files = [
    ...walk(join(ENGINE, "src")),
    ...walk(join(ENGINE, "ui", "src")),
    ...walk(join(ENGINE, "tests")),
  ].filter((file) => !file.includes(`${sep}components${sep}ui${sep}`));
  return files.map((file) => ({
    rel: relative(ENGINE, file).split(sep).join("/"),
    text: readFileSync(file, "utf8"),
  }));
}

// The count is part of the key so a new violation in an already excepted file still fails.
const EXCEPTIONS: Record<string, Exception> = {};

describe("escáner", () => {
  it("encuentra el comentario que sigue a una comilla en texto JSX", () => {
    const text = 'const node = <p>It\'s 5" wide</p>;\n// Una prueba\n';
    expect(scan(text).comments.map((comment) => comment.body.trim())).toEqual(["Una prueba"]);
  });

  it("entra en las expresiones de una plantilla, también anidadas", () => {
    const text = [
      "const value = `out ${ /* inner */ name + `${ // nested",
      "suffix }` } end`;",
      "// after",
    ].join("\n");
    expect(scan(text).comments.map((comment) => comment.body.trim())).toEqual(["inner", "nested", "after"]);
  });

  it("no confunde una división con una expresión regular", () => {
    const text = String.raw`const ratio = a / b; // half
const other = (a + b) / 2; // paren
const re = /a\/\/b/; // slashes
const set = /[/]/; // class
// tail
`;
    expect(scan(text).comments.map((comment) => comment.body.trim())).toEqual([
      "half",
      "paren",
      "slashes",
      "class",
      "tail",
    ]);
  });

  it("devuelve el código sin comentarios y conserva las cadenas", () => {
    const text = 'const url = "https://example.com/a//b"; // removed\nconst other = 2;\n';
    const { code } = scan(text);
    expect(code).toContain('"https://example.com/a//b"');
    expect(code).not.toContain("removed");
    expect(code).toContain("const other = 2;");
  });
});

describe("idioma", () => {
  it("marca castellano sin acentos cuando hay dos palabras funcionales", () => {
    const cases = [
      "// Comprueba la firma antes de abrir",
      "// Filtra la lista de candidatos",
      "// Exactamente el tope no es un recorte.",
    ];
    for (const text of cases) {
      expect(violationsOf("src/example.ts", `const value = 1;\n${text}\n`).map((v) => v.key)).toEqual([
        "src/example.ts (lang)",
      ]);
    }
  });

  it("marca una palabra llana con acento", () => {
    const text = "const value = 1;\n// Cabecera de módulo\n";
    expect(violationsOf("src/example.ts", text).map((v) => v.key)).toEqual(["src/example.ts (lang)"]);
  });

  it("no marca inglés técnico, URLs, citas ni una sola palabra dudosa", () => {
    const cases = [
      "// Math.sin(theta) is the vertical component",
      "// sin() returns the sine",
      "// cos and sin of the angle",
      "// Los Angeles is in the fixture",
      "// Bézier control points",
      '// The viewer answers "La base está bloqueada" here',
      "// See https://example.com/para/guide",
    ];
    for (const text of cases) {
      expect(violationsOf("src/example.ts", `const value = 1;\n${text}\n`), text).toEqual([]);
    }
  });
});

describe("comentarios", () => {
  it("cumplen la norma salvo las excepciones, y ninguna excepción sobra", () => {
    const violations = sources().flatMap(({ rel, text }) => violationsOf(rel, text));
    const { unexpected, changed, stale } = compareExceptions(violations, EXCEPTIONS);
    expect(unexpected).toEqual([]);
    expect(changed).toEqual([]);
    expect(stale).toEqual([]);
  });

  it("una violación extra en un fichero ya exceptuado falla", () => {
    const text = "const value = 1;\n// Prueba de la firma\n// Otra prueba de la firma\n";
    const violations = violationsOf("src/env.ts", text);
    expect(violations.map((violation) => violation.key)).toEqual(["src/env.ts (lang)", "src/env.ts (lang)"]);
    const { changed } = compareExceptions(violations, {
      "src/env.ts (lang)": { reason: "known", count: 1 },
    });
    expect(changed).toEqual(["src/env.ts (lang): expected 1, found 2"]);
  });

  it("cada regla rechaza su caso", () => {
    const cases: [string, string, Rule][] = [
      ["una cabecera de cuatro líneas", "// one\n// two\n// three\n// four\nconst value = 1;\n", "header"],
      [
        "un segundo grupo antes del código",
        "// one\n// two\n// three\n\n// a\n// b\n// c\n// d\n// e\n// f\nconst value = 1;\n",
        "block",
      ],
      [
        "un bloque de seis líneas",
        "const value = 1;\n// one\n// two\n// three\n// four\n// five\n// six\n",
        "block",
      ],
      [
        "un bloque que mezcla estilos",
        "const value = 1;\n// one\n// two\n// three\n/* four\n * five\n * six */\n",
        "block",
      ],
      [
        "seis comentarios al final de línea",
        "const value = 1; // one\n// two\n// three\n// four\n// five\n// six\n",
        "block",
      ],
      ["un comentario en castellano", "const value = 1;\n// Prueba de la firma\n", "lang"],
      ["un TODO sin issue", "const value = 1;\n// TODO: later\n", "todo"],
      ["código comentado", "const value = 1;\n// db.close();\n", "dead"],
      ["una llamada comentada", "const value = 1;\n// foo();\n", "dead"],
      ["un condicional comentado", "const value = 1;\n// if (x) { return; }\n", "dead"],
      ["una función comentada", "const value = 1;\n// function old() {}\n", "dead"],
      ["una asignación comentada", "const value = 1;\n// total = total + 1;\n", "dead"],
      ["una espera comentada", "const value = 1;\n// await load();\n", "dead"],
      ["una supresión sin motivo", "const value = 1;\n// biome-ignore lint/suspicious/noExplicitAny\n", "sup"],
    ];
    for (const [name, text, rule] of cases) {
      const keys = violationsOf("src/example.ts", text).map((violation) => violation.key);
      expect(keys, name).toEqual([`src/example.ts (${rule})`]);
    }
  });

  it("acepta los límites de cada regla", () => {
    const text = [
      "// one",
      "// two",
      "// three",
      "",
      "// a",
      "// b",
      "const value = 1;",
      "// c",
      "// d",
      "// e",
      "// f",
      "// g",
      "",
      "// TODO(#12): later",
      "// biome-ignore lint/suspicious/noExplicitAny: the SDK types the error as unknown.",
      "// return the cached value;",
      "export const other = value;",
      "",
    ].join("\n");
    expect(violationsOf("src/example.ts", text)).toEqual([]);
  });
});
