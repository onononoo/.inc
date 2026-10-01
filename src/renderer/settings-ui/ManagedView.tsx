import { SETTINGS, type SettingKey } from '@shared/settings';
import type { CustomEditorProps } from '../contracts/editor';
import { usePolicy } from '../state/policy-store';
import { EmptyState } from '../ui/EmptyState';
import { Icon } from '../ui/Icon';
import { describeValue } from './settings-model';
import './settings-ui.css';

const FEATURES: {
  key: 'terminal' | 'tasks' | 'gitRemoteOperations' | 'externalLinks';
  label: string;
}[] = [
  { key: 'terminal', label: 'Integrated terminal' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'gitRemoteOperations', label: 'Git fetch, pull and push' },
  { key: 'externalLinks', label: 'Links that open in the browser' },
];

function featureState(key: (typeof FEATURES)[number]['key'], value: unknown): string {
  if (key === 'externalLinks') {
    return value === 'allow' ? 'Allowed' : value === 'deny' ? 'Blocked' : 'Ask first';
  }
  return value === false ? 'Turned off' : 'Allowed';
}

/** What the organization has configured. Read-only: nothing here can be edited from the app. */
export function ManagedView(_props: CustomEditorProps) {
  const policy = usePolicy();
  if (!policy.active) {
    return (
      <div className="settings" data-testid="managed-view">
        <EmptyState
          title="This installation is not managed"
          description="No administrator policy file was found."
        />
      </div>
    );
  }
  return (
    <div className="settings managed" data-testid="managed-view">
      <div className="managed-inner">
        <h1 className="managed-title">
          <Icon name="shield" />
          Managed configuration
        </h1>
        <p className="managed-lead">
          Your organization manages this installation. These values cannot be changed here.
        </p>
        {policy.notice && <p className="managed-notice">{policy.notice}</p>}
        <dl className="managed-meta">
          <dt>Policy file</dt>
          <dd className="selectable">{policy.file ?? 'Unknown'}</dd>
        </dl>

        <h2 className="managed-heading">Features</h2>
        <table className="keys-table">
          <thead>
            <tr>
              <th scope="col">Feature</th>
              <th scope="col">State</th>
            </tr>
          </thead>
          <tbody>
            {FEATURES.map((f) => (
              <tr key={f.key}>
                <td>{f.label}</td>
                <td>{featureState(f.key, policy.features[f.key])}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h2 className="managed-heading">Enforced settings</h2>
        {policy.lockedKeys.length === 0 ? (
          <p className="managed-lead">No settings are enforced.</p>
        ) : (
          <table className="keys-table">
            <thead>
              <tr>
                <th scope="col">Setting</th>
                <th scope="col">Value</th>
              </tr>
            </thead>
            <tbody>
              {policy.lockedKeys.map((key) => (
                <tr key={key} data-testid={`managed-${key}`}>
                  <td className="keys-command">
                    <span>{SETTINGS[key as SettingKey]?.title ?? key}</span>
                    <span className="keys-id">{key}</span>
                  </td>
                  <td className="selectable">{describeValue(policy.values[key as SettingKey])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {policy.warnings.length > 0 && (
          <>
            <h2 className="managed-heading">Problems in the policy file</h2>
            <ul className="managed-warnings">
              {policy.warnings.map((w, i) => (
                <li key={i}>
                  <Icon name="alert-triangle" size={14} />
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="managed-lead">To change any of this, contact your administrator.</p>
      </div>
    </div>
  );
}
