import { PageSkeleton } from '@/components/ui/skeleton';

export default function ConversationLoading() {
  return <PageSkeleton title="Loading conversation" variant="messages" rows={8} />;
}
