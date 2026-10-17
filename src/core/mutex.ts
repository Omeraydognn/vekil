// Async mutex for the entry path (SPEC §15.1). Kill and owner close never take it.
export class Mutex {
  private tail: Promise<void> = Promise.resolve();
  private held = 0;

  get locked(): boolean {
    return this.held > 0;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => (release = r));
    this.held++;
    try {
      await prev;
      return await fn();
    } finally {
      this.held--;
      release();
    }
  }
}
