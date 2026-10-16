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
    return { port, production, publicOrigin, clientId, clientSecret: required('DISCORD_CLIENT_SECRET'), botToken: required('DISCORD_BOT_TOKEN'), databaseUrl: required('DATABASE_URL'), masterKey: required('CREDENTIAL_MASTER_KEY'), objectDir: env.OBJECT_DIR ?? './objects', model, apiOnly: env.API_ONLY === '1' };
}
