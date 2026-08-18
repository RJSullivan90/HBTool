//
// api.ts — the typed surface the preload exposes on window.hbtool.
//
// One declaration, imported by every renderer module, so a channel added in
// preload.ts is either declared here or is a type error at the call site rather
// than an undefined at runtime.
//

import type { FirePerimeter } from '../shared/fires.ts';
import type { MetarStation, TFRRecord } from '../shared/tfr.ts';

export type FetchResult =
  | { ok: true; records: TFRRecord[]; failures: string[] }
  | { ok: false; error: string };

export type WeatherResult =
  | { ok: true; stations: MetarStation[] }
  | { ok: false; error: string };

export type FiresResult = { ok: true; fires: FirePerimeter[] } | { ok: false; error: string };

export type SaveResult =
  | { ok: true; path: string }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled: false; error: string };

export type SecretsStatus = {
  unlocked: boolean;
  bundleMissing: boolean;
  canRemember: boolean;
  fingerprint: string | null;
};

export type UpdateState = {
  status: string;
  version?: string;
  percent?: number;
  message?: string;
};

declare global {
  interface Window {
    hbtool: {
      appInfo(): Promise<{ version: string; platform: string; releasesURL: string }>;

      secretsStatus(): Promise<SecretsStatus>;
      unlock(
        passphrase: string,
        remember: boolean,
      ): Promise<{ ok: boolean; error?: string; status: SecretsStatus }>;
      forgetKey(): Promise<SecretsStatus>;
      onSecretsChanged(fn: (s: SecretsStatus) => void): void;

      fetchTFRs(refresh: boolean): Promise<FetchResult>;
      fetchWeather(lat: number, lon: number): Promise<WeatherResult>;

      fetchFires(source: string): Promise<FiresResult>;
      saveKML(suggestedName: string, contents: string): Promise<SaveResult>;

      copy(text: string): Promise<void>;

      updateState(): Promise<UpdateState>;
      checkForUpdates(): Promise<UpdateState>;
      downloadUpdate(): Promise<UpdateState>;
      installUpdate(): Promise<void>;
      openReleases(): Promise<void>;
      onUpdateChanged(fn: (s: UpdateState) => void): void;
    };
  }
}
