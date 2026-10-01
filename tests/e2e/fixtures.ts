import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Fixture {
  root: string;
  file(...parts: string[]): string;
  git(...args: string[]): string;
  write(rel: string, content: string): string;
  cleanup(): void;
}

const FILES: Record<string, string> = {
  'README.md': '# acme-platform\n\nInternal platform monorepo.\n',
  '.gitignore': 'node_modules/\ndist/\n*.log\n',
  '.editorconfig':
    'root = true\n\n[*]\nindent_style = space\nindent_size = 4\nend_of_line = lf\n\n[*.md]\nindent_size = 2\n',
  'package.json':
    JSON.stringify(
      {
        name: 'acme-platform',
        version: '1.0.0',
        scripts: { build: 'echo building', test: 'echo testing' },
      },
      null,
      2,
    ) + '\n',
  'packages/api/src/index.ts':
    "export function greet(name: string): string {\n    return `Hello, ${name}`;\n}\n\nexport const VERSION = '1.0.0';\n",
  'packages/api/src/server.ts':
    "import { greet } from './index';\n\nexport function start(port: number): void {\n    console.log(greet('world'), port);\n}\n",
  'packages/web/src/App.tsx': 'export function App() {\n    return <main>acme</main>;\n}\n',
  'packages/web/src/styles.css': 'body {\n    margin: 0;\n}\n',
  'tools/scripts/release.sh': '#!/bin/sh\necho release\n',
  'docs/guide.md': '# Guide\n\nTODO: write the guide.\n',
  'data/notes.txt': 'alpha\nbeta\ngamma\nneedle in a haystack\n',
};

/** A small monorepo-shaped workspace with a Git history, used by end-to-end and integration tests. */
export function createFixture(options: { git?: boolean } = {}): Fixture {
  const root = mkdtempSync(path.join(os.tmpdir(), 'inc-fixture-'));
  const write = (rel: string, content: string) => {
    const full = path.join(root, ...rel.split('/'));
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
    return full;
  };
  for (const [rel, content] of Object.entries(FILES)) write(rel, content);

  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test User',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test User',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    });

  if (options.git !== false) {
    git('init', '-q', '-b', 'main');
    git('config', 'core.autocrlf', 'false');
    git('add', '-A');
    git('commit', '-q', '-m', 'Initial commit');
  }

  return {
    root,
    file: (...parts) => path.join(root, ...parts),
    git,
    write,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
