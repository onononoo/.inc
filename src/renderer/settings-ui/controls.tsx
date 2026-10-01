import { useState } from 'react';
import { validateSetting, type SettingDef } from '@shared/settings';
import { Icon } from '../ui/Icon';
import { IconButton } from '../ui/IconButton';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Toggle } from '../ui/Toggle';
import { parseListInput, parseNumberInput } from './settings-model';

export interface ControlProps {
  def: SettingDef;
  value: unknown;
  disabled: boolean;
  /** Write a value. Resolves to an error message, or undefined on success. */
  commit: (value: unknown) => Promise<string | undefined>;
  /** Report a problem found before writing (shown under the control). */
  onError: (message: string | undefined) => void;
}

/** Check a value against the schema and write it. Returns the message to show when it is refused. */
async function validated(
  def: SettingDef,
  value: unknown,
  commit: ControlProps['commit'],
): Promise<string | undefined> {
  const check = validateSetting(def.key, value);
  if (!check.ok) return check.reason;
  return commit(check.value);
}

export function BooleanControl({ def, value, disabled, commit, onError }: ControlProps) {
  return (
    <Toggle
      checked={value === true}
      disabled={disabled}
      aria-label={def.title}
      onChange={(next) => void commit(next).then(onError)}
    />
  );
}

export function EnumControl({ def, value, disabled, commit, onError }: ControlProps) {
  const options = (def.enum ?? []).map((id, i) => ({
    value: id,
    label: def.enumLabels?.[i] ?? id,
  }));
  return (
    <Select
      aria-label={def.title}
      options={options}
      value={String(value)}
      disabled={disabled}
      onChange={(next) => void commit(next).then(onError)}
    />
  );
}

/** A number or text field. It writes on Enter or when it loses focus, never on every keystroke. */
export function TextControl({ def, value, disabled, commit, onError }: ControlProps) {
  const numeric = def.type === 'number';
  const shown = String(value ?? '');
  const [draft, setDraft] = useState(shown);
  const [seen, setSeen] = useState(shown);
  // The value changed from outside (reset, another window): show it instead of the old draft.
  if (seen !== shown) {
    setSeen(shown);
    setDraft(shown);
  }

  const submit = async () => {
    if (draft === shown) return onError(undefined);
    let next: unknown = draft;
    if (numeric) {
      const parsed = parseNumberInput(draft);
      if (parsed === null) return onError('Enter a number.');
      next = parsed;
    }
    const message = await validated(def, next, commit);
    onError(message);
    if (message) return;
  };

  return (
    <Input
      numeric={numeric}
      aria-label={def.title}
      value={draft}
      disabled={disabled}
      spellCheck={false}
      inputMode={numeric ? 'decimal' : undefined}
      onChange={(e) => {
        setDraft(e.target.value);
        onError(undefined);
      }}
      onBlur={() => void submit()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void submit();
        else if (e.key === 'Escape') {
          setDraft(shown);
          onError(undefined);
        }
      }}
    />
  );
}

/** A list of strings or numbers as removable chips, with a field to add more. */
export function ListControl({ def, value, disabled, commit, onError }: ControlProps) {
  const [text, setText] = useState('');
  const items = Array.isArray(value) ? (value as (string | number)[]) : [];
  const type = def.type === 'number[]' ? 'number[]' : 'string[]';

  const write = async (next: (string | number)[]) => onError(await validated(def, next, commit));

  const add = async () => {
    const { values, invalid } = parseListInput(text, type);
    if (invalid.length > 0) return onError(`Not a number: ${invalid.join(', ')}.`);
    if (values.length === 0) return;
    setText('');
    await write([...items, ...values.filter((v) => !items.includes(v))]);
  };

  return (
    <div className="chips">
      <ul className="chip-list" aria-label={`${def.title} values`}>
        {items.map((item, index) => (
          <li className="chip" key={`${item}-${index}`}>
            <span>{String(item)}</span>
            <button
              type="button"
              className="chip-remove"
              disabled={disabled}
              aria-label={`Remove ${String(item)}`}
              onClick={() => void write(items.filter((_, i) => i !== index))}
            >
              <Icon name="close" size={12} />
            </button>
          </li>
        ))}
      </ul>
      <Input
        aria-label={`Add to ${def.title}`}
        placeholder={type === 'number[]' ? 'Add a number' : 'Add a value'}
        value={text}
        disabled={disabled}
        onChange={(e) => {
          setText(e.target.value);
          onError(undefined);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void add();
          }
        }}
      />
    </div>
  );
}

/** A table of name and value pairs: switches for yes or no, text for strings. */
export function RecordControl({ def, value, disabled, commit, onError }: ControlProps) {
  const [name, setName] = useState('');
  const record = (value && typeof value === 'object' ? value : {}) as Record<
    string,
    boolean | string
  >;
  const boolean = def.type === 'record<boolean>';
  const entries = Object.entries(record);

  const write = async (next: Record<string, boolean | string>) =>
    onError(await validated(def, next, commit));

  return (
    <div className="records">
      {entries.map(([key, entry]) => (
        <div className="record" key={key}>
          <span className="record-key" title={key}>
            {key}
          </span>
          {boolean ? (
            <Toggle
              checked={entry === true}
              disabled={disabled}
              aria-label={`${key} on or off`}
              onChange={(next) => void write({ ...record, [key]: next })}
            />
          ) : (
            <Input
              aria-label={`Value for ${key}`}
              defaultValue={String(entry)}
              disabled={disabled}
              onBlur={(e) =>
                e.target.value !== entry && void write({ ...record, [key]: e.target.value })
              }
            />
          )}
          <IconButton
            icon="close"
            label={`Remove ${key}`}
            disabled={disabled}
            onClick={() => {
              const rest = { ...record };
              delete rest[key];
              void write(rest);
            }}
          />
        </div>
      ))}
      <Input
        aria-label={`Add to ${def.title}`}
        placeholder={boolean ? 'Add a pattern, e.g. **/dist' : 'Add a name'}
        value={name}
        disabled={disabled}
        onChange={(e) => {
          setName(e.target.value);
          onError(undefined);
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || name.trim() === '') return;
          e.preventDefault();
          const key = name.trim();
          setName('');
          void write({ ...record, [key]: boolean ? true : '' });
        }}
      />
    </div>
  );
}

/** The control that edits a setting, chosen by the setting's type. */
export function SettingControl(props: ControlProps) {
  switch (props.def.type) {
    case 'boolean':
      return <BooleanControl {...props} />;
    case 'enum':
      return <EnumControl {...props} />;
    case 'string[]':
    case 'number[]':
      return <ListControl {...props} />;
    case 'record<boolean>':
    case 'record<string>':
      return <RecordControl {...props} />;
    default:
      return <TextControl {...props} />;
  }
}
