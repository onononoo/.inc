/**
 * Nested ignore-file evaluation (.gitignore and .ignore) with Git's precedence: rules in a
 * deeper folder override rules in the folders above it, and a later rule overrides an earlier one.
 */
import createIgnore, { type Ignore } from 'ignore';

/** The file names read from each folder, in increasing order of precedence. */
export const IGNORE_FILE_NAMES = ['.gitignore', '.ignore'] as const;

/** `ignore` caches every path it has seen; rebuild an instance after this many lookups. */
const REBUILD_AFTER = 20_000;

const ignoreCase = process.platform !== 'linux';

export class IgnoreRules {
  private ig: Ignore;
  private uses = 0;

  constructor(
    readonly base: string,
    private readonly text: string,
  ) {
    this.ig = this.build();
  }

  private build(): Ignore {
    return createIgnore({ ignoreCase }).add(this.text);
  }

  /** `true` ignored, `false` re-included by a negation, `undefined` no rule applies. */
  verdict(relativePath: string, isDir: boolean): boolean | undefined {
    const inner = this.base === '' ? relativePath : relativePath.slice(this.base.length + 1);
    if (inner === '') return undefined;
    if (++this.uses > REBUILD_AFTER) {
      this.ig = this.build();
      this.uses = 0;
    }
    try {
      const result = this.ig.test(isDir ? `${inner}/` : inner);
      if (result.ignored) return true;
      if (result.unignored) return false;
    } catch {
      /* a path the ignore library cannot represent is simply not ignored */
    }
    return undefined;
  }
}

/** The ignore rules in force for one folder: its ancestors' files plus its own. */
export class IgnoreChain {
  constructor(private readonly rules: readonly IgnoreRules[]) {}

  static readonly empty = new IgnoreChain([]);

  /** A chain with one more ignore file, which sits in folder `base`. */
  with(base: string, text: string): IgnoreChain {
    return new IgnoreChain([...this.rules, new IgnoreRules(base, text)]);
  }

  get length(): number {
    return this.rules.length;
  }

  isIgnored(relativePath: string, isDir: boolean): boolean {
    let ignored = false;
    for (const rule of this.rules) {
      const verdict = rule.verdict(relativePath, isDir);
      if (verdict !== undefined) ignored = verdict;
    }
    return ignored;
  }
}
