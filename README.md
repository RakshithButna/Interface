# Computer-use automation

An LLM works out how to complete a task inside a real UI that has no API. The successful run is recorded as a typed, versioned **capability artifact**. That artifact then replays **deterministically, with no model in the decision loop**, and returns a structured result an AI agent can act on.

> **The model discovers. The artifact becomes a reusable capability. Deterministic replay is how the agent invokes it in production.**

Design decisions and trade-offs are in **[REPORT.md](REPORT.md)**. Evidence from real runs is in **[evidence/](evidence/)**.

---

## What it runs against

A local stand-in called **MemberFirst Core** (`apps/memberfirst-core/`) — a bank back-office servicing app built to be *hostile* in the ways the brief describes: server-rendered, a real `<frameset>`, a nested `<iframe>`, table-based layout, no test IDs, and form fields whose labels sit in an adjacent `<td>` rather than a `<label for>` (so most inputs have **no** computed accessible name at all).

It was built locally rather than using a public demo site for one reason: the hardest requirement is how replay handles *runtime exceptional states*, and you cannot make a public site produce a permission denial or a session timeout on demand. Here they are first-class and armable.

It serves **two tenants running the same vendor product**, configured differently — different branding, field labels, route slugs, product version, minimum deposit policy, and one with a mandatory compliance screen after sign-on:

| tenant | URL | product |
|---|---|---|
| `westside` | `http://127.0.0.1:4173/t/westside/` | MemberFirst Core v7.2.1 |
| `lakeshore` | `http://127.0.0.1:4173/t/lakeshore/` | Lakeshore CU — Core Servicing v6.9.4 |

All data is synthetic. No real credentials, no real PII, no real institution.

---

## Setup

Requires **Node 20+** (developed on 26; TypeScript runs natively, no build step).

```bash
npm install
npx playwright install chromium
```

### Configuration

Only the **discovery** run needs a model. Replay never reads an API key.

```bash
cp .env.example .env
```

Then put a key in `.env`. A **free** Groq key from <https://console.groq.com/keys> is enough:

```
LLM_PROVIDER=groq
GROQ_API_KEY=gsk_...
GROQ_MODEL=moonshotai/kimi-k2-instruct
```

`OPENAI_API_KEY` with `LLM_PROVIDER=openai` also works — the agent loop is written against a provider interface and both are served by the same OpenAI-compatible client.

Because perception is the **accessibility tree** rather than screenshots, a text-only model is sufficient. See REPORT.md §1 for why that is the stronger choice here rather than a compromise.

`.env` is gitignored, and the redactor scrubs secrets from every log, artifact and snapshot.

### Running without live services

- **No model key?** Everything except discovery works. `npm test` covers the whole record → replay pipeline against a real browser with no LLM (`tests/fixtures/scripted-run.ts` scripts the same surface actions the model performs). The committed artifact in `capabilities/` replays as-is.
- **No network?** Nothing reaches the internet except the LLM call. The target app is local.

---

## Demo path

Four terminals' worth of commands, in order. **Start the app first and leave it running:**

```bash
npm run app          # http://127.0.0.1:4173
```

### 1. Discovery — an LLM drives the real UI and the run is recorded

```bash
npm run cli -- discover \
  --goal "Look up member 12345 and read their current savings balance" \
  --name member.lookup_savings_balance \
  --param memberId=12345 \
  --declare 'memberId:string:pii:The member identifier to look up.' \
  --tenant westside
```

A Chromium window opens and you can watch the model work. It signs on (using `{{secret:...}}` placeholders — it is never shown the credentials), navigates the frameset, searches, picks the right row out of the results grid, opens the member record, and reads the balance out of the nested iframe. On success it writes `capabilities/member.lookup_savings_balance@1.0.0.json` and a full evidence directory.

Add `--headless` to run without a window, `--console` to expose the operator console for escalations.

### 2. Inspect the capability

```bash
npm run cli -- catalog list
npm run cli -- catalog show member.lookup_savings_balance
npm run cli -- catalog tools     # the JSON tool schema an AI agent would be given
```

`catalog tools` is worth a look: it contains the description, typed arguments, declared outputs and declared *business outcomes* — and no step, selector or frame path. The calling agent gets a contract, not an implementation.

### 3. Replay — deterministic, no LLM

```bash
npm run cli -- replay member.lookup_savings_balance --param memberId=12345 --mode attended
```

Then prove it is parameterised, not a recording of one member:

```bash
npm run cli -- replay member.lookup_savings_balance --param memberId=22887 --mode attended
```

### 4. Replay hitting exceptional states

Each of these is a *different* category of result — that distinction is the point.

```bash
# A legitimate business outcome, NOT a crash. Exit code 0.
npm run cli -- replay member.lookup_savings_balance --param memberId=99999 --mode attended

# A restricted record -> PERMISSION_DENIED business outcome.
npm run cli -- replay member.lookup_savings_balance --param memberId=30001 --mode attended

# An unexpected interstitial mid-flow -> recovered from, and reported as a warning.
npm run cli -- replay member.lookup_savings_balance --param memberId=12345 --inject interstitial --mode attended

# Session expires mid-flow -> re-authenticates on the same session and completes.
npm run cli -- replay member.lookup_savings_balance --param memberId=12345 --inject session_expired --mode attended

# An unhandled app error -> deliberately NOT retried; escalates to a human.
npm run cli -- replay member.lookup_savings_balance --param memberId=12345 --inject app_error --mode attended

# Input contract violation -> rejected before the browser is even touched.
npm run cli -- replay member.lookup_savings_balance --param memberId=oops --mode attended
```

### 5. Human-in-the-loop escalation on the live session

```bash
npm run cli -- replay member.lookup_savings_balance \
  --param memberId=12345 --inject app_error --wait-human 600
```

The run raises an intervention and **releases the session lease**. Open the console it prints (`http://127.0.0.1:4180`), click into the intervention to see why it stopped plus a live screenshot, press **Take control**, then switch to the Chromium window the automation opened — it is the same session, same cookies, same page. Everything you click is recorded and appears in the console. Press **Hand back & resume** and automation continues on that same session, re-verifying its checkpoint.

### 6. Cross-tenant reuse — one recording, a second institution

```bash
npm run cli -- replay member.lookup_savings_balance --param memberId=12345 --tenant lakeshore --mode attended
```

Same artifact, no re-recording. Lakeshore has different branding, different field labels ("Membership Number", "Savings Bal."), different route slugs (`members/find`), a different product version, and an extra compliance screen after sign-on. It is absorbed by `config/tenants/memberfirst-core/lakeshore.json` plus a product-level recovery rule.

### 7. Approval gating and agent invocation

Unattended invocation of an unapproved capability is refused:

```bash
npm run cli -- replay member.lookup_savings_balance --param memberId=12345 --mode unattended
#   FAILED ... NOT_APPROVED

npm run cli -- catalog approve member.lookup_savings_balance
```

Then invoke it the way an agent would — by tool name, with typed JSON args:

```bash
npm run cli -- catalog invoke member__lookup_savings_balance --args '{"memberId":"22887"}'
```

---

## Tests

```bash
npm test        # 82 tests
npm run typecheck
```

`tests/pipeline.test.ts` is the one that matters: it records a capability from a live browser run and replays it through the happy path, two business outcomes, interstitial recovery, session-timeout re-authentication, the approval gate, an input-contract violation, and a second tenant — all without an LLM.

---

## Layout

```
apps/memberfirst-core/    the hostile legacy target app (2 tenants, injectable faults)
capabilities/             recorded capability artifacts (one JSON per name@version)
config/
  policy.json             allowlist, risk dispositions, redaction, limits
  outcomes/<product>.json  business-outcome + recovery vocabulary, per VENDOR PRODUCT
  tenants/<product>/<tenant>.json   per-tenant label/route overrides
evidence/                 discovery and replay runs: logs, artifacts, screenshots, snapshots
src/
  schema/                 artifact, targeting, assertions, result contract   <- the core models
  surface/                Surface abstraction + Playwright web implementation
  targeting/              descriptor capture + resolver ladder
  runtime/                bindings, assertion evaluation, tenant overrides
  agent/                  LLM discovery loop, tools, provider interface       (discovery only)
  record/                 transcript -> capability artifact
  replay/                 deterministic replay engine + error taxonomy        (no LLM)
  policy/                 allowlist, risk classification, redaction
  escalation/             session lease, operator console, human action capture
  catalog/                artifact store + agent-facing tool schemas
  cli/
```

## Notes

- `/_control/*` on the target app is a **test affordance** for arming faults, not a product feature. The agent's allowlist explicitly denies it so it cannot arm its own failures.
- Runs write to `evidence/<runId>/`. Committed evidence is kept; ad-hoc runs are gitignored under `runs/`.
