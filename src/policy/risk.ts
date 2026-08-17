/**
 * Risk classification.
 *
 * Someone has to decide, at record time, which steps can move money. The model
 * cannot be trusted to self-report that reliably, and asking a human to
 * annotate every step of every capability does not scale to thousands of app
 * instances. So the recorder applies a conservative heuristic and the human
 * confirms it once, at approval time, when they review the artifact.
 *
 * The heuristic is intentionally biased toward over-classification: a control
 * whose label sounds consequential is treated as irreversible. Over-classifying
 * costs an approval prompt. Under-classifying costs an unintended account
 * opening at a credit union. Those are not symmetric, so the tie goes to
 * caution, and REPORT.md section 6 is explicit that this is a heuristic with a
 * human backstop rather than a guarantee.
 *
 * Note the asymmetry between links and buttons. In a server-rendered app a
 * link is a GET and a button is usually a POST, which maps closely enough onto
 * "reads state" versus "changes state" to be a useful prior.
 */

import type { Risk } from '../schema/artifact.ts';
import type { UiNode } from '../surface/types.ts';
import type { ActionType } from './config.ts';

/**
 * Verbs that, on a banking back-office screen, indicate an action the
 * institution cannot quietly undo.
 */
const IRREVERSIBLE_VERBS =
  /\b(open|create|add|submit|post|transfer|withdraw|deposit|pay|send|delete|remove|close|approve|authoriz|authoris|confirm|issue|reverse|void|charge)\w*\b/i;

/** Controls that clearly only move you around or clear a form. */
const BENIGN_CONTROLS = /^(search|find|look ?up|view|open detail|next|previous|back|cancel|reset|clear|continue|home|sign ?on|log ?in|acknowledge[\w\s]*)$/i;

export interface RiskInput {
  actionType: ActionType;
  node?: UiNode | undefined;
}

export function classifyRisk(input: RiskInput): { risk: Risk; reason: string } {
  const { actionType, node } = input;

  switch (actionType) {
    case 'navigate':
    case 'waitFor':
    case 'assert':
    case 'extract':
      return { risk: 'safe', reason: `${actionType} does not modify institution state` };

    case 'fill':
    case 'select':
      // Typing into a field changes nothing until something is submitted.
      return { risk: 'safe', reason: 'entering data into an unsubmitted form is reversible' };

    case 'press':
      // A keypress can submit a form (Enter in a text field commonly does) and
      // we cannot tell statically, so it never counts as safe.
      return { risk: 'stateChanging', reason: 'keypress may submit the enclosing form' };

    case 'click':
      break;
  }

  if (!node) {
    return { risk: 'stateChanging', reason: 'click on an unidentified control' };
  }

  const label = (node.name || node.text || '').trim();

  if (BENIGN_CONTROLS.test(label)) {
    return { risk: 'safe', reason: `'${label}' is a navigation or search control` };
  }

  if (node.role === 'link') {
    // A link is a GET in a server-rendered app. It can still be consequential
    // if its label says so, which is why the verb check still applies.
    if (IRREVERSIBLE_VERBS.test(label)) {
      return { risk: 'stateChanging', reason: `link labelled '${label}' suggests a state change` };
    }
    return { risk: 'safe', reason: 'link navigation' };
  }

  if (node.role === 'button') {
    if (IRREVERSIBLE_VERBS.test(label)) {
      return {
        risk: 'irreversible',
        reason: `button labelled '${label}' matches an irreversible-action verb`,
      };
    }
    return { risk: 'stateChanging', reason: `button '${label}' submits a form` };
  }

  return { risk: 'stateChanging', reason: `click on ${node.role}` };
}
