import * as React from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'outline' | 'destructive';
type Size = 'sm' | 'md' | 'lg' | 'icon';

const variants: Record<Variant, string> = {
  primary:
    'bg-primary text-primary-foreground shadow-sm hover:brightness-110 active:brightness-95 disabled:opacity-50',
  secondary:
    'bg-primary-subtle text-primary hover:bg-primary/15 active:bg-primary/20 disabled:opacity-50',
  ghost:
    'text-foreground hover:bg-muted active:bg-muted/70 disabled:opacity-50',
  outline:
    'border border-border-strong bg-surface text-foreground hover:bg-muted active:bg-muted/70 disabled:opacity-50',
  destructive:
    'bg-destructive text-white shadow-sm hover:brightness-110 active:brightness-95 disabled:opacity-50',
};

const sizes: Record<Size, string> = {
  sm: 'h-9 px-3 text-sm rounded-md gap-1.5',
  md: 'h-11 px-4 text-sm rounded-lg gap-2',
  lg: 'h-12 px-6 text-base rounded-lg gap-2',
  // 44x44 minimum touch target, per accessibility guidance
  icon: 'h-11 w-11 rounded-lg justify-center',
};

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  isLoading?: boolean;
};

const Spinner = () => (
  <svg className="size-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
    <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
  </svg>
);

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className = '', variant = 'primary', size = 'md', isLoading, children, disabled, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || isLoading}
      aria-busy={isLoading || undefined}
      className={[
        'inline-flex items-center justify-center font-medium transition duration-150',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        'disabled:cursor-not-allowed select-none',
        variants[variant],
        sizes[size],
        className,
      ].join(' ')}
      {...props}
    >
      {isLoading && <Spinner />}
      {children}
    </button>
  );
});
