// The sign-in page's stylesheet, apart from the page because the CSP allows no inline script
// and keeping it a file lets the browser cache it. The tokens are the viewer's, copied rather
// than imported: this has to render before anything of the interface loads.

export const LOGIN_CSS = `:root, [data-theme="dark"] {
  color-scheme: dark;
  --surface: #1a1917;
  --raised: #21201d;
  --field: #100f0d;
  --ink: #e8e4dc;
  --ink-soft: #d2cec6;
  --ink-muted: #a09c93;
  --ink-faint: #6f6c64;
  --edge: rgb(255 255 255 / 0.14);
  --brand: #f087ad;
  --on-brand: #141311;
  --danger: #e4948c;
  --logo: url("/login-logo-dark.webp");
}

@media (prefers-color-scheme: light) {
  :root {
    color-scheme: light;
    --surface: #cbc9c3;
    --raised: #d6d3cc;
    --field: #bcbab3;
    --ink: #121114;
    --ink-soft: #333236;
    --ink-muted: #4b4943;
    --ink-faint: #807d75;
    --edge: rgb(0 0 0 / 0.12);
    --brand: #b23a76;
    --on-brand: #ffffff;
    --danger: #842a1f;
    --logo: url("/login-logo.webp");
  }
}

* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }

body {
  display: grid;
  place-items: center;
  padding: 24px;
  background: var(--surface);
  color: var(--ink);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 15px;
  line-height: 1.5;
}

main { width: 100%; max-width: 25rem; }

.marca {
  display: block;
  width: 148px;
  height: 137px;
  margin: 0 auto 20px;
  background: var(--logo) center / contain no-repeat;
}

.lema {
  margin: 0 0 28px;
  text-align: center;
  color: var(--ink-muted);
  font-size: 13px;
}

form {
  padding: 28px 26px 26px;
  border: 1px solid var(--edge);
  border-radius: 14px;
  background: var(--raised);
}

.campo + .campo { margin-top: 18px; }

label {
  display: block;
  margin-bottom: 7px;
  color: var(--ink-soft);
  font-size: 13px;
}

input {
  width: 100%;
  /* 48 px tall: the smallest target a thumb hits without aiming. */
  padding: 13px 14px;
  border: 1px solid var(--edge);
  border-radius: 10px;
  background: var(--field);
  color: var(--ink);
  font: inherit;
}

input:focus {
  outline: none;
  border-color: var(--brand);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--brand) 28%, transparent);
}

button {
  width: 100%;
  margin-top: 22px;
  padding: 14px;
  border: 0;
  border-radius: 10px;
  background: var(--brand);
  color: var(--on-brand);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

button:hover { filter: brightness(1.08); }

:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 2px;
}

.aviso {
  margin: 16px 0 0;
  padding: 11px 13px;
  border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--danger) 12%, transparent);
  color: var(--danger);
  font-size: 13px;
}
`;
