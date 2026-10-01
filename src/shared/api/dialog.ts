export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface MessageBoxOptions {
  type?: 'none' | 'info' | 'warning' | 'error' | 'question';
  title?: string;
  message: string;
  detail?: string;
  buttons: string[];
  defaultId?: number;
  cancelId?: number;
  checkboxLabel?: string;
}

export interface MessageBoxResult {
  response: number;
  checkboxChecked: boolean;
}

export interface DialogInvoke {
  /** Returns null when cancelled. */
  'dialog:openFolder': (options?: { title?: string; defaultPath?: string }) => string | null;
  /** Returns an empty list when cancelled. */
  'dialog:openFiles': (options?: {
    title?: string;
    defaultPath?: string;
    filters?: FileFilter[];
    multiple?: boolean;
  }) => string[];
  /** Returns null when cancelled. */
  'dialog:saveAs': (options?: {
    title?: string;
    defaultPath?: string;
    filters?: FileFilter[];
  }) => string | null;
  'dialog:message': (options: MessageBoxOptions) => MessageBoxResult;
}

export type DialogEvents = Record<never, never>;
