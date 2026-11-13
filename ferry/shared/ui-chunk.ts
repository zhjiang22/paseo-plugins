import { createClientChunkRpc } from "./client-chunk";
import { PLUGIN_ID } from "./plugin-id";

/** Ferry's screens, settings and timeline cards arrive as one lazy chunk, fetched the first time one of them shows. */
export const getClientChunk = createClientChunkRpc(`${PLUGIN_ID}.client-chunk.get`, ["ui"]);
