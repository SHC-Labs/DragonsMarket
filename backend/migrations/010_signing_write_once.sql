-- A signature, once stored, is the publisher's word for that round. Nothing may change or remove it, so no service with a
-- database login (and no bug in one) can make the publisher sign a second price for the same moment.
CREATE OR REPLACE FUNCTION refuse_signed_decision_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.signature IS NOT NULL THEN RAISE EXCEPTION 'A signed decision cannot be changed or removed'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS signing_decisions_write_once ON signing_decisions;
CREATE TRIGGER signing_decisions_write_once BEFORE UPDATE OR DELETE ON signing_decisions FOR EACH ROW EXECUTE FUNCTION refuse_signed_decision_change();
CREATE INDEX IF NOT EXISTS signing_decisions_boundary ON signing_decisions (deployment_id, boundary_key);
