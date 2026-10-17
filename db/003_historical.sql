CREATE TABLE IF NOT EXISTS durable_work (
 id VARCHAR(180) PRIMARY KEY, guild_id VARCHAR(22) REFERENCES guilds(id) ON DELETE CASCADE,
 kind VARCHAR(20) NOT NULL, due BIGINT NOT NULL, data JSONB NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS durable_ready ON durable_work(kind,due,id);
CREATE INDEX IF NOT EXISTS durable_guild ON durable_work(guild_id,kind,due);
INSERT INTO schema_migrations(version) VALUES('003');
