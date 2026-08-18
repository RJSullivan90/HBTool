//
// renderer.ts — the app shell: sidebar, tool switching, and the chrome shared by
// every tool (version, update badge, team-key panel).
//
// Tools are constructed LAZILY on first visit but then stay mounted, so a loaded
// perimeter list or a TFR selection survives switching away and back. Same
// reasoning as the Swift app's keep-alive ZStack — and the same consequence:
// anything that must react to becoming visible needs an explicit activate(),
// because nothing fires on show.
//

import './api.ts';
import { FirePerimeterTool } from './firePerimeter.ts';
import { TfrReportTool } from './tfrReport.ts';
import type { SecretsStatus, UpdateState } from './api.ts';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as unknown as T;

type ToolId = 'tfr' | 'fire';

const TOOLS: Array<{ id: ToolId; title: string; icon: string }> = [
  { id: 'tfr', title: 'TFR Report', icon: '✈' },
  { id: 'fire', title: 'Fire Perimeter Tool', icon: '△' },
];

const els = {
  toolList: $<HTMLElement>('tool-list'),
  toolTitle: $<HTMLElement>('tool-title'),
  version: $<HTMLElement>('version'),
  badge: $<HTMLElement>('update-badge'),
  panes: { tfr: $<HTMLElement>('tool-tfr'), fire: $<HTMLElement>('tool-fire') },
  key: $<HTMLInputElement>('key'),
  remember: $<HTMLInputElement>('remember'),
  unlock: $<HTMLButtonElement>('unlock'),
  forget: $<HTMLButtonElement>('forget'),
  keyState: $<HTMLElement>('key-state'),
  keyMessage: $<HTMLElement>('key-message'),
};

let current: ToolId = 'tfr';
const built: Partial<Record<ToolId, { activate(): void }>> = {};

function build(id: ToolId): { activate(): void } {
  const existing = built[id];
  if (existing) return existing;
  const tool =
    id === 'tfr' ? new TfrReportTool(els.panes.tfr) : new FirePerimeterTool(els.panes.fire);
  built[id] = tool;
  return tool;
}

function selectTool(id: ToolId): void {
  current = id;
  for (const t of TOOLS) els.panes[t.id].hidden = t.id !== id;
  els.toolTitle.textContent = TOOLS.find((t) => t.id === id)!.title;
  renderToolList();
  // Built on first visit, then kept; activate() is how a mounted tool learns it
  // is visible again, since no DOM event reports that.
  build(id).activate();
}

function renderToolList(): void {
  els.toolList.replaceChildren();
  for (const t of TOOLS) {
    const b = document.createElement('button');
    b.className = `tool-item${current === t.id ? ' on' : ''}`;
    b.type = 'button';
    const icon = document.createElement('span');
    icon.className = 'tool-icon';
    icon.textContent = t.icon;
    const label = document.createElement('span');
    label.textContent = t.title;
    b.append(icon, label);
    b.addEventListener('click', () => selectTool(t.id));
    els.toolList.append(b);
  }
}

// MARK: secrets panel

function showSecrets(s: SecretsStatus): void {
  if (s.bundleMissing) {
    els.keyState.textContent = '— none shipped in this build';
    els.unlock.disabled = true;
    return;
  }
  els.keyState.textContent = s.unlocked ? `— unlocked (key ${s.fingerprint})` : '— locked';
  els.remember.disabled = !s.canRemember;
  if (!s.canRemember) {
    els.keyMessage.textContent =
      'This computer has no usable credential store, so the key must be entered each launch.';
  }
}

// MARK: update badge

function showUpdate(s: UpdateState): void {
  const show = (text: string, onClick: () => void) => {
    els.badge.textContent = text;
    els.badge.hidden = false;
    (els.badge as HTMLElement).onclick = onClick;
  };
  switch (s.status) {
    case 'downloaded':
      show(`Restart to update to ${s.version ?? 'the new version'}`, () => {
        void window.hbtool.installUpdate();
      });
      break;
    case 'downloading':
      // Not clickable: the download is already running, and cancelling
      // mid-transfer is not something electron-updater exposes cleanly.
      show(`Downloading ${s.version ?? 'update'}… ${s.percent ?? 0}%`, () => {});
      break;
    case 'available':
      // Reached when the dialog was dismissed or declined — the badge becomes
      // the second chance, so declining is not a dead end.
      show(`Update ${s.version ?? ''} available — download`.replace('  ', ' '), () => {
        void window.hbtool.downloadUpdate();
      });
      break;
    case 'manual':
      show('Update available — download', () => {
        void window.hbtool.openReleases();
      });
      break;
    case 'idle':
      if (s.message && s.version) {
        show(`Update ${s.version} available — download`, () => {
          void window.hbtool.downloadUpdate();
        });
      } else {
        els.badge.hidden = true;
      }
      break;
    default:
      els.badge.hidden = true;
  }
}

// MARK: wiring

els.unlock.addEventListener('click', async () => {
  const res = await window.hbtool.unlock(els.key.value, els.remember.checked);
  els.keyMessage.textContent = res.ok ? 'Unlocked.' : (res.error ?? 'Could not unlock.');
  if (res.ok) els.key.value = '';
  showSecrets(res.status);
});

els.forget.addEventListener('click', async () => {
  showSecrets(await window.hbtool.forgetKey());
  els.keyMessage.textContent = 'Key forgotten on this computer.';
});

window.hbtool.onSecretsChanged(showSecrets);
window.hbtool.onUpdateChanged(showUpdate);

void (async () => {
  const info = await window.hbtool.appInfo();
  els.version.textContent = `v${info.version}`;
  if (info.platform === 'win32') document.body.classList.add('win');
  showSecrets(await window.hbtool.secretsStatus());
  showUpdate(await window.hbtool.updateState());
  selectTool('tfr');
})();
