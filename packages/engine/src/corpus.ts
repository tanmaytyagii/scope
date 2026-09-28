/**
 * Local document corpora for the built-in `retrieve` step: Markdown and text files are chunked
 * by heading and paragraph; JSONL/JSON files provide one document per record. Search is BM25.
 *
 * Corpora are loaded once per process and reused while the files are unchanged.
 */
import { readFileSync, statSync } from 'node:fs';
import { extname, relative } from 'node:path';
import {
  type Bm25Index,
  createBm25Index,
  ErrorCodes,
  isJsonObject,
  type JsonValue,
  ScopeError,
} from '@scope-ai/core';
import { expandGlob } from './glob.ts';

export interface CorpusDocument {
  id: string;
  source: string;
  title: string | null;
  text: string;
}

export interface RetrievedDocument extends CorpusDocument {
  score: number;
}

export interface Corpus {
  documents: CorpusDocument[];
  files: string[];
  search(query: string, topK: number, minScore?: number): RetrievedDocument[];
}

const TEXT_EXTENSIONS = ['.md', '.markdown', '.txt', '.mdx'];
const DATA_EXTENSIONS = ['.jsonl', '.ndjson', '.json'];
export const CORPUS_EXTENSIONS = [...TEXT_EXTENSIONS, ...DATA_EXTENSIONS];
const MAX_CORPUS_BYTES = 50 * 1024 * 1024;

/** Splits Markdown/text into chunks of roughly `size` characters along headings and paragraphs. */
export function chunkText(
  text: string,
  size: number,
): Array<{ title: string | null; text: string }> {
  const chunks: Array<{ title: string | null; text: string }> = [];
  let title: string | null = null;
  let buffer: string[] = [];
  const flush = () => {
    const body = buffer.join('\n\n').trim();
    if (body) chunks.push({ title, text: body });
    buffer = [];
  };
  for (const block of text.replace(/\r\n/g, '\n').split(/\n{2,}/)) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const heading = /^#{1,6}\s+(.+)$/.exec(trimmed.split('\n')[0] ?? '');
    if (heading) {
      flush();
      title = (heading[1] as string).trim();
      const rest = trimmed.split('\n').slice(1).join('\n').trim();
      if (rest) buffer.push(rest);
      continue;
    }
    const current = buffer.join('\n\n').length;
    if (current > 0 && current + trimmed.length > size) flush();
    if (trimmed.length > size * 2) {
      // Very long paragraphs are split on sentence boundaries.
      let piece = '';
      for (const sentence of trimmed.split(/(?<=[.!?])\s+/)) {
        if (piece && piece.length + sentence.length > size) {
          buffer.push(piece.trim());
          flush();
          piece = '';
        }
        piece += `${sentence} `;
      }
      if (piece.trim()) buffer.push(piece.trim());
    } else buffer.push(trimmed);
  }
  flush();
  return chunks;
}

function recordsFrom(path: string, display: string): CorpusDocument[] {
  const text = readFileSync(path, 'utf8');
  const rows: unknown[] = [];
  if (path.endsWith('.json')) {
    const data = JSON.parse(text) as unknown;
    if (Array.isArray(data)) rows.push(...data);
    else if (
      isJsonObject(data as JsonValue) &&
      Array.isArray((data as { documents?: unknown }).documents)
    ) {
      rows.push(...(data as { documents: unknown[] }).documents);
    }
  } else {
    text.split(/\r?\n/).forEach((line, i) => {
      if (!line.trim()) return;
      try {
        rows.push(JSON.parse(line));
      } catch {
        throw new ScopeError(
          ErrorCodes.configInvalid,
          `${display}:${i + 1}: invalid JSON in corpus file`,
          {
            hint: 'Each line of a JSONL corpus is one object with a "text" field.',
          },
        );
      }
    });
  }
  return rows.map((row, i) => {
    const r = row as Record<string, unknown>;
    const body =
      typeof r.text === 'string' ? r.text : typeof r.content === 'string' ? r.content : null;
    if (body === null) {
      throw new ScopeError(
        ErrorCodes.configInvalid,
        `${display}: record ${i + 1} has no "text" field`,
        {
          hint: 'Corpus records look like {"id": "doc-1", "title": "…", "text": "…"}.',
        },
      );
    }
    return {
      id:
        typeof r.id === 'string' || typeof r.id === 'number' ? String(r.id) : `${display}#${i + 1}`,
      source: typeof r.source === 'string' ? r.source : display,
      title: typeof r.title === 'string' ? r.title : null,
      text: body,
    };
  });
}

const cache = new Map<string, { signature: string; corpus: Corpus }>();

export interface LoadCorpusOptions {
  /** Directory patterns are resolved against (the workflow's directory). */
  baseDir: string;
  /** Project root, for display paths. */
  root: string;
  chunkSize?: number;
}

export function loadCorpus(
  patterns: string | readonly string[],
  options: LoadCorpusOptions,
): Corpus {
  const list = typeof patterns === 'string' ? [patterns] : [...patterns];
  const files = [
    ...new Set(list.flatMap((p) => expandGlob(p, options.baseDir, CORPUS_EXTENSIONS))),
  ].filter((f) => CORPUS_EXTENSIONS.includes(extname(f).toLowerCase()));
  if (files.length === 0) {
    throw new ScopeError(
      ErrorCodes.configInvalid,
      `No corpus files match ${list.map((p) => `"${p}"`).join(', ')}`,
      {
        hint: `Paths are relative to the workflow file. Supported files: ${CORPUS_EXTENSIONS.join(', ')}.`,
      },
    );
  }
  const chunkSize = options.chunkSize ?? 800;
  const stats = files.map((f) => statSync(f));
  const totalBytes = stats.reduce((n, s) => n + s.size, 0);
  if (totalBytes > MAX_CORPUS_BYTES) {
    throw new ScopeError(
      ErrorCodes.configInvalid,
      `The corpus is ${Math.round(totalBytes / 1e6)} MB; the built-in retriever supports up to 50 MB`,
      {
        hint: 'For larger corpora, retrieve in a function step with your own vector store.',
      },
    );
  }
  const signature = `${chunkSize}|${files.map((f, i) => `${f}:${stats[i]?.mtimeMs}:${stats[i]?.size}`).join('|')}`;
  const key = `${options.baseDir}|${list.join(',')}|${chunkSize}`;
  const hit = cache.get(key);
  if (hit && hit.signature === signature) return hit.corpus;

  const documents: CorpusDocument[] = [];
  for (const file of files) {
    const display = relative(options.root, file) || file;
    if (DATA_EXTENSIONS.includes(extname(file).toLowerCase())) {
      documents.push(...recordsFrom(file, display));
    } else {
      chunkText(readFileSync(file, 'utf8'), chunkSize).forEach((chunk, i) => {
        documents.push({
          id: `${display}#${i + 1}`,
          source: display,
          title: chunk.title,
          text: chunk.text,
        });
      });
    }
  }
  const index: Bm25Index = createBm25Index(documents.map((d) => `${d.title ?? ''}\n${d.text}`));
  const corpus: Corpus = {
    documents,
    files,
    search(query, topK, minScore = 0) {
      return index
        .search(query, topK)
        .filter((h) => h.score >= minScore)
        .map((h) => ({
          ...(documents[h.index] as CorpusDocument),
          score: Math.round(h.score * 1000) / 1000,
        }));
    },
  };
  cache.set(key, { signature, corpus });
  return corpus;
}
