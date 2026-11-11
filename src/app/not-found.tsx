import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { NexoraMark } from '@/components/auth/auth-shell';

export default function NotFound() {
  return (
    <div className="nexora-ambient flex min-h-dvh flex-col items-center justify-center px-4 text-center">
      <NexoraMark className="mb-5 size-10" />
      <p className="font-mono text-xs tracking-widest text-muted-foreground uppercase">404</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-balance">
        That page doesn&apos;t exist
      </h1>
      <p className="mt-1.5 max-w-sm text-sm text-muted-foreground text-pretty">
        The link may be outdated, or the conversation or contact was deleted.
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <Link href="/dashboard">
          <Button>Go to dashboard</Button>
        </Link>
        <Link href="/conversations">
          <Button variant="outline">Browse conversations</Button>
        </Link>
      </div>
    </div>
  );
}
