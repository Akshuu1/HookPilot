import { io, type Socket } from 'socket.io-client';
import chalk from 'chalk';
import { loadConfig, DEFAULT_SERVER_URL } from '../config.js';

export interface ListenOptions {
  endpoint?: string;
  server?: string;
  key?: string;
  path?: string;
}

interface TunnelEventPayload {
  eventId: string;
  endpointId: string;
  endpointSlug: string;
  method: string;
  path?: string;
  headers: Record<string, string>;
  rawBody: string;
  timeoutMs?: number;
}

export async function listenCommand(portStr: string, options: ListenOptions): Promise<void> {
  const port = parseInt(portStr, 10);
  if (Number.isNaN(port) || port <= 0 || port > 65535) {
    console.error(chalk.red(`Error: Invalid port "${portStr}". Must be between 1 and 65535.`));
    process.exit(1);
  }

  const endpointSlug = options.endpoint?.trim();
  if (!endpointSlug) {
    console.error(chalk.red('Error: --endpoint <slug> is required.'));
    console.error(chalk.dim('Example: hookpilot listen 3000 --endpoint my-webhook-slug'));
    process.exit(1);
  }

  const config = loadConfig();
  const apiKey = options.key?.trim() || config.apiKey;

  if (!apiKey) {
    console.error(chalk.red('Error: API key required.'));
    console.error(
      chalk.dim('Run "hookpilot login --key <apiKey>" or pass "--key <apiKey>" to authenticate.'),
    );
    process.exit(1);
  }

  const serverUrl = (options.server?.trim() || config.serverUrl || DEFAULT_SERVER_URL).replace(
    /\/+$/,
    '',
  );
  const basePath = options.path || '';

  console.info(chalk.bold.cyan('\n  HookPilot Webhook Tunnel CLI'));
  console.info(chalk.dim('  ---------------------------------------------'));
  console.info(chalk.dim('  Server:     '), chalk.white(serverUrl));
  console.info(chalk.dim('  Endpoint:   '), chalk.yellow(endpointSlug));
  console.info(
    chalk.dim('  Forwarding: '),
    chalk.green(`http://localhost:${port}${basePath || '/'}`),
  );
  console.info(chalk.dim('  Connecting to HookPilot tunnel network...\n'));

  const socket: Socket = io(serverUrl, {
    auth: {
      apiKey,
    },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  });

  let heartbeatInterval: NodeJS.Timeout | null = null;

  socket.on('connect', () => {
    console.info(chalk.green('✓ Connected to HookPilot server!'));

    socket.emit(
      'tunnel:join',
      { endpointSlug },
      (ack?: { success: boolean; error?: string; endpointId?: string; slug?: string }) => {
        if (!ack || !ack.success) {
          const err = ack?.error || 'Unknown error joining tunnel';
          console.error(chalk.red(`✗ Failed to join tunnel: ${err}`));
          if (err === 'FORBIDDEN') {
            console.error(
              chalk.dim('  Your API key does not have access to this endpoint/workspace.'),
            );
          } else if (err === 'ENDPOINT_NOT_FOUND') {
            console.error(chalk.dim(`  Endpoint "${endpointSlug}" not found or is inactive.`));
          }
          return;
        }

        console.info(
          chalk.bold.green(
            `✓ Tunnel live! Forwarding inbound webhooks -> http://localhost:${port}${basePath || ''}\n`,
          ),
        );
        console.info(chalk.dim('Waiting for events... (Press Ctrl+C to stop)'));

        // Start heartbeat to keep Redis TTL fresh
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        heartbeatInterval = setInterval(() => {
          socket.emit('tunnel:heartbeat', { endpointSlug });
        }, 10000);
      },
    );
  });

  socket.on('connect_error', (err) => {
    console.error(chalk.red(`✗ Connection error: ${err.message}`));
  });

  socket.on('disconnect', (reason) => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    console.warn(chalk.yellow(`⚠ Disconnected from HookPilot server (${reason}). Reconnecting...`));
  });

  // Handle inbound webhook forwarded via tunnel
  socket.on('tunnel:event', async (event: TunnelEventPayload) => {
    const timestamp = new Date().toLocaleTimeString();
    const eventPath = event.path && event.path !== '/' ? event.path : basePath || '';
    const destinationUrl = `http://localhost:${port}${eventPath}`;

    const startTime = Date.now();
    let responseStatus = 502;
    const responseHeaders: Record<string, string> = {};
    let responseBodySnippet = '';
    let errorMessage: string | null = null;

    try {
      const forwardHeaders = { ...event.headers };
      delete forwardHeaders.host;
      delete forwardHeaders.connection;

      const res = await fetch(destinationUrl, {
        method: event.method,
        headers: forwardHeaders,
        body: event.rawBody,
      });

      const durationMs = Date.now() - startTime;
      responseStatus = res.status;

      res.headers.forEach((val, key) => {
        responseHeaders[key.toLowerCase()] = val;
      });

      try {
        const fullText = await res.text();
        responseBodySnippet = fullText.slice(0, 2048);
      } catch {
        responseBodySnippet = '';
      }

      // Format log output
      const statusColor =
        responseStatus >= 200 && responseStatus < 300
          ? chalk.green
          : responseStatus >= 400 && responseStatus < 500
            ? chalk.yellow
            : chalk.red;

      console.info(
        `${chalk.dim(`[${timestamp}]`)} ${chalk.bold.cyan(event.method)} ${chalk.white(eventPath || '/')} ` +
          `-> ${statusColor(`${responseStatus} ${res.statusText || ''}`)} ` +
          `${chalk.dim(`(${durationMs}ms)`)} ${chalk.dim(`[event: ${event.eventId}]`)}`,
      );

      // Reply with tunnel response
      socket.emit('tunnel:response', {
        eventId: event.eventId,
        responseStatus,
        responseHeaders,
        responseBodySnippet,
        durationMs,
        error: null,
      });
    } catch (err: unknown) {
      const durationMs = Date.now() - startTime;
      const errObj = err as Error;
      errorMessage = errObj.message || 'Failed to forward request to localhost';

      console.info(
        `${chalk.dim(`[${timestamp}]`)} ${chalk.bold.red(event.method)} ${chalk.white(eventPath || '/')} ` +
          `-> ${chalk.red('ERROR (Local server unreachable)')} ` +
          `${chalk.dim(`(${durationMs}ms)`)} ${chalk.dim(`[event: ${event.eventId}]`)}`,
      );
      console.error(chalk.dim(`  ${errorMessage}`));

      // Reply with error response
      socket.emit('tunnel:response', {
        eventId: event.eventId,
        responseStatus: 502,
        responseHeaders: {},
        responseBodySnippet: `Local forward failed: ${errorMessage}`,
        durationMs,
        error: errorMessage,
      });
    }
  });

  // Graceful shutdown
  const shutdown = () => {
    console.info(chalk.yellow('\nShutting down HookPilot tunnel...'));
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    socket.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
