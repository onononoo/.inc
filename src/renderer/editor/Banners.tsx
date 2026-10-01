import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import type { DocumentInfo } from './document';
import { editorRuntime } from './runtime';

function Banner({
  tone,
  icon,
  children,
  actions,
}: {
  tone: 'warning' | 'info';
  icon: string;
  children: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className={`eg-banner is-${tone}`} role="status">
      <Icon name={icon} className="eg-banner-icon" />
      <span className="eg-banner-text">{children}</span>
      {actions && <span className="eg-banner-actions">{actions}</span>}
    </div>
  );
}

/** Compact bars under the tabs that explain a document's state and offer the way forward. */
export function DocumentBanners({ doc }: { doc: DocumentInfo }) {
  const { documents } = editorRuntime();
  const act = (action: (d: NonNullable<ReturnType<typeof documents.get>>) => void) => {
    const current = documents.get(doc.key);
    if (current) action(current);
  };
  return (
    <>
      {doc.conflict && (
        <Banner
          tone="warning"
          icon="alert-triangle"
          actions={
            <>
              <Button size="sm" onClick={() => act((d) => void documents.reload(d))}>
                Reload
              </Button>
              <Button size="sm" variant="ghost" onClick={() => act((d) => documents.keepMine(d))}>
                Keep mine
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => act((d) => void documents.compareWithDisk(d))}
              >
                Compare
              </Button>
            </>
          }
        >
          This file changed on disk and you have unsaved changes.
        </Banner>
      )}
      {doc.deletedOnDisk && (
        <Banner tone="warning" icon="alert-triangle">
          This file was deleted from disk. Saving it will create it again.
        </Banner>
      )}
      {doc.readOnly && (
        <Banner tone="info" icon="lock">
          This file is read-only.
        </Banner>
      )}
      {doc.largeFile && (
        <Banner tone="info" icon="info">
          This is a large file. Some editor features are turned off to keep it fast.
        </Banner>
      )}
    </>
  );
}
