/**
 * An OpenAI-compatible chat-completions client.
 *
 * Groq is the default target (free tier, fast, good tool calling), but the same
 * class serves OpenAI, Together, vLLM and anything else speaking the same
 * endpoint -- only `baseUrl`, `model` and the key change.
 *
 * Deliberately hand-rolled over `fetch` rather than pulled from an SDK. The
 * surface we need is one POST with a JSON body; a dependency would add supply
 * chain and version churn for no benefit, and this way the retry and error
 * semantics are visible rather than inherited.
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

interface WireToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface WireResponse {
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: WireToolCall[] };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

export interface OpenAICompatibleOptions {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export class OpenAICompatibleProvider implements LlmProvider {
  readonly name: string;
  readonly model: string;
  private baseUrl: string;
  private apiKey: string;
  private timeoutMs: number;
  private maxRetries: number;

  constructor(opts: OpenAICompatibleOptions) {
    this.name = opts.name;
    this.model = opts.model;
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.maxRetries = opts.maxRetries ?? 3;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const body = {
      model: this.model,
      temperature: req.temperature ?? 0,
      max_tokens: req.maxTokens ?? 1024,
      messages: [{ role: 'system', content: req.system }, ...req.messages.map(toWire)],
      tools: req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      tool_choice: 'auto',
    };

    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.once(body);
      } catch (err) {
        lastErr = err;
        // Retry only on transient conditions -- see isTransient().
        if (!isTransient(err) || attempt === this.maxRetries) break;
        /**
         * A rate-limited provider tells you exactly how long to wait. Honour
         * it: exponential backoff capped at 8s will simply fail again against
         * a per-minute token budget, which is what a free tier actually
         * enforces. Guessing shorter than the server's own answer is the one
         * retry strategy guaranteed not to work.
         */
        const retryAfter = err instanceof LlmError ? err.retryAfterMs : undefined;
        const backoff = retryAfter ?? Math.min(8000, 500 * 2 ** attempt) + Math.random() * 250;
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
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new LlmError(`Request to ${this.name} failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    const raw = await res.text();
    if (!res.ok) {
      /**
       * `tool_use_failed` means the model produced a tool call the provider
       * could not parse -- it echoes the attempt back in `failed_generation`.
       * This is a formatting stumble in one sample, not a malformed request,
       * so it is returned as a response the loop can correct rather than an
       * error that ends the run.
       */
      const malformed = extractFailedGeneration(raw);
      if (malformed !== null) {
        return { text: '', toolCalls: [], malformedToolCall: malformed };
      }
      const err = new LlmError(`${this.name} returned ${res.status}`, res.status, raw.slice(0, 800));
      if (res.status === 429) err.retryAfterMs = parseRetryAfter(res, raw);
      throw err;
    }

    let parsed: WireResponse;
    try {
      parsed = JSON.parse(raw) as WireResponse;
    } catch {
      throw new LlmError(`${this.name} returned non-JSON`, res.status, raw.slice(0, 400));
    }
    if (parsed.error) throw new LlmError(parsed.error.message ?? 'unknown provider error', res.status);

    const choice = parsed.choices?.[0];
    const toolCalls: ToolCall[] = [];
    for (const tc of choice?.message?.tool_calls ?? []) {
      const name = tc.function?.name;
      if (!name) continue;
      toolCalls.push({
        id: tc.id ?? `call_${toolCalls.length}`,
        name,
        // Models occasionally emit malformed JSON in arguments. Surfacing it as
        // an empty object lets the loop respond with a corrective tool result
        // rather than crashing the whole discovery run.
        arguments: safeParseArgs(tc.function?.arguments),
      });
    }

    const out: LlmResponse = { text: choice?.message?.content ?? '', toolCalls };
    if (choice?.finish_reason) out.finishReason = choice.finish_reason;
    if (parsed.usage) {
      out.usage = {};
      if (parsed.usage.prompt_tokens !== undefined) out.usage.promptTokens = parsed.usage.prompt_tokens;
      if (parsed.usage.completion_tokens !== undefined) out.usage.completionTokens = parsed.usage.completion_tokens;
    }
    return out;
  }
}

/**
 * How long to wait after a 429, from the `retry-after` header if present, else
 * from the wait time providers commonly state in the error message. Capped so
 * a hostile or mistaken value cannot stall a run indefinitely.
 */
function parseRetryAfter(res: Response, body: string): number | undefined {
  const header = res.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.min(60_000, seconds * 1000 + 250);
  }
  const m = /try again in ([\d.]+)\s*s/i.exec(body);
  if (m?.[1]) return Math.min(60_000, Number(m[1]) * 1000 + 250);
  return undefined;
}

/** Returns the echoed bad generation for a `tool_use_failed` error, else null. */
function extractFailedGeneration(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { error?: { code?: string; failed_generation?: string } };
    if (parsed.error?.code !== 'tool_use_failed') return null;
    return (parsed.error.failed_generation ?? '').slice(0, 500);
  } catch {
    return null;
  }
}

function safeParseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toWire(m: LlmMessage): Record<string, unknown> {
  switch (m.role) {
    case 'system':
    case 'user':
      return { role: m.role, content: m.content };
    case 'assistant': {
      const out: Record<string, unknown> = { role: 'assistant', content: m.content || null };
      if (m.toolCalls?.length) {
        out['tool_calls'] = m.toolCalls.map((t) => ({
          id: t.id,
          type: 'function',
          function: { name: t.name, arguments: JSON.stringify(t.arguments) },
        }));
      }
      return out;
    }
    case 'tool':
      return { role: 'tool', tool_call_id: m.toolCallId, name: m.name, content: m.content };
  }
}
