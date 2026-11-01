import { useQuery } from "@tanstack/react-query";
import { api } from "@/api";
import { ago } from "@/format";
import { Chip, Count, Empty, Failure, Loading, type ListProps, Row } from "./primitives";

export function TraitList({ scope, selected, onSelect, totalTraits }: ListProps & { totalTraits: number | undefined }) {
  const query = useQuery({
    queryKey: ["traits", scope ?? ""],
    queryFn: ({ signal }) => api.traits(scope, signal),
  });

  if (query.isPending) return <Loading label="Cargando los rasgos…" />;
  const rows = query.data?.rows ?? [];
  const total = totalTraits ?? rows.length;
  const truncated = rows.length < total;

  return (
    <div className="flex flex-col gap-2">
      {query.isError && <Failure what="los rasgos" error={query.error} stale={rows.length > 0} />}
      {rows.length > 0 && (
        <Count>
          {truncated ? `${rows.length} de ${total} rasgos · se muestran los más fuertes` : `${rows.length} ${rows.length === 1 ? "rasgo" : "rasgos"}`}
        </Count>
      )}
      {rows.length === 0 ? (
        query.isError ? null : <Empty>Ningún patrón se ha cristalizado como rasgo todavía.</Empty>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((trait) => (
            <Row
              key={trait.id}
              layer="trait"
              active={selected?.layer === "trait" && selected.id === trait.id}
              onClick={() => onSelect({ layer: "trait", id: trait.id })}
              text={trait.text}
              meta={
                <>
                  <Chip>{trait.scope}</Chip>
                  <Chip brand>fuerza {trait.strength}</Chip>
                  {trait.polarity !== "neutral" && <Chip>{trait.polarity}</Chip>}
                  <Chip>{ago(trait.updated_at)}</Chip>
                </>
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
}
