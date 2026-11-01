# Releases

Una release es un **tag anotado `vX.Y.Z` sobre `main`**, una release de GitHub con sus notas y una sección
con fecha en el [`CHANGELOG.md`](../../CHANGELOG.md). Versionado semántico.

## El CHANGELOG

- Arriba, `## Sin publicar`. **Cada PR añade ahí su entrada**, no al cortar la release: así el contexto
  está fresco y el revisor la ve.
- Una entrada es un `###` que dice el efecto en lenguaje de producto, y viñetas con el porqué.
- Una release cierra la sección: `## X.Y.Z — AAAA-MM-DD`, y arriba queda otra `## Sin publicar` vacía.
- Un cambio `breaking` lleva su nota de migración en la entrada.
- El `CHANGELOG.md` es el índice con el porqué; la release de GitHub conserva el detalle medido (cifras de
  `mismem-bench`, notas de migración largas) y enlaza a él.

## Cortar una release

1. Rama `chore/release-x-y-z` desde `main` (por ejemplo `chore/release-0-6-0`; el punto no cabe en [el nombre de una rama](branches.md)). Se sube la versión en **tres sitios**, que
   `engine/tests/version.test.ts` obliga a mantener iguales: `version` en `engine/package.json`, y
   `version` y `packages[0].version` en `server.json`. Se mueve la sección del CHANGELOG.
2. PR con la plantilla `release.md` (URL en [`CONTRIBUTING.md`](../../CONTRIBUTING.md#estándar-de-pr)),
   CI en verde, merge commit.
3. Tag anotado sobre el merge, en `main` actualizado:
   `git tag -a vX.Y.Z -m 'misMEM X.Y.Z'` y `git push origin vX.Y.Z`.
4. El tag lanza `docker.yml`: corre el mismo CI y publica `ghcr.io/lucasmella-stack/mismem-brain` con la
   versión exacta y `major.minor`; en un push, `latest` sólo desde el tag estable más alto, y en una
   republicación manual, desde el tag despachado. Si falla al empujar, ver `DEPLOY.md`.
5. Release de GitHub sobre el tag con notas generadas (agrupadas por [`.github/release.yml`](../../.github/release.yml)
   según las etiquetas de los PR) y la sección del CHANGELOG.
6. `pnpm publish` desde `engine/`, a mano: ningún workflow publica en npm. `prepublishOnly` repite
   typecheck, tests y build.

## Dar la release por buena

Declarada sólo cuando se observa, no cuando se lanza:

- el workflow `docker` del tag, terminado y en verde;
- `npm view @lucasmella/mismem version` devuelve `X.Y.Z`;
- la release de GitHub existe con las notas.

Lo que falte se declara pendiente en la release; no se anuncia como hecho.

## Arreglo urgente

Es un PR de `fix` sobre `main` con su test de regresión, y una release de parche (`X.Y.Z+1`) con los
mismos pasos. No hay rama de hotfix: `main` siempre se puede publicar.
