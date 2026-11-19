import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { DragEndEvent } from '@dnd-kit/core';
import { QuestionBoard, StateBadges } from '@/components/kit/QuestionBoard';
import { richKit } from './fixtures';

// jsdom has no layout, so pointer/keyboard drags can't be simulated; capture the
// drop handler instead and feed it the events dnd-kit would produce.
const drops: ((e: DragEndEvent) => void)[] = [];
vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/core')>();
  return {
    ...actual,
    DndContext: ({ children, onDragEnd }: { children: React.ReactNode; onDragEnd: (e: DragEndEvent) => void }) => {
      drops.push(onDragEnd);
      return children;
    },
  };
});
const drop = (activeId: string, overId: string | null) => ({ active: { id: activeId }, over: overId ? { id: overId } : null }) as unknown as DragEndEvent;

function board(mutate: (k: ReturnType<typeof richKit>) => void = () => {}) {
  const kit = richKit();
  kit.questions.push({ id: 'q5', category: 'technical', prompt: 'Second technical', answer_outline: '', difficulty: 1, requirement_ids: [], state: { origin: 'user', edited: false, pinned: false } });
  kit.questions.push({ id: 'q6', category: 'technical', prompt: 'Third technical', answer_outline: 'Points', difficulty: 3, requirement_ids: ['r9'], state: { origin: 'template', edited: false, pinned: true } });
  mutate(kit);
  const dispatch = vi.fn();
  const onRegenerate = vi.fn().mockResolvedValue(undefined);
  drops.length = 0;
  render(<QuestionBoard kit={kit} dispatch={dispatch} regen={null} onRegenerate={onRegenerate} />);
  return { kit, dispatch, onRegenerate };
}
const technical = () => within(screen.getByRole('heading', { name: /^Technical/ }).closest('section')!);

describe('QuestionBoard', () => {
  it('groups questions by category with counts, badges and requirement chips', () => {
    board((k) => {
      k.questions[1]!.state = { origin: 'generated', edited: true, pinned: false };
    });
    expect(screen.getByRole('heading', { name: 'Technical (4)' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'System design (0)' })).toBeInTheDocument();
    expect(technical().getByText('Yours')).toBeInTheDocument();
    expect(technical().getByText('Generic fallback')).toBeInTheDocument();
    expect(technical().getByText('Edited')).toBeInTheDocument();
    expect(technical().getByText('Pinned')).toBeInTheDocument();
    expect(technical().getByText(/^r1 · Node\.js and TypeScript/)).toBeInTheDocument();
    expect(technical().getByText('r9')).toBeInTheDocument(); // unknown requirement id still shown
    expect(technical().getByText('No linked requirement')).toBeInTheDocument();
    expect(screen.getByText(/no system-design round was published/)).toBeInTheDocument();
  });

  it('edits prompt, outline, difficulty, category and linked requirements', async () => {
    const { dispatch } = board();
    const prompt = screen.getByLabelText('Technical question 1', { selector: 'textarea' });
    fireEvent.focus(prompt);
    fireEvent.change(prompt, { target: { value: 'Reworded' } });
    fireEvent.blur(prompt);
    expect(dispatch).toHaveBeenCalledWith({ op: 'question.update', id: 'q1', patch: { prompt: 'Reworded' } });
    const outline = screen.getByLabelText('Answer outline for Technical question 1');
    fireEvent.focus(outline);
    fireEvent.change(outline, { target: { value: 'Key points' } });
    fireEvent.blur(outline);
    expect(dispatch).toHaveBeenCalledWith({ op: 'question.update', id: 'q1', patch: { answer_outline: 'Key points' } });
    const first = within(technical().getAllByRole('listitem')[0]!);
    await userEvent.selectOptions(first.getByLabelText('Difficulty'), '1');
    expect(dispatch).toHaveBeenCalledWith({ op: 'question.update', id: 'q1', patch: { difficulty: 1 } });
    await userEvent.selectOptions(first.getByLabelText('Category'), 'system-design');
    expect(dispatch).toHaveBeenCalledWith({ op: 'question.move', id: 'q1', toIndex: 9999, category: 'system-design' });
    await userEvent.click(first.getByRole('checkbox', { name: /r2/ }));
    expect(dispatch).toHaveBeenCalledWith({ op: 'question.update', id: 'q1', patch: { requirement_ids: ['r1', 'r2'] } });
    await userEvent.click(first.getByRole('checkbox', { name: /r1/ }));
    expect(dispatch).toHaveBeenCalledWith({ op: 'question.update', id: 'q1', patch: { requirement_ids: [] } });
  });

  it('reorders with buttons and by drag-and-drop, as a full ordering of all questions', async () => {
    const { dispatch } = board();
    const items = technical().getAllByRole('listitem');
    expect(within(items[0]!).getByRole('button', { name: 'Move up' })).toBeDisabled();
    expect(within(items[3]!).getByRole('button', { name: 'Move down' })).toBeDisabled();
    await userEvent.click(within(items[0]!).getByRole('button', { name: 'Move down' }));
    expect(dispatch).toHaveBeenLastCalledWith({ op: 'question.reorder', ids: ['q2', 'q1', 'q3', 'q4', 'q5', 'q6'] });
    await userEvent.click(within(items[1]!).getByRole('button', { name: 'Move up' }));
    expect(dispatch).toHaveBeenLastCalledWith({ op: 'question.reorder', ids: ['q2', 'q1', 'q3', 'q4', 'q5', 'q6'] });
    const technicalDrop = drops[0]!;
    act(() => technicalDrop(drop('q6', 'q1')));
    expect(dispatch).toHaveBeenLastCalledWith({ op: 'question.reorder', ids: ['q6', 'q1', 'q3', 'q4', 'q2', 'q5'] });
    const calls = dispatch.mock.calls.length;
    act(() => technicalDrop(drop('q1', null)));
    act(() => technicalDrop(drop('q1', 'q1')));
    expect(dispatch.mock.calls.length).toBe(calls);
  });

  it('pins, unpins and deletes', async () => {
    const { dispatch } = board();
    const items = technical().getAllByRole('listitem');
    await userEvent.click(within(items[0]!).getByRole('button', { name: 'Pin' }));
    expect(dispatch).toHaveBeenCalledWith({ op: 'pin', target: 'question', id: 'q1', pinned: true });
    await userEvent.click(within(items[3]!).getByRole('button', { name: 'Unpin' }));
    expect(dispatch).toHaveBeenCalledWith({ op: 'pin', target: 'question', id: 'q6', pinned: false });
    await userEvent.click(within(items[0]!).getByRole('button', { name: 'Delete Technical question 1' }));
    expect(dispatch).toHaveBeenCalledWith({ op: 'question.delete', id: 'q1' });
  });

  it('adds a question by hand, with or without a requirement, and cancels', async () => {
    const { dispatch } = board();
    await userEvent.click(screen.getByRole('button', { name: '+ Add a technical question' }));
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    fireEvent.submit(screen.getByLabelText('New question').closest('form')!);
    expect(dispatch).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText('New question'), 'My own question');
    await userEvent.selectOptions(screen.getByLabelText('Requirement'), 'r2');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(dispatch).toHaveBeenCalledWith({ op: 'question.add', tempId: expect.stringMatching(/^tmp-/), question: { category: 'technical', prompt: 'My own question', requirement_ids: ['r2'] } });
    await userEvent.click(screen.getByRole('button', { name: '+ Add a behavioural question' }));
    await userEvent.type(screen.getByLabelText('New question'), 'No requirement');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ question: { category: 'behavioural', prompt: 'No requirement', requirement_ids: [] } }));
    await userEvent.click(screen.getByRole('button', { name: '+ Add a company fit question' }));
    await userEvent.type(screen.getByLabelText('New question'), 'x');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByLabelText('New question')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '+ Add a company fit question' }));
    await userEvent.type(screen.getByLabelText('New question'), 'y');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('New question')).toBeNull();
  });

  it('filters by text or requirement id, and regenerates one category', async () => {
    const { onRegenerate } = board();
    await userEvent.type(screen.getByLabelText('Filter questions'), 'third');
    expect(technical().getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getAllByText('No matches in this category').length).toBeGreaterThan(0);
    await userEvent.clear(screen.getByLabelText('Filter questions'));
    await userEvent.type(screen.getByLabelText('Filter questions'), 'r2');
    expect(technical().getAllByRole('listitem')).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Regenerate technical' }));
    expect(onRegenerate).toHaveBeenCalledWith('questions:technical');
  });

  it('shows the generic empty-state hint for categories other than system design', () => {
    board((k) => {
      k.questions = k.questions.filter((q) => q.category !== 'behavioural');
    });
    expect(screen.getByText('Add one yourself or regenerate this category.')).toBeInTheDocument();
  });

  it('StateBadges renders nothing without state', () => {
    const { container } = render(<StateBadges />);
    expect(container).toBeEmptyDOMElement();
  });
});
