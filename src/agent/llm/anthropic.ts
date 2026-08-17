/**
 * Anthropic Messages API client.
 *
 * Anthropic is NOT OpenAI-compatible, which is exactly why this file exists
 * rather than another `baseUrl` entry in the factory. Four things differ:
 *
 *   - The system prompt is a top-level `system` field, not a message.
 *   - Tools are `{name, description, input_schema}` -- not wrapped in a
 *     `function` object.
 *   - Tool calls come back as `tool_use` CONTENT BLOCKS inside the assistant
 *     message, not as a parallel `tool_calls` array, and their arguments are
 *     already-parsed JSON rather than a string that needs parsing.
 *   - Tool results go back as a `tool_result` block inside a USER message,
 *     not as a dedicated `tool` role.
 *
 * One non-obvious constraint worth recording, because it is a 400 rather than
 * a degradation: `temperature`, `top_p` and `top_k` were REMOVED on the current
 * generation (Opus 5, Sonnet 5, Opus 4.8/4.7, Fable 5) and sending any of them
 * fails the request outright. The OpenAI-compatible client in this directory
 * sends `temperature: 0` for determinism; doing the same here would break every
 * call. So this client sends no sampling parameters at all.
 *
 * Similarly, thinking is left at its default rather than disabled. Disabling it
 * on Opus 5 has a documented failure mode where the model occasionally writes a
 * tool call into its visible text instead of emitting a `tool_use` block -- the
 * turn succeeds, the call silently never runs, and in an agent loop that bogus
 * text pollutes every later turn. That failure is invisible and would be
 * miserable to debug, so we accept the thinking tokens.
 */

import {
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  type LlmMessage,
  type ToolCall,
  LlmError,
  isTransient,
} from './provider.ts';

const ANTHROPIC_VERSION = '2023-06-01';

interface WireContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface WireResponse {
  content?: WireContentBlock[];
  stop_reason?: string;
  stop_details?: { category?: string | null; explanation?: string | null } | null;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string; type?: string };
}

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  readonly model: string;
  private apiKey: string;
  private baseUrl: string;
  private timeoutMs: number;
  private maxRetries: number;

  constructor(opts: AnthropicOptions) {
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? 'https://api.anthropic.com/v1').replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.maxRetries = opts.maxRetries ?? 3;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const body = {
      model: this.model,
      max_tokens: req.maxTokens ?? 4096,
      system: req.system,
      messages: toAnthropicMessages(req.messages),
      tools: req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      })),
      tool_choice: { type: 'auto' as const },
      // Deliberately no temperature/top_p/top_k -- see the file header.
    };

    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.once(body);
      } catch (err) {
        lastErr = err;
        if (!isTransient(err) || attempt === this.maxRetries) break;
        const backoff = Math.min(8000, 500 * 2 ** attempt) + Math.random() * 250;
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    throw lastErr instanceof Error ? lastErr : new LlmError(String(lastErr));
  }

  private async once(body: unknown): Promise<LlmResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new LlmError(`Request to anthropic failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    const raw = await res.text();
    if (!res.ok) {
      throw new LlmError(`anthropic returned ${res.status}`, res.status, raw.slice(0, 800));
    }

    let parsed: WireResponse;
    try {
      parsed = JSON.parse(raw) as WireResponse;
    } catch {
      throw new LlmError('anthropic returned non-JSON', res.status, raw.slice(0, 400));
    }
    if (parsed.error) throw new LlmError(parsed.error.message ?? 'unknown provider error', res.status);

    /**
     * A safety refusal arrives as a normal 200 with `stop_reason: "refusal"`
     * and no usable content. Surfacing it as an error is right for this
     * system: the discovery run cannot continue, and the operator needs to
     * know the model declined rather than that it produced nothing.
     */
    if (parsed.stop_reason === 'refusal') {
      const category = parsed.stop_details?.category ?? 'unspecified';
      throw new LlmError(
        `anthropic declined the request (refusal category: ${category})`,
        undefined,
        undefined,
        false, // deterministic: retrying wastes the run's LLM budget
      );
    }

    const toolCalls: ToolCall[] = [];
    const textParts: string[] = [];

    for (const block of parsed.content ?? []) {
      if (block.type === 'text' && block.text) {
        textParts.push(block.text);
      } else if (block.type === 'tool_use' && block.name) {
        toolCalls.push({
          id: block.id ?? `call_${toolCalls.length}`,
          name: block.name,
          // Already parsed JSON -- unlike the OpenAI wire format, there is no
          // string to JSON.parse and therefore no malformed-JSON case.
          arguments: block.input ?? {},
        });
      }
    }

    const out: LlmResponse = { text: textParts.join('\n'), toolCalls };
    if (parsed.stop_reason) out.finishReason = parsed.stop_reason;
    if (parsed.usage) {
      out.usage = {};
      if (parsed.usage.input_tokens !== undefined) out.usage.promptTokens = parsed.usage.input_tokens;
      if (parsed.usage.output_tokens !== undefined) out.usage.completionTokens = parsed.usage.output_tokens;
    }
    return out;
  }
}

/* -------------------------------------------------------- message mapping */

type AnthropicMessage = { role: 'user' | 'assistant'; content: unknown };

/**
 * Translate the provider-neutral message list into Anthropic's shape.
 *
 * The system message is dropped here because the caller lifts it into the
 * top-level `system` field. Tool results become `tool_result` blocks in a
 * user message; consecutive tool results are merged into a single user
 * message, because Anthropic expects all results for one assistant turn to
 * arrive together.
 */
export function toAnthropicMessages(messages: LlmMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];

  for (const m of messages) {
    switch (m.role) {
      case 'system':
        // Lifted to the top-level `system` field by the caller.
        continue;

      case 'user':
        out.push({ role: 'user', content: m.content });
        break;

      case 'assistant': {
        const blocks: unknown[] = [];
        // An empty text block is rejected by the API, so only include it when
        // there is actually text.
        if (m.content && m.content.trim()) blocks.push({ type: 'text', text: m.content });
        for (const tc of m.toolCalls ?? []) {
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments });
        }
        // An assistant turn must carry at least one block.
        if (blocks.length === 0) blocks.push({ type: 'text', text: '(no output)' });
        out.push({ role: 'assistant', content: blocks });
        break;
      }

      case 'tool': {
        const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content };
        const prev = out[out.length - 1];
        if (prev && prev.role === 'user' && Array.isArray(prev.content)) {
          (prev.content as unknown[]).push(block);
        } else {
          out.push({ role: 'user', content: [block] });
        }
        break;
      }
    }
  }

  return out;
}
