/**
 * Provider selection.
 *
 * The goal here is that whoever runs this repo gets a working discovery run
 * with whatever model key they already have, without editing code. So the
 * factory AUTO-DETECTS: if `LLM_PROVIDER` is unset, it picks the first
 * provider whose key is present. Anyone evaluating this project is likely to
 * have exactly one key sitting in their environment, and requiring them to
 * also know which env var name we chose would be a pointless obstacle.
 *
 * Two client implementations sit behind the `LlmProvider` interface:
 *
 *   OpenAICompatibleProvider  Groq, OpenAI, Together, OpenRouter, vLLM,
 *                             Ollama -- anything speaking the OpenAI
 *                             chat-completions shape. One tested code path
 *                             serves all of them; only `baseUrl` and `model`
 *                             differ.
 *   AnthropicProvider         Anthropic's Messages API, which is a genuinely
 *                             different wire format (see anthropic.ts).
 *
 * The agent loop imports neither. It is written against `LlmProvider` and
 * would work unchanged against a provider added tomorrow.
 *
 * Detection order puts Groq first only because it is the documented default
 * for this project's demo (free tier, sufficient for one run) -- not because
 * it is preferred. Setting `LLM_PROVIDER` explicitly always wins.
 */

import { OpenAICompatibleProvider } from './openai-compatible.ts';
import { AnthropicProvider } from './anthropic.ts';
import type { LlmProvider } from './provider.ts';

export interface ProviderEnv {
  LLM_PROVIDER?: string | undefined;

  GROQ_API_KEY?: string | undefined;
  GROQ_MODEL?: string | undefined;
  GROQ_BASE_URL?: string | undefined;

  ANTHROPIC_API_KEY?: string | undefined;
  ANTHROPIC_MODEL?: string | undefined;
  ANTHROPIC_BASE_URL?: string | undefined;

  OPENAI_API_KEY?: string | undefined;
  OPENAI_MODEL?: string | undefined;
  OPENAI_BASE_URL?: string | undefined;

  OPENROUTER_API_KEY?: string | undefined;
  OPENROUTER_MODEL?: string | undefined;

  TOGETHER_API_KEY?: string | undefined;
  TOGETHER_MODEL?: string | undefined;

  /** Any other OpenAI-compatible endpoint (vLLM, Ollama, LM Studio, ...). */
  OPENAI_COMPATIBLE_BASE_URL?: string | undefined;
  OPENAI_COMPATIBLE_API_KEY?: string | undefined;
  OPENAI_COMPATIBLE_MODEL?: string | undefined;
}

/** Provider id -> which env var carries its key. Detection order. */
const KEY_VARS: Array<[string, keyof ProviderEnv]> = [
  ['groq', 'GROQ_API_KEY'],
  ['anthropic', 'ANTHROPIC_API_KEY'],
  ['openai', 'OPENAI_API_KEY'],
  ['openrouter', 'OPENROUTER_API_KEY'],
  ['together', 'TOGETHER_API_KEY'],
  ['custom', 'OPENAI_COMPATIBLE_API_KEY'],
];

export class MissingApiKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingApiKeyError';
  }
}

function noKeyMessage(): string {
  return [
    'No model API key found. The discovery run needs one; replay does not.',
    '',
    'Set ONE of these in a .env file at the repo root (any will work):',
    '',
    '  GROQ_API_KEY=gsk_...          free tier, https://console.groq.com/keys',
    '  ANTHROPIC_API_KEY=sk-ant-...  https://console.anthropic.com/settings/keys',
    '  OPENAI_API_KEY=sk-...         https://platform.openai.com/api-keys',
    '  OPENROUTER_API_KEY=sk-or-...  https://openrouter.ai/keys',
    '  TOGETHER_API_KEY=...          https://api.together.ai/settings/api-keys',
    '',
    'The provider is detected automatically from whichever key is present.',
    'Override the model with GROQ_MODEL / ANTHROPIC_MODEL / OPENAI_MODEL / etc.',
    '',
    'For a self-hosted or otherwise OpenAI-compatible endpoint (vLLM, Ollama):',
    '  OPENAI_COMPATIBLE_BASE_URL=http://localhost:11434/v1',
    '  OPENAI_COMPATIBLE_API_KEY=whatever',
    '  OPENAI_COMPATIBLE_MODEL=your-model',
  ].join('\n');
}

/** Which providers have a key available. Used by the CLI for diagnostics. */
export function detectAvailableProviders(env: ProviderEnv = process.env as ProviderEnv): string[] {
  return KEY_VARS.filter(([, v]) => Boolean(env[v])).map(([id]) => id);
}

export function createProvider(env: ProviderEnv = process.env as ProviderEnv): LlmProvider {
  const explicit = env.LLM_PROVIDER?.trim().toLowerCase();
  const available = detectAvailableProviders(env);

  const which = explicit || available[0];
  if (!which) throw new MissingApiKeyError(noKeyMessage());

  if (explicit && !available.includes(explicit)) {
    throw new MissingApiKeyError(
      `LLM_PROVIDER is set to '${explicit}' but no key for it was found.\n\n${noKeyMessage()}`,
    );
  }

  switch (which) {
    case 'anthropic':
      return new AnthropicProvider({
        apiKey: env.ANTHROPIC_API_KEY!,
        // Opus 5 is the current default. Any Claude model id works here.
        model: env.ANTHROPIC_MODEL ?? 'claude-opus-5',
        ...(env.ANTHROPIC_BASE_URL ? { baseUrl: env.ANTHROPIC_BASE_URL } : {}),
      });

    case 'groq':
      return new OpenAICompatibleProvider({
        name: 'groq',
        baseUrl: env.GROQ_BASE_URL ?? 'https://api.groq.com/openai/v1',
        apiKey: env.GROQ_API_KEY!,
        model: env.GROQ_MODEL ?? 'llama-3.3-70b-versatile',
      });

    case 'openai':
      return new OpenAICompatibleProvider({
        name: 'openai',
        baseUrl: env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
        apiKey: env.OPENAI_API_KEY!,
        model: env.OPENAI_MODEL ?? 'gpt-4.1',
      });

    case 'openrouter':
      return new OpenAICompatibleProvider({
        name: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: env.OPENROUTER_API_KEY!,
        model: env.OPENROUTER_MODEL ?? 'anthropic/claude-sonnet-4.5',
      });

    case 'together':
      return new OpenAICompatibleProvider({
        name: 'together',
        baseUrl: 'https://api.together.xyz/v1',
        apiKey: env.TOGETHER_API_KEY!,
        model: env.TOGETHER_MODEL ?? 'Qwen/Qwen2.5-72B-Instruct-Turbo',
      });

    case 'custom': {
      const baseUrl = env.OPENAI_COMPATIBLE_BASE_URL;
      if (!baseUrl) {
        throw new MissingApiKeyError(
          'OPENAI_COMPATIBLE_API_KEY is set but OPENAI_COMPATIBLE_BASE_URL is not. Both are required.',
        );
      }
      return new OpenAICompatibleProvider({
        name: 'custom',
        baseUrl,
        apiKey: env.OPENAI_COMPATIBLE_API_KEY!,
        model: env.OPENAI_COMPATIBLE_MODEL ?? 'default',
      });
    }

    default:
      throw new Error(
        `Unknown LLM_PROVIDER '${which}'. Supported: ${KEY_VARS.map(([id]) => id).join(', ')}.`,
      );
  }
}
