-- 001 is immutable. New team data uses the same tenant/RLS boundary.
CREATE TABLE sa_task_dependencies (
  tenant_id uuid NOT NULL, task_id uuid NOT NULL, dependency_task_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,task_id,dependency_task_id),
  CHECK(task_id<>dependency_task_id),
  FOREIGN KEY(tenant_id,task_id) REFERENCES sa_tasks(tenant_id,id),
  FOREIGN KEY(tenant_id,dependency_task_id) REFERENCES sa_tasks(tenant_id,id)
);
ALTER TABLE sa_task_dependencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE sa_task_dependencies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sa_task_dependencies USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON sa_task_dependencies TO super_agent_app;
CREATE INDEX sa_task_dependencies_reverse ON sa_task_dependencies(tenant_id,dependency_task_id,task_id);

DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['task_deliveries','task_reviews','coordinator_events'] LOOP
    EXECUTE format('CREATE TABLE sa_%I (tenant_id uuid NOT NULL,id uuid NOT NULL,data jsonb NOT NULL,version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id))',name);
    EXECUTE format('ALTER TABLE sa_%I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('ALTER TABLE sa_%I FORCE ROW LEVEL SECURITY',name);
    EXECUTE format('CREATE POLICY tenant_isolation ON sa_%I USING(tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',name);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON sa_%I TO super_agent_app',name);
    EXECUTE format('CREATE INDEX ON sa_%I(tenant_id,created_at,id)',name);
  END LOOP;
END $$;
ALTER TABLE sa_tasks ADD COLUMN parent_ref uuid GENERATED ALWAYS AS (NULLIF(data->>'parent_task_id','')::uuid) STORED;
ALTER TABLE sa_tasks ADD COLUMN root_ref uuid GENERATED ALWAYS AS (NULLIF(data->>'root_task_id','')::uuid) STORED;
ALTER TABLE sa_tasks ADD COLUMN plan_ref uuid GENERATED ALWAYS AS (NULLIF(data->>'plan_id','')::uuid) STORED;
ALTER TABLE sa_tasks ADD CONSTRAINT sa_tasks_parent_fk FOREIGN KEY(tenant_id,parent_ref) REFERENCES sa_tasks(tenant_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE sa_tasks ADD CONSTRAINT sa_tasks_root_fk FOREIGN KEY(tenant_id,root_ref) REFERENCES sa_tasks(tenant_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE sa_tasks ADD CONSTRAINT sa_tasks_plan_fk FOREIGN KEY(tenant_id,plan_ref) REFERENCES sa_plans(tenant_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX sa_tasks_plan_parent ON sa_tasks(tenant_id,plan_ref,parent_ref);
ALTER TABLE sa_task_deliveries ADD COLUMN task_ref uuid GENERATED ALWAYS AS ((data->>'task_id')::uuid) STORED;
ALTER TABLE sa_task_deliveries ADD COLUMN run_ref uuid GENERATED ALWAYS AS ((data->>'run_id')::uuid) STORED;
ALTER TABLE sa_task_deliveries ADD CONSTRAINT sa_delivery_task_fk FOREIGN KEY(tenant_id,task_ref) REFERENCES sa_tasks(tenant_id,id);
ALTER TABLE sa_task_deliveries ADD CONSTRAINT sa_delivery_run_fk FOREIGN KEY(tenant_id,run_ref) REFERENCES sa_runs(tenant_id,id);
CREATE UNIQUE INDEX sa_delivery_run ON sa_task_deliveries(tenant_id,run_ref);
ALTER TABLE sa_task_reviews ADD COLUMN delivery_ref uuid GENERATED ALWAYS AS ((data->>'delivery_id')::uuid) STORED;
ALTER TABLE sa_task_reviews ADD CONSTRAINT sa_review_delivery_fk FOREIGN KEY(tenant_id,delivery_ref) REFERENCES sa_task_deliveries(tenant_id,id);
CREATE UNIQUE INDEX sa_coordinator_event_key ON sa_coordinator_events(tenant_id,(data->>'event_key'));
CREATE UNIQUE INDEX sa_plan_source_event ON sa_plans(tenant_id,(data->>'source_event_id')) WHERE data->>'source_event_id' IS NOT NULL;
CREATE UNIQUE INDEX sa_message_source_event ON sa_messages(tenant_id,(data->>'source_event_id')) WHERE data->>'source_event_id' IS NOT NULL;
CREATE UNIQUE INDEX sa_usage_event_request ON sa_usage_records(tenant_id,(data->>'event_id'),(data->>'request_key')) WHERE data->>'event_id' IS NOT NULL;
DROP INDEX sa_usage_request;
CREATE UNIQUE INDEX sa_usage_request ON sa_usage_records(tenant_id,(COALESCE(data->>'event_id',data->>'run_id')),(data->>'request_key'));
