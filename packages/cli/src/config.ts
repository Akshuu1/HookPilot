import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface CliConfig {
  apiKey?: string;
  serverUrl?: string;
}

export const DEFAULT_SERVER_URL = 'http://localhost:4000';

export function getConfigDir(): string {
  return path.join(os.homedir(), '.hookpilot');
}

export function getConfigFilePath(): string {
  return path.join(getConfigDir(), 'config.json');
}

export function loadConfig(): CliConfig {
  try {
    const filePath = getConfigFilePath();
    if (!fs.existsSync(filePath)) {
      return {};
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as CliConfig;
  } catch {
    return {};
  }
}

export function saveConfig(updates: Partial<CliConfig>): CliConfig {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const current = loadConfig();
  const nextConfig: CliConfig = {
    ...current,
    ...updates,
  };

  const filePath = getConfigFilePath();
  fs.writeFileSync(filePath, JSON.stringify(nextConfig, null, 2), {
    mode: 0o600,
  });

  return nextConfig;
}
