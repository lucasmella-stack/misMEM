# Política de seguridad

## Cómo reportar

En privado, por GitHub: pestaña **Security** del repositorio, **Report a vulnerability**
(GitHub Private Vulnerability Reporting). El hilo queda visible sólo para quien reporta y
para quien mantiene. No abras un issue público, y no publiques la prueba de concepto hasta
que haya arreglo.

Basta con lo mínimo para reproducirlo: versión (la de `engine/package.json`), cómo se
ejecuta (MCP local, npm, o servidor HTTP en Docker) y qué se consigue.

## Qué versiones reciben arreglos

Sólo la última versión publicada, la de npm (`@lucasmella/mismem`) y las releases de GitHub.
Las anteriores no se parchean: el arreglo sale en una versión nueva y se anota en
`CHANGELOG.md`.

## Qué cuenta como vulnerabilidad

misMEM guarda toda tu memoria en un único fichero SQLite y, en modo HTTP, la expone por red.
Cuenta como vulnerabilidad cualquier forma de:

- **Saltarte o debilitar la autenticación del modo HTTP**: el BasicAuth de `MISMEM_AUTH_USER`
  y `MISMEM_AUTH_PASS`, la guarda de `Host` o el bind a loopback por defecto. Incluye leer
  `/mcp`, `/viewer` o las rutas del visor sin credenciales, o inyectar cabeceras para lograrlo.
- **Leer, escribir o borrar la DB sin permiso**, o hacer que el servidor la escriba donde otro
  usuario pueda leerla. Ese fichero es toda la memoria y se restringe a `0600` al abrirlo, si el sistema de ficheros lo permite.
- **Ejecutar código o SQL** a partir de input externo: consultas de `recall`, cuerpos de
  `capture`, rutas del visor, importación de exports.
- **Filtrar memoria a un tercero** por logs, errores, telemetría o cualquier salida que
  incluya contenido que no pediste.

Fuera de alcance: el contenido que se le pasa al agente (un secreto que se le cuente queda en la
DB) y exponer el servidor HTTP a internet sin BasicAuth ni proxy, que ya está documentado como
inseguro. Los avisos de dependencias van por Dependabot, no por acá.
