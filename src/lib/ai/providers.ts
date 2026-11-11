/**
 * Modular AI provider adapters.
 *
 * Every adapter talks to the provider's real HTTP API using the *user's own key*.
 * There is no shared developer key, no mock mode, and no simulated response path.
 * Adding a provider = adding one object here.
 *
 * Model lists are deliberately short and conservative. A long list of models that
 * may or may not exist is worse than four that work: provider rosters churn
 * (Gemini 2.0/1.5 and `text-embedding-004` now 404 for new users), and each stale
 * entry becomes a runtime failure for the user who picks it.
 */

export type ProviderId = 'openai' | 'anthropic' | 'google' | 'openai_compatible';

export type ModelOption = {
  id: string;
  label: string;
  contextWindow: number;
  supportsEmbeddings?: boolean;
};

export type ProviderDefinition = {
  id: ProviderId;
  name: string;
  keyPrefixHint: string;
  keyDocsUrl: string;
  requiresBaseUrl?: boolean;
  models: ModelOption[];
  /** Cheapest call that proves a key works. */
  validate(key: string, baseUrl?: string): Promise<ValidationResult>;
  chat(req: ChatRequest): Promise<ChatResult>;
  embed?(req: EmbedRequest): Promise<EmbedResult>;
};

export type ValidationResult =
  | { ok: true; detail: string }
  | { ok: false; kind: ErrorKind; message: string };

export type ErrorKind =
  | 'invalid_key'
  | 'insufficient_quota'
  | 'rate_limited'
  | 'model_unavailable'
  | 'network'
  | 'provider_error';

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type ChatRequest = {
  key: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  baseUrl?: string;
};

export type ChatResult = {
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number };
};

export type EmbedRequest = { key: string; model: string; input: string[]; baseUrl?: string };
export type EmbedResult = { vectors: number[][]; model: string };

const TIMEOUT_MS = 60_000;

async function postJson(url: string, headers: Record<string, string>, body: unknown) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON error body */
    }
    return { res, text, json };
  } catch (e) {
    // Never let a raw fetch/abort error escape: callers classify on
    // ProviderError.kind, and an unclassified error surfaces to the user as
    // "Unexpected error: This operation was aborted", which explains nothing.
    if (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
      throw new ProviderError('provider_error', `The provider did not respond within ${TIMEOUT_MS / 1000}s.`);
    }
    throw new ProviderError('network', 'Could not reach the provider. Check your connection.');
  } finally {
    clearTimeout(timer);
  }
}

function classify(status: number, body: string): { kind: ErrorKind; message: string } {
  const b = body.toLowerCase();

  if (status === 401 || status === 403) {
    return { kind: 'invalid_key', message: 'That API key was rejected by the provider.' };
  }

  if (status === 429) {
    // Distinguish a free-tier daily cap from a genuinely empty balance. Telling a
    // user "top up your account" when they simply hit a per-day limit sends them
    // to spend money they do not need to spend.
    const isFreeTier = b.includes('free_tier') || b.includes('free tier');

    // Gemini puts the retry delay in the body ("retry in 20h9m...").
    const retryMatch = body.match(/retry in ([0-9]+h)?([0-9]+m)?([0-9.]+s)?/i);
    const retryIn = retryMatch
      ? [retryMatch[1], retryMatch[2], retryMatch[3]].filter(Boolean).join(' ')
      : null;

    if (isFreeTier) {
      return {
        kind: 'rate_limited',
        message: retryIn
          ? `You have hit the provider's free-tier daily limit for this model. It resets in about ${retryIn}. Add billing to the provider for a much higher limit, or pick a different model.`
          : "You have hit the provider's free-tier daily limit for this model. Add billing at the provider for a higher limit, or pick a different model.",
      };
    }

    if (b.includes('quota') || b.includes('billing') || b.includes('credit balance')) {
      return { kind: 'insufficient_quota', message: 'Your provider credit balance is too low. Top up with your provider.' };
    }

    return { kind: 'rate_limited', message: 'The provider is rate-limiting this key. Try again shortly.' };
  }
  if (status === 404) {
    return {
      kind: 'model_unavailable',
      message: 'That model is not available to this key. Pick a different model.',
    };
  }
  if (status === 503) {
    return {
      kind: 'provider_error',
      message: 'The provider is temporarily overloaded. Try again, or pick a different model.',
    };
  }
  if (status >= 500) {
    return { kind: 'provider_error', message: 'The provider had a server error. Try again.' };
  }
  if (b.includes('insufficient_quota') || b.includes('credit balance')) {
    return { kind: 'insufficient_quota', message: 'Your provider credit balance is too low.' };
  }
  return { kind: 'provider_error', message: `Provider returned HTTP ${status}.` };
}

// ───────────────────────────── OpenAI ─────────────────────────────
const openai: ProviderDefinition = {
  id: 'openai',
  name: 'OpenAI',
  keyPrefixHint: 'sk-…',
  keyDocsUrl: 'https://platform.openai.com/api-keys',
  models: [
    { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', contextWindow: 1_047_576 },
    { id: 'gpt-4.1', label: 'GPT-4.1', contextWindow: 1_047_576 },
    { id: 'gpt-4o-mini', label: 'GPT-4o mini', contextWindow: 128_000 },
    { id: 'gpt-4o', label: 'GPT-4o', contextWindow: 128_000 },
    { id: 'text-embedding-3-small', label: 'Embedding 3 small', contextWindow: 8191, supportsEmbeddings: true },
  ],
  async validate(key) {
    try {
      const { res, text } = await postJson(
        'https://api.openai.com/v1/chat/completions',
        { authorization: `Bearer ${key}` },
        {
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        },
      );
      if (res.ok) return { ok: true, detail: 'Key validated against OpenAI.' };
      // A 429 still proves the key authenticates — the key is fine, the quota is not.
      if (res.status === 429) {
        return { ok: true, detail: 'Key is valid, but OpenAI is currently rate-limiting it.' };
      }
      const c = classify(res.status, text);
      return { ok: false, kind: c.kind, message: c.message };
    } catch (e) {
      return { ok: false, kind: 'network', message: `Could not reach OpenAI: ${(e as Error).message}` };
    }
  },
  async chat({ key, model, messages, temperature = 0.7, maxTokens = 1200 }) {
    const { res, text, json } = await postJson(
      'https://api.openai.com/v1/chat/completions',
      { authorization: `Bearer ${key}` },
      { model, messages, temperature, max_tokens: maxTokens },
    );
    if (!res.ok) {
      const c = classify(res.status, text);
      throw new ProviderError(c.kind, c.message);
    }
    const data = json as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      text: data.choices?.[0]?.message?.content ?? '',
      usage: { inputTokens: data.usage?.prompt_tokens, outputTokens: data.usage?.completion_tokens },
    };
  },
  async embed({ key, model, input }) {
    const { res, text, json } = await postJson(
      'https://api.openai.com/v1/embeddings',
      { authorization: `Bearer ${key}` },
      { model, input },
    );
    if (!res.ok) {
      const c = classify(res.status, text);
      throw new ProviderError(c.kind, c.message);
    }
    const data = json as { data?: { embedding: number[] }[] };
    return { vectors: (data.data ?? []).map((d) => d.embedding), model };
  },
};

// ───────────────────────────── Anthropic ─────────────────────────────
const anthropic: ProviderDefinition = {
  id: 'anthropic',
  name: 'Anthropic',
  keyPrefixHint: 'sk-ant-…',
  keyDocsUrl: 'https://console.anthropic.com/settings/keys',
  models: [
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', contextWindow: 200_000 },
    { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', contextWindow: 200_000 },
    { id: 'claude-opus-4-1', label: 'Claude Opus 4.1', contextWindow: 200_000 },
  ],
  // No embed() — Anthropic has no embedding model. Semantic search degrades to
  // keyword-only and the UI says so rather than inventing vectors.
  async validate(key) {
    try {
      const { res, text } = await postJson(
        'https://api.anthropic.com/v1/messages',
        { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        { model: 'claude-haiku-4-5', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] },
      );
      if (res.ok) return { ok: true, detail: 'Key validated against Anthropic.' };
      if (res.status === 429) {
        return { ok: true, detail: 'Key is valid, but Anthropic is currently rate-limiting it.' };
      }
      const c = classify(res.status, text);
      return { ok: false, kind: c.kind, message: c.message };
    } catch (e) {
      return { ok: false, kind: 'network', message: `Could not reach Anthropic: ${(e as Error).message}` };
    }
  },
  async chat({ key, model, messages, temperature = 0.7, maxTokens = 1200 }) {
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');

    const { res, text, json } = await postJson(
      'https://api.anthropic.com/v1/messages',
      { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      {
        model,
        max_tokens: maxTokens,
        temperature,
        ...(system ? { system } : {}),
        messages: messages
          .filter((m) => m.role !== 'system')
          .map((m) => ({ role: m.role, content: m.content })),
      },
    );
    if (!res.ok) {
      const c = classify(res.status, text);
      throw new ProviderError(c.kind, c.message);
    }
    const data = json as {
      content?: { type: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    return {
      text: (data.content ?? [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join(''),
      usage: {
        inputTokens: data.usage?.input_tokens,
        outputTokens: data.usage?.output_tokens,
      },
    };
  },
};

// ───────────────────────────── Google Gemini ─────────────────────────────
/**
 * Embedding dimensionality is pinned to 1536 to match the `vector(1536)` column
 * and OpenAI's space. `gemini-embedding-001` natively returns 3072, which the
 * column would reject, so `outputDimensionality` is always sent.
 *
 * Chat models here are *thinking* models. Left at default, reasoning consumes the
 * whole `maxOutputTokens` budget and the reply comes back as an empty string —
 * verified directly: `finishReason: STOP`, zero text. `thinkingBudget: 0` is
 * therefore not an optimisation, it is required for the call to produce text.
 * A small budget is kept for the larger models, which benefit from light reasoning.
 */
const GEMINI_EMBED_DIMS = 1536;

const geminiThinkingConfig = (model: string) => {
  if (model.includes('lite') || model.includes('flash')) {
    return { thinkingBudget: 0 };
  }
  return { thinkingBudget: 1024 };
};

const google: ProviderDefinition = {
  id: 'google',
  name: 'Google Gemini',
  keyPrefixHint: 'AIza…',
  keyDocsUrl: 'https://aistudio.google.com/app/apikey',
  models: [
    // Ordered by verified availability on a fresh free-tier key. `flash-lite`
    // is first because it has its own per-day quota bucket and answered even
    // after the main flash quota was exhausted.
    { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite', contextWindow: 1_048_576 },
    { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', contextWindow: 1_048_576 },
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', contextWindow: 1_048_576 },
    { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', contextWindow: 1_048_576 },
    { id: 'gemini-embedding-001', label: 'Embedding 001', contextWindow: 2048, supportsEmbeddings: true },
  ],
  async validate(key) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
        { signal: controller.signal },
      );
      clearTimeout(timer);
      const text = await res.text();
      if (res.ok) return { ok: true, detail: 'Key validated against Google AI Studio.' };
      const c = classify(res.status, text);
      return { ok: false, kind: c.kind, message: c.message };
    } catch (e) {
      return { ok: false, kind: 'network', message: `Could not reach Google: ${(e as Error).message}` };
    }
  },
  async chat({ key, model, messages, temperature = 0.7, maxTokens = 1200 }) {
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');

    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    const { res, text, json } = await postJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
      {},
      {
        contents,
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        generationConfig: {
          temperature,
          maxOutputTokens: maxTokens,
          // Required: see the note above. Without this the reply can be empty.
          thinkingConfig: geminiThinkingConfig(model),
        },
      },
    );

    if (!res.ok) {
      const c = classify(res.status, text);
      throw new ProviderError(c.kind, c.message);
    }

    const data = json as {
      candidates?: {
        content?: { parts?: { text?: string; thought?: boolean }[] };
        finishReason?: string;
      }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };

    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    // Thinking parts are flagged `thought: true`; including them would leak
    // the model's reasoning into the user's reply.
    const answer = parts
      .filter((p) => !p.thought)
      .map((p) => p.text ?? '')
      .join('')
      .trim();

    if (!answer) {
      throw new ProviderError(
        'provider_error',
        candidate?.finishReason === 'MAX_TOKENS'
          ? 'The model ran out of output tokens before writing a reply. Try a shorter prompt or a different model.'
          : 'The model returned an empty reply. Try again, or pick a different model.',
      );
    }

    return {
      text: answer,
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount,
        outputTokens: data.usageMetadata?.candidatesTokenCount,
      },
    };
  },
  async embed({ key, model, input }) {
    const vectors: number[][] = [];
    for (const content of input) {
      const { res, text: raw, json } = await postJson(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${encodeURIComponent(key)}`,
        {},
        {
          content: { parts: [{ text: content }] },
          // Without this, gemini-embedding-001 returns 3072 dims and the
          // vector(1536) column rejects the insert.
          outputDimensionality: GEMINI_EMBED_DIMS,
        },
      );
      if (!res.ok) {
        const c = classify(res.status, raw);
        throw new ProviderError(c.kind, c.message);
      }
      const data = json as { embedding?: { values?: number[] } };
      const values = data.embedding?.values;
      if (!values || values.length === 0) {
        throw new ProviderError('provider_error', 'Google returned an empty embedding.');
      }
      if (values.length !== GEMINI_EMBED_DIMS) {
        throw new ProviderError(
          'provider_error',
          `Google returned ${values.length}-dimension vectors but this database expects ${GEMINI_EMBED_DIMS}.`,
        );
      }
      vectors.push(values);
    }
    return { vectors, model };
  },
};

// ───────────────────── OpenAI-compatible (Groq, Together, OpenRouter, Ollama, vLLM) ─────────────────────
const openaiCompatible: ProviderDefinition = {
  id: 'openai_compatible',
  name: 'OpenAI-compatible endpoint',
  keyPrefixHint: 'whatever your endpoint issues',
  keyDocsUrl: 'https://platform.openai.com/docs/api-reference',
  requiresBaseUrl: true,
  models: [{ id: 'custom', label: 'Model id (type your own)', contextWindow: 0 }],
  async validate(key, baseUrl) {
    if (!baseUrl) return { ok: false, kind: 'invalid_key', message: 'A base URL is required.' };
    try {
      const { res, text } = await postJson(
        `${baseUrl.replace(/\/$/, '')}/chat/completions`,
        { authorization: `Bearer ${key}` },
        { model: 'placeholder', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 },
      );
      // Any structured response (even "unknown model") proves the endpoint and key
      // are reachable; only auth failures are fatal here.
      if (res.ok) return { ok: true, detail: 'Endpoint reachable and key accepted.' };
      if (res.status === 401 || res.status === 403) {
        return { ok: false, kind: 'invalid_key', message: 'That endpoint rejected the key.' };
      }
      if (res.status === 400 || res.status === 404) {
        return {
          ok: true,
          detail: 'Endpoint reachable. Pick the exact model id your provider uses.',
        };
      }
      const c = classify(res.status, text);
      return { ok: false, kind: c.kind, message: c.message };
    } catch (e) {
      return { ok: false, kind: 'network', message: `Could not reach that endpoint: ${(e as Error).message}` };
    }
  },
  async chat({ key, model, messages, temperature = 0.7, maxTokens = 1200, baseUrl }) {
    if (!baseUrl) throw new ProviderError('invalid_key', 'A base URL is required.');
    const { res, text, json } = await postJson(
      `${baseUrl.replace(/\/$/, '')}/chat/completions`,
      { authorization: `Bearer ${key}` },
      { model, messages, temperature, max_tokens: maxTokens },
    );
    if (!res.ok) {
      const c = classify(res.status, text);
      throw new ProviderError(c.kind, c.message);
    }
    const data = json as { choices?: { message?: { content?: string } }[] };
    return { text: data.choices?.[0]?.message?.content ?? '' };
  },
  async embed({ key, model, input, baseUrl }) {
    if (!baseUrl) throw new ProviderError('invalid_key', 'A base URL is required.');
    const { res, text, json } = await postJson(
      `${baseUrl.replace(/\/$/, '')}/embeddings`,
      { authorization: `Bearer ${key}` },
      { model, input },
    );
    if (!res.ok) {
      const c = classify(res.status, text);
      throw new ProviderError(c.kind, c.message);
    }
    const data = json as { data?: { embedding: number[] }[] };
    return { vectors: (data.data ?? []).map((d) => d.embedding), model };
  },
};

export class ProviderError extends Error {
  constructor(
    public kind: ErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export const PROVIDERS: Record<ProviderId, ProviderDefinition> = {
  openai,
  anthropic,
  google,
  openai_compatible: openaiCompatible,
};

export const PROVIDER_LIST = Object.values(PROVIDERS);

export function getProvider(id: ProviderId): ProviderDefinition {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`Unknown provider: ${id}`);
  return p;
}
