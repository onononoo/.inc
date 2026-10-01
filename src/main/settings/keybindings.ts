/**
 * Keybindings file (userData/keybindings.json): parsing, validation and chord normalisation.
 *
 * Notation is defined in shared/commands/types.ts: modifiers joined with "+", steps of a chord
 * separated by a space. Validation is forgiving about case and common aliases and returns the
 * canonical spelling, so the renderer only ever sees one form.
 */
import { getNodeValue } from 'jsonc-parser';
import type { KeybindingOverride, SettingsIssue } from '@shared/api/settings';
import { commandById } from '@shared/commands/catalog';
import { isValidWhen } from '@shared/when';
import { describeProblem, lineOfNode, lineStarts, parseDocument } from './jsonc';

const MODIFIERS: Record<string, string> = {
  mod: 'Mod',
  ctrl: 'Ctrl',
  control: 'Ctrl',
  cmd: 'Cmd',
  command: 'Cmd',
  meta: 'Cmd',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
};

const NAMED_KEYS: Record<string, string> = {
  enter: 'Enter',
  return: 'Enter',
  escape: 'Escape',
  esc: 'Escape',
  tab: 'Tab',
  space: 'Space',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  arrowup: 'ArrowUp',
  up: 'ArrowUp',
  arrowdown: 'ArrowDown',
  down: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  left: 'ArrowLeft',
  arrowright: 'ArrowRight',
  right: 'ArrowRight',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pgup: 'PageUp',
  pagedown: 'PageDown',
  pgdn: 'PageDown',
  insert: 'Insert',
};

const PUNCTUATION = new Set(['`', ',', '.', '/', '\\', '[', ']', '-', '=', ';']);
const MAX_STEPS = 2;

type StepResult = { ok: true; text: string; hasModifier: boolean } | { ok: false; reason: string };

function normalizeKey(raw: string): string | null {
  if (/^[A-Za-z]$/.test(raw)) return raw.toUpperCase();
  if (/^[0-9]$/.test(raw)) return raw;
  if (PUNCTUATION.has(raw)) return raw;
  const fn = /^f([1-9]|1[0-9]|2[0-4])$/i.exec(raw);
  if (fn) return `F${fn[1]}`;
  return NAMED_KEYS[raw.toLowerCase()] ?? null;
}

function normalizeStep(step: string): StepResult {
  const parts = step.split('+');
  const keyPart = parts.pop() ?? '';
  const modifiers: string[] = [];
  for (const part of parts) {
    const modifier = MODIFIERS[part.toLowerCase()];
    if (!modifier) return { ok: false, reason: `"${part}" is not a modifier.` };
    if (modifiers.includes(modifier)) {
      return { ok: false, reason: `The modifier ${modifier} is repeated.` };
    }
    modifiers.push(modifier);
  }
  if (keyPart === '') return { ok: false, reason: 'A key is missing after the last "+".' };
  const key = normalizeKey(keyPart);
  if (!key) return { ok: false, reason: `"${keyPart}" is not a key name.` };
  return { ok: true, text: [...modifiers, key].join('+'), hasModifier: modifiers.length > 0 };
}

/** Canonical spelling of a chord, or the reason it is invalid. */
export function normalizeChord(
  input: string,
): { ok: true; chord: string } | { ok: false; reason: string } {
  const steps = input.trim().split(/\s+/);
  if (steps.length === 0 || steps[0] === '') return { ok: false, reason: 'The key is empty.' };
  if (steps.length > MAX_STEPS) {
    return { ok: false, reason: `A chord can have at most ${MAX_STEPS} steps.` };
  }
  const out: string[] = [];
  for (const [index, step] of steps.entries()) {
    const result = normalizeStep(step);
    if (!result.ok) return result;
    // A bare printable key in the first step would swallow ordinary typing.
    const printable = /^(?:[A-Z0-9]|Space|[`,./\\[\]\-=;])$/.test(result.text);
    if (index === 0 && !result.hasModifier && printable) {
      return { ok: false, reason: `"${step}" needs a modifier such as Mod, Ctrl or Alt.` };
    }
    out.push(result.text);
  }
  return { ok: true, chord: out.join(' ') };
}

export interface ParsedKeybindings {
  entries: KeybindingOverride[];
  issues: SettingsIssue[];
  syntaxError: boolean;
}

const ENTRY_FIELDS = new Set(['key', 'command', 'when', 'args']);

/** Parse and validate the text of a keybindings file. `text` is null when the file is missing. */
export function parseKeybindings(text: string | null, file: string): ParsedKeybindings {
  const entries: KeybindingOverride[] = [];
  const issues: SettingsIssue[] = [];
  if (text === null) return { entries, issues, syntaxError: false };

  const doc = parseDocument(text);
  if (doc.problems.length > 0) {
    for (const problem of doc.problems) {
      issues.push({
        file,
        line: problem.line,
        message: `${describeProblem(problem)} The previous shortcuts stay in effect until this is fixed.`,
      });
    }
    return { entries, issues, syntaxError: true };
  }
  if (!doc.root) return { entries, issues, syntaxError: false };
  if (doc.root.type !== 'array') {
    issues.push({
      file,
      line: 1,
      message:
        'The file must contain a list, for example [ { "key": "Mod+Shift+L", "command": "..." } ].',
    });
    return { entries, issues, syntaxError: true };
  }

  const starts = lineStarts(text);
  for (const node of doc.root.children ?? []) {
    const line = lineOfNode(starts, node);
    const problem = (message: string, command?: string): void => {
      issues.push({ file, line, message, ...(command ? { key: command } : {}) });
    };
    const raw = getNodeValue(node) as unknown;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      problem('Each entry must be an object with "key" and "command".');
      continue;
    }
    const item = raw as Record<string, unknown>;
    if (typeof item.command !== 'string' || item.command.trim() === '') {
      problem('The entry has no "command", so it was ignored.');
      continue;
    }
    const command = item.command.trim();
    if (typeof item.key !== 'string') {
      problem(`The entry for "${command}" has no "key", so it was ignored.`, command);
      continue;
    }
    const chord = normalizeChord(item.key);
    if (!chord.ok) {
      problem(
        `Invalid key "${item.key}" for "${command}": ${chord.reason} It was ignored.`,
        command,
      );
      continue;
    }
    if (item.when !== undefined) {
      if (typeof item.when !== 'string' || !isValidWhen(item.when)) {
        problem(`Invalid "when" clause for "${command}", so the entry was ignored.`, command);
        continue;
      }
    }
    const id = command.startsWith('-') ? command.slice(1) : command;
    if (!commandById(id)) {
      problem(
        `"${id}" is not a known command. The entry is kept in case it is provided later.`,
        command,
      );
    }
    for (const field of Object.keys(item)) {
      if (!ENTRY_FIELDS.has(field)) problem(`Unknown field "${field}" was ignored.`, command);
    }
    const entry: KeybindingOverride = { key: chord.chord, command };
    if (typeof item.when === 'string' && item.when.trim() !== '') entry.when = item.when.trim();
    if (item.args !== undefined) entry.args = item.args;
    entries.push(entry);
  }
  return { entries, issues, syntaxError: false };
}
