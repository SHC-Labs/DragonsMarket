-- Deployment identities are append-only. Workers need no UPDATE privilege to lock this table.
CREATE FUNCTION refuse_deployment_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Deployment identity is immutable; register a new deployment'; END $$;
CREATE TRIGGER deployments_immutable BEFORE UPDATE OR DELETE ON deployments FOR EACH ROW EXECUTE FUNCTION refuse_deployment_change();
