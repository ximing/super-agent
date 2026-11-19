-- Durable push routing and deliveries; token plaintext never belongs in these tables.
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['push_registrations','notification_deliveries','notification_preferences'] LOOP
    EXECUTE format('CREATE TABLE sa_%I (tenant_id uuid NOT NULL,id uuid NOT NULL,data jsonb NOT NULL,version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id))',name);
    EXECUTE format('ALTER TABLE sa_%I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('ALTER TABLE sa_%I FORCE ROW LEVEL SECURITY',name);
    EXECUTE format('CREATE POLICY tenant_isolation ON sa_%I USING(tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',name);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON sa_%I TO super_agent_app',name);
    EXECUTE format('CREATE INDEX ON sa_%I(tenant_id,created_at,id)',name);
  END LOOP;
END $$;
ALTER TABLE sa_push_registrations ADD COLUMN session_ref uuid GENERATED ALWAYS AS ((data->>'session_id')::uuid) STORED;
ALTER TABLE sa_push_registrations ADD CONSTRAINT sa_push_registration_session_fk FOREIGN KEY(session_ref) REFERENCES sa_sessions(id);
CREATE UNIQUE INDEX sa_push_registration_identity ON sa_push_registrations(tenant_id,(data->>'token_hash'));
CREATE INDEX sa_push_registration_session ON sa_push_registrations(tenant_id,session_ref);
ALTER TABLE sa_notification_deliveries ADD COLUMN notification_ref uuid GENERATED ALWAYS AS ((data->>'notification_id')::uuid) STORED;
ALTER TABLE sa_notification_deliveries ADD COLUMN registration_ref uuid GENERATED ALWAYS AS ((data->>'registration_id')::uuid) STORED;
ALTER TABLE sa_notification_deliveries ADD CONSTRAINT sa_push_delivery_notification_fk FOREIGN KEY(tenant_id,notification_ref) REFERENCES sa_notifications(tenant_id,id);
ALTER TABLE sa_notification_deliveries ADD CONSTRAINT sa_push_delivery_registration_fk FOREIGN KEY(tenant_id,registration_ref) REFERENCES sa_push_registrations(tenant_id,id);
CREATE UNIQUE INDEX sa_push_delivery_identity ON sa_notification_deliveries(tenant_id,notification_ref,registration_ref);
CREATE INDEX sa_push_delivery_pending ON sa_notification_deliveries(tenant_id,created_at,id)
  WHERE data->>'status' IN ('pending','retry','unconfigured','receipt_pending','sending');

-- Authentication-plane locator, like sa_sessions: no notification or token contents.
-- A session-scoped sender lock and registration xact lock serialize account transfer.
CREATE TABLE sa_push_token_owners (
  token_hash text PRIMARY KEY CHECK(token_hash ~ '^[0-9a-f]{64}$'),
  tenant_id uuid NOT NULL,
  registration_id uuid NOT NULL,
  session_id uuid NOT NULL REFERENCES sa_sessions(id),
  version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,registration_id) REFERENCES sa_push_registrations(tenant_id,id)
);
REVOKE ALL ON sa_push_token_owners FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON sa_push_token_owners TO super_agent_app;
