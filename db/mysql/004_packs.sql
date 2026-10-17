CREATE TABLE IF NOT EXISTS pack_definitions (
  guild_id VARCHAR(22) NOT NULL, id CHAR(36) NOT NULL,
  data JSON NOT NULL CHECK (JSON_TYPE(data)='OBJECT'), revision INTEGER NOT NULL CHECK (revision>0),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (guild_id,id), FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE,
  CHECK (
    JSON_UNQUOTE(JSON_EXTRACT(data,'$.guildId'))=guild_id AND
    JSON_UNQUOTE(JSON_EXTRACT(data,'$.id'))=id AND
    CAST(JSON_UNQUOTE(JSON_EXTRACT(data,'$.revision')) AS SIGNED)=revision
  ),
  INDEX pack_definitions_guild_updated (guild_id,updated_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS moderation_packs (
  guild_id VARCHAR(22) NOT NULL, id CHAR(36) NOT NULL,
  data JSON NOT NULL CHECK (JSON_TYPE(data)='OBJECT'), revision INTEGER NOT NULL CHECK (revision>0),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (guild_id,id), FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE,
  CHECK (
    JSON_UNQUOTE(JSON_EXTRACT(data,'$.guildId'))=guild_id AND
    JSON_UNQUOTE(JSON_EXTRACT(data,'$.id'))=id AND
    CAST(JSON_UNQUOTE(JSON_EXTRACT(data,'$.revision')) AS SIGNED)=revision
  ),
  INDEX moderation_packs_guild_updated (guild_id,updated_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

INSERT INTO schema_migrations(version) VALUES ('004') ON DUPLICATE KEY UPDATE version=version;
