import { Link } from 'react-router';
import { useTitle } from '../app/hooks.ts';
import { EmptyState } from '../ui/States.tsx';

export function NotFound() {
  useTitle('Not found');
  return (
    <EmptyState title="There is nothing at this address">
      <p>
        The link may be from another SCOPE project or server.{' '}
        <Link to="/" className="text-accent-fg underline-offset-2 hover:underline">
          Go to the overview
        </Link>
        .
      </p>
    </EmptyState>
  );
}
