CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'super_agent_app') THEN
    CREATE ROLE super_agent_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  EXECUTE format('GRANT super_agent_app TO %I', current_user);
END $$;

CREATE TABLE IF NOT EXISTS sa_users (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL UNIQUE,
  issuer text NOT NULL,
  subject text NOT NULL,
  email text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, subject)
);
CREATE TABLE IF NOT EXISTS sa_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES sa_users(id),
  refresh_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sa_device_keys (
  device_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  public_key text NOT NULL,
  key_version integer NOT NULL DEFAULT 1,
  revoked_at timestamptz
);
CREATE TABLE IF NOT EXISTS sa_pairings (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  public_key text NOT NULL,
  polling_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  device_id uuid,
  tenant_id uuid,
  claimed_by uuid REFERENCES sa_users(id)
);
CREATE TABLE IF NOT EXISTS sa_challenges (
  nonce text PRIMARY KEY,
  device_id uuid NOT NULL REFERENCES sa_device_keys(device_id),
  challenge text NOT NULL,
  expires_at timestamptz NOT NULL
);
GRANT SELECT,INSERT,UPDATE,DELETE ON sa_users,sa_sessions,sa_device_keys,sa_pairings,sa_challenges TO super_agent_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'devices','tasks','runs','messages','questions','memories','settings','commands',
    'assistant_leases','plans','checkpoints','frames','views','usage_records','budgets','memory_bindings',
    'budget_reservations','schedules','notifications','artifacts','steps','inbox_receipts'
  ] LOOP
    EXECUTE format('CREATE TABLE IF NOT EXISTS sa_%I (
      tenant_id uuid NOT NULL,
      id uuid NOT NULL,
      data jsonb NOT NULL,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, id)
    )', t);
    EXECUTE format('ALTER TABLE sa_%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE sa_%I FORCE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'sa_' || t AND policyname = 'tenant_isolation') THEN
      EXECUTE format('CREATE POLICY tenant_isolation ON sa_%I
        USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)
        WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
    END IF;
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON sa_%I TO super_agent_app', t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON sa_%I (tenant_id, updated_at DESC)', 'sa_' || t || '_updated', t);
  END LOOP;
END $$;

ALTER TABLE sa_runs ADD COLUMN IF NOT EXISTS task_ref uuid GENERATED ALWAYS AS ((data->>'task_id')::uuid) STORED;
ALTER TABLE sa_runs ADD COLUMN IF NOT EXISTS device_ref uuid GENERATED ALWAYS AS ((data->>'device_id')::uuid) STORED;
ALTER TABLE sa_tasks ADD COLUMN IF NOT EXISTS device_ref uuid GENERATED ALWAYS AS (NULLIF(data->>'device_id','')::uuid) STORED;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='sa_runs_task_fk') THEN
    ALTER TABLE sa_runs ADD CONSTRAINT sa_runs_task_fk FOREIGN KEY (tenant_id, task_ref) REFERENCES sa_tasks(tenant_id,id);
    ALTER TABLE sa_runs ADD CONSTRAINT sa_runs_device_fk FOREIGN KEY (tenant_id, device_ref) REFERENCES sa_devices(tenant_id,id);
    ALTER TABLE sa_tasks ADD CONSTRAINT sa_tasks_device_fk FOREIGN KEY (tenant_id, device_ref) REFERENCES sa_devices(tenant_id,id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS sa_runs_device_state ON sa_runs (tenant_id,device_ref,(data->>'state'));
CREATE UNIQUE INDEX IF NOT EXISTS sa_messages_client_id ON sa_messages (tenant_id,(data->>'client_message_id')) WHERE data->>'client_message_id' IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sa_plans_source ON sa_plans (tenant_id,(data->>'source_message_id'));
CREATE UNIQUE INDEX IF NOT EXISTS sa_usage_request ON sa_usage_records (tenant_id,(data->>'run_id'),(data->>'request_key'));
CREATE UNIQUE INDEX IF NOT EXISTS sa_memory_bindings_actor ON sa_memory_bindings ((data->>'url'),(data->>'actor_id'));

CREATE TABLE IF NOT EXISTS sa_streams (tenant_id uuid PRIMARY KEY, seq bigint NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sa_events (
  tenant_id uuid NOT NULL,
  seq bigint NOT NULL,
  id uuid NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,seq), UNIQUE (tenant_id,id)
);
CREATE TABLE IF NOT EXISTS sa_idempotency (
  tenant_id uuid NOT NULL,
  identity text NOT NULL,
  request_hash text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,identity)
);
CREATE TABLE IF NOT EXISTS sa_report_receipts (
  tenant_id uuid NOT NULL,
  message_id uuid NOT NULL,
  producer_id text,
  producer_seq text,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,message_id),
  UNIQUE (tenant_id,producer_id,producer_seq)
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['streams','events','idempotency','report_receipts'] LOOP
    EXECUTE format('ALTER TABLE sa_%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE sa_%I FORCE ROW LEVEL SECURITY',t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='sa_'||t AND policyname='tenant_isolation') THEN
      EXECUTE format('CREATE POLICY tenant_isolation ON sa_%I USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
    END IF;
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON sa_%I TO super_agent_app',t);
  END LOOP;
END $$;
GRANT USAGE ON SCHEMA public TO super_agent_app;
