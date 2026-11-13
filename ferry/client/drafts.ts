// What `/ferry` was given travels to the screen through memory, not the URL: a message can be long, and a URL that
// carries it would land in the app's history. The screen gets the store through its props.

export interface Draft {
  args: string;
  /** Run without asking when the target is named exactly. */
  auto: boolean;
}

export interface Drafts {
  put(draft: Draft): string;
  take(id: string): Draft | null;
}

export function createDrafts(): Drafts {
  const drafts = new Map<string, Draft>();
  let counter = 0;
  return {
    put(draft) {
      counter += 1;
      const id = `${Date.now().toString(36)}${counter.toString(36)}`;
      drafts.set(id, draft);
      // Only the last few matter; a screen opened twice reads the same one.
      while (drafts.size > 8) drafts.delete(drafts.keys().next().value!);
      return id;
    },
    take(id) {
      return drafts.get(id) ?? null;
    },
  };
}
