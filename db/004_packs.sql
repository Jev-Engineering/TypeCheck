CREATE TABLE IF NOT EXISTS pack_definitions (
 guild_id text NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
 id uuid NOT NULL, data jsonb NOT NULL CHECK (jsonb_typeof(data)='object'),
 revision integer NOT NULL CHECK(revision>0), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(guild_id,id), CHECK(data->>'guildId'=guild_id), CHECK(data->>'id'=id::text), CHECK((data->>'revision')::integer=revision)
);
CREATE TABLE IF NOT EXISTS moderation_packs (
 guild_id text NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
 id uuid NOT NULL, data jsonb NOT NULL CHECK (jsonb_typeof(data)='object'),
 revision integer NOT NULL CHECK(revision>0), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(guild_id,id), CHECK(data->>'guildId'=guild_id), CHECK(data->>'id'=id::text), CHECK((data->>'revision')::integer=revision)
);
INSERT INTO schema_migrations(version) VALUES ('004') ON CONFLICT DO NOTHING;
