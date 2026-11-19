'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cx } from '../ui';

/**
 * Always-editable text that looks like text. Local draft while typing;
 * committed on blur, Ctrl/Cmd+Enter, or after a pause — never per keystroke.
 * Escape reverts. External changes (e.g. a regeneration) only replace the
 * text when the user isn't editing it.
 */
export function InlineText({
  value,
  onCommit,
  label,
  className,
  placeholder,
  multiline = true,
  required = false,
}: {
  value: string;
  onCommit: (v: string) => void;
  label: string;
  className?: string;
  placeholder?: string;
  multiline?: boolean;
  required?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const committed = useRef(value);
  // Escape blurs the field; the blur handler must not then save what Escape discarded.
  const discarding = useRef(false);

  useEffect(() => {
    if (!focused) {
      setDraft(value);
      committed.current = value;
    }
  }, [value, focused]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [draft]);

  const commit = (v: string) => {
    clearTimeout(timer.current);
    const next = v.trim();
    if (required && !next) {
      setDraft(committed.current);
      return;
    }
    if (next !== committed.current.trim()) {
      committed.current = next;
      onCommit(next);
    }
  };

  return (
    <textarea
      ref={ref}
      aria-label={label}
      rows={1}
      value={draft}
      placeholder={placeholder}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        if (discarding.current) discarding.current = false;
        else commit(draft);
      }}
      onChange={(e) => {
        const v = multiline ? e.target.value : e.target.value.replace(/\n/g, ' ');
        setDraft(v);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => commit(v), 1200);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          clearTimeout(timer.current);
          setDraft(committed.current);
          discarding.current = true;
          (e.target as HTMLTextAreaElement).blur();
        } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !multiline)) {
          e.preventDefault();
          commit(draft);
        }
      }}
      className={cx(
        'block w-full resize-none overflow-hidden rounded border border-transparent bg-transparent px-1.5 py-1 -mx-1.5 hover:border-slate-200 focus:border-brand-500 focus:bg-white focus:outline-none focus:ring-1 focus:ring-brand-500',
        className,
      )}
    />
  );
}
