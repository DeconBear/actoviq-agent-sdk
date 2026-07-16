/**
 * Serializes mutating turns for one session while allowing unrelated sessions
 * to keep running concurrently.
 *
 * This is intentionally process-local. SessionStore's durable turn lease
 * serializes the same session across clients/processes before revisions/CAS.
 */
export class SessionTurnCoordinator {
  private readonly tails = new Map<string, Promise<void>>();

  runExclusive<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    const result = previous.then(task, task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );

    this.tails.set(sessionId, tail);
    void tail.finally(() => {
      if (this.tails.get(sessionId) === tail) {
        this.tails.delete(sessionId);
      }
    });

    return result;
  }
}
