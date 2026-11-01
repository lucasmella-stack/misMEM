// What the server tells a model at initialize: when to reach for each tool and how to
// recover from an empty answer.

/**
 * Descriptions say what each tool does; this says when to reach for it, since a model that
 * never captures leaves the memory empty and one that gives up on a misspelled scope decides
 * there is nothing. Every session pays for it: tests/server-core.test.ts caps it at 1500.
 */
export const MCP_INSTRUCTIONS = `misMEM is a shared memory with three layers: episodes (what happened, verbatim and dated), memories (the distilled gist and details) and traits (recurring patterns).

A scope namespaces everything: "<person or team>/<project>". Use the same scope to save and to search. A misspelled scope looks exactly like an empty memory.

capture when the user states a decision and why, when you find the root cause of a failure, or when the user corrects you. One idea per call. Never capture secrets or third-party data.

recall before asking the user something that may already be stored. Pass the scope when you know it. A hit with truncated true has a field clipped: read it in full with mem_get_observation and its id.

A recall or mem_search with no hits adds scopes: the scopes that do hold content. When a scope was asked for, hint says it matched nothing: retry without it or with another.

reinforce after answering, with the ids the answer actually relied on, not every hit.

consolidate saves a memory you wrote from the episodes you list (the nightly run distills pending ones by itself); crystallize promotes a pattern that repeats across memories. forget prunes old consolidated episodes and low-salience memories, and only writes with dry_run false.

A validation error comes as one line per problem: "Error en <tool>: <field>: <what it expects>". Fix that field and retry; sent unchanged, the call fails again.`;
