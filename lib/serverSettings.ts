import * as fs from 'fs';
import * as path from 'path';

export interface AppSettings {
  evmNetwork: 'mainnet' | 'testnet';
  solanaNetwork: 'mainnet-beta' | 'devnet';
}

const SETTINGS_FILE = path.join(process.cwd(), 'data', 'settings.json');

const DEFAULTS: AppSettings = {
  evmNetwork:    'mainnet',
  solanaNetwork: 'mainnet-beta',
};

function load(): AppSettings {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
    }
  } catch { /* ignore — use defaults */ }
  return { ...DEFAULTS };
}

function save(s: AppSettings): void {
  try {
    const dir = path.dirname(SETTINGS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
  } catch { /* non-fatal */ }
}

declare global { var __appSettings: AppSettings | undefined }

export function getSettings(): AppSettings {
  if (!global.__appSettings) global.__appSettings = load();
  return global.__appSettings;
}

export function updateSettings(partial: Partial<AppSettings>): AppSettings {
  const updated = { ...getSettings(), ...partial };
  global.__appSettings = updated;
  save(updated);
  return updated;
}
