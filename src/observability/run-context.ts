/**
 * Run context: the per-run bundle of identity, logging, evidence and redaction.
 *
 * Both the discovery loop and the replay engine take one of these. Having a
 * single object means every write to disk goes through the same redactor, and
 * every run -- LLM-driven or deterministic -- produces the same evidence layout.
 * A reviewer comparing a discovery run to the replay that followed it should
 * not have to learn two formats.
 *
 * Layout on disk:
 *
 *   <root>/<runId>/
 *     meta.json          what this run was, and how it ended
 *     run.jsonl          the structured event log, one JSON object per line
 *     artifact.json      (discovery only) the capability that was produced
 *     result.json        (replay only) the structured result returned
 *     screenshots/*.png
 *     snapshots/*.html   DOM captures
 *     snapshots/*.json   normalised accessibility-tree captures
 */

import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { Redactor } from '../policy/redact.ts';
import type { PolicyConfig } from '../policy/config.ts';
import type { EvidenceRefs } from '../schema/result.ts';
import type { Surface } from '../surface/types.ts';

export type RunKind = 'discovery' | 'replay';

export interface LogRecord {
  ts: string;
  seq: number;
  event: string;
  [key: string]: unknown;
}

export class RunContext {
  readonly runId: string;
  readonly kind: RunKind;
  readonly dir: string;
  readonly redactor: Redactor;
  readonly startedAt: string;

  private seq = 0;
  private logPath: string;
  private verbose: boolean;

  constructor(opts: {
    runId: string;
    kind: RunKind;
    root: string;
    policy: PolicyConfig;
    verbose?: boolean;
  }) {
    this.runId = opts.runId;
    this.kind = opts.kind;
    this.dir = join(opts.root, opts.runId);
    this.redactor = new Redactor(opts.policy);
    this.startedAt = new Date().toISOString();
    this.verbose = opts.verbose ?? true;

    mkdirSync(join(this.dir, 'screenshots'), { recursive: true });
    mkdirSync(join(this.dir, 'snapshots'), { recursive: true });
    this.logPath = join(this.dir, 'run.jsonl');
  }

  /* -------------------------------------------------------------- logging */

  /**
   * Append one structured event. Every field is deep-redacted on the way out,
   * so a caller cannot leak a secret by logging a field they forgot about.
   */
  log(event: string, data: Record<string, unknown> = {}): void {
    this.seq += 1;
    const record: LogRecord = {
      ts: new Date().toISOString(),
      seq: this.seq,
      event,
      ...(this.redactor.value(data) as Record<string, unknown>),
    };
    appendFileSync(this.logPath, `${JSON.stringify(record)}\n`, 'utf8');
    if (this.verbose) this.echo(record);
  }

  private echo(r: LogRecord): void {
    const detail = Object.entries(r)
      .filter(([k]) => !['ts', 'seq', 'event'].includes(k))
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' ');
    const line = `  [${String(r.seq).padStart(3, '0')}] ${r.event}${detail ? ` ${detail}` : ''}`;
    console.log(line.length > 300 ? `${line.slice(0, 300)}...` : line);
  }

  /* ------------------------------------------------------------- evidence */

  writeJson(name: string, data: unknown): string {
    const path = join(this.dir, name);
    writeFileSync(path, `${JSON.stringify(this.redactor.value(data), null, 2)}\n`, 'utf8');
    return path;
  }

  /**
   * Capture the richer failure signal the brief asks for in section 3.5:
   * a screenshot, a DOM snapshot, and the normalised accessibility tree we
   * actually made decisions from.
   *
   * The third one is the most useful of the three in practice. A screenshot
   * tells you what a human would have seen; the node list tells you what the
   * SYSTEM saw, which is where the discrepancy that caused the failure lives.
   */
  async captureEvidence(surface: Surface, label: string): Promise<EvidenceRefs> {
    const safe = label.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60);
    const refs: EvidenceRefs = { runLogPath: relative(this.dir, this.logPath) };

    try {
      const png = await surface.screenshot();
      if (png) {
        const p = join(this.dir, 'screenshots', `${safe}.png`);
        writeFileSync(p, png);
        refs.screenshotPath = `screenshots/${safe}.png`;
      }
    } catch {
      /* evidence capture must never mask the original failure */
    }

    try {
      const dom = await surface.domSnapshot();
      if (dom) {
        const p = join(this.dir, 'snapshots', `${safe}.html`);
        writeFileSync(p, this.redactor.text(dom), 'utf8');
        refs.domSnapshotPath = `snapshots/${safe}.html`;
      }
    } catch {
      /* ignore */
    }

    try {
      const obs = await surface.observe();
      const p = join(this.dir, 'snapshots', `${safe}.a11y.json`);
      writeFileSync(p, `${JSON.stringify(this.redactor.value(obs), null, 2)}\n`, 'utf8');
      refs.a11ySnapshotPath = `snapshots/${safe}.a11y.json`;
    } catch {
      /* ignore */
    }

    return refs;
  }

  finish(meta: Record<string, unknown>): void {
    this.writeJson('meta.json', {
      runId: this.runId,
      kind: this.kind,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      redactedValueCount: this.redactor.registeredCount,
      ...meta,
    });
  }
}

function relative(_dir: string, path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

/** Run ids sort chronologically and carry their kind, so `ls` is useful. */
export function newRunId(kind: RunKind): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const rand = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${kind}-${rand}`;
}
