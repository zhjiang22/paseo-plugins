import { tokensOf } from "../shared/bytes";
import type { NoteData } from "../shared/rpc";
import { t, type MessageId } from "../shared/text";

/** A server note worded on this device; a code this version does not know shows as itself, so nothing is lost. */
export function noteText(note: NoteData): string {
  const text = t(note.code as MessageId, note.params);
  return text && text !== note.code ? text : `${note.code}${note.params ? ` ${JSON.stringify(note.params)}` : ""}`;
}

export const familyName = (family: string): string => {
  switch (family) {
    case "claude":
      return t("picker.familyClaude");
    case "codex":
      return t("picker.familyCodex");
    case "pi":
    case "omp":
      return t("picker.familyPi");
    case "opencode":
      return t("picker.familyOpencode");
    case "acp":
      return t("picker.familyAcp");
    default:
      return t("picker.familyOther");
  }
};

/** Approximate tokens for a byte count, rounded for reading: "14k". */
export function tokens(bytes: number): string {
  const count = tokensOf(bytes);
  if (count < 1000) return String(count);
  return `${Math.round(count / 100) / 10}k`.replace(/\.0k$/, "k");
}

export function kilobytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round((bytes / 1024) * 10) / 10} KB`;
}
