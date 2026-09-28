/**
 * Terminal styling. Color is used only where it carries meaning (status, emphasis) and is
 * disabled for non-TTY output, NO_COLOR, --no-color, and TERM=dumb.
 */
import { styleText } from 'node:util';

type Format = Parameters<typeof styleText>[0];

export interface Style {
  enabled: boolean;
  bold(s: string): string;
  dim(s: string): string;
  green(s: string): string;
  red(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
  magenta(s: string): string;
  underline(s: string): string;
}

export function colorEnabled(
  stream: NodeJS.WriteStream,
  flag: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (flag === false) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0') return true;
  if (env.TERM === 'dumb') return false;
  return Boolean(stream.isTTY);
}

export function createStyle(enabled: boolean): Style {
  const apply = (format: Format) => (s: string) =>
    enabled ? styleText(format, s, { validateStream: false }) : s;
  return {
    enabled,
    bold: apply('bold'),
    dim: apply('dim'),
    green: apply('green'),
    red: apply('red'),
    yellow: apply('yellow'),
    cyan: apply('cyan'),
    magenta: apply('magenta'),
    underline: apply('underline'),
  };
}

export const plainStyle = createStyle(false);

/** Symbols with ASCII fallbacks for terminals that cannot render them. */
export function symbols(unicode = process.platform !== 'win32' || Boolean(process.env.WT_SESSION)) {
  return unicode
    ? {
        pass: '✓',
        fail: '✗',
        warn: '▲',
        skip: '○',
        error: '!',
        dot: '·',
        arrow: '→',
        bullet: '•',
        tee: '├─',
        elbow: '└─',
        pipe: '│ ',
        blank: '  ',
      }
    : {
        pass: 'v',
        fail: 'x',
        warn: '!',
        skip: 'o',
        error: '!',
        dot: '-',
        arrow: '->',
        bullet: '*',
        tee: '|-',
        elbow: '`-',
        pipe: '| ',
        blank: '  ',
      };
}

export type Symbols = ReturnType<typeof symbols>;

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape sequences
const ANSI = /\u001b\[[0-9;]*m/g;

export function visibleLength(text: string): number {
  return [...text.replace(ANSI, '')].length;
}

export function padEnd(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - visibleLength(text)));
}

export function padStart(text: string, width: number): string {
  return ' '.repeat(Math.max(0, width - visibleLength(text))) + text;
}

export function truncate(text: string, width: number): string {
  const plain = text.replace(/\s+/g, ' ');
  if (visibleLength(plain) <= width) return plain;
  return `${[...plain].slice(0, Math.max(0, width - 1)).join('')}…`;
}
