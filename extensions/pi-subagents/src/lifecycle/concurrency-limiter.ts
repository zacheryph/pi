/**
 * concurrency-limiter.ts — FIFO admission gate for background work.
 *
 * Schedules run closures (thunks) against a dynamic limit, running them in
 * scheduling order as slots free. The limiter knows nothing about agents, IDs,
 * or the manager — it owns only the active count and the pending queue.
 *
 * Every scheduled promise settles: it follows the task's settlement when the
 * task runs, or resolves early if clear() drops it before it starts.
 */

export class ConcurrencyLimiter {
	private active = 0;
	private readonly pending: Array<{ start: () => void; settle: () => void }> = [];

	constructor(private readonly getLimit: () => number) {}

	/**
	 * Schedule a task to run FIFO once a slot is free.
	 * Returns a promise that settles with the task, or resolves early if the
	 * task is dropped by clear() before it starts.
	 */
	schedule(task: () => Promise<void>): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args
		this.pending.push({
			start: () => {
				this.active++;
				task()
					.then(resolve, reject)
					.finally(() => {
						this.active--;
						this.recheck();
					});
			},
			settle: resolve,
		});
		this.recheck();
		return promise;
	}

	/** Start pending tasks until the limit is reached. Call when the limit may have grown. */
	recheck(): void {
		while (this.active < this.getLimit()) {
			const next = this.pending.shift();
			if (!next) break;
			next.start();
		}
	}

	/** Drop all pending tasks, resolving their promises without running them. */
	clear(): void {
		const dropped = this.pending.splice(0);
		for (const task of dropped) task.settle();
	}
}

/**
 * A set of independent FIFO limiters keyed by pool name, each against its own
 * dynamic limit. Pools are created on first use, so the set knows nothing about
 * which names are configured — the caller resolves a name before scheduling.
 */
export class ConcurrencyPools {
	private readonly limiters = new Map<string, ConcurrencyLimiter>();

	constructor(
		private readonly getLimit: (pool: string) => number,
		private readonly defaultPool: string,
	) {}

	/** Schedule a task FIFO within `pool`; omitted, it joins the default pool. */
	schedule(task: () => Promise<void>, pool: string = this.defaultPool): Promise<void> {
		let limiter = this.limiters.get(pool);
		if (!limiter) {
			limiter = new ConcurrencyLimiter(() => this.getLimit(pool));
			this.limiters.set(pool, limiter);
		}
		return limiter.schedule(task);
	}

	/** Start pending tasks in every pool. Call when any limit may have grown. */
	recheck(): void {
		for (const limiter of this.limiters.values()) limiter.recheck();
	}

	/** Drop pending tasks in every pool, resolving their promises without running them. */
	clear(): void {
		for (const limiter of this.limiters.values()) limiter.clear();
	}
}
