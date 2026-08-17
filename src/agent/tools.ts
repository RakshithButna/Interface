/**
 * The tool surface exposed to the model during discovery.
 *
 * Every tool takes an `intent` string, and that is not decoration. The intent
 * the model states is what becomes `Step.intent` in the artifact -- the plain
 * language a human reviewer reads to decide whether to approve the capability.
 * Asking for it at the moment of the decision produces a far better record than
 * summarising a transcript afterwards, because the model is describing what it
 * is about to do rather than reconstructing why it did it.
 *
 * The tool set is deliberately small. Every additional verb is another thing
 * the replay engine must be able to execute deterministically, so a verb only
 * earns inclusion if it maps onto a recordable `Action`. There is no
 * `execute_javascript`, no `type_at_coordinates`, no free-form escape hatch --
 * anything the model could do through such a tool would be unrecordable, which
 * makes it useless to a system whose output is a replayable artifact.
 */

import type { ToolDefinition } from './llm/provider.ts';

const REF = {
  type: 'string',
  description: "A control ref exactly as listed in the observation, e.g. '2#7'. Never invent one.",
};

const INTENT = {
  type: 'string',
  description:
    'One short sentence: what you are trying to achieve with this action, in business terms ' +
    "(e.g. 'enter the member ID into the search form'). This is recorded for human review.",
};

export const AGENT_TOOLS: ToolDefinition[] = [
  {
    name: 'navigate',
    description:
      'Load a URL directly. Use this only to reach the application entry point. ' +
      'Once inside the app, prefer clicking the visible navigation controls -- a recorded flow ' +
      'that drives the UI the way an operator would is more portable than one built from guessed URLs.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' }, intent: INTENT },
      required: ['url', 'intent'],
      additionalProperties: false,
    },
  },
  {
    name: 'click',
    description: 'Click a link, button or other control.',
    parameters: {
      type: 'object',
      properties: { ref: REF, intent: INTENT },
      required: ['ref', 'intent'],
      additionalProperties: false,
    },
  },
  {
    name: 'fill',
    description: 'Type a value into a text field. Replaces any existing content.',
    parameters: {
      type: 'object',
      properties: {
        ref: REF,
        value: { type: 'string', description: 'The exact text to enter.' },
        intent: INTENT,
      },
      required: ['ref', 'value', 'intent'],
      additionalProperties: false,
    },
  },
  {
    name: 'select',
    description: 'Choose an option in a dropdown. Pass the option value or its visible label.',
    parameters: {
      type: 'object',
      properties: { ref: REF, value: { type: 'string' }, intent: INTENT },
      required: ['ref', 'value', 'intent'],
      additionalProperties: false,
    },
  },
  {
    name: 'extract',
    description:
      'Record a value visible on screen as an OUTPUT of this capability. Use this for every piece ' +
      'of data the goal asks you to read back. The name you choose becomes part of the public ' +
      'contract callers depend on, so use a clear camelCase name such as savingsBalance.',
    parameters: {
      type: 'object',
      properties: {
        ref: REF,
        name: {
          type: 'string',
          description: 'camelCase output name, e.g. savingsBalance or newAccountNumber.',
        },
        intent: INTENT,
      },
      required: ['ref', 'name', 'intent'],
      additionalProperties: false,
    },
  },
  {
    name: 'wait',
    description: 'Pause briefly when a page appears to still be loading. Bounded to 10 seconds.',
    parameters: {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: 'How long to wait, 1-10.' },
        intent: INTENT,
      },
      required: ['seconds', 'intent'],
      additionalProperties: false,
    },
  },
  {
    name: 'done',
    description:
      'Declare the goal achieved. Only call this when the screen in front of you actually shows ' +
      'the end state the goal described, and you have extracted every value the goal asked for.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'What was accomplished, and how you can tell.' },
        checkpointText: {
          type: 'string',
          description:
            'A distinctive piece of text visible on this final screen that proves the goal was reached. ' +
            'This becomes the success condition asserted on every future replay, so choose something ' +
            'that is present on success and absent otherwise.',
        },
      },
      required: ['summary', 'checkpointText'],
      additionalProperties: false,
    },
  },
  {
    name: 'stuck',
    description:
      'Stop and hand off to a human operator. Call this when you cannot make progress, when the ' +
      'screen is not what you expected, or when proceeding would require guessing at something ' +
      'consequential. Stopping is always preferable to guessing on a banking system.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why you cannot proceed, and what you tried.' },
        whatIsNeeded: {
          type: 'string',
          description: 'What a human would need to do to unblock this.',
        },
      },
      required: ['reason', 'whatIsNeeded'],
      additionalProperties: false,
    },
  },
];
