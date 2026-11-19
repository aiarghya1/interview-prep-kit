'use client';
import { useState } from 'react';
import type { RegenState } from '@/lib/types';
import { Button } from '../ui';

export function RegenButton({
  section,
  label,
  regen,
  onRegenerate,
  note = 'Keeps anything you wrote, edited or pinned.',
}: {
  section: string;
  label: string;
  regen: RegenState | null;
  onRegenerate: (section: string) => Promise<void>;
  note?: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const running = regen?.status === 'running';
  const mine = running && regen?.section === section;
  const id = `regen-note-${section.replace(/[^a-z]/g, '')}`;
  return (
    <span className="inline-flex flex-col items-end">
      <Button
        size="sm"
        variant="secondary"
        busy={mine || starting}
        disabled={running && !mine}
        aria-describedby={id}
        title={running && !mine ? `Wait for ${regen?.section} to finish` : note}
        onClick={async () => {
          setError(null);
          setStarting(true);
          try {
            await onRegenerate(section);
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setStarting(false);
          }
        }}
      >
        {mine ? 'Regenerating…' : label}
      </Button>
      <span id={id} className="sr-only">{note}</span>
      {error && <span role="alert" className="mt-1 text-xs text-red-700">{error}</span>}
    </span>
  );
}
