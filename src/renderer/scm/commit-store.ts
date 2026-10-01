import { create } from 'zustand';

interface CommitState {
  message: string;
  amend: boolean;
  busy: boolean;
  /** Bumped when the message box should take focus. */
  focusNonce: number;
}

export const useCommitStore = create<CommitState>(() => ({
  message: '',
  amend: false,
  busy: false,
  focusNonce: 0,
}));

export function setMessage(message: string): void {
  useCommitStore.setState({ message });
}

export function setAmend(amend: boolean): void {
  useCommitStore.setState({ amend });
}

export function setBusy(busy: boolean): void {
  useCommitStore.setState({ busy });
}

export function focusMessage(): void {
  useCommitStore.setState((s) => ({ focusNonce: s.focusNonce + 1 }));
}

export function clearCommit(): void {
  useCommitStore.setState({ message: '', amend: false });
}
