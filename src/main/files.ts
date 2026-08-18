//
// files.ts — saving exports.
//
// NEVER OVERWRITE. Outputs append " 2", " 3" … instead of replacing an existing
// file. This is a standing rule from the Swift app: originals and previous
// exports are never modified, because a re-export with the same fire number is
// routine and silently clobbering yesterday's deliverable is not recoverable.
//

import { dialog, shell, type BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

/** "V10755 perimeter.kml" → "V10755 perimeter 2.kml" if taken, then " 3" … */
export function availableName(dir: string, fileName: string): string {
  const ext = extname(fileName);
  const base = basename(fileName, ext);
  if (!existsSync(join(dir, fileName))) return fileName;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base} ${n}${ext}`;
    if (!existsSync(join(dir, candidate))) return candidate;
  }
  return `${base} ${Date.now()}${ext}`;
}

export type SaveResult =
  | { ok: true; path: string }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled: false; error: string };

export async function saveTextFile(
  win: BrowserWindow | null,
  suggestedName: string,
  contents: string,
): Promise<SaveResult> {
  const opts = {
    title: 'Save KML',
    defaultPath: suggestedName,
    filters: [
      { name: 'KML', extensions: ['kml'] },
      { name: 'All files', extensions: ['*'] },
    ],
  };
  const result = win
    ? await dialog.showSaveDialog(win, opts)
    : await dialog.showSaveDialog(opts);
  if (result.canceled || !result.filePath) return { ok: false, cancelled: true };

  // The save panel already asked about replacing, but the no-overwrite rule is
  // the app's, not the panel's — so a unique name is chosen regardless.
  const dir = dirname(result.filePath);
  const finalName = availableName(dir, basename(result.filePath));
  const path = join(dir, finalName);
  try {
    await writeFile(path, contents, 'utf8');
    shell.showItemInFolder(path);
    return { ok: true, path };
  } catch (e) {
    return { ok: false, cancelled: false, error: e instanceof Error ? e.message : String(e) };
  }
}
