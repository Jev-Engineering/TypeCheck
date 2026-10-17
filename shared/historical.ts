export interface ScanChannel { id: string; name: string; status: 'pending' | 'complete' | 'excluded' | 'failed'; reason: string | null; before: string }
export type ScanStatus = 'running' | 'paused' | 'throttled' | 'budget_paused' | 'completed' | 'completed_with_gaps' | 'cancelled' | 'failed';
export interface HistoricalScan {
    id: string; guildId: string; actor: string; createdAt: string; cutoff: string; from: string | null;
    policy: string; status: ScanStatus; reason: string | null; nextAttempt: number;
    channels: ScanChannel[]; threadCoverage: string; channelIndex: number;
    budgets: { messages: number; images: number; requests: number };
    counters: { messages: number; images: number; matches: number; skipped: number; failed: number; requests: number; reused: number };
    failures: { reason: string; channel: string; message?: string }[];
    pending: { imageReserved?: boolean; editedAt: string | null; message: string; user: string; attachments: string[]; index: number } | null;
    retries: number; mode: 'review_only';
}
