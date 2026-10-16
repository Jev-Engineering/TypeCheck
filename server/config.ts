import { assert, snowflake } from '../shared/domain.js';
export interface Config {
    port: number;
    production: boolean;
    publicOrigin: string;
    clientId: string;
    clientSecret: string;
    botToken: string;
    databaseUrl: string;
    masterKey: string;
    objectDir: string;
    model: string;
    apiOnly: boolean;
    enforcementApproved?: boolean;
    migrateOnStart?: boolean;
    databaseTls?: { ca?: string };
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    const production = env.NODE_ENV === 'production';
    const port = Number(env.PORT ?? 3000);
    assert(Number.isInteger(port) && port > 0 && port < 65536, 'invalid_port');
    const required = (k: string) => { const v = env[k]; assert(v && !v.includes('REPLACE_'), `missing_${k}`); return v; };
    const publicOrigin = new URL(required('PUBLIC_ORIGIN')).origin;
    assert(!production || publicOrigin.startsWith('https://'), 'production_requires_https');
    const clientId = required('DISCORD_CLIENT_ID');
    assert(snowflake(clientId), 'invalid_client_id');
    const model = env.JEV_MODEL ?? 'jev-1.14.0';
    assert(/^jev-\d+\.\d+\.\d+$/.test(model), 'pin_versioned_jev_model');
    assert(!(production && env.API_ONLY === '1'), 'api_only_is_development_only');
    const database = databaseConfig(env);
    return { port, production, publicOrigin, clientId, clientSecret: required('DISCORD_CLIENT_SECRET'), botToken: required('DISCORD_BOT_TOKEN'), databaseUrl: database.url, databaseTls: database.tls, migrateOnStart: env.MIGRATE_ON_START === '1', masterKey: required('CREDENTIAL_MASTER_KEY'), objectDir: env.OBJECT_DIR ?? './objects', model, apiOnly: env.API_ONLY === '1', enforcementApproved: env.ACCEPTANCE_APPROVED === '1' };
}

export function databaseConfig(env: NodeJS.ProcessEnv = process.env): { url: string; tls?: { ca?: string } } {
    let url = env.DATABASE_URL;
    if (!url) {
        const required = (key: string) => { const value = env[key]; assert(value && !value.includes('REPLACE_'), `missing_${key}`); return value; };
        const host = required('DB_HOST');
        assert(/^[a-zA-Z0-9.\-]+$/.test(host), 'invalid_DB_HOST');
        const port = Number(env.DB_PORT ?? 3306);
        assert(Number.isInteger(port) && port > 0 && port < 65536, 'invalid_DB_PORT');
        url = `mysql://${encodeURIComponent(required('DB_USER'))}:${encodeURIComponent(required('DB_PASSWORD'))}@${host}:${port}/${encodeURIComponent(required('DB_NAME'))}`;
    }
    assert(!url.includes('REPLACE_'), 'missing_DATABASE_URL');
    assert(['mysql:', 'postgres:', 'postgresql:'].includes(url.split(':')[0] + ':'), 'invalid_database_scheme');
    assert(env.DB_SSL === undefined || ['0', '1'].includes(env.DB_SSL), 'invalid_DB_SSL');
    assert(!env.DB_SSL_CA || env.DB_SSL === '1', 'DB_SSL_CA_requires_DB_SSL');
    return { url, tls: env.DB_SSL === '1' ? { ca: env.DB_SSL_CA } : undefined };
}
