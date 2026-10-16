import type { AnalyticsStore } from '../shared/analytics.js';
import type { RecordBase, Kind, Settings, Job, ImageMessage, Session } from '../shared/domain.js';
export interface SettingsVersion {
    value: Settings;
    revision: number;
}
export interface Usage {
    day: string;
    calls: number;
    inputTokens: number;
}
export interface ActionRecord {
    guildId: string;
    messageId: string;
    slot: string;
    action: string;
    status: string;
    detail: string;
    createdAt: string;
}
export interface Store {
    readonly analytics: AnalyticsStore;
    getSettings(guild: string): Promise<SettingsVersion>;
    putSettings(guild: string, value: Settings, revision: number): Promise<void>;
    guilds(): Promise<string[]>;
    all<T extends RecordBase>(kind: Kind, guild: string): Promise<T[]>;
    get<T extends RecordBase>(kind: Kind, guild: string, id: string): Promise<T | null>;
    put<T extends RecordBase>(kind: Kind, record: T, expectedRevision: number): Promise<void>;
    remove(kind: Kind, guild: string, id: string, revision: number): Promise<void>;
    withGuild<T>(guild: string, work: (store: Store) => Promise<T>): Promise<T>;
    enqueue(message: ImageMessage): Promise<boolean>;
    claim(): Promise<Job | null>;
    finish(id: string, error: string | null): Promise<void>;
    seen(guild: string, message: string, attachment: string): Promise<boolean>;
    markSeen(guild: string, message: string, attachment: string): Promise<void>;
    beginAction(row: ActionRecord): Promise<boolean>;
    finishAction(guild: string, message: string, slot: string, status: string, detail: string): Promise<void>;
    actions(guild: string): Promise<ActionRecord[]>;
    reserveCall(guild: string, limit: number, day?: string): Promise<void>;
    addTokens(guild: string, tokens: number, day?: string): Promise<void>;
    usage(guild: string): Promise<Usage>;
    createNonce(hash: string, origin: string): Promise<void>;
    consumeNonce(hash: string, origin: string): Promise<boolean>;
    createSession(hash: string, session: Session): Promise<void>;
    session(hash: string): Promise<Session | null>;
    deleteSession(hash: string): Promise<void>;
    maintenance(): Promise<void>;
}
