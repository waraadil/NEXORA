import * as React from 'react';

type FieldProps = {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
};

/**
 * Visible label + hint + inline error. Never placeholder-only labelling —
 * placeholder text disappears exactly when the user needs it most.
 */
export function Field({ label, htmlFor, hint, error, required, children }: FieldProps) {
  const hintId = hint ? `${htmlFor}-hint` : undefined;
  const errorId = error ? `${htmlFor}-error` : undefined;

  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-foreground">
        {label}
        {required && (
          <span className="ml-0.5 text-destructive" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {children}
      {hint && !error && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="flex items-start gap-1.5 text-xs text-destructive">
          <svg className="mt-0.5 size-3.5 shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path
              fillRule="evenodd"
              d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-8-5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0v-4.5A.75.75 0 0 1 10 5Zm0 10a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
              clipRule="evenodd"
            />
          </svg>
          {error}
        </p>
      )}
    </div>
  );
}

export type InputProps = React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean };

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { className = '', invalid, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={[
        'h-11 w-full rounded-lg border bg-surface px-3 text-sm text-foreground',
        'placeholder:text-muted-foreground/70',
        'transition-colors duration-150',
        invalid
          ? 'border-destructive focus-visible:outline-destructive'
          : 'border-border-strong hover:border-primary/50',
        'disabled:cursor-not-allowed disabled:opacity-60',
        className,
      ].join(' ')}
      {...props}
    />
  );
});

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean };

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className = '', invalid, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      aria-invalid={invalid || undefined}
      className={[
        'w-full rounded-lg border bg-surface px-3 py-2.5 text-sm text-foreground',
        'placeholder:text-muted-foreground/70 resize-y min-h-24',
        'transition-colors duration-150',
        invalid
          ? 'border-destructive focus-visible:outline-destructive'
          : 'border-border-strong hover:border-primary/50',
        className,
      ].join(' ')}
      {...props}
    />
  );
});

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className = '', children, ...props }, ref) {
    return (
      <select
        ref={ref}
        className={[
          'h-11 w-full rounded-lg border border-border-strong bg-surface px-3 text-sm text-foreground',
          'transition-colors duration-150 hover:border-primary/50',
          'disabled:cursor-not-allowed disabled:opacity-60',
          className,
        ].join(' ')}
        {...props}
      >
        {children}
      </select>
    );
  },
);
