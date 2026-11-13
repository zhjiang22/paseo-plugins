/**
 * Every name Ferry puts into Paseo comes from here: the install id (it also names the data folder
 * `$PASEO_HOME/plugin-data/<id>/`), RPC and settings names, agent labels, timeline row kinds, the envelope tags agents
 * read and the agent tool. Renaming the plugin is one edit.
 */
export const PLUGIN_ID = "ferry";

/** Agent labels: the chain an agent belongs to and how it joined it. Labels survive restarts; Ferry's chain files are the record. */
export const LABEL_CHAIN = `${PLUGIN_ID}.chain`;
export const LABEL_VISIT = `${PLUGIN_ID}.visit`;
export const LABEL_FROM_AGENT = `${PLUGIN_ID}.from-agent`;
export const OWN_LABELS: readonly string[] = [LABEL_CHAIN, LABEL_VISIT, LABEL_FROM_AGENT];

/** Timeline rows Ferry appends (`kind`). The app accepts lower-case letters, digits and dashes only in contribution ids
 * and kinds. */
export const ROW_HANDOFF = `${PLUGIN_ID}-handoff`;
export const ROW_MOVED = `${PLUGIN_ID}-moved`;
export const ROW_ALERT = `${PLUGIN_ID}-alert`;
export const ROW_VERSION = 1;

/** The envelope agents receive: `<ferry-handoff …>` with one `<ferry-item …>` per conversation item. */
export const ENVELOPE_TAG = `${PLUGIN_ID}-handoff`;
export const ITEM_TAG = `${PLUGIN_ID}-item`;

/** Title of the history attachment (the model is not shown it; Paseo may list it). */
export const ENVELOPE_TITLE = "Ferry: conversation history";

/** The read-only history tool given to agents in a chain (Claude shows it as `mcp__paseo__<name>`). */
export const TOOL_NAME = `${PLUGIN_ID}_read_history`;

/** Client message ids of the messages Ferry sends start with this, so a live timeline row is recognised at once. */
export const MESSAGE_PREFIX = `${PLUGIN_ID}-`;
