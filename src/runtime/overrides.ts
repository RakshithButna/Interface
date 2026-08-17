/**
 * Per-tenant specialization, applied at resolve time.
 *
 * The problem this solves is the one in brief section 3.7: hundreds of tenants
 * run ~20 apps each and many share the same underlying vendor product. If a
 * capability had to be re-recorded per tenant, the system would not be
 * operable at that scale.
 *
 * The observation that makes one-recording-many-tenants tractable is that the
 * differences between two installs of the same product are overwhelmingly
 * SUPERFICIAL and of a small number of shapes:
 *
 *   they renamed a field   ("Member ID" -> "Membership Number")
 *   they changed a route   ("member-search" -> "members/find")
 *   they added a screen    (a compliance acknowledgement after login)
 *
 * The first two are pure text substitution and are handled here. The third is
 * handled by the recovery system, since an extra screen is operationally the
 * same thing as an unexpected interstitial. Anything genuinely structural
 * falls through to explicit step patches in the override, and if a tenant
 * needs many of those, that is the signal that it deserves its own recording.
 *
 * Applying aliases at RESOLVE time rather than rewriting the artifact matters:
 * the artifact on disk stays the canonical base recording, so a fix to the
 * base flow propagates to every tenant automatically instead of needing to be
 * applied N times.
 */

import type { TenantOverride, Step, CapabilityArtifact, RecoveryRule } from '../schema/artifact.ts';
import type { Strategy, Scope, TargetDescriptor } from '../schema/targeting.ts';

/** Translate a base-recording label into this tenant's wording. */
export function aliasLabel(text: string, ov: TenantOverride | undefined): string {
  if (!ov) return text;
  const direct = ov.labelAliases[text];
  if (direct !== undefined) return direct;
  // Case-insensitive fallback, because label casing drifts between installs
  // far more often than the words themselves do.
  const lower = text.toLowerCase();
  for (const [from, to] of Object.entries(ov.labelAliases)) {
    if (from.toLowerCase() === lower) return to;
  }
  return text;
}

/** Rewrite recorded route segments for this tenant. */
export function aliasUrl(url: string, ov: TenantOverride | undefined, baseUrl?: string): string {
  let out = url;
  if (!ov) return out;

  if (ov.baseUrl && baseUrl && out.startsWith(baseUrl)) {
    out = ov.baseUrl + out.slice(baseUrl.length);
  }

  const entries = Object.entries(ov.routeAliases).sort((a, b) => b[0].length - a[0].length);
  if (entries.length === 0) return out;

  /**
   * Single pass, longest alias first.
   *
   * Applying aliases sequentially is wrong and the failure is subtle: with
   * {"member-search": "members/find", "member": "members/detail"}, the first
   * rule produces "/members/find" and the second then matches the "member"
   * INSIDE that result, yielding "/members/details/find". Every substitution
   * must see only original text, so we match all aliases in one scan and never
   * re-examine what we just wrote.
   */
  const pattern = new RegExp(entries.map(([from]) => escapeRegex(from)).join('|'), 'g');
  return out.replace(pattern, (matched) => ov.routeAliases[matched] ?? matched);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Apply label aliases to every human-text field a strategy references. */
export function aliasStrategy(s: Strategy, ov: TenantOverride | undefined): Strategy {
  if (!ov) return s;
  switch (s.kind) {
    case 'roleName':
      return { ...s, name: aliasLabel(s.name, ov) };
    case 'label':
      return { ...s, label: aliasLabel(s.label, ov) };
    case 'text':
      return { ...s, text: aliasLabel(s.text, ov) };
    case 'columnCell':
      return { ...s, column: aliasLabel(s.column, ov) };
    // testId, formField and structural reference machine identifiers, which
    // are the SAME across installs of one product. Aliasing them would be
    // actively wrong.
    default:
      return s;
  }
}

export function aliasScope(scope: Scope | undefined, ov: TenantOverride | undefined): Scope | undefined {
  if (!scope || !ov) return scope;
  if (scope.kind === 'tableRow') return { ...scope, matchColumn: aliasLabel(scope.matchColumn, ov) };
  return { ...scope, nearHeading: aliasLabel(scope.nearHeading, ov) };
}

export function aliasTarget(t: TargetDescriptor, ov: TenantOverride | undefined): TargetDescriptor {
  if (!ov) return t;
  const out: TargetDescriptor = {
    ...t,
    strategies: t.strategies.map((s) => aliasStrategy(s, ov)),
  };
  const scope = aliasScope(t.scope, ov);
  if (scope) out.scope = scope;
  return out;
}

/**
 * Produce the effective step list for a tenant: base steps minus disabled
 * ones, with the tenant's extra steps spliced in at their anchor points.
 */
export function effectiveSteps(artifact: CapabilityArtifact, ov: TenantOverride | undefined): Step[] {
  if (!ov) return artifact.steps;

  const disabled = new Set(ov.disableSteps);
  const base = artifact.steps.filter((s) => !disabled.has(s.id));

  if (ov.insertSteps.length === 0) return base;

  const out: Step[] = [];
  const atEnd = ov.insertSteps.filter((i) => i.before === '$end').map((i) => i.step);
  for (const step of base) {
    for (const ins of ov.insertSteps) {
      if (ins.before === step.id) out.push(ins.step);
    }
    out.push(step);
  }
  out.push(...atEnd);
  return out;
}

export function effectiveRecoveries(artifact: CapabilityArtifact, ov: TenantOverride | undefined): RecoveryRule[] {
  return ov ? [...artifact.recoveries, ...ov.extraRecoveries] : artifact.recoveries;
}
