CREATE TABLE IF NOT EXISTS usage_tracking (id INTEGER PRIMARY KEY, started_at VARCHAR(24) NOT NULL);
CREATE TABLE IF NOT EXISTS usage_legacy (guild_id text NOT NULL, day DATE NOT NULL, calls BIGINT NOT NULL, input_tokens BIGINT NOT NULL, PRIMARY KEY(guild_id,day), FOREIGN KEY(guild_id) REFERENCES guilds(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS usage_rates (guild_id text NOT NULL, model VARCHAR(100) NOT NULL, revision INTEGER NOT NULL, effective_at VARCHAR(24) NOT NULL, data jsonb NOT NULL, PRIMARY KEY(guild_id,model,revision), FOREIGN KEY(guild_id) REFERENCES guilds(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS usage_attempts (
 guild_id text NOT NULL, id VARCHAR(36) NOT NULL, started_at VARCHAR(24) NOT NULL, day VARCHAR(10) NOT NULL,
 model VARCHAR(100) NOT NULL, purpose VARCHAR(32) NOT NULL, verification INTEGER NOT NULL,
 outcome VARCHAR(16) NOT NULL, input_tokens BIGINT, currency VARCHAR(3), cost_micros DECIMAL(38,0), data jsonb NOT NULL,
 PRIMARY KEY(guild_id,id), FOREIGN KEY(guild_id) REFERENCES guilds(id) ON DELETE CASCADE,
 CHECK (outcome IN ('reserved','dispatching','success','failure','uncertain')),
 CHECK (purpose IN ('moderation','rule_test','credential_validation')),
 CHECK (verification IN (0,1)), CHECK (input_tokens IS NULL OR input_tokens>=0), CHECK(cost_micros IS NULL OR cost_micros>=0)
);
CREATE INDEX IF NOT EXISTS usage_attempts_window ON usage_attempts(guild_id,started_at,id);
CREATE INDEX IF NOT EXISTS usage_attempts_retention ON usage_attempts(day);
INSERT INTO usage_tracking VALUES(1,to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ON CONFLICT DO NOTHING;
INSERT INTO usage_legacy SELECT guild_id,day,calls,input_tokens FROM usage_daily ON CONFLICT DO NOTHING;
INSERT INTO schema_migrations(version) VALUES('002') ON CONFLICT DO NOTHING;
