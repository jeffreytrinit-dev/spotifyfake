import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
  size?: 'sm' | 'md' | 'lg';
  children: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

const SIZES = { sm: 'h-9 w-9', md: 'h-11 w-11', lg: 'h-14 w-14' };

/** Icon-only button: always labelled for screen readers, ≥44 px touch target on md/lg. */
export function IconButton({
  label,
  active,
  size = 'md',
  className = '',
  children,
  ...rest
}: Props) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...(active !== undefined ? { 'aria-pressed': active } : {})}
      className={`inline-flex shrink-0 items-center justify-center rounded-full transition-colors hover:bg-surface-2 active:scale-95 disabled:opacity-40 ${
        active ? 'text-sea' : 'text-fg'
      } ${SIZES[size]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
