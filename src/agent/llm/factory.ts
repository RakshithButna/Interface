/**
 * Provider selection from environment configuration.
 *
 * Groq is the default: the free tier is sufficient for a discovery run, and
 * because perception in this system is the accessibility tree rather than
 * screenshots, a text-only model is not a compromise. It is arguably the
 * better fit -- the a11y tree is the representation that also exists on
 * desktop surfaces, so building the loop around text keeps the desktop path
 * open in a way a screenshot-and-coordinates loop would not.
 */

import { OpenAICompatibleProvider } from './openai-compatible.ts';
import type { LlmProvider } from './provider.ts';

export interface ProviderEnv {
  LLM_PROVIDER?: string | undefined;
  GROQ_API_KEY?: string | undefined;
  GROQ_MODEL?: string | undefined;
  GROQ_BASE_URL?: string | undefined;
  OPENAI_API_KEY?: string | undefined;
  OPENAI_MODEL?: string | undefined;
  OPENAI_BASE_URL?: string | undefined;
}

export class MissingApiKeyError extends Error {
  constructor(provider: string, envVar: string) {
    super(
      `No API key for provider '${provider}'. Set ${envVar} in your environment or in a .env file at the repo root. ` +
        `A free Groq key can be created at https://console.groq.com/keys`,
    );
    this.name = 'MissingApiKeyError';
  }
}

export function createProvider(env: ProviderEnv = process.env as ProviderEnv): LlmProvider {
  const which = (env.LLM_PROVIDER ?? 'groq').toLowerCase();

  if (which === 'groq') {
    if (!env.GROQ_API_KEY) throw new MissingApiKeyError('groq', 'GROQ_API_KEY');
    return new OpenAICompatibleProvider({
      name: 'groq',
      baseUrl: env.GROQ_BASE_URL ?? 'https://api.groq.com/openai/v1',
      apiKey: env.GROQ_API_KEY,
      model: env.GROQ_MODEL ?? 'moonshotai/kimi-k2-instruct',
    });
  }

  if (which === 'openai') {
    if (!env.OPENAI_API_KEY) throw new MissingApiKeyError('openai', 'OPENAI_API_KEY');
    return new OpenAICompatibleProvider({
      name: 'openai',
      baseUrl: env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL ?? 'gpt-4.1-mini',
    });
  }

  throw new Error(
    `Unknown LLM_PROVIDER '${which}'. Supported: groq, openai (both via the OpenAI-compatible client).`,
  );
}
