# Evidence

Every run in this directory was produced by the committed code against the local
target app. Nothing here is hand-written.

Each run directory contains:

```
meta.json          what the run was and how it ended
run.jsonl          structured event log, one JSON object per line
transcript.json    (discovery) the model's actions, intents and token usage
artifact.json      (discovery) the capability that was produced
result.json        (replay) the structured result returned to the caller
screenshots/       captured on failure, escalation and business outcomes
snapshots/         DOM + normalised accessibility-tree captures
```

## The discovery run

**`*-discovery-*`** — a genuine LLM-driven run. `groq/openai/gpt-oss-120b`
signed on using secret placeholders (it is never shown the credentials),
traversed the frameset, ran a member search, picked the right row out of the
results grid, opened the member record, and read the savings balance out of a
nested `<iframe>`. `transcript.json` has the model's stated intent for every
action; `run.jsonl` has the raw decisions.

The resulting artifact is `capabilities/member.lookup_savings_balance@1.0.0.json`.

**Read the `review warnings` in `meta.json`.** The model nominated `"$4,281.37"`
— member 12345's balance — as the success condition. That is a value from this
run, not a property of the flow: it would only ever hold for one member. The
recorder detected it, substituted a structural condition (`"Member Detail"`),
and flagged it for the reviewer. Replays 1 and 2 below are what that fix buys.

## The replay runs

No LLM is constructed on any of these. All ten runs use the one artifact above.

| # | Invocation | Result |
|---|---|---|
| 1 | `memberId=12345` | `success`, `savingsBalance: 4281.37` |
| 2 | `memberId=22887` | `success`, `savingsBalance: 15029.9` — different member, no re-recording |
| 3 | `memberId=99999` | `outcome: MEMBER_NOT_FOUND` — a legitimate answer, exit code 0 |
| 4 | `memberId=30001` | `outcome: PERMISSION_DENIED` — restricted record |
| 5 | `--inject interstitial` | `success` + `RECOVERY_APPLIED` — unexpected dialog dismissed |
| 6 | `--inject session_expired` | `success` + `RECOVERY_APPLIED` — re-authenticated mid-flow |
| 7 | `--inject app_error` | `escalated` — deliberately **not** retried; routed to a human |
| 8 | `--tenant lakeshore` | `success` — second institution, same vendor product, overrides only |
| 9 | agent invocation by tool name | `success`, `savingsBalance: 15029.9` |

Runs 3–7 are the error/exceptional-state demonstrations the brief asks for.
Run 7 also writes `intervention-*.json` with the full context a human operator
would receive.

## Redaction

- No credential value appears in any file here or in the artifact. The password
  is referenced as `{{secret:operatorPassword}}` during discovery and as
  `{"param": "operatorPassword"}` in the artifact.
- The member ID is declared `pii`, so logs show `***2345` rather than the raw
  value — last-4 is kept deliberately so a failure can still be traced to a
  record.
- The artifact's `description` and `provenance.goal` are generalised to
  `${memberId}` rather than naming a concrete member, because the artifact is
  committed to version control.

Screenshots are captured whole and are **not** pixel-redacted; a screenshot of a
member detail page contains PII by construction. This directory should be
treated as regulated data. That limit is stated in REPORT.md §6.
