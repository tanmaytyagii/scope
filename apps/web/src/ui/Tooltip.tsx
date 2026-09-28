import { Tooltip as T } from 'radix-ui';
import type { ReactNode } from 'react';

export const TooltipProvider = T.Provider;

/** A hint on hover and keyboard focus. Never the only place information lives. */
export function Tooltip({
  content,
  children,
  side = 'top',
}: {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
}) {
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className="z-50 max-w-xs rounded-md border border-line bg-raised px-2.5 py-1.5 text-xs text-fg shadow-pop"
        >
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
