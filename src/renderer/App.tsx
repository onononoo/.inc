import { ErrorBoundary } from './ui/ErrorBoundary';
import { Workbench } from './workbench/Workbench';

export function App() {
  return (
    <ErrorBoundary region="The window">
      <Workbench />
    </ErrorBoundary>
  );
}
