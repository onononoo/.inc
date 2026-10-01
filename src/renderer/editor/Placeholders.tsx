import { useEffect, useState } from 'react';
import { describeError } from '@shared/errors';
import { ipc } from '../services/ipc';
import { service } from '../services/registry';
import { getSetting } from '../state/settings-store';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { Spinner } from '../ui/Spinner';
import type { DocumentInfo } from './document';
import { formatBytes } from './document-policy';
import { editorRuntime } from './runtime';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'svg']);
const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
};

export function isImagePath(path: string | null): boolean {
  if (!path) return false;
  const dot = path.lastIndexOf('.');
  return dot !== -1 && IMAGE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

function revealButton(path: string | null) {
  return path ? (
    <Button onClick={() => void ipc.invoke('fs:reveal', path)}>Reveal in file manager</Button>
  ) : undefined;
}

export function BinaryPlaceholder({ doc }: { doc: DocumentInfo }) {
  return (
    <div className="eg-placeholder">
      <EmptyState
        title={`${doc.name} is a binary file`}
        description={`This file is ${formatBytes(doc.size)} and cannot be shown as text.`}
        action={revealButton(doc.path)}
      />
    </div>
  );
}

export function TooLargePlaceholder({ doc }: { doc: DocumentInfo }) {
  const limit = getSetting('editor.maxFileSizeMB');
  const open = () => {
    if (!doc.path) return;
    void editorRuntime()
      .documents.open(doc.path, { loadAnyway: true })
      .catch((error) =>
        service('notifications').error(`Could not open ${doc.name}.`, describeError(error)),
      );
  };
  return (
    <div className="eg-placeholder">
      <EmptyState
        title={`${doc.name} is very large`}
        description={`This file is ${formatBytes(doc.size)}. The limit for opening files is ${limit} MB (setting editor.maxFileSizeMB).`}
        action={
          <span className="eg-placeholder-actions">
            <Button variant="primary" onClick={open}>
              Open anyway
            </Button>
            {revealButton(doc.path)}
          </span>
        }
        hint="Opening it turns off most editor features and can be slow."
      />
    </div>
  );
}

/** Image files: shown at the size that fits, or at their real size. A new file starts a fresh view. */
export function ImagePreview({ doc }: { doc: DocumentInfo }) {
  return <ImageView key={`${doc.path}:${doc.mtimeMs}`} doc={doc} />;
}

function ImageView({ doc }: { doc: DocumentInfo }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fit, setFit] = useState(true);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    let revoked: string | null = null;
    let cancelled = false;
    if (!doc.path) return;
    const extension = doc.path.slice(doc.path.lastIndexOf('.') + 1).toLowerCase();
    ipc
      .invoke('fs:readBytes', doc.path)
      .then((bytes) => {
        if (cancelled) return;
        const blob = new Blob([bytes as BlobPart], {
          type: MIME[extension] ?? 'application/octet-stream',
        });
        revoked = URL.createObjectURL(blob);
        setUrl(revoked);
      })
      .catch((e) => !cancelled && setError(describeError(e)));
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [doc.path, doc.mtimeMs]);

  if (error) {
    return (
      <div className="eg-placeholder">
        <EmptyState
          title={`Could not show ${doc.name}`}
          description={error}
          action={revealButton(doc.path)}
        />
      </div>
    );
  }

  return (
    <div className="eg-image">
      <div className="eg-image-bar">
        <span>
          {dimensions ? `${dimensions.width} × ${dimensions.height}` : ''}
          {dimensions ? '  ·  ' : ''}
          {formatBytes(doc.size)}
        </span>
        <Button size="sm" variant="ghost" onClick={() => setFit((v) => !v)}>
          {fit ? 'Actual size' : 'Fit to window'}
        </Button>
      </div>
      <div className="eg-image-stage">
        {url ? (
          <img
            src={url}
            alt={doc.name}
            className={fit ? 'is-fit' : undefined}
            onLoad={(e) =>
              setDimensions({
                width: e.currentTarget.naturalWidth,
                height: e.currentTarget.naturalHeight,
              })
            }
          />
        ) : (
          <Spinner label="Loading image" />
        )}
      </div>
    </div>
  );
}
