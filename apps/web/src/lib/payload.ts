/**
 * Understanding captured payloads: the shapes SCOPE's engine records for model calls and
 * retrievals, and the markers its privacy layer leaves behind (truncation, redaction).
 */
import type { JsonValue } from '@scope-ai/protocol';

export interface ChatMessage {
  role: string;
  content: string;
}

type JsonObject = { [key: string]: JsonValue };

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Payloads larger than the privacy limit are stored as a preview with the original size. */
export function truncation(value: unknown): { originalBytes: number; preview: string } | null {
  if (isObject(value) && value.$truncated === true) {
    return {
      originalBytes: typeof value.originalBytes === 'number' ? value.originalBytes : 0,
      preview: typeof value.preview === 'string' ? value.preview : '',
    };
  }
  return null;
}

/** Chat messages from a model call's input, when it has them. */
export function chatMessages(input: JsonValue | null): ChatMessage[] | null {
  if (!isObject(input) || !Array.isArray(input.messages)) return null;
  const messages: ChatMessage[] = [];
  for (const m of input.messages) {
    if (!isObject(m) || typeof m.role !== 'string') return null;
    const content =
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? null, null, 2);
    messages.push({ role: m.role, content });
  }
  return messages;
}

/** Request parameters of a model call other than the messages. */
export function requestParams(input: JsonValue | null): JsonObject | null {
  if (!isObject(input)) return null;
  const { messages: _messages, prompt: _prompt, system: _system, ...rest } = input;
  return Object.keys(rest).length ? rest : null;
}

/** The text a model call produced, when the output is SCOPE's `{ text }` shape or a string. */
export function responseText(output: JsonValue | null): string | null {
  if (typeof output === 'string') return output;
  if (isObject(output) && typeof output.text === 'string') return output.text;
  return null;
}

export interface RetrievedDocument {
  id: string;
  source: string | null;
  title: string | null;
  text: string;
  score: number | null;
}

export function retrievedDocuments(output: JsonValue | null): RetrievedDocument[] | null {
  if (!isObject(output) || !Array.isArray(output.documents)) return null;
  return output.documents.filter(isObject).map((d, i) => ({
    id: typeof d.id === 'string' ? d.id : String(i),
    source: typeof d.source === 'string' ? d.source : null,
    title: typeof d.title === 'string' ? d.title : null,
    text: typeof d.text === 'string' ? d.text : JSON.stringify(d),
    score: typeof d.score === 'number' ? d.score : null,
  }));
}

/** Pretty JSON for display; strings are shown as text, not as quoted JSON. */
export function displayText(value: JsonValue | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

/**
 * Previews are stored as compact text of the whole output. A workflow output with one text
 * field (`{ "answer": "…" }`) reads better as `answer: …`; anything else is shown as stored.
 */
export function readablePreview(preview: string): string {
  const trimmed = preview.trim();
  const cut = trimmed.endsWith('…');
  const body = cut ? trimmed.slice(0, -1) : trimmed;
  const match = /^\{\s*"([^"\\]{1,64})":\s*"((?:[^"\\]|\\.)*)(?:"\s*\})?$/.exec(body);
  if (!match || (!cut && !body.endsWith('}'))) return preview;
  const [, key, value = ''] = match;
  let text = value;
  try {
    text = JSON.parse(`"${value.replace(/\\$/, '')}"`) as string;
  } catch {
    // a truncated escape sequence: show the raw text
  }
  return `${key}: ${text}${cut ? '…' : ''}`;
}

/** Number of redaction markers in a payload (e.g. "[redacted:openai_key]"). */
export function redactionCount(value: JsonValue | null): number {
  if (value === null) return 0;
  return (JSON.stringify(value).match(/\[redacted:[a-z_]+\]/g) ?? []).length;
}
