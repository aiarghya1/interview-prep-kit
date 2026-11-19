import type { Kit } from '@kit/core/schema';
import type { IdHighWater } from '@kit/core/edit';
import type { CardProgress, PracticeSummary } from '@kit/core/practice';
import type { Story } from '@kit/core/stories';

export type KitStatus = 'queued' | 'running' | 'ready' | 'failed';

export interface ProgressEntry {
  step: string;
  status: 'running' | 'done' | 'skipped' | 'failed';
  message: string;
  at: string;
}

export interface RegenState {
  section: string;
  status: 'running' | 'done' | 'failed';
  startedAt?: string;
  finishedAt?: string;
  message?: string;
}

export interface KitView {
  id: string;
  status: KitStatus;
  title: string;
  company: string;
  input: { jd: string; company_url: string; days: number };
  kit: Kit | null;
  version: number;
  highWater: IdHighWater;
  progress: ProgressEntry[];
  error: { code: string; message: string } | null;
  regen: RegenState | null;
  scheduleStale: boolean;
  stories: Story[];
  createdAt: string;
  updatedAt: string;
}

export interface KitStatusView {
  status: KitStatus;
  progress: ProgressEntry[];
  error: { code: string; message: string } | null;
  regen: RegenState | null;
  version: number;
  scheduleStale: boolean;
}

export interface KitSummary {
  id: string;
  status: KitStatus;
  title: string;
  company: string;
  days: number;
  questions: number;
  flashcards: number;
  lastProgress: string | null;
  error: { code: string; message: string } | null;
  createdAt: string;
}

export interface PracticeView {
  progress: Record<string, CardProgress>;
  order: string[];
  summary: PracticeSummary;
}

export type { Kit };
