import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { KeybindingOverride } from '@shared/api/settings';
import { describeError } from '@shared/errors';
import {
  canonicalChord,
  chordLabel,
  isModifierOnly,
  parseChord,
  strokeFromEvent,
  type Stroke,
} from '@shared/keys';
import type { Platform } from '@shared/paths';
import type { CustomEditorProps } from '../contracts/editor';
import type { ResolvedKeybinding } from '../contracts/commands';
import { ipc, platform as hostPlatform } from '../services/ipc';
import { service } from '../services/registry';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { Icon } from '../ui/Icon';
import { IconButton } from '../ui/IconButton';
import { Input } from '../ui/Input';
import { Kbd } from '../ui/Kbd';
import { cx } from '../ui/cx';
import {
  commandTitle,
  conflictsFor,
  matchesShortcut,
  parseKeybindingsFile,
  removeBinding,
  resetBinding,
  setBinding,
  shortcutRows,
  type ShortcutRow,
} from './keybindings-model';
import './settings-ui.css';

const platform = hostPlatform as Platform;

function labelOf(chord: string): string {
  const parsed = parseChord(chord, platform);
  return parsed ? chordLabel(parsed, platform) : chord;
}

/** Read keybindings.json, apply a change and write it back. The file watcher feeds the result to the app. */
async function editFile(change: (text: string) => string): Promise<boolean> {
  const notifications = service('notifications');
  try {
    const path = await ipc.invoke('keybindings:ensureFile');
    const read = await ipc.invoke('fs:readFile', path);
    const text = read.kind === 'text' ? read.content : '';
    const parsed = parseKeybindingsFile(text);
    if (parsed.errors.length > 0 || !parsed.isArray) {
      notifications.error(
        'keybindings.json has a syntax error.',
        'Fix the file, then change shortcuts here again.',
      );
      return false;
    }
    const next = change(text);
    if (next !== text) {
      await ipc.invoke('fs:writeFile', path, next, {
        encoding: read.encoding,
        expectedMtimeMs: read.mtimeMs,
      });
    }
    return true;
  } catch (error) {
    notifications.error('Could not change the shortcut.', describeError(error));
    return false;
  }
}

interface CaptureProps {
  row: ShortcutRow;
  resolved: readonly ResolvedKeybinding[];
  onDone: () => void;
}

/** "Press the key combination, then Enter." Two steps are allowed, as in Ctrl+K Ctrl+S. */
function Capture({ row, resolved, onDone }: CaptureProps) {
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);

  const chord = strokes.length > 0 ? canonicalChord(strokes, platform) : '';
  const conflicts = chord ? conflictsFor(chord, row.command.id, resolved) : [];
  const defaults = resolved
    .filter((b) => b.commandId === row.command.id && b.source === 'default')
    .map((b) => b.chord);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      onDone();
      return;
    }
    if (e.key === 'Enter' && chord) {
      e.preventDefault();
      void editFile((text) => setBinding(text, row.command.id, chord, defaults)).then(onDone);
      return;
    }
    if (e.key === 'Backspace' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      setStrokes((s) => s.slice(0, -1));
      return;
    }
    if (isModifierOnly(e)) return;
    e.preventDefault();
    const stroke = strokeFromEvent(e.nativeEvent);
    if (stroke) setStrokes((current) => (current.length >= 2 ? [stroke] : [...current, stroke]));
  };

  return (
    <div className="capture">
      <input
        ref={ref}
        className="ui-input capture-input"
        aria-label={`New shortcut for ${commandTitle(row.command)}`}
        placeholder="Press the key combination, then Enter"
        readOnly
        value={chord ? labelOf(chord) : ''}
        onKeyDown={onKeyDown}
        onBlur={onDone}
      />
      {conflicts.length > 0 && (
        <p className="capture-conflict" role="alert">
          <Icon name="alert-triangle" size={14} />
          <span>Also used by {conflicts.join(', ')}. Both will run.</span>
        </p>
      )}
    </div>
  );
}

/** Every command with its shortcut: search, change a shortcut, remove it or restore the default. */
export function KeybindingsEditor(_props: CustomEditorProps) {
  const keybindings = service('keybindings');
  const [version, setVersion] = useState(0);
  const [query, setQuery] = useState('');
  const [capturing, setCapturing] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<KeybindingOverride[]>([]);

  useEffect(() => keybindings.onDidChange(() => setVersion((v) => v + 1)), [keybindings]);
  useEffect(() => {
    void ipc.invoke('keybindings:get').then((snapshot) => setOverrides(snapshot.entries));
    return ipc.on('keybindings:changed', (snapshot) => setOverrides(snapshot.entries));
  }, []);

  const resolved = useMemo(() => {
    void version; // the bindings changed: read them again
    return keybindings.all();
  }, [keybindings, version]);
  const rows = useMemo(
    () => shortcutRows(resolved, overrides).filter((r) => matchesShortcut(r, query, platform)),
    [resolved, overrides, query],
  );
  const defaultsOf = (id: string) =>
    resolved.filter((b) => b.commandId === id && b.source === 'default').map((b) => b.chord);

  return (
    <div className="settings" data-testid="keybindings-editor">
      <header className="settings-header">
        <div className="settings-search">
          <Input
            type="search"
            aria-label="Search keyboard shortcuts"
            placeholder="Search by command or key"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-autofocus
          />
          <span className="settings-count" role="status">
            {rows.length === 1 ? '1 command' : `${rows.length} commands`}
          </span>
        </div>
        <Button
          size="sm"
          variant="ghost"
          icon="file-json"
          onClick={() => void service('commands').execute('settings.openKeybindingsJson')}
        >
          Open keyboard shortcuts (JSON)
        </Button>
      </header>
      <div className="keys-scroll" role="region" aria-label="Keyboard shortcuts">
        {rows.length === 0 ? (
          <EmptyState
            title="No commands match"
            description={query ? `Nothing matches "${query}".` : undefined}
            action={query ? <Button onClick={() => setQuery('')}>Clear search</Button> : undefined}
          />
        ) : (
          <table className="keys-table">
            <thead>
              <tr>
                <th scope="col">Command</th>
                <th scope="col">Keybinding</th>
                <th scope="col">When</th>
                <th scope="col">Source</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const isCapturing = capturing === row.command.id;
                return (
                  <tr
                    key={row.command.id}
                    className={cx(row.modified && 'is-modified')}
                    data-testid={`key-${row.command.id}`}
                  >
                    <td className="keys-command">
                      <span>{commandTitle(row.command)}</span>
                      <span className="keys-id">{row.command.id}</span>
                    </td>
                    <td className="keys-binding">
                      {isCapturing ? (
                        <Capture row={row} resolved={resolved} onDone={() => setCapturing(null)} />
                      ) : row.bindings.length > 0 ? (
                        <span className="keys-chips">
                          {row.bindings.map((b) => (
                            <Kbd key={b.chord + (b.when ?? '')} keys={labelOf(b.chord)} />
                          ))}
                        </span>
                      ) : (
                        <span className="keys-none">{row.unbound ? 'Removed' : 'Not set'}</span>
                      )}
                    </td>
                    <td className="keys-when">{row.bindings[0]?.when ?? ''}</td>
                    <td className="keys-source">
                      {row.modified ? 'User' : row.bindings.length > 0 ? 'Default' : ''}
                    </td>
                    <td className="keys-actions">
                      <IconButton
                        icon="edit"
                        label={`Change the shortcut for ${commandTitle(row.command)}`}
                        onClick={() => setCapturing(row.command.id)}
                      />
                      <IconButton
                        icon="close"
                        label="Remove the shortcut"
                        disabled={row.bindings.length === 0}
                        onClick={() =>
                          void editFile((t) =>
                            removeBinding(t, row.command.id, defaultsOf(row.command.id)),
                          )
                        }
                      />
                      <IconButton
                        icon="reset"
                        label="Reset to the default shortcut"
                        disabled={!row.modified}
                        onClick={() => void editFile((t) => resetBinding(t, row.command.id))}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
