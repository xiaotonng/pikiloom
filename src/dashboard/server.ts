import http from 'node:http';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { getRequestListener } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import path from 'node:path';
import fs from 'node:fs';
import { exec } from 'node:child_process';
import configRoutes from './routes/config.js';
import agentRoutes, { preloadAgentStatus } from './routes/agents.js';
import sessionRoutes from './routes/sessions.js';
import extensionRoutes from './routes/extensions.js';
import cliRoutes from './routes/cli.js';
import modelsRoutes from './routes/models.js';
import localModelsRoutes from './routes/local-models.js';
import accountsRoutes from './routes/accounts.js';
import { runtime } from './runtime.js';
import { registerProcessRuntime } from '../core/process-control.js';
import { VERSION } from '../core/version.js';
import type { Bot } from '../bot/bot.js';
import { mountPikichannel, type PikichannelHandle } from '../pikichannel/server.js';

export interface DashboardOptions {
  port?: number;
  open?: boolean;
  bot?: Bot;
}

export interface DashboardServer {
  port: number;
  url: string;
  close(): Promise<void>;
  attachBot(bot: Bot): void;
}

const DASHBOARD_PORT_RETRY_LIMIT = 10;

export async function startDashboard(opts: DashboardOptions = {}): Promise<DashboardServer> {
  const preferredPort = opts.port || 3939;
  if (opts.bot) runtime.attachBot(opts.bot);

  const app = new Hono();

  app.use('*', compress());

  app.route('/', configRoutes);
  app.route('/', agentRoutes);
  app.route('/', sessionRoutes);
  app.route('/', extensionRoutes);
  app.route('/', cliRoutes);
  app.route('/', modelsRoutes);
  app.route('/', localModelsRoutes);
  app.route('/', accountsRoutes);

  let pikichannel: PikichannelHandle | null = null;
  try {
    pikichannel = await mountPikichannel(app);
  } catch (err) {
    runtime.warn(`[pikichannel] mount failed: ${(err as Error)?.message || err}`);
  }

  const dashboardRoot = path.resolve(import.meta.dirname, '..', '..', 'dashboard', 'dist');

  app.use('/assets/*', serveStatic({
    root: dashboardRoot,
    onFound: (_path, c) => {
      c.header('Cache-Control', 'public, max-age=31536000, immutable');
    },
  }));

  app.use('/*', serveStatic({
    root: dashboardRoot,
    onFound: (p, c) => {
      if (p.endsWith('.html')) c.header('Cache-Control', 'no-cache');
    },
    onNotFound: () => {
    },
  }));

  app.get('*', async (c) => {
    if (c.req.path.startsWith('/api/')) {
      return c.json({ error: 'Not Found' }, 404);
    }
    const indexPath = path.join(dashboardRoot, 'index.html');
    try {
      const html = fs.readFileSync(indexPath, 'utf-8');
      c.header('Cache-Control', 'no-cache');
      return c.html(html);
    } catch {
      return c.text('Dashboard build not found. Run: npm run build:dashboard', 500);
    }
  });

  let nodeServer: http.Server | null = null;

  const RESTART_CLOSE_TIMEOUT_MS = 3000;

  const unregisterProcessRuntime = registerProcessRuntime({
    label: 'dashboard',
    prepareForRestart: () => new Promise<void>(resolve => {
      if (!nodeServer) { resolve(); return; }
      pikichannel?.stop();
      const timer = setTimeout(resolve, RESTART_CLOSE_TIMEOUT_MS);
      nodeServer.close(() => { clearTimeout(timer); resolve(); });
    }),
  });

  return new Promise<DashboardServer>((resolve, reject) => {
    let nextPort = preferredPort;
    let settled = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    function tryListen(port: number) {
      try {
        const requestListener = getRequestListener(app.fetch);
        const server = http.createServer(requestListener);

        server.on('upgrade', (req, socket, head) => {
          if (pikichannel?.handleUpgrade(req, socket, head)) return;
          socket.destroy();
        });

        server.listen(port, () => {
          if (settled) return;
          settled = true;
          nodeServer = server;
          const addr = server.address();
          const actualPort = typeof addr === 'object' && addr ? addr.port : port;
          const dashUrl = `http://localhost:${actualPort}`;
          const ts = new Date().toTimeString().slice(0, 8);
          process.stdout.write(`[pikiloom ${ts}] dashboard: ${dashUrl}\n`);

          preloadAgentStatus();

          if (opts.open !== false) {
            const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
            exec(`${cmd} ${dashUrl}`);
          }

          resolve({
            port: actualPort,
            url: dashUrl,
            attachBot(bot: Bot) {
              runtime.attachBot(bot);
            },
            close() {
              return new Promise<void>(resolveClose => {
                unregisterProcessRuntime();
                if (!server) {
                  resolveClose();
                  return;
                }
                server.close(() => resolveClose());
              });
            },
          });
        });

        server.on('error', (err: NodeJS.ErrnoException) => {
          if (settled) return;
          if (err.code === 'EADDRINUSE') {
            if (nextPort >= preferredPort + DASHBOARD_PORT_RETRY_LIMIT) {
              fail(new Error(`Dashboard ports ${preferredPort}-${preferredPort + DASHBOARD_PORT_RETRY_LIMIT} are already in use.`));
              return;
            }
            nextPort += 1;
            tryListen(nextPort);
            return;
          }
          fail(err);
        });

        server.on('close', () => {
          unregisterProcessRuntime();
        });
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
      }
    }

    tryListen(preferredPort);
  });
}
