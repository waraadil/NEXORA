import * as React from 'react';

type Tone = 'neutral' | 'primary' | 'accent' | 'success' | 'warning' | 'destructive';

const tones: Record<Tone, string> = {
  neutral: 'bg-muted text-muted-foreground border-border-strong',
  primary: 'bg-primary-subtle text-primary border-primary/20',
  accent: 'bg-accent-subtle text-accent border-accent/25',
  success: 'bg-success-subtle text-success border-success/25',
  warning: 'bg-warning-subtle text-warning border-warning/25',
  destructive: 'bg-destructive-subtle text-destructive border-destructive/25',
};

export function Badge({
  tone = 'neutral',
  className = '',
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={[
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium',
        tones[tone],
        className,
      ].join(' ')}
      {...props}
    />
  );
}
