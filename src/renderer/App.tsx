import { useWorkspace } from './state/workspace-store';

/** Placeholder shell, replaced by the workbench layout slice. */
export function App() {
  const workspace = useWorkspace();
  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ margin: 0 }}>.inc</h1>
      <p data-testid="workspace-name">{workspace ? workspace.name : 'No folder open'}</p>
    </div>
  );
}
