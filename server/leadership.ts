export interface LeaderStore {
    acquireLeader(onLost: () => void): Promise<(() => Promise<void>) | null>;
}
export interface Controller { run(): Promise<void>; stop(): void; }
// A standby never constructs controllers. Loss fails closed and lets supervision
// restart the process; graceful shutdown drains work before releasing the lock.
export class Leadership {
    state: 'standby' | 'leader' | 'lost' | 'stopping' = 'standby';
    private release: (() => Promise<void>) | null = null;
    private controllers: Controller[] = [];
    private jobs: Promise<void>[] = [];
    private pending: Promise<void> | undefined;
    private timer: ReturnType<typeof setTimeout> | undefined;
    constructor(private store: LeaderStore, private create: () => Controller[], private fatal: (code: string) => void, private report: (code: string) => void, private retryMs = 5000) { }
    private lost = () => {
        if (this.state === 'lost' || this.state === 'stopping') return;
        this.state = 'lost'; clearTimeout(this.timer);
        for (const controller of this.controllers) controller.stop();
        this.fatal('worker_leadership_lost');
    };
    attempt(): Promise<void> {
        if (this.pending) return this.pending;
        this.pending = this.acquire().finally(() => { this.pending = undefined; });
        return this.pending;
    }
    private async acquire() {
        if (this.state !== 'standby') return;
        try {
            const release = await this.store.acquireLeader(this.lost);
            if (this.state !== 'standby') { await release?.(); return; }
            if (!release) return;
            this.release = release; this.state = 'leader';
            this.controllers = this.create();
            this.jobs = this.controllers.map(c => c.run());
            for (const job of this.jobs) void job.then(() => {
                if (this.state === 'leader') this.lost();
            }, () => { if (this.state === 'leader') this.lost(); });
        } catch {
            if (this.state === 'leader') this.lost();
            else this.report('leadership_acquire_failed');
        }
    }
    async start() {
        await this.attempt();
        const retry = async () => { await this.attempt(); if (this.state === 'standby') this.timer = setTimeout(() => void retry(), this.retryMs); };
        if (this.state === 'standby') this.timer = setTimeout(() => void retry(), this.retryMs);
    }
    async stop() {
        this.state = 'stopping'; clearTimeout(this.timer);
        for (const controller of this.controllers) controller.stop();
        await this.pending;
        await Promise.allSettled(this.jobs);
        await this.release?.(); this.release = null;
    }
}
