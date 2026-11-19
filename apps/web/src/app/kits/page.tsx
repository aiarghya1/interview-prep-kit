'use client';
import { BatchUpload } from '@/components/BatchUpload';
import { CreateKitForm } from '@/components/CreateKitForm';
import { KitList, useKitList } from '@/components/KitList';
import { Card } from '@/components/ui';

export default function KitsPage() {
  const list = useKitList();
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="space-y-6">
        <Card>
          <CreateKitForm onCreated={list.reload} />
        </Card>
        <Card>
          <BatchUpload onCreated={list.reload} />
        </Card>
      </div>
      <section aria-labelledby="kits-heading" className="space-y-3">
        <h2 id="kits-heading" className="text-lg font-semibold">Your kits</h2>
        <KitList list={list} />
      </section>
    </div>
  );
}
