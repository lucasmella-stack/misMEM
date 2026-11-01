import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "./support/contrast";

const CSS_PATH = fileURLToPath(new URL("../ui/src/styles.css", import.meta.url));

function themeTokens(selector: RegExp): Map<string, string> {
  const css = readFileSync(CSS_PATH, "utf8");
  const block = css.match(selector)?.[1];
  if (!block) throw new Error(`styles.css no tiene el bloque ${selector}`);
  const tokens = new Map<string, string>();
  for (const match of block.matchAll(/--color-([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const [, name, value] = match;
    if (name && value) tokens.set(name, value.trim());
  }
  return tokens;
}

function hex(tokens: Map<string, string>, name: string): string {
  const value = tokens.get(name);
  if (!value) throw new Error(`falta --color-${name}`);
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`--color-${name} no es #rrggbb: ${value}`);
  return value;
}

/**
 * `bg-brand/15` is brand at 15% alpha over the background: blended per channel in
 * sRGB (0-255), which is what the browser does when painting the translucent layer.
 */
function over(brand: string, background: string, alpha: number): string {
  const channel = (value: string, index: number): number =>
    Number.parseInt(value.slice(1 + index * 2, 3 + index * 2), 16);
  const blended = [0, 1, 2].map((index) =>
    Math.round(channel(brand, index) * alpha + channel(background, index) * (1 - alpha)),
  );
  return `#${blended.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

describe("contrastRatio", () => {
  it("da 21 entre negro y blanco", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
  });
});

describe("contraste de los tokens de texto", () => {
  const themes = [
    ["oscuro", /:root\s*,\s*\[data-theme="dark"\]\s*\{([^}]*)\}/],
    ["claro", /\[data-theme="light"\]\s*\{([^}]*)\}/],
  ] as const;

  it("ink, ink-soft, ink-muted y brand-text pasan AA sobre las dos superficies", () => {
    for (const [theme, selector] of themes) {
      const tokens = themeTokens(selector);
      for (const foreground of ["ink", "ink-soft", "ink-muted", "brand-text"]) {
        for (const background of ["surface", "surface-raised"]) {
          const ratio = contrastRatio(hex(tokens, foreground), hex(tokens, background));
          expect(ratio, `${theme}: ${foreground} sobre ${background} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
            4.5,
          );
        }
      }
    }
  });

  // `field` is the real background of chips and notices: passing over surface is not enough.
  it("los tokens de texto pasan AA sobre field", () => {
    for (const [theme, selector] of themes) {
      const tokens = themeTokens(selector);
      for (const foreground of ["ink", "ink-soft", "ink-muted", "brand-text"]) {
        const ratio = contrastRatio(hex(tokens, foreground), hex(tokens, "field"));
        expect(ratio, `${theme}: ${foreground} sobre field = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  // The scopes' `+N` badge paints brand-text over brand at 15%.
  it("brand-text pasa AA sobre brand al 15 % en surface y surface-raised", () => {
    for (const [theme, selector] of themes) {
      const tokens = themeTokens(selector);
      for (const background of ["surface", "surface-raised"]) {
        const tinted = over(hex(tokens, "brand"), hex(tokens, background), 0.15);
        const ratio = contrastRatio(hex(tokens, "brand-text"), tinted);
        expect(
          ratio,
          `${theme}: brand-text sobre brand/15 encima de ${background} = ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
