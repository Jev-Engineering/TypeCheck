CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(16) PRIMARY KEY, applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS guilds (id VARCHAR(22) PRIMARY KEY CHECK (REGEXP_LIKE(id,'^[0-9]{6,22}$')), settings JSON NOT NULL CHECK (JSON_TYPE(settings)='OBJECT'), revision INTEGER NOT NULL DEFAULT 1, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS image_groups (
  guild_id VARCHAR(22) NOT NULL, id CHAR(36) NOT NULL,
  data JSON NOT NULL CHECK (JSON_TYPE(data)='OBJECT'), revision INTEGER NOT NULL CHECK (revision>0),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (guild_id,id), FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE,
  CHECK (
    JSON_UNQUOTE(JSON_EXTRACT(data,'$.guildId'))=guild_id AND
    JSON_UNQUOTE(JSON_EXTRACT(data,'$.id'))=id AND
    CAST(JSON_UNQUOTE(JSON_EXTRACT(data,'$.revision')) AS SIGNED)=revision
  ),
  INDEX image_groups_guild_updated (guild_id,updated_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS reference_images (
  guild_id VARCHAR(22) NOT NULL, id CHAR(36) NOT NULL,
  data JSON NOT NULL CHECK (JSON_TYPE(data)='OBJECT'), revision INTEGER NOT NULL CHECK (revision>0),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (guild_id,id), FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE,
  CHECK (
    JSON_UNQUOTE(JSON_EXTRACT(data,'$.guildId'))=guild_id AND
    JSON_UNQUOTE(JSON_EXTRACT(data,'$.id'))=id AND
    CAST(JSON_UNQUOTE(JSON_EXTRACT(data,'$.revision')) AS SIGNED)=revision
  ),
  INDEX reference_images_guild_updated (guild_id,updated_at DESC),
  group_id CHAR(36), FOREIGN KEY (guild_id,group_id) REFERENCES image_groups(guild_id,id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS moderation_rules (
  guild_id VARCHAR(22) NOT NULL, id CHAR(36) NOT NULL,
  data JSON NOT NULL CHECK (JSON_TYPE(data)='OBJECT'), revision INTEGER NOT NULL CHECK (revision>0),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (guild_id,id), FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE,
  CHECK (
    JSON_UNQUOTE(JSON_EXTRACT(data,'$.guildId'))=guild_id AND
    JSON_UNQUOTE(JSON_EXTRACT(data,'$.id'))=id AND
    CAST(JSON_UNQUOTE(JSON_EXTRACT(data,'$.revision')) AS SIGNED)=revision
  ),
  INDEX moderation_rules_guild_updated (guild_id,updated_at DESC),
  group_id CHAR(36), FOREIGN KEY (guild_id,group_id) REFERENCES image_groups(guild_id,id) ON DELETE RESTRICT,
  reference_id CHAR(36), FOREIGN KEY (guild_id,reference_id) REFERENCES reference_images(guild_id,id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS role_grants (
  guild_id VARCHAR(22) NOT NULL, id CHAR(36) NOT NULL,
  data JSON NOT NULL CHECK (JSON_TYPE(data)='OBJECT'), revision INTEGER NOT NULL CHECK (revision>0),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (guild_id,id), FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE,
  CHECK (
    JSON_UNQUOTE(JSON_EXTRACT(data,'$.guildId'))=guild_id AND
    JSON_UNQUOTE(JSON_EXTRACT(data,'$.id'))=id AND
    CAST(JSON_UNQUOTE(JSON_EXTRACT(data,'$.revision')) AS SIGNED)=revision
  ),
  INDEX role_grants_guild_updated (guild_id,updated_at DESC),
  role_id VARCHAR(22) GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(data,'$.roleId'))) STORED, UNIQUE KEY one_grant_per_role (guild_id,role_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS guild_credentials (
  guild_id VARCHAR(22) NOT NULL, id CHAR(36) NOT NULL,
  data JSON NOT NULL CHECK (JSON_TYPE(data)='OBJECT'), revision INTEGER NOT NULL CHECK (revision>0),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (guild_id,id), FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE,
  CHECK (
    JSON_UNQUOTE(JSON_EXTRACT(data,'$.guildId'))=guild_id AND
    JSON_UNQUOTE(JSON_EXTRACT(data,'$.id'))=id AND
    CAST(JSON_UNQUOTE(JSON_EXTRACT(data,'$.revision')) AS SIGNED)=revision
  ),
  INDEX guild_credentials_guild_updated (guild_id,updated_at DESC),
  UNIQUE KEY one_credential_per_guild (guild_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS calibration_trials (
  guild_id VARCHAR(22) NOT NULL, id CHAR(36) NOT NULL,
  data JSON NOT NULL CHECK (JSON_TYPE(data)='OBJECT'), revision INTEGER NOT NULL CHECK (revision>0),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (guild_id,id), FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE,
  CHECK (
    JSON_UNQUOTE(JSON_EXTRACT(data,'$.guildId'))=guild_id AND
    JSON_UNQUOTE(JSON_EXTRACT(data,'$.id'))=id AND
    CAST(JSON_UNQUOTE(JSON_EXTRACT(data,'$.revision')) AS SIGNED)=revision
  ),
  INDEX calibration_trials_guild_updated (guild_id,updated_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS image_evaluations (
  guild_id VARCHAR(22) NOT NULL, id CHAR(36) NOT NULL,
  data JSON NOT NULL CHECK (JSON_TYPE(data)='OBJECT'), revision INTEGER NOT NULL CHECK (revision>0),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (guild_id,id), FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE,
  CHECK (
    JSON_UNQUOTE(JSON_EXTRACT(data,'$.guildId'))=guild_id AND
    JSON_UNQUOTE(JSON_EXTRACT(data,'$.id'))=id AND
    CAST(JSON_UNQUOTE(JSON_EXTRACT(data,'$.revision')) AS SIGNED)=revision
  ),
  INDEX image_evaluations_guild_updated (guild_id,updated_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS moderation_events (
  guild_id VARCHAR(22) NOT NULL, id CHAR(36) NOT NULL,
  data JSON NOT NULL CHECK (JSON_TYPE(data)='OBJECT'), revision INTEGER NOT NULL CHECK (revision>0),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (guild_id,id), FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE,
  CHECK (
    JSON_UNQUOTE(JSON_EXTRACT(data,'$.guildId'))=guild_id AND
    JSON_UNQUOTE(JSON_EXTRACT(data,'$.id'))=id AND
    CAST(JSON_UNQUOTE(JSON_EXTRACT(data,'$.revision')) AS SIGNED)=revision
  ),
  INDEX moderation_events_guild_updated (guild_id,updated_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS audit_events (
  guild_id VARCHAR(22) NOT NULL, id CHAR(36) NOT NULL,
  data JSON NOT NULL CHECK (JSON_TYPE(data)='OBJECT'), revision INTEGER NOT NULL CHECK (revision>0),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (guild_id,id), FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE,
  CHECK (
    JSON_UNQUOTE(JSON_EXTRACT(data,'$.guildId'))=guild_id AND
    JSON_UNQUOTE(JSON_EXTRACT(data,'$.id'))=id AND
    CAST(JSON_UNQUOTE(JSON_EXTRACT(data,'$.revision')) AS SIGNED)=revision
  ),
  INDEX audit_events_guild_updated (guild_id,updated_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS jobs (
 id CHAR(36) PRIMARY KEY, guild_id VARCHAR(22) NOT NULL, message JSON NOT NULL,
 message_id VARCHAR(22) NOT NULL, signature CHAR(64) NOT NULL,
 status VARCHAR(16) NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','done','failed')),
 error TEXT, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE,
 UNIQUE(guild_id,message_id,signature), INDEX pending_jobs(status,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS seen_attachments (
 guild_id VARCHAR(22) NOT NULL, message_id VARCHAR(22) NOT NULL, attachment_id VARCHAR(22) NOT NULL,
 PRIMARY KEY(guild_id,message_id,attachment_id), FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS action_ledger (
 guild_id VARCHAR(22) NOT NULL, message_id VARCHAR(22) NOT NULL,
 slot VARCHAR(16) NOT NULL CHECK(slot IN ('delete','user','dm','log')),
 action VARCHAR(32) NOT NULL, status VARCHAR(32) NOT NULL, detail TEXT NOT NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY(guild_id,message_id,slot),
 FOREIGN KEY(guild_id) REFERENCES guilds(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS usage_daily (
 guild_id VARCHAR(22) NOT NULL, day DATE NOT NULL, calls INTEGER NOT NULL DEFAULT 0, input_tokens BIGINT NOT NULL DEFAULT 0,
 PRIMARY KEY(guild_id,day), FOREIGN KEY(guild_id) REFERENCES guilds(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS auth_nonces (hash CHAR(64) PRIMARY KEY, origin TEXT NOT NULL, expires_at DATETIME(3) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS sessions (
 hash CHAR(64) PRIMARY KEY, user_id VARCHAR(22) NOT NULL, guild_id VARCHAR(22) NOT NULL, expires_at DATETIME(3) NOT NULL,
 FOREIGN KEY(guild_id) REFERENCES guilds(id) ON DELETE CASCADE, INDEX sessions_expiry(expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
INSERT INTO schema_migrations(version) VALUES ('001') ON DUPLICATE KEY UPDATE version=version;
