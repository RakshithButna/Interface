/**
 * Shared CLI plumbing: argument parsing, environment, policy loading.
 */

import { readFileSync, existsSync } from 'node:fs';
import { config as loadDotenv } from 'dotenv';
import { PolicyConfigSchema, DEFAULT_POLICY, type PolicyConfig } from '../policy/config.ts';

export interface Args {
  command: string;
  positional: string[];
  /** Last occurrence wins. */
  flags: Record<string, string | boolean>;
  /** Every occurrence, for flags that are legitimately repeatable. */
  lists: Record<string, string[]>;
  /** Repeated `--param k=v` collected into a map. */
  params: Record<string, string>;
}

export function parseArgs(argv: string[]): Args {
  const [command = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const lists: Record<string, string[]> = {};
  const params: Record<string, string> = {};

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    const key = (eq === -1 ? token.slice(2) : token.slice(2, eq)).trim();
    let value: string | boolean;
    if (eq !== -1) {
      value = token.slice(eq + 1);
    } else {
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        value = next;
        i += 1;
      } else {
        value = true;
      }
    }

    if (key === 'param') {
      const raw = String(value);
      const sep = raw.indexOf('=');
      if (sep === -1) throw new Error(`--param expects name=value, got '${raw}'`);
      params[raw.slice(0, sep)] = raw.slice(sep + 1);
      continue;
    }
    flags[key] = value;
    if (typeof value === 'string') {
      (lists[key] ??= []).push(value);
    }
  }

  return { command, positional, flags, lists, params };
}

export function flagString(args: Args, name: string, fallback: string): string {
  const v = args.flags[name];
  return typeof v === 'string' ? v : fallback;
}

export function flagBool(args: Args, name: string, fallback = false): boolean {
  const v = args.flags[name];
  if (v === undefined) return fallback;
  if (typeof v === 'boolean') return v;
  return !/^(false|0|no)$/i.test(v);
}

export function flagNumber(args: Args, name: string, fallback: number): number {
  const v = args.flags[name];
  if (typeof v !== 'string') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function loadEnv(): void {
  loadDotenv({ quiet: true });
}

export function loadPolicy(path = 'config/policy.json'): PolicyConfig {
  if (!existsSync(path)) return DEFAULT_POLICY;
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return PolicyConfigSchema.parse(raw);
}

/** Prompt on stdin. Used for inline approval of risky steps during discovery. */
export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    // Non-interactive (CI, piped input): refuse rather than assume yes. A
    // system that silently approves irreversible banking actions because
    // nobody was watching is the failure mode this whole layer exists to stop.
    console.log(`${question}\n  (non-interactive session: declining automatically)`);
    return false;
  }
  process.stdout.write(`${question} [y/N] `);
  return new Promise<boolean>((resolve) => {
    const onData = (chunk: Buffer) => {
      process.stdin.pause();
      process.stdin.off('data', onData);
      resolve(/^y(es)?$/i.test(chunk.toString().trim()));
    };
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

/** Arm a fault in the demo app. Test affordance for the error-path demos. */
export async function armInjection(baseOrigin: string, mode: string): Promise<void> {
  const res = await fetch(`${baseOrigin}/_control/inject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) throw new Error(`Could not arm injection '${mode}': ${res.status}`);
}

export async function assertAppReachable(origin: string): Promise<void> {
  try {
    const res = await fetch(`${origin}/_control/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(String(res.status));
  } catch {
    throw new Error(
      `The target application is not reachable at ${origin}.\n` +
        `Start it in another terminal with:  npm run app`,
    );
  }
}
