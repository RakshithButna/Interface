# Design write-up

## 1. Architecture

The system is one idea in three stages: **the model discovers, the artifact becomes a reusable capability, deterministic replay is how an agent invokes it in production.** Everything below follows from taking that separation seriously — in particular, from the rule that *nothing on the replay path may import anything on the discovery path.* Replay constructs no LLM client, reads no API key, and would run identically if `src/agent/` were deleted.

```
                    ┌─────────────── discovery (once, expensive, non-deterministic) ──────────────┐
  goal + params ──▶ │  agent loop  ──▶  observe/decide/act  ──▶  transcript                       │
                    └────────────────────────────────┬───────────────────────────────────────────┘
                                                     ▼
                                            recorder  ──▶  capability artifact (typed, versioned, reviewable)
                                                     │
                    ┌────────────────────────────────▼───────────────────────────────────────────┐
  agent invocation  │  replay engine  ──▶  resolve/act/verify  ──▶  ReplayResult                 │
  (name + args)     └────────────────────────────────────────────────────────────────────────────┘

  shared substrate:   Surface (perceive/act)  •  Guard (allowlist, risk)  •  Redactor  •  SessionController
```

**The load-bearing boundary is `Surface`** (`src/surface/types.ts`). It exposes `observe(): Observation` returning a normalised, accessibility-tree-shaped `UiNode[]`, and `perform(op)` taking an opaque `ref` minted during that observation. Everything above it — the targeting resolver, the assertion evaluator, the recorder, the replay engine, the agent loop — operates on `UiNode` and has no idea Playwright exists. That is what makes the desktop story in §4 a change of one directory rather than a rewrite.

**Perception is the accessibility tree, not screenshots.** This is the "computer use" decision the brief cares about, and I made it on three grounds. First, it is the representation that exists on *both* web and desktop (UIAutomation, AX), so it does not paint the design into the browser. Second, and more decisively: to record a durable artifact you must know the *identity* of the control that was acted on. Clicking at `(412, 233)` yields nothing recordable; clicking node `2#7` yields a role, an accessible name, a form-field name, and a table row. A screenshot-and-coordinates loop is structurally incapable of producing a replayable artifact. Third, legacy frameset-and-table software carries essentially no visual information the markup lacks. The honest limit is a canvas-rendered surface, which has no meaningful a11y tree — that would need a vision/OCR `Surface` implementation, and the fact that it plugs in *there* is the point.

**Single process**, which the brief explicitly permits with justification. The justification is that a human must take control of the *same live browser session*; brokering that across a process boundary is a real production problem but adds plumbing here without exercising any idea being evaluated. `SessionController` is already the only thing that decides who may act, so putting it behind an RPC later touches one file.

**Trade-off I'd flag:** refs are element *handles*, not selectors, so an observation is only valid until the page changes. Re-querying by selector between observing and acting is how automation clicks a different element than the one it reasoned about — especially in a grid. I chose to fail loudly on an expired handle rather than silently re-resolve.

## 2. Artifact schema

`src/schema/artifact.ts`. The framing that shaped it is the brief's own: a capability an agent can call *"needs a clear contract, not just a step list."* So the schema is organised **contract first** (`inputs`, `outputs`, `outcomes`, `successCheckpoint`) and **implementation second** (`steps`). A calling agent should be able to decide whether to invoke a capability by reading only the contract half. The catalogue enforces this literally: `toToolDefinition()` emits a function-calling schema containing the description, typed args, declared outputs and declared outcomes — and no step, selector or frame path. A test asserts that.

Four decisions I'd defend:

**Declared business outcomes are part of the contract, not error handling.** `MEMBER_NOT_FOUND` is enumerated alongside outputs, and `ReplayResult` makes it a distinct `status: 'outcome'`, not an exception. The brief names conflating these as the most common mistake here; making the distinction *structural* means a caller cannot accidentally treat it as a crash. `exitCodeFor()` returns 0 for a business outcome.

**The artifact is decoupled from the transcript.** No prompts, completions or model reasoning are stored — `provenance` carries a pointer to the run and that is all. The transcript is evidence; the artifact is a contract, and mixing them makes the contract unreviewable.

**Targeting is a three-part model** (`src/schema/targeting.ts`): `frame` (which document), `scope` (which region — crucially, which table *row*), and a ranked `strategies` ladder. Collapsing these into one selector string is the standard design and it fails on legacy grids: every row contains an identical "View" link, so no selector distinguishes them but a *scope* does. The ladder is ordered by one principle — **prefer the identifier the application itself depends on, then the one a human depends on, then raw structure**: `testId` → `formField` → `roleName` → `label` → `text` → `structural`. `formField` (the `name` attribute) is deliberately ranked above accessible name for inputs, because on a server-rendered app it is a contract *with the server* — renaming it breaks form submission — which makes it far more stable than any visible label. It is not ranked first overall because it does not port to desktop.

**Risk is per step**, so a reviewer reading the artifact can see exactly which steps can move money before approving it.

One thing worth calling out because it is not obvious: the recorder does **not** invent the error vocabulary. A happy-path run cannot discover failure screens — the model never sees one. So business outcomes and recovery rules are authored once per **vendor product** (`config/outcomes/memberfirst-core.json`) and attached at record time. That is also the correct unit of reuse: error screens are a property of the product, not the institution, so one file serves every capability on every tenant.

## 3. Determinism & error handling

Determinism comes from four places: the ladder resolves by *unique match* (a strategy matching several elements is treated as a miss, never "take the first"); row scopes bind to input parameters rather than positions; every step asserts a checkpoint; and no model participates in any decision.

The sharpest bug I hit building this is worth recording, because it is exactly the failure the design exists to prevent. Capture originally accepted an unscoped descriptor whenever it resolved uniquely. In a results grid, the `structural` rung matches exactly one element via `tr:nth-of-type(2)` — so the descriptor "verified" perfectly at record time and then resolved to *row 2 forever*, ignoring `memberId` entirely. The fix is two rules: a descriptor may only skip a row scope if a **stable** rung (rank ≤ `label`) resolved it uniquely; and a row-scoped descriptor never retains a `structural` fallback, because positional coordinates and row anchoring express contradictory intents and the dangerous one would silently rescue the safe one's failure. A second refinement followed: a **parameter-based** anchor is applied even when the element is already unique, because uniqueness observed at record time is a property of that run's *data*, not of the flow.

**The error taxonomy** is enforced by pipeline ordering in `src/replay/engine.ts`:

| category | detection | response |
|---|---|---|
| **business outcome** | declared detector matches, checked *before* the checkpoint and both before and after each action | end cleanly, `status:'outcome'` with the code and disposition |
| **recoverable** | declared recovery rule matches | apply bounded fix, re-observe, continue; reported as a `warning`, never hidden |
| **hard failure** | target not found/ambiguous, checkpoint failed, timeout, recovery exhausted, policy violation | stop, capture evidence, `status:'failed'` with step / expected / observed |

Ordering matters more than it looks: outcome detection runs **before** checkpoint verification, otherwise "no member records matched" surfaces as `CHECKPOINT_FAILED` — a debuggable-looking error for something that is not an error. Recoverable conditions deliberately do **not** appear as a top-level status: a condition successfully recovered from did not change the run's outcome, and forcing callers to handle a case that resolved itself would be noise. One that could not be recovered from becomes `RECOVERY_EXHAUSTED`.

Recovery is bounded per rule per run — unbounded retry against a system of record is not resilience — and the rules encode judgement, not just mechanism. `app-error-escalate` deliberately does *not* retry: re-submitting after an unknown server-side failure risks duplicating a transaction that may have partially applied, so it routes to a human instead.

**Drift** is handled secondarily but explicitly. Capture records which rung won (`recordedRank`); if replay resolves via a weaker rung, the step still succeeds and the run emits `LOCATOR_DRIFT`. That is a leading indicator available *before* the capability breaks, and it feeds the approval decision.

Two subtle bugs the tests caught and I'd have shipped otherwise: route aliases applied sequentially let a short alias re-match text a longer one had just written (`member-search` → `members/find` → `members/details/find`), now a single pass; and `frame: []` was conflated with "frame omitted", which silently turned "search any frame" into "top document only" and stopped every recovery rule from firing in a frameset app.

## 4. Heterogeneity & multi-tenant

**Surface abstraction.** The seam is `Surface` + `UiNode`. A `DesktopSurface` driving UIAutomation/AX produces the same node shape from a completely different source; the resolver, assertions, recorder and replay engine work unchanged, which the unit tests demonstrate incidentally by exercising all of them on synthetic observations with no browser present. The ladder degrades gracefully: `role`/`name` exist on desktop, `formField` and `structural` do not and simply never match — so a web-recorded artifact does not become *unportable*, it becomes *weaker*, and the drift signal says so. A legacy web app needs nothing new; it is what I built against.

**Multi-tenant.** The rule is that specialization is **data, not a fork**, and it lives at two levels:

- `config/tenants/<productId>/<tenantId>.json` — per product+tenant, applies to *every* capability recorded against that product.
- `artifact.overrides[]` — per capability+tenant, for a quirk affecting one flow at one institution.

The product-level file is the load-bearing one, and the reason is a scaling property: the work required when a tenant rebrands must be proportional to the number of *tenants*, not the number of *recorded flows*. An institution that renamed "Member ID" to "Membership Number" renamed it everywhere; that is one file edited once, not one edit per artifact.

Overrides are applied at **resolve time**, not by rewriting the artifact, so the stored recording stays canonical and a fix to the base flow propagates to every tenant automatically. Aliases rewrite human-facing text (`roleName.name`, `label`, `text`, `columnCell`, row `matchColumn`) but **never** machine identifiers (`formField`, `testId`, `structural`) — those are identical across installs of one product, and aliasing them would break the very tenant they were meant to fix.

Three shapes of drift cover nearly everything: *they renamed a field* (label aliases), *they changed a route* (route aliases), *they added a screen*. The third is deliberately **not** a tenant-specific step. Lakeshore's post-sign-on compliance acknowledgement is handled by the product-level `acknowledge-compliance-notice` recovery rule, because an extra mandatory screen is operationally identical to an unexpected interstitial — which means a tenant toggling that setting needs no change at all. This is demonstrated, not asserted: one artifact recorded against Westside replays successfully against Lakeshore (different branding, labels, route slugs, product version, and that extra screen) with no re-recording.

Drift detection across tenants uses the same signal as §3: if a tenant resolves consistently via weaker rungs, its aliases are stale. A tenant needing many *step patches* rather than aliases is the signal it has diverged enough to deserve its own recording.

## 5. Escalation & handoff

The control model is a **lease**. Exactly one party holds it; automation asserts it before every action and throws otherwise. Enforcement sits at the same chokepoint as the guardrails rather than being a convention.

**Detecting stuck** has three sources: the agent calls `stuck` during discovery (the prompt tells it that on a banking system stopping is always better than guessing); policy requires a human for a risky step; or a recovery rule routes to a human explicitly. All three produce the same `InterventionRequest`, carrying the capability, goal, tenant, step id and intent, why it stopped, the current URL, and evidence captured at the moment of stopping — screenshot, DOM snapshot, and the normalised a11y snapshot. That third one is the most useful in practice: the screenshot shows what a human would have seen, the node list shows what the *system* saw, and the discrepancy between them is usually the cause.

**Taking control is real.** Automation releases the lease the instant it asks for help — holding it while blocked is how a human ends up fighting an automation that thinks it is still driving. The operator drives the actual live Chromium window: same context, same cookies, same server-side session, same record open on screen. Nothing is proxied or reconstructed. Their actions are captured by capture-phase listeners installed in every frame and reinstalled on navigation, with values redacted *in the page* before crossing back into Node — a password field reports that it was filled and never with what.

**Handing back** returns the lease and the run resumes on the same session, re-verifying its checkpoint rather than assuming the human did what it hoped.

Escalation is split into `raise()` (records and returns immediately) and `awaitResolution()` (blocks). Same request, same state machine, two callers — and the split is the honest part of the design: a production agent invocation gets `status:'escalated'` with an intervention id and does *not* hold a browser open waiting for someone to notice, while an attended run or the demo blocks.

**What is mocked:** the console itself. No auth, no tenant scoping, no work queue, no video. The *mechanism* — lease, request, live-session takeover, action capture, resume — is real.

## 6. Safety

**Allowlist** (`config/policy.json`, enforced in `src/policy/guard.ts`) covers origins, path globs, denied paths, and permitted action types, checked at the single `act()` chokepoint used by *both* the model and the replay engine. A policy that only constrains the model is not a policy, because the artifact the model produced is what actually runs. It is re-checked **after** navigation, because an allowed URL can redirect somewhere disallowed and that is the case actually worth catching. The app's own fault-injection endpoint is explicitly denied, so the agent cannot arm its own failures.

**Risk.** Three classes; `irreversible` escalates to a human in *both* attended and unattended modes — a capability that opens an account does not get to do so unsupervised just because a human started the run. Classification is a label-verb heuristic biased toward over-classification: over-classifying costs an approval prompt, under-classifying costs a compliance event, and those are not symmetric. It is a heuristic with a human backstop at approval time, not a guarantee.

**Data handling.** Redaction is driven by the *declared sensitivity of the parameter*, not by the call site, so a developer cannot forget. `secret` is removed entirely; `pii` keeps its last 4 characters, because a log where every member ID reads `[REDACTED]` cannot be used to trace which record a failure happened on, which makes the system unoperable in exactly the situation you need logs for. Credentials are never shown to the model at all — it passes `{{secret:operatorPassword}}` and the loop substitutes the value immediately before it reaches the surface, so the transcript, the logs and the artifact contain the placeholder by construction rather than by discipline. A test asserts no credential value appears anywhere in a recorded artifact.

**Approval gating.** Every recording is born `draft`, and unattended invocation of a non-approved capability is refused with `NOT_APPROVED`. Letting an LLM-authored flow reach production unreviewed would make the rest of the guardrails decorative.

**Limits I'd state plainly.** The risk heuristic reads labels and can be fooled by a badly-named button. Redaction cannot catch sensitive data it was never told about and that matches no pattern — screenshots in particular are captured whole, so a screenshot on a member detail page contains PII and the evidence directory must be treated as regulated data (it is written under the same redactor for text, but pixels are not redacted). The allowlist is origin/path level, not intent level: an action inside an allowed route that happens to be destructive is caught by the risk layer, not the allowlist. And nothing here defends against a compromised target application.

## 7. Cuts

**Deliberately cut, with the seam left real:**

- **Operator console depth.** Minimal UI, no auth, no queue, no co-browsing video. The control-transfer mechanism is real; the console is a window onto it.
- **Desktop surface.** Not built. `Surface`/`UiNode` is the seam and is exercised by tests that run entirely without a browser, which is the evidence that it is a real boundary rather than a hopeful one.
- **A second LLM provider.** The provider interface exists and `OpenAICompatibleProvider` already serves Groq, OpenAI, Together and vLLM via `baseUrl`. I chose not to ship an untested Anthropic adapter — an untested second code path is a liability, not a feature.
- **Region scoping** is approximated by proximity to a heading. Adequate for panelised legacy layouts; would need real containment for a denser UI.
- **Persistence and scale infrastructure.** Artifacts are JSON files, and I would keep them that way well past the toy scale: they are *reviewed artefacts* that should live in version control, diff in a pull request, and carry the same change-control trail as code — a property a database row does not have. The brief is explicit that building queues and clusters is not rewarded.
- **Nested tables.** `closest('table')` resolves the innermost table; a grid nested inside a cell of another grid would confuse row anchoring.

**What I'd build next, in order:**

1. **Assisted fallback on replay failure** — a bounded, policy-checked, single-step LLM recovery, recorded as evidence and never open-ended. The seam is already there: a hard failure has the step, the expected condition and the observed state, which is exactly the context such a call needs.
2. **Multi-run stability signal.** `Stability` already counts the four result kinds separately (business outcomes deliberately count as *working*, not flakiness); an N-run flake report would make `approve` a genuinely quantitative gate.
3. **Canonicalisation of a capability into a page-object/test snippet**, so a recorded flow can be handed to an engineer rather than only to an agent.
4. **Session service.** Move `SessionController` behind an RPC and address browser sessions by id, which is what makes the operator console a real multi-operator product.
