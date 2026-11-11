import * as React from 'react';

export function Card({ className = '', ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={[
        'rounded-xl border border-border bg-surface shadow-[var(--shadow-sm)]',
        className,
      ].join(' ')}
      {...props}
    />
  );
}

export function CardHeader({ className = '', ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={['space-y-1 p-5 pb-3', className].join(' ')} {...props} />;
}

export function CardTitle({ className = '', ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={['text-base font-semibold tracking-tight', className].join(' ')} {...props} />;
}

export function CardDescription({ className = '', ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={['text-sm text-muted-foreground', className].join(' ')} {...props} />;
}

export function CardContent({ className = '', ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={['p-5 pt-0', className].join(' ')} {...props} />;
}

export function CardFooter({ className = '', ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={['flex items-center gap-2 p-5 pt-0', className].join(' ')} {...props} />;
}
