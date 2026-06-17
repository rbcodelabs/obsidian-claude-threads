import { describe, it, expect, beforeEach } from 'vitest';

/**
 * Unit tests for the task-card auto-dismiss behaviour added to ThreadsView.
 *
 * When all tasks on a thread are completed, the card should stay visible
 * during the turn they finish (so the user can review), then disappear the
 * moment the user sends their next message.  New tasks on a future turn
 * clear the dismissed flag so the card reappears.
 *
 * Tested against pure-logic mirrors that avoid Obsidian DOM dependencies.
 */

// ---------------------------------------------------------------------------
// Types mirroring ThreadsView's relevant pieces
// ---------------------------------------------------------------------------

type TaskStatus = 'pending' | 'in_progress' | 'completed';
interface TaskItem { status: TaskStatus; }
interface Thread { id: string; tasks?: TaskItem[]; }

// ---------------------------------------------------------------------------
// Logic mirrors
// ---------------------------------------------------------------------------

/**
 * Mirrors `taskCardDismissed` + `renderTaskCard()` + the
 * `user_message_added` handler in ThreadsView.
 */
class TaskDismissState {
  private dismissed = new Set<string>();

  /**
   * Called by `renderTaskCard()` to decide whether to hide the card.
   * Returns true when the card should be hidden.
   */
  isHidden(thread: Thread): boolean {
    const tasks = thread.tasks ?? [];
    if (tasks.length === 0) return true;                   // no tasks → no card
    const allDone = tasks.every(t => t.status === 'completed');
    if (!allDone) {
      // Active tasks in progress → clear any stale dismiss and show the card.
      this.dismissed.delete(thread.id);
      return false;
    }
    return this.dismissed.has(thread.id);
  }

  /**
   * Called by the `user_message_added` handler.
   * Dismisses the card if every task is complete.
   */
  onUserMessageAdded(thread: Thread): void {
    const tasks = thread.tasks ?? [];
    if (tasks.length > 0 && tasks.every(t => t.status === 'completed')) {
      this.dismissed.add(thread.id);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function completedThread(id: string, count = 3): Thread {
  return {
    id,
    tasks: Array.from({ length: count }, () => ({ status: 'completed' as const })),
  };
}

function mixedThread(id: string): Thread {
  return {
    id,
    tasks: [
      { status: 'completed' },
      { status: 'in_progress' },
      { status: 'pending' },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('task card auto-dismiss', () => {
  let state: TaskDismissState;

  beforeEach(() => {
    state = new TaskDismissState();
  });

  it('card is visible when tasks are in progress', () => {
    const thread = mixedThread('t1');
    expect(state.isHidden(thread)).toBe(false);
  });

  it('card is visible when all tasks done but user has not sent a new message', () => {
    const thread = completedThread('t1');
    expect(state.isHidden(thread)).toBe(false);
  });

  it('card is hidden after user sends a message with all tasks done', () => {
    const thread = completedThread('t1');
    state.onUserMessageAdded(thread);
    expect(state.isHidden(thread)).toBe(true);
  });

  it('user sending a message does NOT dismiss when tasks are not all done', () => {
    const thread = mixedThread('t1');
    state.onUserMessageAdded(thread);
    expect(state.isHidden(thread)).toBe(false);
  });

  it('card is hidden only for the affected thread, not others', () => {
    const t1 = completedThread('t1');
    const t2 = completedThread('t2');
    state.onUserMessageAdded(t1);
    expect(state.isHidden(t1)).toBe(true);
    expect(state.isHidden(t2)).toBe(false);  // t2 not dismissed
  });

  it('card reappears when new (non-done) tasks arrive after dismissal', () => {
    const thread = completedThread('t1');
    state.onUserMessageAdded(thread);
    expect(state.isHidden(thread)).toBe(true);

    // Claude creates new tasks on the next turn → tasks_updated with mixed state
    thread.tasks = [
      { status: 'completed' },
      { status: 'in_progress' },  // new task in progress
    ];
    expect(state.isHidden(thread)).toBe(false);  // dismissed flag cleared
  });

  it('card stays hidden when tasks_updated fires with still-all-done tasks', () => {
    const thread = completedThread('t1', 2);
    state.onUserMessageAdded(thread);
    // A tasks_updated that keeps everything completed doesn't clear the dismiss
    expect(state.isHidden(thread)).toBe(true);
  });

  it('card is hidden when there are no tasks at all', () => {
    const thread: Thread = { id: 't1', tasks: [] };
    expect(state.isHidden(thread)).toBe(true);
  });

  it('dismiss survives multiple user messages without re-showing', () => {
    const thread = completedThread('t1');
    state.onUserMessageAdded(thread);
    state.onUserMessageAdded(thread);  // second message
    expect(state.isHidden(thread)).toBe(true);
  });
});
