// Keep OAuth credentials only in memory for the current Activity instance.
export class HttpError extends Error {
    constructor(message: string, readonly status: number) { super(message); }
}
export function connectionError(stage: string, error: unknown): Error {
    const detail = error instanceof HttpError ? ` (HTTP ${error.status}: ${error.message})` :
        error && typeof error === 'object' && 'code' in error && typeof error.code === 'number' ? ` (Discord code ${error.code})` : '';
    return new Error(`${stage} failed${detail}. Click Connect in Discord to retry. If Discord continues rejecting authorization, close and reopen the Activity.`);
}
export function serializeConnection<T>(run: () => Promise<T>): () => Promise<T> {
    let pending: Promise<T> | undefined;
    return () => pending ??= Promise.resolve().then(run).finally(() => { pending = undefined; });
}
export function activityAuth<T>(options: {
    start(): Promise<string>;
    authorize(nonce: string): Promise<string>;
    exchange(code: string, nonce: string): Promise<T>;
    renew(accessToken: string, nonce: string): Promise<T>;
    authenticate(auth: T): Promise<void>;
    accessToken(auth: T): string;
}) {
    let accessToken = '';
    return serializeConnection(async () => {
        const stage = async <V>(name: string, run: () => Promise<V>) => { try { return await run(); } catch (error) { throw connectionError(name, error); } };
        if (accessToken) {
            const nonce = await stage('Session renewal setup', options.start);
            try { return await options.renew(accessToken, nonce); }
            catch (error) {
                if (!(error instanceof HttpError) || error.status !== 401) throw connectionError('Session renewal', error);
                accessToken = '';
            }
        }
        // A failed renewal consumed its nonce. Never replay a code or nonce.
        const nonce = await stage('Authorization setup', options.start);
        const code = await stage('Discord authorization', () => options.authorize(nonce));
        const auth = await stage('Authorization code exchange', () => options.exchange(code, nonce));
        await stage('Discord authentication', () => options.authenticate(auth));
        accessToken = options.accessToken(auth);
        return auth;
    });
}
