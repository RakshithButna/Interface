/**
 * The guardrail chokepoint.
 *
 * Every action -- whether the LLM proposed it during discovery or the replay
 * engine read it out of an artifact -- passes through `Guard.check()` before it
 * reaches a surface. One chokepoint, two callers. That is deliberate: a policy
 * that only applies to the model is not a policy, because the artifact the
 * model produced is what actually runs in production.
 *
 * Three things are enforced here:
 *
 *   1. Allowlist. Origin and path, checked on navigation, plus the set of
 *      action types the agent may use at all.
 *   2. Risk disposition. Per risk class, per mode (attended vs unattended).
 *   3. Post-navigation origin re-check, because an allowed URL can redirect
 *      somewhere disallowed, and that is exactly the case worth catching.
 */

import type { PolicyConfig, ActionType, RiskDisposition } from './config.ts';
import type { Risk } from '../schema/artifact.ts';

export type GuardMode = 'attended' | 'unattended';

export type GuardDecision =
  | { allow: true; escalate: false }
  /** Permitted, but a human must approve before it happens. */
  | { allow: true; escalate: true; reason: string }
  | { allow: false; escalate: false; reason: string; code: 'ALLOWLIST' | 'ACTION_TYPE' | 'RISK_BLOCKED' };

export interface CheckActionInput {
  actionType: ActionType;
  risk: Risk;
  /** Present for navigations, and for clicks whose target is a link. */
  url?: string | undefined;
}

/** Glob with `*` inside a path segment and `**` across segments. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = escaped
    .split('**')
    .map((part) => part.split('*').join('[^/]*'))
    .join('.*');
  return new RegExp(`^${body}$`);
}

export class Guard {
  private config: PolicyConfig;
  private mode: GuardMode;
  private allowedPaths: RegExp[];
  private deniedPaths: RegExp[];
  private allowedActions: Set<string>;

  constructor(config: PolicyConfig, mode: GuardMode) {
    this.config = config;
    this.mode = mode;
    this.allowedPaths = config.allowlist.pathPatterns.map(globToRegExp);
    this.deniedPaths = config.allowlist.deniedPathPatterns.map(globToRegExp);
    this.allowedActions = new Set(config.allowlist.actions);
  }

  get currentMode(): GuardMode {
    return this.mode;
  }

  /** Origin + path check. Exposed separately so it can also run AFTER a
   *  navigation settles, catching redirects into disallowed territory. */
  checkUrl(rawUrl: string): GuardDecision {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { allow: false, escalate: false, code: 'ALLOWLIST', reason: `Malformed URL: ${rawUrl}` };
    }

    if (!this.config.allowlist.origins.includes(url.origin)) {
      return {
        allow: false,
        escalate: false,
        code: 'ALLOWLIST',
        reason: `Origin '${url.origin}' is not on the allowlist`,
      };
    }

    if (this.deniedPaths.some((re) => re.test(url.pathname))) {
      return {
        allow: false,
        escalate: false,
        code: 'ALLOWLIST',
        reason: `Path '${url.pathname}' matches a denied pattern`,
      };
    }

    if (this.allowedPaths.length > 0 && !this.allowedPaths.some((re) => re.test(url.pathname))) {
      return {
        allow: false,
        escalate: false,
        code: 'ALLOWLIST',
        reason: `Path '${url.pathname}' is not on the allowlist`,
      };
    }

    return { allow: true, escalate: false };
  }

  check(input: CheckActionInput): GuardDecision {
    if (!this.allowedActions.has(input.actionType)) {
      return {
        allow: false,
        escalate: false,
        code: 'ACTION_TYPE',
        reason: `Action type '${input.actionType}' is not permitted by policy`,
      };
    }

    if (input.url) {
      const urlDecision = this.checkUrl(input.url);
      if (!urlDecision.allow) return urlDecision;
    }

    const table = this.mode === 'unattended' ? this.config.risk.unattended : this.config.risk.attended;
    const disposition = (table[input.risk] ?? 'escalate') as RiskDisposition;

    switch (disposition) {
      case 'allow':
        return { allow: true, escalate: false };
      case 'escalate':
        return {
          allow: true,
          escalate: true,
          reason: `Step is classified '${input.risk}'; policy requires human approval in ${this.mode} mode`,
        };
      case 'block':
        return {
          allow: false,
          escalate: false,
          code: 'RISK_BLOCKED',
          reason: `Step is classified '${input.risk}', which is blocked in ${this.mode} mode`,
        };
    }
  }

  /** Budget checks, kept here so all limits live behind one object. */
  get limits(): PolicyConfig['limits'] {
    return this.config.limits;
  }

  get requiresApprovalForUnattended(): boolean {
    return this.config.requireApprovalForUnattended;
  }
}
