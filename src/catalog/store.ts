/**
 * Artifact storage.
 *
 * Plain JSON files in `capabilities/`, one per name@version. That is not a
 * placeholder for "a real database" -- it is the right choice here, and I would
 * defend it beyond the toy scale:
 *
 *   - Capability artifacts are REVIEWED ARTEFACTS. They should live in version
 *     control, diff legibly in a pull request, and carry the same approval
 *     trail as code. That is exactly what a bank's change-control process
 *     expects of something that can open accounts, and it is a property a
 *     database row does not have.
 *   - Writes are rare (one per recording) and reads are trivial. There is no
 *     access pattern here a database would serve better.
 *   - Versions are immutable files, so "which version ran in production on
 *     Tuesday" is answerable from git rather than from an audit table someone
 *     has to remember to write to.
 *
 * The one thing that genuinely is mutable is replay statistics, which is why
 * `updateStability` exists and why it is the only mutation on a published
 * version.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  CapabilityArtifactSchema,
  type CapabilityArtifact,
  type Stability,
} from '../schema/artifact.ts';
import type { ReplayResult } from '../schema/result.ts';

export class CapabilityStore {
  private root: string;

  constructor(root = 'capabilities') {
    this.root = root;
    mkdirSync(this.root, { recursive: true });
  }

  private fileFor(name: string, version: string): string {
    return join(this.root, `${name}@${version}.json`);
  }

  list(): CapabilityArtifact[] {
    if (!existsSync(this.root)) return [];
    const out: CapabilityArtifact[] = [];
    for (const file of readdirSync(this.root)) {
      if (!file.endsWith('.json')) continue;
      try {
        out.push(CapabilityArtifactSchema.parse(JSON.parse(readFileSync(join(this.root, file), 'utf8'))));
      } catch (err) {
        // A malformed artifact must not take down the whole catalogue, but it
        // must be loud: a capability that silently vanishes from the listing is
        // worse than one that errors.
        console.error(`[catalog] skipping ${file}: ${(err as Error).message}`);
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name) || compareVersions(b.version, a.version));
  }

  /** Resolve `name` or `name@version`. Bare names get the newest version. */
  get(ref: string): CapabilityArtifact | undefined {
    const at = ref.lastIndexOf('@');
    if (at > 0) {
      const name = ref.slice(0, at);
      const version = ref.slice(at + 1);
      const path = this.fileFor(name, version);
      if (!existsSync(path)) return undefined;
      return CapabilityArtifactSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    }
    const matches = this.list().filter((a) => a.name === ref);
    return matches[0];
  }

  save(artifact: CapabilityArtifact): string {
    const path = this.fileFor(artifact.name, artifact.version);
    writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    return path;
  }

  /**
   * Fold a replay result into the artifact's stability record.
   *
   * This is what the approval decision is made on. Deliberately counts the four
   * result kinds separately: a capability that returns MEMBER_NOT_FOUND fifty
   * times is working perfectly, and lumping those in with failures would make
   * the number meaningless.
   */
  recordReplay(artifact: CapabilityArtifact, result: ReplayResult): CapabilityArtifact {
    const s: Stability = { ...artifact.stability };
    s.replays += 1;
    s.lastReplayAt = new Date().toISOString();

    switch (result.status) {
      case 'success':
        s.successes += 1;
        break;
      case 'outcome':
        s.businessOutcomes += 1;
        break;
      case 'escalated':
        s.escalations += 1;
        break;
      case 'failed':
        s.failures += 1;
        break;
    }

    const drifting = new Set(s.driftingSteps);
    for (const w of result.warnings) {
      if (w.code === 'LOCATOR_DRIFT' && w.stepId) drifting.add(w.stepId);
    }
    s.driftingSteps = [...drifting].sort();

    const updated: CapabilityArtifact = { ...artifact, stability: s };
    this.save(updated);
    return updated;
  }

  setStatus(artifact: CapabilityArtifact, status: CapabilityArtifact['status']): CapabilityArtifact {
    const updated: CapabilityArtifact = { ...artifact, status };
    this.save(updated);
    return updated;
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Is this capability sound enough to run unattended?
 *
 * Kept as an explicit, readable predicate rather than a score. An approver
 * needs to be able to say WHY something was or was not eligible, and
 * "0.87 confidence" does not survive that question.
 */
export function approvalReadiness(a: CapabilityArtifact): {
  ready: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  const s = a.stability;

  if (s.replays === 0) reasons.push('never replayed');
  const conclusive = s.successes + s.businessOutcomes;
  if (s.replays > 0 && conclusive === 0) reasons.push('no replay has yet reached a conclusive result');
  if (s.failures > 0) {
    reasons.push(`${s.failures} of ${s.replays} replays failed outright`);
  }
  if (s.driftingSteps.length > 0) {
    reasons.push(`locator drift observed on step(s): ${s.driftingSteps.join(', ')}`);
  }
  const risky = a.steps.filter((st) => st.risk === 'irreversible');
  if (risky.length > 0) {
    reasons.push(
      `contains ${risky.length} irreversible step(s) (${risky.map((r) => r.id).join(', ')}) — ` +
        `these will still escalate to a human on every run`,
    );
  }

  return { ready: s.replays > 0 && s.failures === 0 && conclusive > 0, reasons };
}
