'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { useKit } from '@/lib/useKit';
import { Banner, Button, Spinner } from '@/components/ui';
import { GenerationProgress } from '@/components/kit/GenerationProgress';
import { KitWorkspace } from '@/components/kit/KitWorkspace';

function KitPageInner({ id }: { id: string }) {
  const note = useSearchParams().get('note');
  const k = useKit(id);
  if (k.loadError) {
    const notFound = k.loadError.status === 404;
    return (
      <div className="mx-auto max-w-xl pt-10">
        <Banner tone="error" title={notFound ? 'Kit not found' : "Couldn't load this kit"} action={notFound ? <Link href="/kits"><Button size="sm">All kits</Button></Link> : <Button size="sm" onClick={k.reload}>Retry</Button>}>
          {notFound ? 'It may have been deleted, or it belongs to another account.' : k.loadError.message}
        </Banner>
      </div>
    );
  }
  if (!k.view) return <p className="flex items-center gap-2 pt-10 text-sm text-slate-500"><Spinner label="Loading kit" /> Loading kit…</p>;
  if (k.view.status !== 'ready') return <GenerationProgress view={k.view} onRetry={k.retry} />;
  return <KitWorkspace k={k} note={note} />;
}

export default function KitPage({ params }: { params: { id: string } }) {
  return (
    <Suspense>
      <KitPageInner id={params.id} />
    </Suspense>
  );
}
