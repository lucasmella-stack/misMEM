import type { EpisodeItem, Layer } from "@/api";

/**
 * The episode carries its text in the selection because there is no detail endpoint by id:
 * the row snapshot is the only thing that has it. The other layers are requested by id.
 */
export type Selection = { layer: Layer; id: string; episode?: EpisodeItem };
