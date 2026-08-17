/**
 * The recorder: a successful discovery run in, a typed capability artifact out.
 *
 * This is the step the whole system exists to make possible -- the point where
 * a one-off, model-driven, non-deterministic run becomes a contract that runs
 * the same way every time without a model.
 *
 * Four transformations happen here, and each is a place where a naive
 * implementation would produce something that replays once and then rots:
 *
 * 1. PARAMETERIZATION. Concrete values from the run are replaced with typed
 *    parameter references. The recorder knows which literals to parameterize
 *    because the operator declared them when launching the run -- it does not
 *    guess by pattern-matching strings, which would happily turn a date or a
 *    branch name into a parameter.
 *
 * 2. CANONICALIZATION. Recorded URLs become `${baseUrl}`-relative templates
 *    with parameter substitution, so `/t/westside/member?id=12345` is stored as
 *    `${baseUrl}/member?id=${memberId}`. That single change is what lets one
 *    recording serve another tenant whose install lives at a different base
 *    and uses different route slugs.
 *
 * 3. DURABLE TARGETING. Each acted-on node becomes a `TargetDescriptor` with a
 *    verified ladder, via `captureTarget`. Descriptors that fail to re-resolve
 *    against the observation they came from are reported as warnings, because
 *    a descriptor that cannot find its own element at record time will
 *    certainly not find it next month.
 *
 * 4. CHECKPOINTS. Every step gets a condition asserting that it landed. These
 *    are synthesised from what actually changed on screen -- a newly-appeared
 *    heading, or a URL transition -- rather than from the model's narration,
 *    which is a claim rather than an observation.
 *
 * What the recorder explicitly does NOT do is invent the error vocabulary. See
 * outcome-library.ts.
 */

import type {
  CapabilityArtifact,
  Step,
  ParamSpec,
  OutputSpec,
  Action,
  Sensitivity,
} from '../schema/artifact.ts';
import { SCHEMA_VERSION, CapabilityArtifactSchema } from '../schema/artifact.ts';
import type { Assertion } from '../schema/assertions.ts';
import { A } from '../schema/assertions.ts';
import type { ValueExpr } from '../schema/targeting.ts';
import type { DiscoveryOutcome, RecordedAction } from '../agent/loop.ts';
import type { Observation } from '../surface/types.ts';
import { captureTarget } from '../targeting/capture.ts';
import type { OutcomeLibrary } from './outcome-library.ts';
import { EMPTY_LIBRARY } from './outcome-library.ts';

export interface ParamDeclaration {
  name: string;
  type?: ParamSpec['type'];
  description?: string;
  sensitivity?: Sensitivity;
  pattern?: string;
  example?: string;
}

export interface RecordOptions {
  name: string;
  version: string;
  title: string;
  description: string;

  productId: string;
  productVersion?: string;
  /** Tenant-scoped base, e.g. http://127.0.0.1:4173/t/westside */
  baseUrl: string;
  /** Where the run started. Becomes the capability's first step. */
  entryUrl: string;
  tenantId: string;

  /** Concrete values used in the run, keyed by parameter name. */
  params: Record<string, string>;
  /** Metadata for those parameters, supplied by the operator. */
  paramDeclarations?: ParamDeclaration[];
  /** Secret parameter names referenced via placeholders during the run. */
  secretNames?: string[];

  runId: string;
  provider: string;
  model: string;
  evidencePath?: string;

  outcomeLibrary?: OutcomeLibrary;
}

export interface RecordResult {
  artifact: CapabilityArtifact;
  /** Problems a human should look at before approving this capability. */
  warnings: string[];
}

/* ------------------------------------------------------------- utilities */

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function headings(obs: Observation): string[] {
  return obs.nodes.filter((n) => n.role === 'heading' && n.name).map((n) => n.name);
}

/**
 * Turn a literal captured during the run into an expression.
 *
 * Exact matches become parameter references. Values that merely CONTAIN a
 * parameter become templates. Everything else stays literal -- deliberately
 * conservative, because wrongly parameterizing a constant produces a
 * capability that silently does the wrong thing when invoked.
 */
function valueExprFor(raw: string, params: Record<string, string>, secretName?: string): ValueExpr {
  if (secretName) return { param: secretName };

  for (const [name, value] of Object.entries(params)) {
    if (value.length > 0 && raw === value) return { param: name };
  }
  let templated = raw;
  let substituted = false;
  // Longest values first so a short parameter cannot chew a hole in a longer one.
  for (const [name, value] of Object.entries(params).sort((a, b) => b[1].length - a[1].length)) {
    if (value.length >= 3 && templated.includes(value)) {
      templated = templated.split(value).join(`\${${name}}`);
      substituted = true;
    }
  }
  return substituted ? { template: templated } : { literal: raw };
}

/** `http://host/t/westside/member?id=12345` -> `${baseUrl}/member?id=${memberId}` */
function canonicalizeUrl(url: string, baseUrl: string, params: Record<string, string>): ValueExpr {
  let rest = url;
  if (url.startsWith(baseUrl)) {
    rest = url.slice(baseUrl.length);
  }
  let templated = rest;
  for (const [name, value] of Object.entries(params).sort((a, b) => b[1].length - a[1].length)) {
    if (value.length >= 2 && templated.includes(value)) {
      templated = templated.split(value).join(`\${${name}}`);
    }
  }
  return { template: `\${baseUrl}${templated}` };
}

/* -------------------------------------------------------------- recorder */

export function recordArtifact(outcome: DiscoveryOutcome, opts: RecordOptions): RecordResult {
  if (outcome.status !== 'succeeded') {
    throw new Error(`Refusing to record an artifact from a run with status '${outcome.status}'`);
  }

  const warnings: string[] = [];
  const library = opts.outcomeLibrary ?? EMPTY_LIBRARY;
  const secretNames = new Set(opts.secretNames ?? []);
  const canonicalizationNotes: string[] = [];

  const steps: Step[] = [];
  const outputs: OutputSpec[] = [];
  const usedParams = new Set<string>();

  /**
   * The entry navigation is performed by the harness before the model gets a
   * turn, so it never appears in the transcript -- but replay obviously has to
   * open the application before it can do anything. Synthesised here as the
   * first step, canonicalised like any other URL so it moves with the tenant.
   *
   * It also matters for recovery: a session-expiry re-authentication replays
   * the preamble, and the preamble has to start by loading the sign-on page.
   */
  const firstAction = outcome.actions[0];
  const modelNavigatedFirst =
    firstAction?.kind === 'navigate' && firstAction.value === opts.entryUrl;

  if (!modelNavigatedFirst) {
    steps.push({
      id: 's00_navigate',
      intent: 'Open the application entry point',
      action: { type: 'navigate', url: canonicalizeUrl(opts.entryUrl, opts.baseUrl, opts.params) },
      risk: 'safe',
      outcomeRules: [],
      recoveries: [],
      timeoutMs: 20_000,
      optional: false,
    });
  }

  for (const action of outcome.actions) {
    const step = buildStep(action);
    if (step) steps.push(step);
  }

  if (steps.length === 0) {
    throw new Error('Discovery produced no recordable steps');
  }

  /* --- authentication preamble ----------------------------------------- */

  // The preamble is everything up to and including the submit that follows the
  // last secret entry. Recorded explicitly so `reauthenticate` recovery has a
  // precise, reviewable definition of what it will re-run.
  const lastSecretIdx = steps.findLastIndex(
    (s) => s.action.type === 'fill' && 'param' in s.action.value && secretNames.has(s.action.value.param),
  );
  let preamble: string[] = [];
  if (lastSecretIdx >= 0) {
    const submitIdx = steps.findIndex((s, i) => i > lastSecretIdx && s.action.type === 'click');
    const end = submitIdx === -1 ? lastSecretIdx : submitIdx;
    preamble = steps.slice(0, end + 1).map((s) => s.id);
  } else {
    warnings.push(
      'No credential entry was detected, so no authentication preamble was recorded. ' +
        'A session-expiry recovery will not be able to re-authenticate.',
    );
  }

  /* --- parameters -------------------------------------------------------- */

  const declByName = new Map((opts.paramDeclarations ?? []).map((d) => [d.name, d]));
  const inputs: ParamSpec[] = [];

  for (const name of [...usedParams].sort()) {
    const decl = declByName.get(name);
    const isSecret = secretNames.has(name);
    const spec: ParamSpec = {
      name,
      type: decl?.type ?? 'string',
      required: true,
      description:
        decl?.description ??
        (isSecret ? `Credential '${name}', supplied from the caller's secret store.` : `Input parameter '${name}'.`),
      sensitivity: decl?.sensitivity ?? (isSecret ? 'secret' : 'none'),
    };
    if (decl?.pattern) spec.pattern = decl.pattern;
    // Never carry an example for a sensitive parameter: the catalogue is a
    // human-readable surface and must not become a place PII accumulates.
    if (decl?.example && spec.sensitivity === 'none') spec.example = decl.example;
    inputs.push(spec);
  }

  /* --- success checkpoint ------------------------------------------------ */

  let successCheckpoint: Assertion;
  if (outcome.checkpointText) {
    successCheckpoint = A.text(outcome.checkpointText);
  } else {
    const finalHeading = headings(outcome.finalObservation)[0];
    successCheckpoint = finalHeading ? A.text(finalHeading) : A.url(escapeRegex(outcome.finalObservation.url));
    warnings.push(
      'The run did not nominate checkpoint text; the success condition was inferred from the final screen and should be reviewed.',
    );
  }

  if (outputs.length === 0) {
    warnings.push('This capability declares no outputs. Callers will receive success/failure only.');
  }

  /* --- assemble ---------------------------------------------------------- */

  const artifact: CapabilityArtifact = CapabilityArtifactSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    name: opts.name,
    version: opts.version,
    title: opts.title,
    description: opts.description,
    // Always draft. An LLM-authored flow reaching production without a human
    // looking at it would make the rest of the guardrails decorative.
    status: 'draft',
    app: {
      productId: opts.productId,
      ...(opts.productVersion ? { productVersion: opts.productVersion } : {}),
      surface: 'web',
      baseUrl: opts.baseUrl,
    },
    inputs,
    outputs,
    outcomes: library.outcomes,
    steps,
    successCheckpoint,
    outcomeRules: library.outcomeRules,
    recoveries: library.recoveries,
    authPreambleStepIds: preamble,
    overrides: [],
    provenance: {
      discoveryRunId: opts.runId,
      recordedAt: new Date().toISOString(),
      model: opts.model,
      provider: opts.provider,
      goal: outcome.goal,
      recordedOnTenant: opts.tenantId,
      ...(opts.evidencePath ? { evidencePath: opts.evidencePath } : {}),
      canonicalizationNotes,
    },
    stability: {},
  });

  return { artifact, warnings };

  /* ------------------------------------------------------------ builders */

  function buildStep(action: RecordedAction): Step | null {
    const id = `s${String(action.seq).padStart(2, '0')}_${action.kind}`;

    if (action.kind === 'wait') return null;

    if (action.kind === 'navigate') {
      const url = canonicalizeUrl(action.value ?? action.urlAfter, opts.baseUrl, opts.params);
      if ('template' in url) {
        canonicalizationNotes.push(`navigate: ${action.urlAfter} -> ${url.template}`);
        for (const name of Object.keys(opts.params)) {
          if (url.template.includes(`\${${name}}`)) usedParams.add(name);
        }
      }
      const navCheckpoint = checkpointFor(action);
      return {
        id,
        intent: action.intent,
        action: { type: 'navigate', url },
        risk: 'safe',
        outcomeRules: [],
        recoveries: [],
        timeoutMs: 15_000,
        optional: false,
        ...(navCheckpoint ? { checkpoint: navCheckpoint } : {}),
      };
    }

    const node = action.node;
    if (!node) {
      warnings.push(`Step ${id} acted on no identifiable control and was dropped.`);
      return null;
    }

    const capture = captureTarget(node, action.observation, {
      paramValues: opts.params,
      // Never let a risky click fall back to a positional CSS path. If the
      // stable rungs cannot find the button that opens an account, the correct
      // behaviour is to stop, not to click wherever that button used to be.
      ...(action.risk === 'irreversible' ? { maxRank: 4 } : {}),
    });

    if (!capture.verified) {
      warnings.push(
        `Step ${id} ("${action.intent}"): the recorded locator could not re-find its own element. ${capture.notes.join('; ')}`,
      );
    }
    for (const note of capture.notes) {
      if (note.startsWith('row anchored')) canonicalizationNotes.push(`${id}: ${note}`);
    }

    // A row anchor bound to a parameter is a used parameter.
    const scope = capture.target.scope;
    if (scope?.kind === 'tableRow' && 'param' in scope.matchValue) usedParams.add(scope.matchValue.param);

    let act: Action;
    switch (action.kind) {
      case 'click':
        act = { type: 'click', target: capture.target };
        break;

      case 'fill': {
        const value = valueExprFor(action.value ?? '', opts.params, action.secretRef);
        if ('param' in value) usedParams.add(value.param);
        if ('template' in value) {
          for (const name of Object.keys(opts.params)) {
            if (value.template.includes(`\${${name}}`)) usedParams.add(name);
          }
        }
        act = { type: 'fill', target: capture.target, value, clearFirst: true };
        break;
      }

      case 'select': {
        const value = valueExprFor(action.value ?? '', opts.params);
        if ('param' in value) usedParams.add(value.param);
        act = { type: 'select', target: capture.target, value };
        break;
      }

      case 'extract': {
        const name = action.outputName!;
        const looksLikeMoney = /^\$?[\d,]+\.\d{2}$/.test((action.extractedValue ?? '').trim());
        outputs.push({
          name,
          type: looksLikeMoney ? 'money' : 'string',
          description: action.intent,
          producedByStep: id,
          required: true,
          sensitivity: 'none',
        });
        act = {
          type: 'extract',
          target: capture.target,
          into: name,
          from: 'text',
          transform: 'trim',
        };
        break;
      }

      default:
        return null;
    }

    const checkpoint = checkpointFor(action);
    return {
      id,
      intent: action.intent,
      action: act,
      risk: action.risk,
      outcomeRules: [],
      recoveries: [],
      timeoutMs: 15_000,
      optional: false,
      ...(checkpoint ? { checkpoint } : {}),
    };
  }

  /**
   * Synthesise "did this step land?" from what actually changed on screen.
   *
   * A newly-appeared heading is the best available signal in this kind of app:
   * it is the thing a human operator uses to know they got somewhere, it is
   * stable across sessions, and it is absent on the error screens. A URL change
   * is the fallback. If neither happened, no checkpoint is emitted rather than
   * a vacuous one -- an assertion that always passes is worse than none,
   * because it reads like verification.
   */
  function checkpointFor(action: RecordedAction): Assertion | undefined {
    if (action.kind === 'extract') return undefined;

    const before = new Set(headings(action.observation));
    const appeared = headings(action.observationAfter).filter((h) => !before.has(h));
    if (appeared.length > 0) return A.text(appeared[0]!);

    if (action.urlAfter !== action.urlBefore) {
      const path = urlPath(action.urlAfter, opts.params);
      if (path) return A.url(path);
    }
    return undefined;
  }
}

/** Path-only regex for a URL checkpoint, with parameter values generalised. */
function urlPath(url: string, params: Record<string, string>): string | undefined {
  try {
    const u = new URL(url);
    let p = u.pathname;
    for (const value of Object.values(params)) {
      if (value.length >= 2 && p.includes(value)) p = p.split(value).join('[^/]+');
    }
    return escapeRegex(p).replace(/\\\[\\\^\\\/\\\]\\\+/g, '[^/]+');
  } catch {
    return undefined;
  }
}
