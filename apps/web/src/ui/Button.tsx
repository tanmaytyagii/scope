import { type ButtonHTMLAttributes, forwardRef } from 'react';
import { cx } from './cx.ts';

type Variant = 'default' | 'primary' | 'ghost';
type Size = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const VARIANTS: Record<Variant, string> = {
  default: 'border border-line-strong bg-raised text-fg hover:bg-hover',
  primary: 'border border-transparent bg-accent-solid text-white hover:brightness-110',
  ghost: 'border border-transparent text-fg-2 hover:bg-hover hover:text-fg',
};

const SIZES: Record<Size, string> = {
  sm: 'h-7 px-2 text-xs gap-1.5',
  md: 'h-8 px-3 text-sm gap-2',
};

export const buttonClass = (variant: Variant = 'default', size: Size = 'md', extra?: string) =>
  cx(
    'inline-flex shrink-0 items-center justify-center rounded-md font-medium whitespace-nowrap',
    'transition-colors disabled:pointer-events-none disabled:opacity-50',
    VARIANTS[variant],
    SIZES[size],
    extra,
  );

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'md', className, type = 'button', ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} className={buttonClass(variant, size, className)} {...rest} />
  );
});

/** A square icon-only button. Always give it an aria-label. */
export const IconButton = forwardRef<HTMLButtonElement, ButtonProps & { 'aria-label': string }>(
  function IconButton(
    { variant = 'ghost', size = 'md', className, type = 'button', ...rest },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type}
        className={cx(
          buttonClass(variant, size),
          size === 'sm' ? 'w-7 px-0' : 'w-8 px-0',
          className,
        )}
        {...rest}
      />
    );
  },
);
