import { execFile as execFileCallback } from 'node:child_process';

export type GitHubCredentialSource = 'gh-cli' | 'alternate-token';
export type GitHubStatusState = 'authenticated' | 'not_authenticated' | 'missing' | 'error';
export type GitHubWriteMethod = 'POST' | 'PATCH' | 'PUT';
export type GitHubApiField = string | number | boolean | null;

export interface GitHubExecFileOptions {
  cwd?: string;
  env: NodeJS.ProcessEnv;
  windowsHide: true;
  encoding: 'utf8';
  maxBuffer: number;
  timeout: number;
}

export type GitHubExecFile = (
  executable: string,
  args: string[],
  options: GitHubExecFileOptions,
) => Promise<{ stdout: string; stderr: string }>;

export interface GitHubPluginOptions {
  executable?: string;
  host?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  token?: string;
  timeoutMs?: number;
  execFile?: GitHubExecFile;
}

export interface GitHubStatus {
  ok: boolean;
  state: GitHubStatusState;
  host: string;
  account?: string;
  credentialSource: GitHubCredentialSource;
  message: string;
}

export interface GitHubWriteApiRequest {
  endpoint: string;
  method: GitHubWriteMethod;
  fields?: Record<string, GitHubApiField>;
}

export interface GitHubPluginAction<TInput, TOutput> {
  readonly name: string;
  readonly isDestructive: boolean;
  execute(input: TInput): Promise<TOutput>;
}

export interface GitHubPlugin {
  readonly id: 'github';
  readonly host: string;
  status(): Promise<GitHubStatus>;
  readApi(
    endpoint: string,
    query?: Record<string, GitHubApiField>,
  ): Promise<unknown>;
  writeApi(request: GitHubWriteApiRequest): Promise<unknown>;
  deleteApi(endpoint: string): Promise<unknown>;
  readonly actions: {
    status: GitHubPluginAction<void, GitHubStatus>;
    readApi: GitHubPluginAction<
      { endpoint: string; query?: Record<string, GitHubApiField> },
      unknown
    >;
    writeApi: GitHubPluginAction<GitHubWriteApiRequest, unknown>;
    deleteApi: GitHubPluginAction<{ endpoint: string }, unknown>;
  };
}

type InvocationFailureKind = 'missing' | 'failed';

class GitHubCliInvocationError extends Error {
  constructor(
    readonly kind: InvocationFailureKind,
    operation: string,
  ) {
    super(`GitHub CLI command failed (${operation}).`);
    this.name = 'GitHubCliInvocationError';
  }
}

export function createGitHubPlugin(
  options: GitHubPluginOptions = {},
): GitHubPlugin {
  const executable = options.executable?.trim() || 'gh';
  const host = options.host?.trim() || 'github.com';
  const execFile = options.execFile ?? defaultExecFile;
  const alternateToken = options.token?.trim();
  const credentialSource: GitHubCredentialSource = alternateToken
    ? 'alternate-token'
    : 'gh-cli';
  const baseEnv = options.env ? { ...options.env } : { ...process.env };

  async function invoke(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const env = { ...baseEnv };
    if (alternateToken) {
      env.GH_TOKEN = alternateToken;
    }

    try {
      return await execFile(executable, args, {
        cwd: options.cwd,
        env,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: Math.max(1_000, Math.min(120_000, options.timeoutMs ?? 30_000)),
      });
    } catch (error) {
      const kind = isMissingExecutable(error) ? 'missing' : 'failed';
      throw new GitHubCliInvocationError(kind, describeOperation(args));
    }
  }

  async function status(): Promise<GitHubStatus> {
    try {
      await invoke([
        'auth',
        'status',
        '--active',
        '--hostname',
        host,
      ]);
    } catch (error) {
      if (error instanceof GitHubCliInvocationError && error.kind === 'missing') {
        return {
          ok: false,
          state: 'missing',
          host,
          credentialSource,
          message: 'GitHub CLI is not installed or is not available on PATH.',
        };
      }
      return {
        ok: false,
        state: 'not_authenticated',
        host,
        credentialSource,
        message: 'GitHub CLI does not have an active authenticated account.',
      };
    }

    let account: string | undefined;
    try {
      const result = await invoke([
        'api',
        'user',
        '--hostname',
        host,
        '--method',
        'GET',
        '--jq',
        '.login',
      ]);
      account = firstNonEmptyLine(result.stdout);
    } catch {
      return {
        ok: false,
        state: 'error',
        host,
        credentialSource,
        message: 'GitHub CLI authentication exists, but the GitHub API check failed.',
      };
    }

    return {
      ok: true,
      state: 'authenticated',
      host,
      ...(account ? { account } : {}),
      credentialSource,
      message: account
        ? `GitHub CLI is authenticated as ${account}.`
        : 'GitHub CLI has an active authenticated account.',
    };
  }

  async function readApi(
    endpoint: string,
    query: Record<string, GitHubApiField> = {},
  ): Promise<unknown> {
    const args = [
      'api',
      normalizeEndpoint(endpoint),
      '--hostname',
      host,
      '--method',
      'GET',
      ...serializeFields(query),
    ];
    const result = await invoke(args);
    return parseOutput(result.stdout);
  }

  async function writeApi(request: GitHubWriteApiRequest): Promise<unknown> {
    const method = String(request.method).toUpperCase();
    if (!isWriteMethod(method)) {
      throw new TypeError(`Unsupported GitHub write method: ${method}`);
    }
    const args = [
      'api',
      normalizeEndpoint(request.endpoint),
      '--hostname',
      host,
      '--method',
      method,
      ...serializeFields(request.fields ?? {}),
    ];
    const result = await invoke(args);
    return parseOutput(result.stdout);
  }

  async function deleteApi(endpoint: string): Promise<unknown> {
    const result = await invoke([
      'api',
      normalizeEndpoint(endpoint),
      '--hostname',
      host,
      '--method',
      'DELETE',
    ]);
    return parseOutput(result.stdout);
  }

  return {
    id: 'github',
    host,
    status,
    readApi,
    writeApi,
    deleteApi,
    actions: {
      status: {
        name: 'github_status',
        isDestructive: false,
        execute: async () => status(),
      },
      readApi: {
        name: 'github_read_api',
        isDestructive: false,
        execute: async ({ endpoint, query }) => readApi(endpoint, query),
      },
      writeApi: {
        name: 'github_write_api',
        isDestructive: true,
        execute: writeApi,
      },
      deleteApi: {
        name: 'github_delete_api',
        isDestructive: true,
        execute: async ({ endpoint }) => deleteApi(endpoint),
      },
    },
  };
}

async function defaultExecFile(
  executable: string,
  args: string[],
  options: GitHubExecFileOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFileCallback(
      executable,
      args,
      options,
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}

function serializeFields(fields: Record<string, GitHubApiField>): string[] {
  return Object.keys(fields)
    .sort((left, right) => left.localeCompare(right))
    .flatMap((name) => {
      const normalizedName = normalizeFieldName(name);
      const value = fields[name];
      return [
        typeof value === 'string' ? '--raw-field' : '--field',
        `${normalizedName}=${String(value)}`,
      ];
    });
}

function normalizeEndpoint(endpoint: string): string {
  const value = endpoint.trim();
  if (!value) {
    throw new TypeError('GitHub API endpoint is required.');
  }
  if (value.startsWith('-')) {
    throw new TypeError('GitHub API endpoint must not begin with a dash.');
  }
  if (/[\r\n\0]/.test(value)) {
    throw new TypeError('GitHub API endpoint contains invalid control characters.');
  }
  return value;
}

function normalizeFieldName(name: string): string {
  const value = name.trim();
  if (!value) {
    throw new TypeError('GitHub API field name is required.');
  }
  if (value.startsWith('-')) {
    throw new TypeError('GitHub API field name must not begin with a dash.');
  }
  if (/[\r\n\0=]/.test(value)) {
    throw new TypeError('GitHub API field name contains invalid characters.');
  }
  return value;
}

function parseOutput(stdout: string): unknown {
  const value = stdout.trim();
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function firstNonEmptyLine(value: string): string | undefined {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
}

function isWriteMethod(value: string): value is GitHubWriteMethod {
  return value === 'POST' || value === 'PATCH' || value === 'PUT';
}

function isMissingExecutable(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'ENOENT';
}

function describeOperation(args: string[]): string {
  if (args[0] === 'auth') {
    return 'auth status';
  }
  if (args[0] === 'api') {
    return 'api';
  }
  return 'command';
}
