import chalk from 'chalk';
import { saveConfig, DEFAULT_SERVER_URL, getConfigFilePath } from '../config.js';

export interface LoginOptions {
  key?: string;
  server?: string;
}

export async function loginCommand(options: LoginOptions): Promise<void> {
  const apiKey = options.key?.trim();

  if (!apiKey) {
    console.error(chalk.red('Error: --key <apiKey> is required.'));
    console.error(chalk.dim('Example: hookpilot login --key hp_live_abcdef123456'));
    process.exit(1);
  }

  if (!apiKey.startsWith('hp_')) {
    console.error(chalk.red('Error: Invalid API key format. HookPilot API keys start with "hp_".'));
    process.exit(1);
  }

  const serverUrl = (options.server?.trim() || DEFAULT_SERVER_URL).replace(/\/+$/, '');

  console.info(chalk.blue('Authenticating with HookPilot server at:'), chalk.cyan(serverUrl));

  try {
    const verifyRes = await fetch(`${serverUrl}/auth/verify-key`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (verifyRes.ok) {
      const data = (await verifyRes.json()) as { workspaceId?: string; name?: string };
      saveConfig({ apiKey, serverUrl });
      console.info(chalk.green('✓ Logged in successfully!'));
      if (data.name) {
        console.info(chalk.dim(`  API Key:     ${data.name}`));
      }
      if (data.workspaceId) {
        console.info(chalk.dim(`  Workspace:   ${data.workspaceId}`));
      }
      console.info(chalk.dim(`  Config saved: ${getConfigFilePath()}`));
    } else {
      const errBody = (await verifyRes.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      const msg = errBody.error?.message || `HTTP ${verifyRes.status}`;
      console.error(chalk.red(`✗ Authentication failed: ${msg}`));
      process.exit(1);
    }
  } catch {
    // If server is not reachable, save config anyway with a warning
    console.warn(
      chalk.yellow('⚠ Could not reach server to verify key immediately (server offline?).'),
    );
    saveConfig({ apiKey, serverUrl });
    console.info(chalk.green('✓ API key saved to config!'));
    console.info(chalk.dim(`  Config saved: ${getConfigFilePath()}`));
  }
}
