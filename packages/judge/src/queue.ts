/**
 * Runs tasks at most `limit` at a time, each as soon as a slot is free, in the order they were added.
 * Once a task has failed, the tasks still waiting are skipped (those already running finish); `idle`
 * waits for every task added so far and throws the first failure.
 */
export class BoundedQueue {
  private running = 0;
  private waiting: readonly (() => void)[] = [];
  private tasks: readonly Promise<void>[] = [];
  private failure: { error: unknown } | null = null;

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`A queue runs a whole number of tasks above 0 at a time, not ${limit}`);
    }
  }

  add(task: () => Promise<void>): void {
    this.tasks = [...this.tasks, this.turn().then(() => this.runUnlessFailed(task))];
  }

  async idle(): Promise<void> {
    await Promise.all(this.tasks);
    if (this.failure !== null) throw this.failure.error;
  }

  /** Resolves once a slot is free, holding it. */
  private turn(): Promise<void> {
    if (this.running < this.limit) {
      this.running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiting = [...this.waiting, () => resolve()];
    });
  }

  /** Never rejects: a failure is held for `idle`, and recorded before the slot passes on. */
  private async runUnlessFailed(task: () => Promise<void>): Promise<void> {
    try {
      if (this.failure === null) await task();
    } catch (error) {
      this.failure ??= { error };
    } finally {
      this.release();
    }
  }

  /** Hands the slot to the task waiting longest, or frees it. */
  private release(): void {
    const [next, ...rest] = this.waiting;
    if (next === undefined) {
      this.running -= 1;
      return;
    }
    this.waiting = rest;
    next();
  }
}
