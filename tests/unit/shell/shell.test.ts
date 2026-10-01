import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { isEmptyLaunch, parseLaunchArgs, type PathKind } from '../../../src/main/shell/argv';
import { normalizeCssColor } from '../../../src/main/shell/css-color';
import {
  displayUrl,
  openExternalLink,
  parseExternalUrl,
  type ExternalLinkDeps,
} from '../../../src/main/shell/external-links';
import {
  LogBudget,
  MAX_LOG_MESSAGE,
  cleanLogLevel,
  cleanLogMessage,
} from '../../../src/main/shell/log-sink';

const win = path.win32;
const posix = path.posix;

function fsOf(entries: Record<string, PathKind>) {
  return (p: string) => entries[p] ?? null;
}

describe('command line', () => {
  it('opens folders and files, with a position, in the order given', () => {
    const request = parseLaunchArgs(['inc', 'app', 'app/a.ts:12:3', 'b.ts'], {
      cwd: '/work',
      pathApi: posix,
      caseInsensitive: false,
      stat: fsOf({
        '/work/app': 'directory',
        '/work/app/a.ts': 'file',
        '/work/b.ts': 'file',
      }),
    });
    expect(request.folders).toEqual(['/work/app']);
    expect(request.files).toEqual([
      { path: '/work/app/a.ts', line: 12, column: 3 },
      { path: '/work/b.ts' },
    ]);
    expect(request.missing).toEqual([]);
    expect(isEmptyLaunch(request)).toBe(false);
  });

  it('prefers a file that really has a colon in its name over a position', () => {
    const request = parseLaunchArgs(['inc', 'notes:2024'], {
      cwd: '/work',
      pathApi: posix,
      caseInsensitive: false,
      stat: fsOf({ '/work/notes:2024': 'file' }),
    });
    expect(request.files).toEqual([{ path: '/work/notes:2024' }]);
  });

  it('does not read a Windows drive letter as a position', () => {
    const request = parseLaunchArgs(['inc.exe', 'C:12'], {
      cwd: 'C:\\work',
      pathApi: win,
      caseInsensitive: true,
      stat: () => null,
    });
    expect(request.files).toEqual([]);
    expect(request.missing).toEqual(['C:12']);
  });

  it('skips the app directory, Chromium switches and URLs, and reports missing paths', () => {
    const request = parseLaunchArgs(
      ['electron', 'C:\\app\\', '--disable-gpu', 'https://example.com', 'nope.txt'],
      {
        cwd: 'C:\\work',
        appPath: 'c:\\APP',
        pathApi: win,
        caseInsensitive: true,
        stat: () => null,
      },
    );
    expect(request).toMatchObject({ folders: [], files: [], missing: ['nope.txt'] });
    expect(isEmptyLaunch(request)).toBe(true);
  });

  it('understands --new-window and both spellings of --user-data-dir', () => {
    const base = { cwd: '/work', pathApi: posix, caseInsensitive: false, stat: () => null };
    expect(parseLaunchArgs(['inc', '-n'], base).newWindow).toBe(true);
    expect(parseLaunchArgs(['inc', '--user-data-dir=data'], base).userDataDir).toBe('/work/data');
    expect(parseLaunchArgs(['inc', '--user-data-dir', '/x/y'], base).userDataDir).toBe('/x/y');
    expect(parseLaunchArgs(['inc', '--user-data-dir'], base).userDataDir).toBeUndefined();
  });

  it('lists a path once even if it is given twice, and honours -- for paths starting with a dash', () => {
    const request = parseLaunchArgs(['inc', 'a.ts', 'a.ts', '--', '-odd.ts'], {
      cwd: '/w',
      pathApi: posix,
      caseInsensitive: false,
      stat: fsOf({ '/w/a.ts': 'file', '/w/-odd.ts': 'file' }),
    });
    expect(request.files.map((f) => f.path)).toEqual(['/w/a.ts', '/w/-odd.ts']);
  });

  it('ignores arguments with NUL bytes and rejects absurd positions', () => {
    const request = parseLaunchArgs(['inc', 'a\0b', 'a.ts:99999999999'], {
      cwd: '/w',
      pathApi: posix,
      caseInsensitive: false,
      stat: fsOf({ '/w/a.ts': 'file' }),
    });
    expect(request.files).toEqual([]);
  });
});

describe('external links', () => {
  it('accepts http, https and mailto only', () => {
    expect(parseExternalUrl('https://example.com/a?b=1')?.hostname).toBe('example.com');
    expect(parseExternalUrl('mailto:help@example.com')).not.toBeNull();
    for (const bad of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'ftp://example.com',
      'data:text/html,hi',
      'inc://app/index.html',
    ]) {
      expect(parseExternalUrl(bad)).toBeNull();
    }
  });

  it('refuses addresses that disguise their destination', () => {
    expect(parseExternalUrl('https://user:pw@example.com')).toBeNull();
    expect(parseExternalUrl('https://exa mple.com')).toBeNull();
    expect(parseExternalUrl('https://example.com/\u0007')).toBeNull();
    expect(parseExternalUrl('https://')).toBeNull();
    expect(parseExternalUrl(42)).toBeNull();
    expect(parseExternalUrl('https://example.com/' + 'a'.repeat(3000))).toBeNull();
  });

  it('shortens very long addresses only for display', () => {
    const url = new URL('https://example.com/' + 'a'.repeat(1500));
    const shown = displayUrl(url);
    expect(shown.length).toBeLessThan(700);
    expect(shown).toContain('...');
    expect(displayUrl(new URL('https://example.com/x'))).toBe('https://example.com/x');
  });

  const deps = (over: Partial<ExternalLinkDeps> = {}) => ({
    mode: 'prompt' as const,
    confirm: vi.fn(async () => true),
    open: vi.fn(async () => undefined),
    log: vi.fn(),
    ...over,
  });

  it('opens silently when allowed', async () => {
    const d = deps({ mode: 'allow' });
    expect(await openExternalLink('https://example.com', d)).toBe(true);
    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.open).toHaveBeenCalledWith('https://example.com/');
  });

  it('asks first when the mode is prompt, and respects a refusal', async () => {
    const d = deps({ confirm: vi.fn(async () => false) });
    expect(await openExternalLink('https://example.com', d)).toBe(false);
    expect(d.confirm).toHaveBeenCalledWith('https://example.com/');
    expect(d.open).not.toHaveBeenCalled();
  });

  it('never opens anything when policy denies links', async () => {
    const d = deps({ mode: 'deny' });
    expect(await openExternalLink('https://example.com', d)).toBe(false);
    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.open).not.toHaveBeenCalled();
  });

  it('reports a failure to open instead of throwing', async () => {
    const d = deps({
      mode: 'allow',
      open: vi.fn(async () => {
        throw new Error('no handler');
      }),
    });
    expect(await openExternalLink('https://example.com', d)).toBe(false);
    expect(d.log).toHaveBeenCalledWith('warn', expect.stringContaining('could not open'));
  });
});

describe('log sink', () => {
  it('flattens control characters and caps the length', () => {
    expect(cleanLogMessage('a\nb\u0000c')).toBe('a b c');
    const long = cleanLogMessage('x'.repeat(MAX_LOG_MESSAGE + 50));
    expect(long.endsWith('(truncated)')).toBe(true);
    expect(() => cleanLogMessage(5)).toThrow();
  });

  it('accepts only the four levels', () => {
    expect(cleanLogLevel('warn')).toBe('warn');
    expect(() => cleanLogLevel('trace')).toThrow();
    expect(() => cleanLogLevel(undefined)).toThrow();
  });

  it('drops messages over the budget and reports how many in the next slice', () => {
    const budget = new LogBudget(3, 1000);
    const decisions = [0, 1, 2, 3, 4, 5].map((t) => budget.take(t).decision);
    expect(decisions).toEqual(['accept', 'accept', 'accept', 'drop', 'drop', 'drop']);
    expect(budget.take(1500)).toEqual({ decision: 'dropped-summary', dropped: 3 });
    expect(budget.take(1501).decision).toBe('accept');
  });
});

describe('theme colour sent to the native window', () => {
  it('normalises the accepted forms to #rrggbb', () => {
    expect(normalizeCssColor('#FFF')).toBe('#ffffff');
    expect(normalizeCssColor('#1f5fd1')).toBe('#1f5fd1');
    expect(normalizeCssColor('#1f5fd1cc')).toBe('#1f5fd1');
    expect(normalizeCssColor('rgb(31, 95, 209)')).toBe('#1f5fd1');
  });

  it('rejects anything else', () => {
    for (const bad of ['red', 'url(x)', '', 'rgb(1,2)', 5, null, 'x'.repeat(100)]) {
      expect(normalizeCssColor(bad)).toBeNull();
    }
  });
});
