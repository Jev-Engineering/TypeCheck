CREATE TABLE IF NOT EXISTS usage_tracking (id INTEGER PRIMARY KEY, started_at VARCHAR(24) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS usage_legacy (guild_id VARCHAR(22) NOT NULL, day DATE NOT NULL, calls BIGINT NOT NULL, input_tokens BIGINT NOT NULL, PRIMARY KEY(guild_id,day), FOREIGN KEY(guild_id) REFERENCES guilds(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS usage_rates (guild_id VARCHAR(22) NOT NULL, model VARCHAR(100) NOT NULL, revision INTEGER NOT NULL, effective_at VARCHAR(24) NOT NULL, data JSON NOT NULL, PRIMARY KEY(guild_id,model,revision), FOREIGN KEY(guild_id) REFERENCES guilds(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS usage_attempts (
 guild_id VARCHAR(22) NOT NULL, id VARCHAR(36) NOT NULL, started_at VARCHAR(24) NOT NULL, day VARCHAR(10) NOT NULL,
 model VARCHAR(100) NOT NULL, purpose VARCHAR(32) NOT NULL, verification INTEGER NOT NULL,
 outcome VARCHAR(16) NOT NULL, input_tokens BIGINT, currency VARCHAR(3), cost_micros DECIMAL(38,0), data JSON NOT NULL,
 PRIMARY KEY(guild_id,id), FOREIGN KEY(guild_id) REFERENCES guilds(id) ON DELETE CASCADE,
 INDEX usage_attempts_window (guild_id,started_at,id), INDEX usage_attempts_retention (day), CHECK (outcome IN ('reserved','dispatching','success','failure','uncertain')),
 CHECK (purpose IN ('moderation','rule_test','credential_validation')),
 CHECK (verification IN (0,1)), CHECK (input_tokens IS NULL OR input_tokens>=0), CHECK(cost_micros IS NULL OR cost_micros>=0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
INSERT INTO usage_tracking SELECT 1,CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3),'%Y-%m-%dT%H:%i:%s.'),LEFT(DATE_FORMAT(UTC_TIMESTAMP(3),'%f'),3),'Z') ON DUPLICATE KEY UPDATE id=id;
INSERT INTO usage_legacy SELECT guild_id,day,calls,input_tokens FROM usage_daily ON DUPLICATE KEY UPDATE guild_id=usage_legacy.guild_id;
INSERT INTO schema_migrations(version) VALUES('002');
