/** A minimal typed event emitter. A throwing listener never stops the others. */
export class Emitter<T> {
  private readonly listeners = new Set<(value: T) => void>();

  /** Subscribe. Returns the unsubscribe function. */
  readonly event = (listener: (value: T) => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(value);
      } catch (error) {
        console.error('Listener failed', error);
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }

  clear(): void {
    this.listeners.clear();
  }
}
