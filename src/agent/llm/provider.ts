/**
 * The LLM provider seam.
 *
 * The agent loop is written against this interface and knows nothing about who
 * serves the model. That is not abstraction for its own sake -- the brief
 * leaves provider choice to us, and in the real environment the choice is a
 * procurement decision that changes over time, per institution, sometimes per
 * data-residency requirement. Baking one vendor's SDK into the loop would make
 * that a rewrite instead of a config change.
 *
 * The shape here is the OpenAI-style tool-calling contract, because it is what
 * essentially every provider now speaks (Groq, OpenAI, Together, vLLM, Ollama,
 * and Anthropic via a thin adapter). `OpenAICompatibleProvider` therefore
 * covers several vendors with one tested code path.
 *
 * Worth stating plainly: NONE of this is on the replay path. Replay never
 * constructs a provider, never reads an API key, and would run identically if
 * this directory were deleted. That separation is the whole point of the
 * record-once/replay-many model.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type LlmMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  tools: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
}

export interface LlmUsage {
  promptTokens?: number;
  completionTokens?: number;
}

export interface LlmResponse {
  text: string;
  toolCalls: ToolCall[];
  usage?: LlmUsage;
  /** Provider's stop reason, for diagnostics. */
  finishReason?: string;
  /**
   * Set when the model emitted something the provider recognised as an
   * attempted tool call but could not parse into one.
   *
   * Some hosted providers (Groq is one) validate tool-call syntax server-side
   * and reject a malformed generation with a 400 rather than returning it. That
   * is a per-generation formatting stumble, not a broken request -- the very
   * next sample usually succeeds. Surfacing it as a response the loop can
   * respond to, rather than an exception, keeps one bad sample from ending a
   * discovery run that was otherwise going fine.
   */
  malformedToolCall?: string;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export class LlmError extends Error {
  readonly status: number | undefined;
  readonly body: string | undefined;
  /**
   * Explicit retryability, when the status code alone cannot express it.
   *
   * A network failure has no status and should be retried; a safety refusal
   * also has no status (it arrives as a perfectly good HTTP 200) and must NOT
   * be, because it will resolve identically every time and each attempt costs
   * the run part of its budget.
   */
  readonly retryable: boolean | undefined;
  /** Server-stated wait before retrying, from a 429. Honoured by the client. */
  retryAfterMs: number | undefined;

  constructor(message: string, status?: number, body?: string, retryable?: boolean) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.body = body;
    this.retryable = retryable;
  }
}

/** Shared retry predicate, so every provider agrees on what is transient. */
export function isTransient(err: unknown): boolean {
  if (!(err instanceof LlmError)) return true;
  if (err.retryable !== undefined) return err.retryable;
  const s = err.status;
  // No status means a transport failure, which is worth another attempt.
  // A 400 will fail identically forever; retrying it just burns the budget.
  return s === undefined || s === 429 || (s >= 500 && s < 600);
}
