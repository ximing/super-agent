-- Message processing receipts and durable task-action receipts.
-- Historical rows are not backfilled; unknown history stays unknown.
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['message_processing','task_actions'] LOOP
    EXECUTE format('CREATE TABLE sa_%I (tenant_id uuid NOT NULL,id uuid NOT NULL,data jsonb NOT NULL,version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id))',name);
    EXECUTE format('ALTER TABLE sa_%I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('ALTER TABLE sa_%I FORCE ROW LEVEL SECURITY',name);
    EXECUTE format('CREATE POLICY tenant_isolation ON sa_%I USING(tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',name);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON sa_%I TO super_agent_app',name);
    EXECUTE format('CREATE INDEX ON sa_%I(tenant_id,created_at,id)',name);
  END LOOP;
END $$;
CREATE UNIQUE INDEX sa_message_processing_source ON sa_message_processing(tenant_id,(data->>'source_message_id'));
CREATE INDEX sa_task_actions_task ON sa_task_actions(tenant_id,(data->>'task_id'),created_at);
