/**
 * Access to the API. A local `scope ui` needs nothing; a `scope server` asks for an API key
 * with the "read" scope, kept for this tab (or on this device, if the user chooses).
 */
import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { ApiError, apiGet, getApiKey, setApiKey, UNAUTHORIZED_EVENT } from '../api/client.ts';
import { useServerInfo } from '../api/queries.ts';
import { Button } from '../ui/Button.tsx';
import { Reticle } from '../ui/icons.tsx';
import { ErrorState, Loading } from '../ui/States.tsx';

function SignIn({ onSignedIn, rejected }: { onSignedIn: () => void; rejected: boolean }) {
  const [key, setKey] = useState('');
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<string | null>(
    rejected ? 'The saved API key was rejected. It may have been revoked.' : null,
  );
  const [busy, setBusy] = useState(false);
  const keyId = useId();
  const errorId = useId();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiGet('/project', {}, { apiKey: key.trim() });
      setApiKey(key.trim(), remember);
      onSignedIn();
    } catch (e) {
      setError(e instanceof ApiError ? `${e.message}${e.hint ? ` ${e.hint}` : ''}` : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-lg border border-line bg-panel p-6"
        aria-describedby={error ? errorId : undefined}
      >
        <div className="mb-5 flex items-center gap-2 text-fg">
          <Reticle size={20} />
          <span className="font-mono text-sm font-medium tracking-[0.2em]">SCOPE</span>
        </div>
        <h1 className="text-lg font-semibold text-fg">This server requires an API key</h1>
        <p className="mt-1 text-sm text-fg-2">
          Use a key with the <code className="text-xs">read</code> scope. Create one where the
          server runs:
        </p>
        <pre className="mt-2 overflow-x-auto rounded-md bg-sunken px-3 py-2 text-xs text-fg">
          scope keys create --name dashboard --scope read
        </pre>
        <label htmlFor={keyId} className="mt-5 block text-xs font-medium text-fg-2">
          API key
        </label>
        <input
          id={keyId}
          type="password"
          autoComplete="off"
          required
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="scope_…"
          className="mt-1 h-9 w-full rounded-md border border-line-strong bg-raised px-3 font-mono text-sm text-fg"
        />
        <label className="mt-3 flex items-center gap-2 text-sm text-fg-2">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="accent-(--accent)"
          />
          Remember on this device
        </label>
        {error && (
          <p id={errorId} role="alert" className="mt-3 text-sm text-bad-fg">
            {error}
          </p>
        )}
        <Button
          type="submit"
          variant="primary"
          disabled={busy || !key.trim()}
          className="mt-5 w-full"
        >
          {busy ? 'Checking…' : 'Continue'}
        </Button>
      </form>
    </main>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const info = useServerInfo();
  const queryClient = useQueryClient();
  const [, setVersion] = useState(0);
  const [rejected, setRejected] = useState(false);

  useEffect(() => {
    const onUnauthorized = () => setRejected(true);
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  if (info.isPending) return <Loading rows={3} label="Connecting to the SCOPE server" />;
  if (info.isError)
    return (
      <main className="mx-auto max-w-xl pt-16">
        <ErrorState error={info.error} onRetry={() => void info.refetch()} />
      </main>
    );
  if (info.data.auth === 'api-key' && (rejected || !getApiKey())) {
    return (
      <SignIn
        rejected={rejected}
        onSignedIn={() => {
          // Drop anything fetched (and rejected) with the previous key.
          void queryClient.resetQueries({ predicate: (q) => q.queryKey[0] !== 'info' });
          setRejected(false);
          setVersion((v) => v + 1);
        }}
      />
    );
  }
  return <>{children}</>;
}
