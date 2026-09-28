/**
 * Provider registry: resolves `provider:model` references to provider instances.
 *
 * Built-in names are `openai`, `anthropic` and `local`. scope.yaml can configure those and add
 * named OpenAI-compatible endpoints (`ollama: { type: openai-compatible, base_url: … }`).
 * Providers are constructed on first use, so an unused provider never needs credentials.
 */
import { ErrorCodes, ScopeError, suggest } from '@scope-ai/core';
import { createAnthropicProvider } from './anthropic.ts';
import { createLocalProvider } from './local.ts';
import { createOpenAIProvider } from './openai.ts';
import type { ModelProvider } from './types.ts';

export interface ProviderConfig {
  type?: 'openai' | 'anthropic' | 'openai-compatible' | undefined;
  api_key?: string | undefined;
  base_url?: string | undefined;
  organization?: string | undefined;
  timeout_ms?: number | undefined;
  max_retries?: number | undefined;
  headers?: Record<string, string> | undefined;
  /** Environment variables referenced in scope.yaml that are not set. */
  missingEnv?: string[] | undefined;
}

export interface ModelRef {
  provider: string;
  model: string;
}

export function parseModelRef(ref: string): ModelRef {
  const colon = ref.indexOf(':');
  if (colon <= 0 || colon === ref.length - 1) {
    throw new ScopeError(ErrorCodes.usage, `"${ref}" is not a model reference`, {
      hint: 'Use provider:model, for example openai:gpt-5, anthropic:claude-opus-5 or local:extractive.',
    });
  }
  return { provider: ref.slice(0, colon), model: ref.slice(colon + 1) };
}

/**
 * Whether a model appears in a provider's model list. Aliases match their dated snapshots
 * (`claude-x` → `claude-x-20250929`, `gpt-x` → `gpt-x-2025-08-07`), and Ollama lists `name:latest`.
 */
export function isModelListed(model: string, listed: readonly string[]): boolean {
  if (listed.includes(model) || listed.includes(`${model}:latest`)) return true;
  const escaped = model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const dated = new RegExp(`^${escaped}-\\d{4}-?\\d{2}-?\\d{2}$`);
  return listed.some((id) => dated.test(id));
}

export interface ProviderDescription {
  name: string;
  type: string;
  builtin: boolean;
  baseUrl: string | null;
  /** Where the credential comes from, for `scope doctor`. */
  credential:
    | { status: 'not-required' }
    | { status: 'config' }
    | { status: 'env'; variable: string }
    | { status: 'missing'; variable: string | null; note?: string };
}

const BUILTIN_TYPES: Record<string, 'openai' | 'anthropic' | 'local'> = {
  openai: 'openai',
  anthropic: 'anthropic',
  local: 'local',
};

export interface ProviderRegistryOptions {
  providers?: Record<string, ProviderConfig>;
  env?: Readonly<Record<string, string | undefined>>;
}

export class ProviderRegistry {
  readonly #configs: Record<string, ProviderConfig>;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #instances = new Map<string, ModelProvider>();

  constructor(options: ProviderRegistryOptions = {}) {
    this.#configs = options.providers ?? {};
    this.#env = options.env ?? process.env;
  }

  names(): string[] {
    return [
      ...new Set([
        ...Object.keys(BUILTIN_TYPES),
        ...Object.keys(this.#configs),
        ...this.#instances.keys(),
      ]),
    ].sort();
  }

  has(name: string): boolean {
    return this.names().includes(name);
  }

  /** Registers a provider instance (custom providers, tests). */
  register(provider: ModelProvider): void {
    this.#instances.set(provider.name, provider);
  }

  typeOf(name: string): string {
    const instance = this.#instances.get(name);
    if (instance) return instance.type;
    return this.#configs[name]?.type ?? BUILTIN_TYPES[name] ?? 'openai-compatible';
  }

  get(name: string): ModelProvider {
    const existing = this.#instances.get(name);
    if (existing) return existing;
    if (!this.has(name)) {
      const guess = suggest(name, this.names());
      throw new ScopeError(ErrorCodes.providerUnknown, `Unknown model provider "${name}"`, {
        hint: guess
          ? `Did you mean "${guess}"?`
          : `Available providers: ${this.names().join(', ')}. Add OpenAI-compatible endpoints under providers: in scope.yaml.`,
      });
    }
    const config = this.#configs[name] ?? {};
    if (config.missingEnv?.length) {
      throw new ScopeError(
        ErrorCodes.providerAuth,
        `Provider "${name}" needs ${config.missingEnv.join(', ')}, which ${config.missingEnv.length === 1 ? 'is' : 'are'} not set`,
        {
          hint: `Export ${config.missingEnv.join(' and ')} before running, or change providers.${name} in scope.yaml.`,
        },
      );
    }
    const type = this.typeOf(name);
    let provider: ModelProvider;
    if (type === 'local') provider = createLocalProvider(name);
    else if (type === 'anthropic') {
      provider = createAnthropicProvider({
        name,
        apiKey: config.api_key,
        baseUrl: config.base_url ?? this.#env.ANTHROPIC_BASE_URL,
        timeoutMs: config.timeout_ms,
        maxRetries: config.max_retries,
        headers: config.headers,
      });
    } else {
      const isOpenAI = type === 'openai';
      if (!isOpenAI && !config.base_url) {
        throw new ScopeError(ErrorCodes.usage, `Provider "${name}" needs a base_url`, {
          hint: `Set providers.${name}.base_url in scope.yaml, e.g. http://localhost:11434/v1 for Ollama.`,
        });
      }
      const apiKey = config.api_key ?? (isOpenAI ? this.#env.OPENAI_API_KEY : undefined);
      if (isOpenAI && !apiKey) {
        throw new ScopeError(ErrorCodes.providerAuth, 'OPENAI_API_KEY is not set', {
          // biome-ignore lint/suspicious/noTemplateCurlyInString: shows scope.yaml syntax
          hint: 'Export OPENAI_API_KEY, or set providers.openai.api_key: ${env:YOUR_VAR} in scope.yaml.',
        });
      }
      provider = createOpenAIProvider({
        name,
        type: isOpenAI ? 'openai' : 'openai-compatible',
        apiKey,
        baseUrl: config.base_url ?? (isOpenAI ? this.#env.OPENAI_BASE_URL : undefined),
        organization: config.organization,
        timeoutMs: config.timeout_ms,
        maxRetries: config.max_retries,
        headers: config.headers,
      });
    }
    this.#instances.set(name, provider);
    return provider;
  }

  resolve(ref: string): { provider: ModelProvider; model: string } {
    const { provider, model } = parseModelRef(ref);
    return { provider: this.get(provider), model };
  }

  /** Describes a provider's configuration without constructing it or contacting it. */
  describe(name: string): ProviderDescription {
    const config = this.#configs[name] ?? {};
    const type = this.typeOf(name);
    const builtin = name in BUILTIN_TYPES;
    const baseUrl =
      config.base_url ??
      (type === 'openai'
        ? (this.#env.OPENAI_BASE_URL ?? null)
        : type === 'anthropic'
          ? (this.#env.ANTHROPIC_BASE_URL ?? null)
          : null);
    let credential: ProviderDescription['credential'];
    if (type === 'local') credential = { status: 'not-required' };
    else if (config.missingEnv?.length)
      credential = { status: 'missing', variable: config.missingEnv[0] ?? null };
    else if (config.api_key) credential = { status: 'config' };
    else if (type === 'openai') {
      credential = this.#env.OPENAI_API_KEY
        ? { status: 'env', variable: 'OPENAI_API_KEY' }
        : { status: 'missing', variable: 'OPENAI_API_KEY' };
    } else if (type === 'anthropic') {
      if (this.#env.ANTHROPIC_API_KEY)
        credential = { status: 'env', variable: 'ANTHROPIC_API_KEY' };
      else if (this.#env.ANTHROPIC_AUTH_TOKEN)
        credential = { status: 'env', variable: 'ANTHROPIC_AUTH_TOKEN' };
      else {
        credential = {
          status: 'missing',
          variable: 'ANTHROPIC_API_KEY',
          note: 'The Anthropic SDK can also use an `ant auth login` profile.',
        };
      }
    } else credential = { status: 'not-required' };
    return { name, type, builtin, baseUrl, credential };
  }
}
