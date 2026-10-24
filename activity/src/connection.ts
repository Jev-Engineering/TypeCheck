// Keep OAuth credentials only in memory for the current Activity instance.
export class HttpError extends Error {
    constructor(message: string, readonly status: number, readonly reference = '') { super(message); }
}
export async function apiResponse<T = any>(response: Response): Promise<T> {
    const reference = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value) ? value : '';
    const headerReference = reference(response.headers.get('x-request-id')) || reference(response.headers.get('cf-ray'));
    let data: unknown;
    try { data = await response.json(); }
    catch { throw new HttpError('The server returned an unreadable response', response.status, headerReference); }
    if (!response.ok) {
        const error = data && typeof data === 'object' && 'error' in data ? data.error : undefined;
        const bodyReference = data && typeof data === 'object' && 'requestId' in data ? reference(data.requestId) : '';
        throw new HttpError(typeof error === 'string' ? error : 'Request failed', response.status, bodyReference || headerReference);
    }
    return data as T;
}
export function connectionError(stage: string, error: unknown): Error {
    if (error instanceof HttpError && error.status === 403 && error.message === 'no_delegated_access')
        return new Error('You need permission to use TypeCheck in this server. Ask a server owner or administrator to open TypeCheck → Permissions and grant access to your Discord role, then click Connect in Discord. Server owners and administrators have access automatically.');
    const detail = error instanceof HttpError ? ` (HTTP ${error.status}: ${error.message}${error.reference ? `; reference ${error.reference}` : ''})` :
        error && typeof error === 'object' && 'code' in error && typeof error.code === 'number' ? ` (Discord code ${error.code})` : '';
    if (error instanceof HttpError && error.status >= 500)
        return new Error(`TypeCheck could not complete sign-in because its server or an upstream service returned an error. Click Connect in Discord to retry. If it continues, share this error with TypeCheck support. ${stage}${detail}.`);
    if (error instanceof HttpError)
        return new Error(`${stage} failed${detail}. Click Connect in Discord to retry. If it continues, report this error to the TypeCheck administrator.`);
    if (error instanceof TypeError || error instanceof SyntaxError)
        return new Error(`${stage} failed: the TypeCheck server could not be reached or returned an unreadable response. Click Connect in Discord to retry. If it continues, report this error to the TypeCheck administrator.`);
    const action = stage === 'Discord authorization' || stage === 'Discord authentication'
        ? 'Click Connect in Discord to retry. If it continues, close and reopen the Activity.'
        : 'Click Connect in Discord to retry. If it continues, report this error to the TypeCheck administrator.';
    return new Error(`Could not connect to TypeCheck. ${action} (${stage} failed${detail}.)`);
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
