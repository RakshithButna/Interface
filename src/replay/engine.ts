/**
 * The deterministic replay engine -- the production execution path.
 *
 * No LLM is constructed, imported or consulted anywhere in this file. Given the
 * same artifact, the same inputs and the same application state, it does the
 * same thing every time. That is the entire value proposition of the system:
 * discovery is expensive, non-deterministic and needs a model; invocation is
 * cheap, repeatable and does not.
 *
 * The interesting design work here is the error taxonomy, because the brief is
 * right that conflating its categories is the classic failure. Every step runs
 * through the same pipeline, and each stage can only produce certain outcomes:
 *
 *   1. observe
 *   2. BUSINESS OUTCOME check  -> declared outcome, run ends cleanly
 *   3. RECOVERY check          -> known condition, fix it and re-observe
 *   4. policy check            -> block, or escalate to a human
 *   5. resolve target          -> not found / ambiguous are HARD failures
 *   6. act
 *   7. settle, re-observe
 *   8. BUSINESS OUTCOME check  -> the "no such member" screen usually lands here
 *   9. checkpoint              -> failure means the step did not do what it said
 *
 * Ordering matters more than it looks. Outcome detection runs BEFORE checkpoint
 * verification, because "no member records matched" would otherwise surface as
 * CHECKPOINT_FAILED -- a debuggable-looking error for something that is not an
 * error at all. And it runs both before and after each action, because an
 * exceptional screen can be what we arrive on as well as what we produce.
 *
 * Recovery is bounded per rule per run, and every attempt is logged. An
 * unbounded retry against a system of record is not resilience.
 */

import type { CapabilityArtifact, Step, RecoveryRule, Risk, TenantOverride } from '../schema/artifact.ts';
import { findOverride } from '../schema/artifact.ts';
import { mergeOverrides } from '../runtime/tenant-store.ts';
import type {
  ReplayResult,
  StepReport,
  Warning,
  ReplayError,
  ErrorCode,
  EvidenceRefs,
} from '../schema/result.ts';
import type { Surface, Observation } from '../surface/types.ts';
import type { Guard, GuardMode } from '../policy/guard.ts';
import type { ActionType } from '../policy/config.ts';
import type { RunContext } from '../observability/run-context.ts';
import type { SessionController } from '../escalation/session-control.ts';
import { STRATEGY_RANK, STABLE_RANK_THRESHOLD } from '../schema/targeting.ts';
import { resolveTarget, formatAttempts } from '../targeting/resolver.ts';
import { evaluateAssertion, describeAssertion } from '../runtime/assert.ts';
import { evalValue, type Bindings, type Scalar, BindingError } from '../runtime/bindings.ts';
import { aliasUrl, effectiveSteps, effectiveRecoveries } from '../runtime/overrides.ts';
import { validateInputs, transformExtracted, coerceOutput } from './inputs.ts';

export interface ReplayOptions {
  artifact: CapabilityArtifact;
  params: Record<string, Scalar>;
  /** Credential values, supplied per invocation. Never stored in the artifact. */
  secrets?: Record<string, string>;
  /** Which tenant to run against. Selects the override, if any. */
  tenantId?: string;
  /**
   * Product-level tenant override, loaded from config by the caller. Merged
   * with any capability-level override on the artifact, which wins on conflict.
   * Passed in rather than read here so the engine stays free of file I/O.
   */
  tenantOverride?: TenantOverride | undefined;
  mode: GuardMode;
  surface: Surface;
  guard: Guard;
  ctx: RunContext;
  controller: SessionController;
  /**
   * When set, an escalation blocks for a human instead of returning
   * immediately. Attended runs and the demo set this; a production agent
   * invocation would not, and would receive `status: 'escalated'` with an
   * intervention id to follow up on.
   */
  waitForHuman?: { timeoutMs: number };
}

interface StepFailure {
  code: ErrorCode;
  message: string;
  expected?: string;
  observed?: string;
}

export async function replayCapability(opts: ReplayOptions): Promise<ReplayResult> {
  const { artifact, surface, guard, ctx, controller } = opts;
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const tenantId = opts.tenantId ?? artifact.provenance.recordedOnTenant;
  const override = mergeOverrides(opts.tenantOverride, findOverride(artifact, tenantId));

  const steps = effectiveSteps(artifact, override);
  const recoveries = effectiveRecoveries(artifact, override);
  const globalRecoveries = recoveries.filter((r) => r.applies === 'global');

  const stepReports: StepReport[] = [];
  const warnings: Warning[] = [];
  const outputs: Record<string, Scalar> = {};
  const recoveryAttempts = new Map<string, number>();

  const finish = (extra: Partial<ReplayResult>): ReplayResult =>
    ({
      runId: ctx.runId,
      capability: artifact.name,
      capabilityVersion: artifact.version,
      tenantId,
      startedAt,
      durationMs: Date.now() - t0,
      steps: stepReports,
      warnings,
      evidence: { runLogPath: 'run.jsonl' },
      ...extra,
    }) as ReplayResult;

  ctx.log('replay_started', {
    capability: `${artifact.name}@${artifact.version}`,
    status: artifact.status,
    tenant: tenantId,
    mode: opts.mode,
    steps: steps.length,
    overrideApplied: Boolean(override),
  });

  if (override) {
    warnings.push({
      code: 'TENANT_OVERRIDE_APPLIED',
      message:
        `Running against tenant '${tenantId}' using overrides ` +
        `(${Object.keys(override.labelAliases).length} label aliases, ` +
        `${Object.keys(override.routeAliases).length} route aliases).`,
    });
  }

  /* --- gate 1: approval ------------------------------------------------- */

  if (opts.mode === 'unattended' && guard.requiresApprovalForUnattended && artifact.status !== 'approved') {
    ctx.log('replay_refused', { reason: 'not approved', status: artifact.status });
    return finish({
      status: 'failed',
      partialOutputs: {},
      error: {
        code: 'NOT_APPROVED',
        message:
          `Capability ${artifact.name}@${artifact.version} has status '${artifact.status}' and policy ` +
          `requires approval before unattended invocation. Review it and run 'catalog approve'.`,
      },
    });
  }

  /* --- gate 2: input contract ------------------------------------------- */

  /**
   * Credentials are declared inputs of the capability, but they are supplied by
   * the runtime's secret store rather than by the calling agent -- an AI agent
   * asking for a member's balance must not be in possession of the operator
   * password. Validation therefore checks the UNION: the contract is fully
   * satisfied, while the two sources stay separate everywhere else.
   */
  const validated = validateInputs(artifact, { ...opts.params, ...(opts.secrets ?? {}) });
  if (!validated.ok) {
    const detail = validated.failures.map((f) => `${f.param}: ${f.problem}`).join('; ');
    ctx.log('replay_refused', { reason: 'input validation', detail });
    return finish({
      status: 'failed',
      partialOutputs: {},
      error: {
        code: 'INPUT_VALIDATION_FAILED',
        message: `Inputs do not satisfy the capability contract: ${detail}`,
      },
    });
  }

  /* --- bindings and redaction ------------------------------------------- */

  const baseUrl = override?.baseUrl ?? artifact.app.baseUrl;
  const bindings: Bindings = {
    // `baseUrl` is a reserved binding, not a declared input: it is where the
    // capability runs, not something the caller reasons about. Overriding it
    // per tenant is what makes one recording portable across installs.
    params: { ...validated.values, ...(opts.secrets ?? {}), baseUrl },
    outputs: {},
  };

  for (const spec of artifact.inputs) {
    const value = bindings.params[spec.name];
    if (value !== undefined) ctx.redactor.register(spec.name, value, spec.sensitivity);
  }
  for (const [name, value] of Object.entries(opts.secrets ?? {})) {
    ctx.redactor.register(name, value, 'secret');
  }

  const deadline = Date.now() + guard.limits.maxReplayMs;

  /* ------------------------------------------------------------ the loop */

  for (const step of steps) {
    const stepStart = Date.now();
    const appliedRecoveries: string[] = [];

    if (Date.now() > deadline) {
      return await hardFail(step, {
        code: 'TIMEOUT',
        message: `Run exceeded its ${guard.limits.maxReplayMs}ms budget`,
      });
    }

    ctx.log('step_started', { stepId: step.id, intent: step.intent, risk: step.risk, action: step.action.type });

    /* --- pre-action: outcomes, then recoveries ------------------------- */

    let obs = await surface.observe();

    const preOutcome = detectOutcome(obs);
    if (preOutcome) return await outcomeResult(preOutcome, step);

    const recovered = await applyRecoveries(obs, step, appliedRecoveries);
    if (recovered.escalation) return recovered.escalation;
    if (recovered.failure) return await hardFail(step, recovered.failure);
    if (recovered.changed) {
      obs = await surface.observe();
      const afterRecoveryOutcome = detectOutcome(obs);
      if (afterRecoveryOutcome) return await outcomeResult(afterRecoveryOutcome, step);
    }

    /* --- policy -------------------------------------------------------- */

    const actionType = step.action.type as ActionType;
    const decision = guard.check({ actionType, risk: step.risk });

    if (!decision.allow) {
      return await hardFail(step, {
        code: 'POLICY_VIOLATION',
        message: decision.reason,
        expected: `an action permitted by policy in ${opts.mode} mode`,
        observed: `${actionType} classified '${step.risk}'`,
      });
    }

    if (decision.escalate) {
      const escalated = await escalate({
        kind: 'risky_step_approval',
        reason: decision.reason,
        detail: `Step '${step.id}' (${step.intent}) is classified '${step.risk}'.`,
        step,
      });
      if (escalated.result) return escalated.result;
      // Human approved; carry on.
      obs = await surface.observe();
    }

    /* --- execute ------------------------------------------------------- */

    let resolvedBy: string | undefined;
    let resolvedRank: number | undefined;

    try {
      controller.assertAutomationControl();
      const exec = await executeStep(step, obs);
      if ('failure' in exec) {
        // A step that fails to resolve may still be rescuable by a recovery
        // rule -- the classic case being an interstitial that appeared between
        // our observation and our action.
        const retry = await applyRecoveries(await surface.observe(), step, appliedRecoveries);
        if (retry.escalation) return retry.escalation;
        if (retry.changed) {
          const obs2 = await surface.observe();
          const lateOutcome = detectOutcome(obs2);
          if (lateOutcome) return await outcomeResult(lateOutcome, step);
          const exec2 = await executeStep(step, obs2);
          if ('failure' in exec2) return await hardFail(step, exec2.failure);
          resolvedBy = exec2.resolvedBy;
          resolvedRank = exec2.resolvedRank;
        } else {
          if (step.optional) {
            ctx.log('step_skipped', { stepId: step.id, reason: exec.failure.message });
            warnings.push({
              code: 'OPTIONAL_STEP_SKIPPED',
              stepId: step.id,
              message: `Optional step skipped: ${exec.failure.message}`,
            });
            stepReports.push({
              stepId: step.id,
              intent: step.intent,
              status: 'skipped',
              risk: step.risk,
              durationMs: Date.now() - stepStart,
            });
            continue;
          }
          return await hardFail(step, exec.failure);
        }
      } else {
        resolvedBy = exec.resolvedBy;
        resolvedRank = exec.resolvedRank;
      }
    } catch (err) {
      if (err instanceof BindingError) {
        return await hardFail(step, {
          code: 'INPUT_VALIDATION_FAILED',
          message: err.message,
        });
      }
      return await hardFail(step, {
        code: 'SURFACE_ERROR',
        message: `Surface error while performing ${step.action.type}: ${(err as Error).message}`,
      });
    }

    /* --- post-action --------------------------------------------------- */

    if (step.action.type !== 'extract' && step.action.type !== 'assert') {
      await surface.settle(Math.min(step.timeoutMs, 10_000));
    }

    const after = await surface.observe();

    // The single most important ordering decision in this file: an exceptional
    // business screen is checked for BEFORE the checkpoint. Otherwise "no such
    // member" arrives at the caller as CHECKPOINT_FAILED.
    const postOutcome = detectOutcome(after);
    if (postOutcome) return await outcomeResult(postOutcome, step);

    if (step.checkpoint) {
      let verdict = evaluateAssertion(step.checkpoint, after, { bindings, override });

      if (!verdict.ok) {
        // A checkpoint miss can be a recoverable interstitial sitting on top of
        // the page we actually reached, so try recovery once before failing.
        const rescue = await applyRecoveries(after, step, appliedRecoveries);
        if (rescue.escalation) return rescue.escalation;
        // A recovery that ITSELF failed is the real error and must be
        // reported. Falling through to CHECKPOINT_FAILED here would bury the
        // actual cause ("the recovery could not find its Continue button")
        // under a generic symptom.
        if (rescue.failure) return await hardFail(step, rescue.failure);
        if (rescue.changed) {
          const obs3 = await surface.observe();
          const o = detectOutcome(obs3);
          if (o) return await outcomeResult(o, step);
          verdict = evaluateAssertion(step.checkpoint, obs3, { bindings, override });
        }
      }

      if (!verdict.ok) {
        return await hardFail(step, {
          code: 'CHECKPOINT_FAILED',
          message: `Step '${step.id}' did not reach its expected state`,
          expected: describeAssertion(step.checkpoint),
          observed: verdict.detail,
        });
      }
    }

    /* --- drift reporting ------------------------------------------------ */

    if (resolvedRank !== undefined) {
      const baseline = targetOf(step)?.recordedRank ?? STABLE_RANK_THRESHOLD;
      if (resolvedRank > baseline) {
        warnings.push({
          code: 'LOCATOR_DRIFT',
          stepId: step.id,
          message:
            `Resolved via '${resolvedBy}' (rank ${resolvedRank}) but was recorded resolving via ` +
            `'${targetOf(step)?.recordedStrategy ?? 'unknown'}' (rank ${baseline}). The step still worked, ` +
            `but the stronger identifiers no longer match -- this capability is drifting.`,
        });
        ctx.log('locator_drift', { stepId: step.id, resolvedBy, resolvedRank, baseline });
      }
    }

    const durationMs = Date.now() - stepStart;
    if (durationMs > 8_000) {
      warnings.push({ code: 'SLOW_STEP', stepId: step.id, message: `Step took ${durationMs}ms` });
    }

    const report: StepReport = {
      stepId: step.id,
      intent: step.intent,
      status: appliedRecoveries.length > 0 ? 'recovered' : 'ok',
      risk: step.risk,
      durationMs,
    };
    if (resolvedBy) report.resolvedBy = resolvedBy;
    if (resolvedRank !== undefined) report.resolvedRank = resolvedRank;
    if (appliedRecoveries.length > 0) report.recoveriesApplied = [...appliedRecoveries];
    stepReports.push(report);

    ctx.log('step_ok', { stepId: step.id, durationMs, resolvedBy, recoveries: appliedRecoveries });
  }

  /* ---------------------------------------------------- success checkpoint */

  const finalObs = await surface.observe();

  const finalOutcome = detectOutcome(finalObs);
  if (finalOutcome) return await outcomeResult(finalOutcome, undefined);

  const success = evaluateAssertion(artifact.successCheckpoint, finalObs, { bindings, override });
  if (!success.ok) {
    const evidence = await ctx.captureEvidence(surface, 'success-checkpoint-failed');
    ctx.log('replay_failed', { code: 'SUCCESS_CHECKPOINT_FAILED', detail: success.detail });
    return finish({
      status: 'failed',
      partialOutputs: outputs,
      evidence,
      error: {
        code: 'SUCCESS_CHECKPOINT_FAILED',
        message: 'Every step completed but the capability-level success condition did not hold',
        expected: describeAssertion(artifact.successCheckpoint),
        observed: success.detail,
        evidence,
      },
    });
  }

  /* --------------------------------------------------------------- outputs */

  const finalOutputs: Record<string, Scalar> = {};
  for (const spec of artifact.outputs) {
    const raw = outputs[spec.name];
    if (raw === undefined) {
      if (!spec.required) continue;
      const evidence = await ctx.captureEvidence(surface, 'missing-output');
      return finish({
        status: 'failed',
        partialOutputs: outputs,
        evidence,
        error: {
          code: 'OUTPUT_EXTRACTION_FAILED',
          message: `Declared output '${spec.name}' was never produced`,
          expected: `output '${spec.name}' from step ${spec.producedByStep}`,
          evidence,
        },
      });
    }
    const coerced = coerceOutput(spec, String(raw));
    if ('problem' in coerced) {
      const evidence = await ctx.captureEvidence(surface, 'bad-output');
      return finish({
        status: 'failed',
        partialOutputs: outputs,
        evidence,
        error: {
          code: 'OUTPUT_EXTRACTION_FAILED',
          message: `Output '${spec.name}' ${coerced.problem}`,
          evidence,
        },
      });
    }
    finalOutputs[spec.name] = coerced.value;
  }

  ctx.log('replay_succeeded', { outputs: finalOutputs, warnings: warnings.length });
  return finish({ status: 'success', outputs: finalOutputs });

  /* ==================================================================== */
  /* helpers                                                              */
  /* ==================================================================== */

  function targetOf(step: Step) {
    const a = step.action;
    return 'target' in a ? a.target : undefined;
  }

  /** Check every declared outcome detector against the current state. */
  function detectOutcome(obs: Observation): { code: string; message: string } | null {
    const allRules = [...artifact.outcomeRules];
    for (const rule of allRules) {
      const verdict = evaluateAssertion(rule.when, obs, { bindings, override });
      if (verdict.ok) {
        return { code: rule.outcome, message: rule.message ?? verdict.detail };
      }
    }
    return null;
  }

  async function outcomeResult(
    hit: { code: string; message: string },
    step: Step | undefined,
  ): Promise<ReplayResult> {
    const spec = artifact.outcomes.find((o) => o.code === hit.code);
    const evidence = await ctx.captureEvidence(surface, `outcome-${hit.code.toLowerCase()}`);
    ctx.log('business_outcome', { outcome: hit.code, stepId: step?.id, message: hit.message });

    if (step) {
      stepReports.push({
        stepId: step.id,
        intent: step.intent,
        status: 'ok',
        risk: step.risk,
        durationMs: 0,
        note: `stopped here: business outcome ${hit.code}`,
      });
    }

    return finish({
      status: 'outcome',
      outcome: hit.code,
      message: hit.message,
      disposition: spec?.disposition ?? 'terminal',
      partialOutputs: outputs,
      evidence,
    });
  }

  async function hardFail(step: Step, failure: StepFailure): Promise<ReplayResult> {
    const evidence = await ctx.captureEvidence(surface, `fail-${step.id}`);
    const error: ReplayError = {
      code: failure.code,
      message: failure.message,
      stepId: step.id,
      evidence,
    };
    if (failure.expected) error.expected = failure.expected;
    if (failure.observed) error.observed = failure.observed;

    stepReports.push({
      stepId: step.id,
      intent: step.intent,
      status: 'failed',
      risk: step.risk,
      durationMs: 0,
      note: failure.message,
    });

    ctx.log('replay_failed', {
      code: failure.code,
      stepId: step.id,
      message: failure.message,
      expected: failure.expected,
      observed: failure.observed,
    });

    return finish({ status: 'failed', error, partialOutputs: outputs, evidence });
  }

  /**
   * Raise an intervention. Returns a result when the run must end here, or
   * nothing when a human approved and the run should continue.
   */
  async function escalate(input: {
    kind: 'risky_step_approval' | 'unrecoverable' | 'recovery_escalation';
    reason: string;
    detail?: string;
    step?: Step;
  }): Promise<{ result?: ReplayResult }> {
    const evidence: EvidenceRefs = await ctx.captureEvidence(
      surface,
      `escalation-${input.step?.id ?? input.kind}`,
    );

    const req = controller.raise({
      kind: input.kind,
      runId: ctx.runId,
      goal: artifact.provenance.goal,
      tenantId,
      reason: input.reason,
      ...(input.detail ? { detail: input.detail } : {}),
      currentUrl: surface.currentUrl(),
      evidence,
      capability: artifact.name,
      capabilityVersion: artifact.version,
      ...(input.step ? { stepId: input.step.id, stepIntent: input.step.intent } : {}),
    });

    ctx.log('escalation_raised', {
      interventionId: req.id,
      kind: input.kind,
      reason: input.reason,
      stepId: input.step?.id,
    });

    if (!opts.waitForHuman) {
      // Production shape: hand the caller an id and stop holding a browser open.
      return {
        result: finish({
          status: 'escalated',
          interventionId: req.id,
          reason: input.reason,
          resumable: true,
          evidence,
        }),
      };
    }

    const resolution = await controller.awaitResolution(req.id, opts.waitForHuman.timeoutMs);
    ctx.log('escalation_resolved', {
      interventionId: req.id,
      resolution,
      humanActions: req.humanActions.length,
    });

    if (resolution === 'resume') {
      warnings.push({
        code: 'RECOVERY_APPLIED',
        ...(input.step ? { stepId: input.step.id } : {}),
        message: `A human took control and handed back after ${req.humanActions.length} recorded action(s).`,
      });
      return {};
    }

    return {
      result: finish({
        status: 'escalated',
        interventionId: req.id,
        reason:
          resolution === 'timeout'
            ? `${input.reason} (no operator responded within ${opts.waitForHuman.timeoutMs}ms)`
            : `${input.reason} (operator aborted the run)`,
        resumable: resolution === 'timeout',
        evidence,
      }),
    };
  }

  /**
   * Try every applicable recovery rule against the current state.
   * Bounded per rule, per run. Returns whether anything changed.
   */
  async function applyRecoveries(
    obs: Observation,
    step: Step,
    applied: string[],
  ): Promise<{ changed: boolean; failure?: StepFailure; escalation?: ReplayResult }> {
    const candidates = [...globalRecoveries, ...step.recoveries];
    let changed = false;

    for (const rule of candidates) {
      const verdict = evaluateAssertion(rule.when, obs, { bindings, override });
      if (!verdict.ok) continue;

      const used = recoveryAttempts.get(rule.id) ?? 0;
      if (used >= rule.maxAttempts) {
        ctx.log('recovery_exhausted', { rule: rule.id, attempts: used, stepId: step.id });
        return {
          changed,
          failure: {
            code: 'RECOVERY_EXHAUSTED',
            message: `Recovery '${rule.id}' triggered more than ${rule.maxAttempts} time(s) and stopped helping`,
            expected: `condition '${rule.description}' to clear`,
            observed: verdict.detail,
          },
        };
      }
      recoveryAttempts.set(rule.id, used + 1);

      ctx.log('recovery_applied', {
        rule: rule.id,
        stepId: step.id,
        attempt: used + 1,
        action: rule.then.type,
        because: verdict.detail,
      });
      applied.push(rule.id);
      warnings.push({
        code: 'RECOVERY_APPLIED',
        stepId: step.id,
        message: `Applied recovery '${rule.id}': ${rule.description}`,
      });

      const outcome = await runRecovery(rule, obs, step);
      if (outcome.escalation) return { changed, escalation: outcome.escalation };
      if (outcome.failure) return { changed, failure: outcome.failure };
      changed = true;
    }

    return { changed };
  }

  async function runRecovery(
    rule: RecoveryRule,
    obs: Observation,
    step: Step,
  ): Promise<{ failure?: StepFailure; escalation?: ReplayResult }> {
    const then = rule.then;
    switch (then.type) {
      case 'wait':
        await new Promise((r) => setTimeout(r, then.ms));
        await surface.settle(then.ms);
        return {};

      case 'reload':
        await surface.perform({ kind: 'navigate', url: surface.currentUrl() });
        await surface.settle(10_000);
        return {};

      case 'click': {
        const res = resolveTarget(then.target, obs, { bindings, override });
        if (!res.ok) {
          return {
            failure: {
              code: 'TARGET_NOT_FOUND',
              message: `Recovery '${rule.id}' could not find the control it needed to click`,
              expected: then.target.description,
              observed: res.detail,
            },
          };
        }
        controller.assertAutomationControl();
        await surface.perform({ kind: 'click', ref: res.node.ref });
        await surface.settle(10_000);
        return {};
      }

      case 'reauthenticate': {
        if (artifact.authPreambleStepIds.length === 0) {
          return {
            failure: {
              code: 'RECOVERY_EXHAUSTED',
              message: `Session expired but this capability records no authentication preamble to replay`,
            },
          };
        }
        ctx.log('reauthenticating', { steps: artifact.authPreambleStepIds });
        for (const id of artifact.authPreambleStepIds) {
          const preStep = steps.find((s) => s.id === id);
          if (!preStep) continue;
          const preObs = await surface.observe();
          const exec = await executeStep(preStep, preObs);
          if ('failure' in exec) {
            return {
              failure: {
                code: 'RECOVERY_EXHAUSTED',
                message: `Re-authentication failed at preamble step '${id}': ${exec.failure.message}`,
              },
            };
          }
          await surface.settle(8_000);
        }
        return {};
      }

      case 'escalate': {
        const esc = await escalate({
          kind: 'recovery_escalation',
          reason: then.reason,
          detail: `Recovery rule '${rule.id}' routed this to a human rather than retrying.`,
          step,
        });
        return esc.result ? { escalation: esc.result } : {};
      }
    }
  }

  /** Perform one step's action. Target resolution failures are returned, not thrown. */
  async function executeStep(
    step: Step,
    obs: Observation,
  ): Promise<{ resolvedBy?: string; resolvedRank?: number } | { failure: StepFailure }> {
    const action = step.action;

    if (action.type === 'navigate') {
      const raw = evalValue(action.url, bindings);
      const url = aliasUrl(raw, override, artifact.app.baseUrl);
      const decision = guard.checkUrl(url);
      if (!decision.allow) {
        return { failure: { code: 'POLICY_VIOLATION', message: decision.reason, observed: url } };
      }
      controller.assertAutomationControl();
      await surface.perform({ kind: 'navigate', url });
      await surface.settle(step.timeoutMs);
      // Re-check after redirects.
      const post = guard.checkUrl(surface.currentUrl());
      if (!post.allow) {
        return {
          failure: {
            code: 'POLICY_VIOLATION',
            message: `Navigation redirected outside the allowlist: ${post.reason}`,
            observed: surface.currentUrl(),
          },
        };
      }
      return {};
    }

    if (action.type === 'waitFor') {
      const until = Date.now() + action.timeoutMs;
      for (;;) {
        const current = await surface.observe();
        if (evaluateAssertion(action.assertion, current, { bindings, override }).ok) return {};
        if (Date.now() > until) {
          return {
            failure: {
              code: 'TIMEOUT',
              message: `Condition did not become true within ${action.timeoutMs}ms`,
              expected: describeAssertion(action.assertion),
            },
          };
        }
        await new Promise((r) => setTimeout(r, 400));
      }
    }

    if (action.type === 'assert') {
      const verdict = evaluateAssertion(action.assertion, obs, { bindings, override });
      if (!verdict.ok) {
        return {
          failure: {
            code: 'CHECKPOINT_FAILED',
            message: 'Explicit assertion failed',
            expected: describeAssertion(action.assertion),
            observed: verdict.detail,
          },
        };
      }
      return {};
    }

    // Everything below needs a resolved element. `press` is the one action
    // whose target is optional -- an unbound keypress goes to the page.
    const target = 'target' in action ? action.target : undefined;
    if (!target) {
      if (action.type === 'press') {
        controller.assertAutomationControl();
        await surface.perform({ kind: 'press', key: action.key });
        return {};
      }
      return {
        failure: { code: 'INTERNAL_ERROR', message: `Action '${action.type}' has no target descriptor` },
      };
    }

    const res = resolveTarget(target, obs, { bindings, override });
    if (!res.ok) {
      const code: ErrorCode = res.reason === 'ambiguous' ? 'TARGET_AMBIGUOUS' : 'TARGET_NOT_FOUND';
      return {
        failure: {
          code,
          message:
            code === 'TARGET_AMBIGUOUS'
              ? `Several controls matched '${target.description}' and none of the recorded strategies distinguished them`
              : `Could not find '${target.description}'`,
          expected: target.description,
          observed: `${res.detail} | ladder: ${formatAttempts(res.attempts)}`,
        },
      };
    }

    controller.assertAutomationControl();

    switch (action.type) {
      case 'click':
        await surface.perform({ kind: 'click', ref: res.node.ref });
        break;

      case 'fill': {
        const value = evalValue(action.value, bindings);
        await surface.perform({ kind: 'fill', ref: res.node.ref, value, clearFirst: action.clearFirst });
        break;
      }

      case 'select': {
        const value = evalValue(action.value, bindings);
        await surface.perform({ kind: 'select', ref: res.node.ref, value });
        break;
      }

      case 'press':
        await surface.perform({ kind: 'press', key: action.key, ref: res.node.ref });
        break;

      case 'extract': {
        const raw = await surface.read(res.node.ref, action.from, action.attribute);
        if (raw === null) {
          return {
            failure: {
              code: 'OUTPUT_EXTRACTION_FAILED',
              message: `Could not read '${action.into}' from ${target.description}`,
            },
          };
        }
        const transformed = transformExtracted(raw, action.transform, action.extractPattern);
        if ('problem' in transformed) {
          return {
            failure: {
              code: 'OUTPUT_EXTRACTION_FAILED',
              message: `Output '${action.into}': ${transformed.problem}`,
              observed: raw.slice(0, 120),
            },
          };
        }
        outputs[action.into] = transformed.value;
        bindings.outputs[action.into] = transformed.value;
        ctx.log('output_extracted', { name: action.into, value: transformed.value });
        break;
      }
    }

    return { resolvedBy: res.strategy.kind, resolvedRank: res.rank };
  }
}

/** Exposed for tests: the ladder rank considered "stable enough". */
export { STRATEGY_RANK, STABLE_RANK_THRESHOLD };
export type { Risk };
