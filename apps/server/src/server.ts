/** Runs the app on Node's HTTP server. */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { ErrorCodes, ScopeError } from '@scope-ai/core';
import { createApp, type ScopeApp } from './app.ts';
import type { AppOptions } from './types.ts';

export interface StartServerOptions extends AppOptions {
  host: string;
  port: number;
}

export interface RunningServer {
  url: string;
  host: string;
  port: number;
  scope: ScopeApp;
  /** Stops accepting connections and closes open ones. */
  close(): Promise<void>;
}

/** True for addresses only reachable from this machine. */
export function isLoopbackHost(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(?:\.\d{1,3}){3}$/.test(h);
}

function urlFor(host: string, port: number): string {
  const display = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  return `http://${display.includes(':') ? `[${display}]` : display}:${port}`;
}

export function startServer(options: StartServerOptions): Promise<RunningServer> {
  const scope = createApp(options);
  return new Promise((resolve, reject) => {
    const server = serve(
      { fetch: scope.app.fetch, port: options.port, hostname: options.host },
      (info: AddressInfo) => {
        server.off('error', onError);
        resolve({
          url: urlFor(options.host, info.port),
          host: options.host,
          port: info.port,
          scope,
          close: () =>
            new Promise<void>((done) => {
              (server as Server).closeAllConnections?.();
              server.close(() => done());
            }),
        });
      },
    );
    const onError = (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        reject(
          new ScopeError(ErrorCodes.usage, `Port ${options.port} is already in use`, {
            hint: 'Another process (perhaps another `scope ui`) is listening. Stop it, or choose a port with --port.',
          }),
        );
      } else if (error.code === 'EACCES') {
        reject(
          new ScopeError(ErrorCodes.usage, `Not allowed to listen on port ${options.port}`, {
            hint: 'Ports below 1024 need elevated privileges. Choose a higher port with --port.',
          }),
        );
      } else if (error.code === 'EADDRNOTAVAIL' || error.code === 'ENOTFOUND') {
        reject(
          new ScopeError(ErrorCodes.usage, `Cannot listen on host "${options.host}"`, {
            hint: 'Use an address of this machine, e.g. 127.0.0.1 or 0.0.0.0.',
          }),
        );
      } else reject(error);
    };
    server.once('error', onError);
  });
}
