import { useQuery } from "@tanstack/react-query";
import { api } from "@/api";
import { Chip, Count, Empty, Failure, Loading, type ListProps, Row } from "./primitives";

/**
 * The semantic islands: which memories talk about the same thing. A topic that draws from three
 * scopes is the thing this view exists for — scope navigation keeps those three apart.
 */
export function TopicList({ scope, selected, onSelect }: ListProps) {
  const query = useQuery({
    queryKey: ["topics", scope ?? ""],
    queryFn: ({ signal }) => api.topics(scope, signal),
  });

  if (query.isPending) return <Loading label="Agrupando las memorias por significado…" />;
  const data = query.data;
  const topics = data?.topics ?? [];

  return (
    <div className="flex flex-col gap-2">
      {query.isError && <Failure what="los temas" error={query.error} stale={topics.length > 0} />}
      {data && topics.length > 0 && (
        <Count>
          {`${topics.length} ${topics.length === 1 ? "tema" : "temas"} sobre ${data.considered} memorias · ${data.alone} sin pareja`}
        </Count>
      )}
      {topics.length === 0 ? (
        query.isError ? null : (
          <Empty>
            {data && data.considered === 0
              ? "Todavía no hay vectores: sin búsqueda por significado no se pueden agrupar las memorias."
              : "Ninguna memoria se parece lo bastante a otra como para formar un tema."}
          </Empty>
        )
      ) : (
        <ul className="flex flex-col gap-2">
          {topics.map((topic) => (
            <Row
              key={topic.entry.id}
              layer="memory"
              active={selected?.layer === "memory" && selected.id === topic.entry.id}
              onClick={() => onSelect({ layer: "memory", id: topic.entry.id })}
              text={topic.entry.gist}
              meta={
                <>
                  <Chip brand>{topic.size} memorias</Chip>
                  {topic.scopes.slice(0, 3).map((s) => (
                    <Chip key={s.scope}>
                      {s.scope} · {s.n}
                    </Chip>
                  ))}
                  {topic.scopes.length > 3 && <Chip>+{topic.scopes.length - 3} ámbitos</Chip>}
                </>
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
}
