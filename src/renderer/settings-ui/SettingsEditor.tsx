import { memo, useDeferredValue, useMemo, useState } from 'react';
import { describeError } from '@shared/errors';
import type { SettingKey } from '@shared/settings';
import { SETTING_CATEGORIES } from '@shared/settings';
import type { CustomEditorProps } from '../contracts/editor';
import { ipc } from '../services/ipc';
import { service } from '../services/registry';
import { resetSetting, setSetting, useSettingsStore } from '../state/settings-store';
import { usePolicy } from '../state/policy-store';
import { useWorkspace } from '../state/workspace-store';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { Icon } from '../ui/Icon';
import { IconButton } from '../ui/IconButton';
import { Input } from '../ui/Input';
import { cx } from '../ui/cx';
import { SettingControl } from './controls';
import {
  categoryCounts,
  describeValue,
  splitTitle,
  visibleRows,
  type CategoryFilter,
  type RowState,
  type Scope,
} from './settings-model';
import './settings-ui.css';

const SOURCE_LABEL: Record<RowState['source'], string> = {
  default: 'Default',
  user: 'Set in your settings',
  workspace: 'Set in this workspace',
  policy: 'Enforced by your organization',
};

interface RowProps {
  row: RowState;
  scope: Scope;
  policyNotice: string | null;
}

const SettingRow = memo(function SettingRow({ row, scope, policyNotice }: RowProps) {
  const { def } = row;
  const [error, setError] = useState<string | undefined>();
  const disabled = row.locked || row.restricted;
  const { prefix, name } = splitTitle(def);
  const key = def.key as SettingKey;

  const commit = async (value: unknown): Promise<string | undefined> => {
    try {
      await setSetting(key, value as never, scope);
      return undefined;
    } catch (e) {
      return describeError(e);
    }
  };

  const reset = async () => {
    try {
      await resetSetting(key, scope);
      setError(undefined);
    } catch (e) {
      setError(describeError(e));
    }
  };

  return (
    <li
      className={cx('srow', row.modified && 'is-modified', row.locked && 'is-locked')}
      data-testid={`setting-${def.key}`}
      data-key={def.key}
    >
      <div className="srow-text">
        <h2 className="srow-title">
          {row.locked && <Icon name="lock" size={14} className="srow-lock" label="Managed" />}
          <span className="srow-prefix">{prefix}:</span>
          <span className="srow-name">{name}</span>
          {row.modified && (
            <span className="srow-modified">
              Modified
              <IconButton
                icon="reset"
                label={`Reset ${name} to its default`}
                disabled={disabled}
                onClick={() => void reset()}
              />
            </span>
          )}
        </h2>
        <p className="srow-description">{def.description}</p>
        {row.locked && (
          <p className="srow-managed">
            <Icon name="shield" size={14} />
            <span>
              Managed by your organization.
              {policyNotice ? ` ${policyNotice}` : ''}
            </span>
          </p>
        )}
        {row.restricted && (
          <p className="srow-managed">
            <Icon name="shield-alert" size={14} />
            <span>This setting is ignored in Restricted Mode. Trust this folder to use it.</span>
          </p>
        )}
        {!row.locked && row.source !== 'default' && (
          <p className="srow-source">
            {SOURCE_LABEL[row.source]}
            {row.source !== scope && row.source !== 'policy'
              ? `. Current value: ${describeValue(row.value)}`
              : ''}
          </p>
        )}
        {error && (
          <p className="srow-error" role="alert">
            <Icon name="alert-circle" size={14} />
            <span>{error}</span>
          </p>
        )}
      </div>
      <div className="srow-control">
        <SettingControl
          def={def}
          value={row.value}
          disabled={disabled}
          commit={commit}
          onError={setError}
        />
      </div>
    </li>
  );
});

/** The settings editor: search, categories, a user and workspace switch, and every setting as a row. */
export function SettingsEditor(_props: CustomEditorProps) {
  const snapshot = useSettingsStore((s) => s.snapshot);
  const workspace = useWorkspace();
  const policy = usePolicy();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<CategoryFilter>('all');
  const [scope, setScope] = useState<Scope>('user');
  const deferred = useDeferredValue(query);
  const trusted = workspace?.trust !== 'untrusted';
  const effectiveScope: Scope = scope === 'workspace' && workspace ? 'workspace' : 'user';

  const rows = useMemo(
    () =>
      snapshot
        ? visibleRows(snapshot, { query: deferred, category, scope: effectiveScope, trusted })
        : [],
    [snapshot, deferred, category, effectiveScope, trusted],
  );
  const counts = useMemo(
    () =>
      snapshot ? categoryCounts(snapshot, { query: deferred, scope: effectiveScope, trusted }) : {},
    [snapshot, deferred, effectiveScope, trusted],
  );

  if (!snapshot) {
    return (
      <div className="settings">
        <EmptyState
          title="Settings could not be loaded"
          description="Close this tab and open settings again."
        />
      </div>
    );
  }

  const openJson = (which: Scope) =>
    void service('commands').execute(
      which === 'user' ? 'settings.openJson' : 'settings.openWorkspaceJson',
    );

  const nav: { id: CategoryFilter; label: string }[] = [
    { id: 'all', label: 'All settings' },
    { id: 'modified', label: 'Modified' },
    ...(policy.active ? [{ id: 'managed' as const, label: 'Managed' }] : []),
    ...SETTING_CATEGORIES.map((c) => ({ id: c as CategoryFilter, label: c })),
  ];

  return (
    <div className="settings" data-testid="settings-editor">
      <header className="settings-header">
        <div className="settings-search">
          <Input
            type="search"
            aria-label="Search settings"
            placeholder="Search settings"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-autofocus
          />
          <span className="settings-count" role="status">
            {rows.length === 1 ? '1 setting' : `${rows.length} settings`}
          </span>
        </div>
        <div className="settings-scope" role="tablist" aria-label="Settings scope">
          <button
            type="button"
            role="tab"
            aria-selected={effectiveScope === 'user'}
            className={cx('scope-tab', effectiveScope === 'user' && 'is-selected')}
            onClick={() => setScope('user')}
          >
            User
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={effectiveScope === 'workspace'}
            aria-disabled={!workspace}
            disabled={!workspace}
            title={workspace ? undefined : 'Open a folder to change workspace settings'}
            className={cx('scope-tab', effectiveScope === 'workspace' && 'is-selected')}
            onClick={() => setScope('workspace')}
          >
            Workspace
          </button>
        </div>
        <Button size="sm" variant="ghost" icon="file-json" onClick={() => openJson(effectiveScope)}>
          Open settings (JSON)
        </Button>
      </header>

      {snapshot.issues.length > 0 && (
        <div className="settings-issues" role="status">
          <Icon name="alert-triangle" size={14} />
          <span>
            {snapshot.issues.length === 1 ? '1 problem' : `${snapshot.issues.length} problems`}{' '}
            found in your settings files. {snapshot.issues[0]?.message}
          </span>
        </div>
      )}

      {effectiveScope === 'workspace' && !trusted && (
        <div className="settings-issues" role="status">
          <Icon name="shield-alert" size={14} />
          <span>
            Restricted Mode. Workspace settings that can run code are ignored until you trust this
            folder.
          </span>
          <Button
            size="sm"
            variant="primary"
            onClick={() => void ipc.invoke('workspace:setTrust', true)}
          >
            Trust folder
          </Button>
        </div>
      )}

      <div className="settings-body">
        <nav className="settings-nav" aria-label="Setting categories">
          {nav.map((item) => (
            <button
              key={item.id}
              type="button"
              className={cx('settings-nav-item', category === item.id && 'is-selected')}
              aria-current={category === item.id ? 'true' : undefined}
              onClick={() => setCategory(item.id)}
            >
              <span>{item.label}</span>
              <span className="settings-nav-count">{counts[item.id] ?? 0}</span>
            </button>
          ))}
        </nav>
        <div className="settings-list" role="region" aria-label="Settings">
          {rows.length === 0 ? (
            <EmptyState
              title="No settings match"
              description={
                query ? `Nothing matches "${query}".` : 'There are no settings in this view.'
              }
              action={
                query ? <Button onClick={() => setQuery('')}>Clear search</Button> : undefined
              }
            />
          ) : (
            <ul>
              {rows.map((row) => (
                <SettingRow
                  key={row.def.key + effectiveScope}
                  row={row}
                  scope={effectiveScope}
                  policyNotice={policy.notice}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
