import { describe, expect, it } from 'vitest';
import { COMMANDS, validateCatalog } from '@shared/commands/catalog';
import { SETTINGS, SETTING_KEYS, defaultSettings, validateSetting } from '@shared/settings';
import { evaluateWhen, isValidWhen } from '@shared/when';
import { IncError, toIncError } from '@shared/errors';

const ctx = (values: Record<string, string | number | boolean>) => (key: string) => values[key];

describe('when clauses', () => {
  it('treats empty clauses as true', () => {
    expect(evaluateWhen(undefined, ctx({}))).toBe(true);
    expect(evaluateWhen('  ', ctx({}))).toBe(true);
  });

  it('supports !, &&, ||, parentheses and comparisons', () => {
    const c = ctx({ a: true, b: false, view: 'explorer' });
    expect(evaluateWhen('a && !b', c)).toBe(true);
    expect(evaluateWhen('a && b', c)).toBe(false);
    expect(evaluateWhen('b || a', c)).toBe(true);
    expect(evaluateWhen('!(a && b)', c)).toBe(true);
    expect(evaluateWhen("view == 'explorer'", c)).toBe(true);
    expect(evaluateWhen('view != explorer', c)).toBe(false);
  });

  it('fails closed on malformed clauses', () => {
    expect(evaluateWhen('a &&', ctx({ a: true }))).toBe(false);
    expect(isValidWhen('a &&')).toBe(false);
    expect(isValidWhen('a && !b')).toBe(true);
  });
});

describe('command catalog', () => {
  it('has unique ids and no conflicting keybindings', () => {
    expect(validateCatalog()).toEqual([]);
    expect(COMMANDS.length).toBeGreaterThan(100);
  });
});

describe('settings schema', () => {
  it('defines a valid default for every setting', () => {
    for (const key of SETTING_KEYS) {
      const result = validateSetting(key, SETTINGS[key].default);
      expect(result.ok, `${key}: ${JSON.stringify(result)}`).toBe(true);
    }
    expect(Object.keys(defaultSettings())).toHaveLength(SETTING_KEYS.length);
  });

  it('rejects out-of-range and mistyped values', () => {
    expect(validateSetting('editor.fontSize', 3).ok).toBe(false);
    expect(validateSetting('editor.fontSize', '13').ok).toBe(false);
    expect(validateSetting('appearance.theme', 'neon').ok).toBe(false);
    expect(validateSetting('files.exclude', { a: 'yes' }).ok).toBe(false);
    expect(validateSetting('nope.key', 1).ok).toBe(false);
    expect(validateSetting('editor.fontSize', 14).ok).toBe(true);
  });
});

describe('errors', () => {
  it('maps Node errno codes', () => {
    expect(toIncError({ code: 'ENOENT', message: 'x' }).code).toBe('E_NOT_FOUND');
    expect(toIncError({ code: 'EACCES', message: 'x' }).code).toBe('E_PERMISSION');
    expect(toIncError('boom').code).toBe('E_UNKNOWN');
    const own = new IncError('E_POLICY', 'blocked');
    expect(toIncError(own)).toBe(own);
  });
});
