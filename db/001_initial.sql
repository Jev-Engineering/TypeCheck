CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS guilds (
  id text PRIMARY KEY CHECK (id ~ '^[0-9]{6,22}$'),
  settings jsonb NOT NULL CHECK (jsonb_typeof(settings)='object'), revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Typed entities are in separate tables; every primary/foreign key includes guild_id.
DO $$ DECLARE tbl text; BEGIN
  FOREACH tbl IN ARRAY ARRAY['image_groups','reference_images','moderation_rules','role_grants','guild_credentials','calibration_trials','image_evaluations','moderation_events','audit_events'] LOOP
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I (
      guild_id text NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
      id uuid NOT NULL, data jsonb NOT NULL CHECK (jsonb_typeof(data)=''object''),
      revision integer NOT NULL CHECK (revision>0), updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (guild_id,id), CHECK (data->>''guildId''=guild_id), CHECK (data->>''id''=id::text),
      CHECK ((data->>''revision'')::integer=revision))',tbl);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I(guild_id,updated_at DESC)',tbl||'_guild_updated',tbl);
  END LOOP;
END $$;
ALTER TABLE reference_images ADD COLUMN IF NOT EXISTS group_id uuid;
ALTER TABLE moderation_rules ADD COLUMN IF NOT EXISTS reference_id uuid;
ALTER TABLE moderation_rules ADD COLUMN IF NOT EXISTS group_id uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='reference_group_fk') THEN
    ALTER TABLE reference_images ADD CONSTRAINT reference_group_fk FOREIGN KEY (guild_id,group_id) REFERENCES image_groups(guild_id,id) ON DELETE RESTRICT;
    ALTER TABLE moderation_rules ADD CONSTRAINT rule_reference_fk FOREIGN KEY (guild_id,reference_id) REFERENCES reference_images(guild_id,id) ON DELETE RESTRICT;
    ALTER TABLE moderation_rules ADD CONSTRAINT rule_group_fk FOREIGN KEY (guild_id,group_id) REFERENCES image_groups(guild_id,id) ON DELETE RESTRICT;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS one_credential_per_guild ON guild_credentials(guild_id);
CREATE UNIQUE INDEX IF NOT EXISTS one_grant_per_role ON role_grants(guild_id,(data->>'roleId'));
CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY, guild_id text NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  message jsonb NOT NULL, message_id text NOT NULL, signature text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','done','failed')),
  error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(guild_id,message_id,signature)
);
CREATE INDEX IF NOT EXISTS pending_jobs ON jobs(created_at) WHERE status='queued';
CREATE TABLE IF NOT EXISTS seen_attachments (
  guild_id text NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  message_id text NOT NULL, attachment_id text NOT NULL,
  PRIMARY KEY(guild_id,message_id,attachment_id)
);
CREATE TABLE IF NOT EXISTS action_ledger (
  guild_id text NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  message_id text NOT NULL, slot text NOT NULL CHECK(slot IN ('delete','user','dm','log')),
  action text NOT NULL, status text NOT NULL, detail text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(guild_id,message_id,slot)
);
CREATE TABLE IF NOT EXISTS usage_daily (
  guild_id text NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  day date NOT NULL, calls integer NOT NULL DEFAULT 0, input_tokens bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(guild_id,day)
);
CREATE TABLE IF NOT EXISTS auth_nonces (hash text PRIMARY KEY,origin text NOT NULL,expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  hash text PRIMARY KEY,user_id text NOT NULL,guild_id text NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
INSERT INTO schema_migrations(version) VALUES ('001') ON CONFLICT DO NOTHING;
