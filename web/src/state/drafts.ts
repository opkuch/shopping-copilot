// Unsent text per conversation ("new" for home). In memory on purpose: typing never touches the
// app reducer, so a keystroke does not re-render the transcript. Not persisted across a reload.
export const NEW_CHAT = "new";

const drafts = new Map<string, string>();

export const getDraft = (key: string) => drafts.get(key) ?? "";

export function setDraft(key: string, text: string): void {
  if (text === "") drafts.delete(key);
  else drafts.set(key, text);
}
