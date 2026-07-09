/**
 * User-managed MCP server config (gap #10, scoped subset — now includes
 * remote HTTP servers).
 *
 * Persisted to ~/.actoviq/mcp.json. Each entry is either a stdio server
 * (command + optional args/env/cwd) or an HTTP server (url + optional headers).
 * The TUI's /mcp add writes here and reloads the client.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { resolveActoviqHome } from '../config/actoviqHome.js';

export interface PersistedMcpServer {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** For remote HTTP MCP servers (streamable_http). */
  url?: string;
  headers?: Record<string, string>;
}

export interface PersistedMcpConfig {
  servers: PersistedMcpServer[];
}

export function getMcpConfigPath(homeDir?: string): string {
  return path.join(resolveActoviqHome(homeDir), 'mcp.json');
}

export function readMcpServerConfig(homeDir?: string): PersistedMcpConfig {
  const file = getMcpConfigPath(homeDir);
  if (!existsSync(file)) return { servers: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    const servers = Array.isArray(parsed.servers)
      ? parsed.servers.filter(
          (s: unknown): s is PersistedMcpServer =>
            typeof s === 'object' && s !== null &&
            typeof (s as PersistedMcpServer).name === 'string' &&
            (typeof (s as PersistedMcpServer).command === 'string' || typeof (s as PersistedMcpServer).url === 'string'),
        )
      : [];
    return { servers };
  } catch {
    return { servers: [] };
  }
}

export function writeMcpServerConfig(config: PersistedMcpConfig, homeDir?: string): void {
  const file = getMcpConfigPath(homeDir);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(config, null, 2), 'utf-8');
}

export function addMcpServer(server: PersistedMcpServer, homeDir?: string): PersistedMcpConfig {
  const config = readMcpServerConfig(homeDir);
  const without = config.servers.filter(s => s.name !== server.name);
  without.push(server);
  const next = { servers: without };
  writeMcpServerConfig(next, homeDir);
  return next;
}

export function removeMcpServer(name: string, homeDir?: string): PersistedMcpConfig {
  const config = readMcpServerConfig(homeDir);
  const next = { servers: config.servers.filter(s => s.name !== name) };
  writeMcpServerConfig(next, homeDir);
  return next;
}
