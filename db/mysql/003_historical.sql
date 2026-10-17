CREATE TABLE IF NOT EXISTS durable_work (
 id VARCHAR(180) PRIMARY KEY, guild_id VARCHAR(22), kind VARCHAR(20) NOT NULL,
 due BIGINT NOT NULL, data JSON NOT NULL, updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 FOREIGN KEY(guild_id) REFERENCES guilds(id) ON DELETE CASCADE,
 INDEX durable_ready(kind,due,id), INDEX durable_guild(guild_id,kind,due)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
INSERT INTO schema_migrations(version) VALUES('003');
