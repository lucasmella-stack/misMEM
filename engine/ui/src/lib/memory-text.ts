export function unconsolidateText(linked: number): string {
  return linked === 0
    ? "La memoria desaparece; no tenía episodios atados."
    : `La memoria desaparece y ${linked === 1 ? "su episodio vuelve" : `sus ${linked} episodios vuelven`} a estar sin consolidar. La próxima consolidación ${linked === 1 ? "lo" : "los"} leerá de nuevo.`;
}

export function forgetText(linked: number, traits: number): string {
  const base =
    linked === 0
      ? "Se borra la memoria."
      : `Se borran la memoria y ${linked === 1 ? "su episodio" : `sus ${linked} episodios`}.`;
  const citing =
    traits === 0
      ? ""
      : traits === 1
        ? " Un rasgo la cita y seguirá existiendo sin ella."
        : ` ${traits} rasgos la citan y seguirán existiendo sin ella.`;
  return `${base} No se puede deshacer.${citing}`;
}
