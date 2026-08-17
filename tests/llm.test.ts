/**
 * Provider wire-format tests.
 *
 * These run against a local HTTP server that captures the exact request body
 * and returns a canned response, so they verify the two things a hand-written
 * API client actually gets wrong: the shape we send, and how we read what comes
 * back. They do not prove a live API accepts the request -- only a real call
 * does that -- but the translation layer is where the bugs live, and it is
 * fully covered here.
 *
 * The Anthropic cases matter most: it is the one provider whose format differs
 * from the OpenAI shape everything else speaks, so it is the one place a
 * copy-paste mistake would go unnoticed until someone with an Anthropic key
 * tried to run a discovery.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { AnthropicProvider, toAnthropicMessages } from '../src/agent/llm/anthropic.ts';
import { OpenAICompatibleProvider } from '../src/agent/llm/openai-compatible.ts';
import { createProvider, detectAvailableProviders, MissingApiKeyError } from '../src/agent/llm/factory.ts';
import { LlmError, type LlmRequest } from '../src/agent/llm/provider.ts';

/* ------------------------------------------------------------ mock server */

interface Captured {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

let server: http.Server;
let origin: string;
let captured: Captured | undefined;
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };

before(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      captured = {
        path: req.url ?? '',
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>,
      };
      res.writeHead(nextResponse.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(nextResponse.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

const REQUEST: LlmRequest = {
  system: 'You operate a bank back-office application.',
  messages: [
    { role: 'user', content: 'GOAL: look up member 12345' },
    { role: 'assistant', content: 'I will search.', toolCalls: [{ id: 'tu_1', name: 'click', arguments: { ref: '2#3' } }] },
    { role: 'tool', toolCallId: 'tu_1', name: 'click', content: 'Done. Now at /member-search' },
  ],
  tools: [
    {
      name: 'click',
      description: 'Click a control.',
      parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] },
    },
  ],
};

/* ------------------------------------------------------------- anthropic */

describe('anthropic wire format', () => {
  const provider = () =>
    new AnthropicProvider({ apiKey: 'sk-ant-test', model: 'claude-opus-5', baseUrl: origin });

  test('sends the Anthropic request shape', async () => {
    nextResponse = {
      status: 200,
      body: { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' },
    };
    await provider().complete(REQUEST);

    const b = captured!.body;
    assert.equal(captured!.path, '/messages', 'endpoint is /messages, not /chat/completions');
    assert.equal(captured!.headers['x-api-key'], 'sk-ant-test', 'auth is x-api-key, not a bearer token');
    assert.equal(captured!.headers['anthropic-version'], '2023-06-01', 'version header is required');

    // System prompt is a top-level field, not a message.
    assert.equal(b['system'], REQUEST.system);
    assert.ok(!JSON.stringify(b['messages']).includes('"role":"system"'));

    // Tools are flat, not wrapped in a `function` object.
    const tools = b['tools'] as Array<Record<string, unknown>>;
    assert.equal(tools[0]!['name'], 'click');
    assert.ok(tools[0]!['input_schema'], 'schema key is input_schema');
    assert.equal(tools[0]!['function'], undefined, 'must not use the OpenAI function wrapper');

    assert.deepEqual(b['tool_choice'], { type: 'auto' });
    assert.ok(b['max_tokens'], 'max_tokens is required by the Messages API');
  });

  test('sends no sampling parameters', async () => {
    // temperature/top_p/top_k were REMOVED on the current generation and now
    // return a 400. Sending them would break every call to a current model.
    nextResponse = { status: 200, body: { content: [], stop_reason: 'end_turn' } };
    await provider().complete(REQUEST);

    for (const key of ['temperature', 'top_p', 'top_k']) {
      assert.equal(captured!.body[key], undefined, `${key} must not be sent`);
    }
  });

  test('parses tool_use content blocks into tool calls', async () => {
    nextResponse = {
      status: 200,
      body: {
        content: [
          { type: 'text', text: 'Searching now.' },
          { type: 'tool_use', id: 'toolu_abc', name: 'fill', input: { ref: '2#0', value: '12345' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 120, output_tokens: 45 },
      },
    };

    const res = await provider().complete(REQUEST);
    assert.equal(res.text, 'Searching now.');
    assert.equal(res.toolCalls.length, 1);
    assert.equal(res.toolCalls[0]!.id, 'toolu_abc');
    assert.equal(res.toolCalls[0]!.name, 'fill');
    // Arguments arrive as parsed JSON, unlike the OpenAI string form.
    assert.deepEqual(res.toolCalls[0]!.arguments, { ref: '2#0', value: '12345' });
    assert.equal(res.usage?.promptTokens, 120);
    assert.equal(res.usage?.completionTokens, 45);
    assert.equal(res.finishReason, 'tool_use');
  });

  test('surfaces a safety refusal as an error rather than empty output', async () => {
    nextResponse = {
      status: 200,
      body: { content: [], stop_reason: 'refusal', stop_details: { category: 'cyber' } },
    };
    await assert.rejects(
      () => provider().complete(REQUEST),
      (err: unknown) => err instanceof LlmError && /refusal category: cyber/.test((err as Error).message),
    );
  });

  test('does not retry a 400, which would fail identically forever', async () => {
    nextResponse = { status: 400, body: { error: { message: 'bad request' } } };
    const started = Date.now();
    await assert.rejects(() => provider().complete(REQUEST), LlmError);
    assert.ok(Date.now() - started < 2000, 'a non-transient error must fail fast');
  });
});

describe('anthropic message mapping', () => {
  test('assistant tool calls become tool_use blocks; results become a user tool_result', () => {
    const mapped = toAnthropicMessages(REQUEST.messages);

    assert.equal(mapped.length, 3);
    assert.equal(mapped[0]!.role, 'user');

    const assistant = mapped[1]!;
    assert.equal(assistant.role, 'assistant');
    const blocks = assistant.content as Array<Record<string, unknown>>;
    assert.equal(blocks[0]!['type'], 'text');
    assert.equal(blocks[1]!['type'], 'tool_use');
    assert.equal(blocks[1]!['id'], 'tu_1');
    assert.deepEqual(blocks[1]!['input'], { ref: '2#3' });

    // A tool result is a USER message carrying a tool_result block -- there is
    // no `tool` role in this API.
    const result = mapped[2]!;
    assert.equal(result.role, 'user');
    const rb = (result.content as Array<Record<string, unknown>>)[0]!;
    assert.equal(rb['type'], 'tool_result');
    assert.equal(rb['tool_use_id'], 'tu_1');
  });

  test('drops the system message (it is lifted to the top-level field)', () => {
    const mapped = toAnthropicMessages([
      { role: 'system', content: 'ignored here' },
      { role: 'user', content: 'hi' },
    ]);
    assert.equal(mapped.length, 1);
    assert.equal(mapped[0]!.role, 'user');
  });

  test('merges consecutive tool results into one user message', () => {
    // The API expects every result for one assistant turn to arrive together.
    const mapped = toAnthropicMessages([
      { role: 'assistant', content: '', toolCalls: [
        { id: 'a', name: 'x', arguments: {} },
        { id: 'b', name: 'y', arguments: {} },
      ] },
      { role: 'tool', toolCallId: 'a', name: 'x', content: 'ra' },
      { role: 'tool', toolCallId: 'b', name: 'y', content: 'rb' },
    ]);

    const results = mapped.filter((m) => m.role === 'user');
    assert.equal(results.length, 1, 'both results belong in a single user message');
    assert.equal((results[0]!.content as unknown[]).length, 2);
  });

  test('omits an empty text block, which the API rejects', () => {
    const mapped = toAnthropicMessages([
      { role: 'assistant', content: '   ', toolCalls: [{ id: 'a', name: 'x', arguments: {} }] },
    ]);
    const blocks = mapped[0]!.content as Array<Record<string, unknown>>;
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]!['type'], 'tool_use');
  });

  test('an assistant turn with nothing at all still carries a block', () => {
    const mapped = toAnthropicMessages([{ role: 'assistant', content: '' }]);
    assert.equal((mapped[0]!.content as unknown[]).length, 1);
  });
});

/* ----------------------------------------------------- openai-compatible */

describe('openai-compatible wire format', () => {
  test('sends the OpenAI shape: system as a message, tools under `function`', async () => {
    nextResponse = {
      status: 200,
      body: { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] },
    };
    await new OpenAICompatibleProvider({
      name: 'groq',
      baseUrl: origin,
      apiKey: 'gsk_test',
      model: 'test-model',
    }).complete(REQUEST);

    const b = captured!.body;
    assert.equal(captured!.path, '/chat/completions');
    assert.equal(captured!.headers['authorization'], 'Bearer gsk_test');

    const messages = b['messages'] as Array<Record<string, unknown>>;
    assert.equal(messages[0]!['role'], 'system', 'system is a message here, unlike Anthropic');

    const tools = b['tools'] as Array<Record<string, unknown>>;
    assert.equal(tools[0]!['type'], 'function');
    assert.ok((tools[0]!['function'] as Record<string, unknown>)['parameters']);

    // The tool result uses a dedicated `tool` role here.
    assert.ok(messages.some((m) => m['role'] === 'tool'));
  });

  test('tolerates malformed tool-call JSON instead of crashing the run', async () => {
    nextResponse = {
      status: 200,
      body: {
        choices: [{
          message: { tool_calls: [{ id: 'c1', function: { name: 'click', arguments: '{not json' } }] },
          finish_reason: 'tool_calls',
        }],
      },
    };
    const res = await new OpenAICompatibleProvider({
      name: 'groq', baseUrl: origin, apiKey: 'k', model: 'm',
    }).complete(REQUEST);

    assert.equal(res.toolCalls.length, 1);
    assert.deepEqual(res.toolCalls[0]!.arguments, {}, 'empty args let the loop correct the model');
  });
});

/* ----------------------------------------------------------- the factory */

describe('provider auto-detection', () => {
  test('picks whichever provider has a key, with no configuration', () => {
    assert.equal(createProvider({ ANTHROPIC_API_KEY: 'sk-ant-x' }).name, 'anthropic');
    assert.equal(createProvider({ OPENAI_API_KEY: 'sk-x' }).name, 'openai');
    assert.equal(createProvider({ GROQ_API_KEY: 'gsk_x' }).name, 'groq');
    assert.equal(createProvider({ TOGETHER_API_KEY: 'x' }).name, 'together');
    assert.equal(createProvider({ OPENROUTER_API_KEY: 'x' }).name, 'openrouter');
  });

  test('an explicit LLM_PROVIDER wins over detection order', () => {
    const p = createProvider({ GROQ_API_KEY: 'gsk_x', ANTHROPIC_API_KEY: 'sk-ant-x', LLM_PROVIDER: 'anthropic' });
    assert.equal(p.name, 'anthropic');
  });

  test('defaults to a current Claude model for Anthropic', () => {
    assert.equal(createProvider({ ANTHROPIC_API_KEY: 'k' }).model, 'claude-opus-5');
    assert.equal(createProvider({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_MODEL: 'claude-sonnet-5' }).model, 'claude-sonnet-5');
  });

  test('no key at all produces an actionable message listing every option', () => {
    try {
      createProvider({});
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof MissingApiKeyError);
      const msg = (err as Error).message;
      for (const v of ['GROQ_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) {
        assert.match(msg, new RegExp(v));
      }
    }
  });

  test('naming a provider whose key is absent says so specifically', () => {
    assert.throws(
      () => createProvider({ GROQ_API_KEY: 'gsk_x', LLM_PROVIDER: 'anthropic' }),
      /LLM_PROVIDER is set to 'anthropic' but no key for it was found/,
    );
  });

  test('detection reports every available provider', () => {
    assert.deepEqual(detectAvailableProviders({ GROQ_API_KEY: 'a', OPENAI_API_KEY: 'b' }), ['groq', 'openai']);
    assert.deepEqual(detectAvailableProviders({}), []);
  });
});
