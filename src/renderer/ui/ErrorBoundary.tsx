import { Component, type ErrorInfo, type ReactNode } from 'react';
import { describeError } from '@shared/errors';
import { ipc } from '../services/ipc';
import { Button } from './Button';
import { EmptyState } from './EmptyState';

export interface ErrorBoundaryProps {
  /** Name of the region, used in the message and the log, e.g. "Explorer". */
  region: string;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: unknown;
}

/**
 * Keeps a failure in one view from blanking the whole window. The error is logged to the main
 * process log and the region shows a plain message with a way to try again.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: undefined };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error ?? new Error('Unknown error') };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    void ipc
      .invoke(
        'app:log',
        'error',
        `${this.props.region} failed to render: ${message}${info.componentStack ?? ''}`,
      )
      .catch(() => undefined);
  }

  override render(): ReactNode {
    if (this.state.error === undefined) return this.props.children;
    return (
      <div className="ui-boundary" role="alert">
        <EmptyState
          title={`${this.props.region} stopped working`}
          description={describeError(this.state.error)}
          action={
            <Button variant="secondary" onClick={() => this.setState({ error: undefined })}>
              Try again
            </Button>
          }
        />
      </div>
    );
  }
}
