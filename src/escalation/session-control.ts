/**
 * Control transfer: who is allowed to touch the live session, and how that
 * changes hands.
 *
 * The brief asks for the seam this implies -- "automation must be able to
 * pause, cede control, and resume on the same session, and there must be a way
 * to know who is (or should be) in control." The model here is a LEASE.
 *
 * Exactly one party holds the lease at a time. Automation asserts the lease
 * before every action it performs; if it does not hold it, the action throws
 * rather than racing a human who is mid-click. That is the whole mechanism, and
 * its value is that it is enforced at the same chokepoint as the guardrails
 * rather than being a convention everyone has to remember.
 *
 * What makes the handoff real rather than cosmetic is that the human operates
 * the SAME browser session -- same context, same cookies, same page, same
 * server-side session. There is no re-login, no state reconstruction, and the
 * member record stays open on screen. When they hand back, automation resumes
 * against whatever state they left behind, and re-verifies its checkpoint
 * before continuing rather than assuming the human did what it hoped.
 *
 * Escalation is deliberately split into two phases:
 *
 *   raise()            Records the request with full context and returns
 *                      immediately. This is what a production deployment does:
 *                      the run ends with status 'escalated', the calling agent
 *                      gets an intervention id, and a queue takes over.
 *   awaitResolution()  Blocks until a human resolves it. This is what an
 *                      attended run does, and what the demo uses.
 *
 * Same request object, same state machine, two callers. Splitting them is what
 * keeps the design honest about the fact that a real deployment cannot hold a
 * browser open waiting for a person to notice.
 */

import { randomUUID } from 'node:crypto';
import type { EvidenceRefs } from '../schema/result.ts';

export type Controller = 'automation' | 'human';

export type InterventionKind =
  /** Discovery could not make progress. */
  | 'stuck'
  /** Policy requires a person to approve a risky/irreversible step. */
  | 'risky_step_approval'
  /** Replay hit a condition it has no recovery for. */
  | 'unrecoverable'
  /** A recovery rule explicitly routed to a human. */
  | 'recovery_escalation';

export type InterventionStatus = 'open' | 'human_in_control' | 'resumed' | 'aborted';

export interface HumanAction {
  ts: string;
  type: 'click' | 'input' | 'change' | 'navigate' | 'note';
  frame?: string;
  control?: string;
  /** Redacted before it is ever written. Password fields report no value. */
  value?: string;
  url?: string;
}

export interface InterventionRequest {
  id: string;
  kind: InterventionKind;
  status: InterventionStatus;
  createdAt: string;

  /* --- context a human needs in order to act ---------------------------- */
  runId: string;
  capability?: string;
  capabilityVersion?: string;
  goal: string;
  tenantId: string;
  /** Which step we stopped on. */
  stepId?: string;
  stepIntent?: string;
  /** Why we stopped, in plain language. */
  reason: string;
  detail?: string;
  currentUrl: string;
  /** Screenshot, DOM and accessibility snapshots captured at the moment of stopping. */
  evidence: EvidenceRefs;

  /* --- what happened next ----------------------------------------------- */
  humanActions: HumanAction[];
  resolution?: 'resume' | 'abort';
  resolvedAt?: string;
  operatorNote?: string;
}

export interface RaiseInput {
  kind: InterventionKind;
  runId: string;
  goal: string;
  tenantId: string;
  reason: string;
  detail?: string;
  currentUrl: string;
  evidence: EvidenceRefs;
  capability?: string;
  capabilityVersion?: string;
  stepId?: string;
  stepIntent?: string;
}

export class ControlLeaseError extends Error {
  constructor(holder: Controller) {
    super(
      `Automation attempted to act while control is held by '${holder}'. ` +
        `The session lease must be handed back before automation resumes.`,
    );
    this.name = 'ControlLeaseError';
  }
}

type Waiter = (resolution: 'resume' | 'abort') => void;

export class SessionController {
  private holder: Controller = 'automation';
  private interventions = new Map<string, InterventionRequest>();
  private waiters = new Map<string, Waiter[]>();
  private listeners: Array<(i: InterventionRequest) => void> = [];

  /** Who currently holds the lease. */
  get controlledBy(): Controller {
    return this.holder;
  }

  /**
   * Called by the executor before every action. This is the enforcement point
   * that makes the lease more than documentation.
   */
  assertAutomationControl(): void {
    if (this.holder !== 'automation') throw new ControlLeaseError(this.holder);
  }

  onChange(fn: (i: InterventionRequest) => void): void {
    this.listeners.push(fn);
  }

  private emit(i: InterventionRequest): void {
    for (const fn of this.listeners) {
      try {
        fn(i);
      } catch {
        /* a broken listener must not break control transfer */
      }
    }
  }

  /** Record an intervention request and cede the lease. Does not block. */
  raise(input: RaiseInput): InterventionRequest {
    const req: InterventionRequest = {
      id: `int_${randomUUID().slice(0, 8)}`,
      status: 'open',
      createdAt: new Date().toISOString(),
      humanActions: [],
      ...input,
    };
    this.interventions.set(req.id, req);
    // Automation gives up the lease the moment it asks for help. It does not
    // wait to be told; holding the lease while blocked is how a human ends up
    // fighting an automation that thinks it is still driving.
    this.holder = 'human';
    this.emit(req);
    return req;
  }

  /** Block until a human resolves the request, or the timeout elapses. */
  awaitResolution(id: string, timeoutMs: number): Promise<'resume' | 'abort' | 'timeout'> {
    const req = this.interventions.get(id);
    if (!req) return Promise.resolve('abort');
    if (req.resolution) return Promise.resolve(req.resolution);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.removeWaiter(id, waiter);
        resolve('timeout');
      }, timeoutMs);

      const waiter: Waiter = (resolution) => {
        clearTimeout(timer);
        resolve(resolution);
      };
      const list = this.waiters.get(id) ?? [];
      list.push(waiter);
      this.waiters.set(id, list);
    });
  }

  private removeWaiter(id: string, waiter: Waiter): void {
    const list = this.waiters.get(id);
    if (!list) return;
    const i = list.indexOf(waiter);
    if (i >= 0) list.splice(i, 1);
  }

  private resolveWaiters(id: string, resolution: 'resume' | 'abort'): void {
    for (const w of this.waiters.get(id) ?? []) w(resolution);
    this.waiters.delete(id);
  }

  /* ---------------------------------------------------- operator actions */

  takeControl(id: string): InterventionRequest | undefined {
    const req = this.interventions.get(id);
    if (!req || req.resolution) return req;
    req.status = 'human_in_control';
    this.holder = 'human';
    this.emit(req);
    return req;
  }

  recordHumanAction(id: string, action: HumanAction): void {
    const req = this.interventions.get(id);
    if (!req) return;
    req.humanActions.push(action);
  }

  /** Hand the lease back so the run can continue. */
  resume(id: string, note?: string): InterventionRequest | undefined {
    const req = this.interventions.get(id);
    if (!req) return undefined;
    req.status = 'resumed';
    req.resolution = 'resume';
    req.resolvedAt = new Date().toISOString();
    if (note) req.operatorNote = note;
    this.holder = 'automation';
    this.emit(req);
    this.resolveWaiters(id, 'resume');
    return req;
  }

  abort(id: string, note?: string): InterventionRequest | undefined {
    const req = this.interventions.get(id);
    if (!req) return undefined;
    req.status = 'aborted';
    req.resolution = 'abort';
    req.resolvedAt = new Date().toISOString();
    if (note) req.operatorNote = note;
    // Control returns to automation so it can shut the run down cleanly.
    this.holder = 'automation';
    this.emit(req);
    this.resolveWaiters(id, 'abort');
    return req;
  }

  get(id: string): InterventionRequest | undefined {
    return this.interventions.get(id);
  }

  list(): InterventionRequest[] {
    return [...this.interventions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  open(): InterventionRequest[] {
    return this.list().filter((i) => !i.resolution);
  }
}
