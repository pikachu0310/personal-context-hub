export class EventQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.ended = false;
  }
  push(item) {
    if (this.ended) return;
    if (this.waiters.length)
      this.waiters.shift().resolve({ value: item, done: false });
    else this.items.push(item);
  }
  end(error) {
    this.ended = true;
    this.error = error;
    for (const waiter of this.waiters.splice(0))
      error ? waiter.reject(error) : waiter.resolve({ done: true });
  }
  next() {
    if (this.items.length)
      return Promise.resolve({ value: this.items.shift(), done: false });
    if (this.error) return Promise.reject(this.error);
    if (this.ended) return Promise.resolve({ done: true });
    return new Promise((resolve, reject) =>
      this.waiters.push({ resolve, reject }),
    );
  }
  [Symbol.asyncIterator]() {
    return this;
  }
}
