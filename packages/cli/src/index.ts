#!/usr/bin/env node

import { Command } from 'commander';
import { loginCommand } from './commands/login.js';
import { listenCommand } from './commands/listen.js';

const program = new Command();

program
  .name('hookpilot')
  .description('HookPilot CLI - Local webhook tunneling and development agent')
  .version('0.1.0');

program
  .command('login')
  .description('Authenticate the CLI with a HookPilot API key')
  .requiredOption('-k, --key <apiKey>', 'HookPilot API key (starts with hp_)')
  .option('-s, --server <serverUrl>', 'HookPilot server URL (default: http://localhost:4000)')
  .action(async (options: { key: string; server?: string }) => {
    await loginCommand(options);
  });

program
  .command('listen')
  .description('Tunnel inbound webhooks from HookPilot directly to a local development server')
  .argument('<port>', 'Local port to forward webhooks to (e.g. 3000)')
  .requiredOption('-e, --endpoint <slug>', 'Endpoint slug to listen to')
  .option('-s, --server <serverUrl>', 'HookPilot server URL (default: http://localhost:4000)')
  .option('-k, --key <apiKey>', 'API key override')
  .option('-p, --path <path>', 'Optional destination path (e.g. /webhook)')
  .action(
    async (
      port: string,
      options: { endpoint: string; server?: string; key?: string; path?: string },
    ) => {
      await listenCommand(port, options);
    },
  );

program.parse(process.argv);
