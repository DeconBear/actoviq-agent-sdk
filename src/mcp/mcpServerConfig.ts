/**
 * User-managed MCP server config (gap #10, scoped subset).
 *
 * A persisted list of stdio MCP servers the user added from the TUI
 * (~/.actoviq/mcp.json), loaded by the SDK client at startup. The TUI's
 * /mcp add and /mcp remove write here and reload the client. Format mirrors
 * the StdioMcpServerDefinition but stored as plain JSON (no class instances).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface PersistedMcpServer {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface PersistedMcpConfig {
  servers: PersistedMcpServer[];
}

export function getMcpConfigPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.actoviq', 'mcp.json');
}

export function readMcpServerConfig(homeDir: string = os.homedir()): PersistedMcpConfig {
  const file = getMcpConfigPath(homeDir);
  if (!existsSync(file)) return { servers: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    const servers = Array.isArray(parsed.servers)
      ? parsed.servers.filter(
          (s: unknown): s is PersistedMcpServer =>
            typeof s === 'object' && s !== null &&
            typeof (s as PersistedMcpServer).name === 'string' &&
            typeof (s as PersistedMcpServer).command === 'string',
        )
      : [];
    return { servers };
  } catch {
    return { servers: [] };
  }
}

export function writeMcpServerConfig(config: PersistedMcpConfig, homeDir: string = os.homedir()): void {
  const file = getMcpConfigPath(homeDir);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(config, null, 2), 'utf-8');
}

export function addMcpServer(server: PersistedMcpServer, homeDir: string = os.homedir()): PersistedMcpConfig {
  const config = readMcpServerConfig(homeDir);
  const without = config.servers.filter(s => s.name !== server.name);
  without.push(server);
  const next = { servers: without };
  writeMcpServerConfig(next, homeDir);
  return next;
}

export function removeMcpServer(name: string, homeDir: string = os.homedir()): PersistedMcpConfig {
  const config = readMcpServerConfig(homeDir);
  const next = { servers: config.servers.filter(s => s.name !== name) };
  writeMcpServerConfig(next, homeDir);
  return next;
}
