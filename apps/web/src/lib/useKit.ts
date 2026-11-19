'use client';
/**
 * Kit state for the builder.
 *
 *   base     the last kit the server confirmed (with its version)
 *   inflight ops sent, awaiting the server
 *   pending  ops not yet sent (debounced)
 *   display  = base + inflight + pending, derived every render
 *
 * Edits are applied instantly (no round trip per keystroke) and saved in
 * batches. Because the display is *derived*, a new base arriving from
 * elsewhere (a regeneration finishing, a reload) never discards unsaved
 * edits: they are simply re-applied on top of it. A base is only accepted if
 * its version is not older than the one we have.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EditOp, EditOpInput } from '@kit/core/edit';
import { EditOpSchema } from '@kit/core/edit';
import { api, ApiError } from './api';
import { applyOpsLeniently, coalesce, remapOpIds } from './applyOps';
import type { KitStatusView, KitView, RegenState } from './types';

export type SaveState = 'idle' | 'saving' | 'saved' | 'retrying' | 'error';

const POLL_MS = 1500;
const SAVE_DEBOUNCE_MS = 450;

export function useKit(id: string) {
  const [view, setView] = useState<KitView | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [, forceRender] = useState(0);
  const pending = useRef<EditOp[]>([]);
  const inflight = useRef<EditOp[]>([]);
  const viewRef = useRef<KitView | null>(null);
  const flushTimer = useRef<ReturnType<typeof setTimeout>>();
  const retryDelay = useRef(1000);
  viewRef.current = view;

  const acceptBase = useCallback((next: KitView) => {
    setView((prev) => (!prev || next.version >= prev.version || next.status !== prev.status ? next : { ...prev, progress: next.progress, regen: next.regen }));
  }, []);

  const load = useCallback(async () => {
    try {
      acceptBase(await api<KitView>(`/kits/${id}`));
      setLoadError(null);
    } catch (err) {
      setLoadError(err as ApiError);
    }
  }, [id, acceptBase]);

  useEffect(() => {
    void load();
  }, [load]);

  // ---- polling while generating or regenerating ----
  const generating = view?.status === 'queued' || view?.status === 'running';
  const regenerating = view?.regen?.status === 'running';
  useEffect(() => {
    if (!generating && !regenerating) return;
    let stopped = false;
    const t = setInterval(async () => {
      try {
        const s = await api<KitStatusView>(`/kits/${id}/status`);
        if (stopped) return;
        const cur = viewRef.current;
        const finished = cur && (s.status !== cur.status || (cur.regen?.status === 'running' && s.regen?.status !== 'running') || s.version > cur.version);
        if (finished) await load();
        else setView((prev) => (prev ? { ...prev, progress: s.progress, regen: s.regen, scheduleStale: s.scheduleStale } : prev));
      } catch {
        /* transient: next tick retries */
      }
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [generating, regenerating, id, load]);

  // ---- saving ----
  const flush = useCallback(async () => {
    clearTimeout(flushTimer.current);
    const base = viewRef.current;
    if (!base?.kit || inflight.current.length || pending.current.length === 0) return;
    const ops = coalesce(pending.current);
    pending.current = [];
    inflight.current = ops;
    setSaveState('saving');
    const localCreated = applyOpsLeniently(base.kit, ops, base.highWater).created;
    try {
      const res = await api<{ kit: KitView['kit']; version: number; highWater: KitView['highWater']; created: Record<string, string>; scheduleStale: boolean }>(
        `/kits/${id}`,
        { method: 'PATCH', body: { ops } },
      );
      const map: Record<string, string> = {};
      for (const [tempId, localId] of Object.entries(localCreated)) {
        const serverId = res.created[tempId];
        if (serverId && serverId !== localId) map[localId] = serverId;
      }
      pending.current = remapOpIds(pending.current, map);
      inflight.current = [];
      setView((prev) => (prev && res.version >= prev.version ? { ...prev, kit: res.kit, version: res.version, highWater: res.highWater, scheduleStale: res.scheduleStale } : prev));
      retryDelay.current = 1000;
      setSaveError(null);
      setSaveState(pending.current.length ? 'saving' : 'saved');
      if (pending.current.length) flushTimer.current = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
    } catch (err) {
      const e = err as ApiError;
      inflight.current = [];
      if (e.retryable) {
        pending.current = [...ops, ...pending.current];
        setSaveState('retrying');
        flushTimer.current = setTimeout(() => void flush(), retryDelay.current);
        retryDelay.current = Math.min(retryDelay.current * 2, 15_000);
      } else {
        setSaveState('error');
        setSaveError(e.message);
        void load();
      }
      forceRender((n) => n + 1);
    }
  }, [id, load]);

  const dispatch = useCallback(
    (input: EditOpInput | EditOpInput[]) => {
      const ops = (Array.isArray(input) ? input : [input]).map((o) => EditOpSchema.parse(o));
      pending.current = coalesce([...pending.current, ...ops]);
      setSaveState('saving');
      forceRender((n) => n + 1);
      clearTimeout(flushTimer.current);
      flushTimer.current = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  // Warn before leaving with unsaved edits; flush when the tab is hidden.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (pending.current.length || inflight.current.length) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    const onHide = () => document.visibilityState === 'hidden' && void flush();
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [flush]);

  // ---- derived display ----
  const unsaved = [...inflight.current, ...pending.current];
  const display = useMemo(
    () => (view?.kit ? applyOpsLeniently(view.kit, unsaved, view.highWater).kit : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view, unsaved.length, JSON.stringify(unsaved)],
  );

  const regenerate = useCallback(
    async (section: string) => {
      await flush();
      const res = await api<KitView | { regen: RegenState }>(`/kits/${id}/regenerate`, { body: { section } });
      if ('kit' in res) acceptBase(res);
      else setView((prev) => (prev ? { ...prev, regen: res.regen } : prev));
    },
    [id, flush, acceptBase],
  );

  const retry = useCallback(async () => {
    await api(`/kits/${id}/retry`, { body: {} });
    await load();
  }, [id, load]);

  return {
    view,
    kit: display,
    loadError,
    reload: load,
    dispatch,
    saveState,
    saveError,
    unsavedCount: unsaved.length,
    regenerate,
    retry,
    flush,
  };
}
