//
// updatePolicy.ts — the decision rules behind the update prompt.
//
// Kept out of src/main/updater.ts so they can be tested without standing up
// Electron: updater.ts imports `app`, `dialog` and `shell`, which cannot be
// loaded under `node --test`. The rules here are about when to bother the user,
// which is exactly the sort of thing worth pinning down with assertions.
//

/**
 * Whether to raise the download prompt for a given version.
 *
 * Stay quiet when: there is no version, a prompt is already on screen (the daily
 * timer must not stack a second dialog on the first), or the user already said
 * "not now" to this exact version.
 *
 * Declines are tracked per version and held only for the session. Persisting
 * them would silently pin someone to an old build forever; forgetting them
 * within a session would re-ask on every daily check, which is nagging.
 */
export function shouldPromptForVersion(
  version: string | undefined,
  declinedVersions: ReadonlySet<string>,
  alreadyPrompting: boolean,
): boolean {
  if (!version) return false;
  if (alreadyPrompting) return false;
  return !declinedVersions.has(version);
}

/**
 * electron-updater hands release notes over as an HTML string, or as an array of
 * `{version, note}` objects, or not at all. Flatten whatever arrives into plain
 * text short enough for a dialog — raw HTML in a native dialog renders as tag
 * soup.
 */
export function plainReleaseNotes(notes: unknown, maxLength = 400): string {
  const raw = Array.isArray(notes)
    ? notes
        .map((n) => (typeof n === 'string' ? n : typeof n?.note === 'string' ? n.note : ''))
        .join('\n')
    : typeof notes === 'string'
      ? notes
      : '';
  const text = raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLength ? text.slice(0, maxLength - 1).trimEnd() + '…' : text;
}

/** True for the electron-updater error that means "unsigned app on macOS, this
 *  update can never be applied automatically". Matched by message because
 *  electron-updater gives it no distinct error code. */
export function isSignatureError(message: string): boolean {
  return /code signature|not signed|Could not get code signature/i.test(message);
}
