import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/base.css';
import './styles/ui.css';
import { App } from './App';
import { registerAllSlices } from './register-all';
import { loadSession } from './services/session';
import { initSettings } from './state/settings-store';
import { initWorkspace } from './state/workspace-store';
import { applyStoredTheme } from './workbench/theme';

// Paint with the last theme straight away; the real value replaces it once settings have loaded.
applyStoredTheme();

async function boot(): Promise<void> {
  await Promise.all([initSettings(), initWorkspace()]);
  await loadSession();
  registerAllSlices();
  const root = document.getElementById('root');
  if (!root) throw new Error('Missing #root');
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
