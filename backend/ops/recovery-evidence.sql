\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '60s';
SET LOCAL transaction_timeout = '120s';
SET LOCAL lock_timeout = '3s';
SET LOCAL work_mem = '8MB';
SET LOCAL search_path = public, pg_catalog;
SET LOCAL timezone = 'UTC';
SET LOCAL datestyle = 'ISO, YMD';
SET LOCAL extra_float_digits = 3;

SELECT json_build_object('kind','identity','format',3,'database',current_database(),
  'version',current_setting('server_version_num'),'readOnly',current_setting('transaction_read_only'),
  'tables',(SELECT count(*) FROM pg_tables WHERE schemaname='public'),
  'sequences',(SELECT count(*) FROM pg_sequences WHERE schemaname='public'));

SELECT format($query$
  SELECT json_build_object('kind','table','name',%L,'rows',count(*),
    'sha256',encode(sha256(convert_to(coalesce(string_agg(digest,'' ORDER BY digest COLLATE "C"),''),
      'UTF8')),'hex'),'complete',count(*) <= 100000)
  FROM (SELECT encode(sha256(convert_to(row_to_json(t)::text,'UTF8')),'hex') AS digest
    FROM %I.%I t LIMIT 100001) evidence;
  $query$, tablename, schemaname, tablename)
FROM pg_tables WHERE schemaname='public' ORDER BY tablename COLLATE "C"
\gexec

SELECT format($query$
  SELECT json_build_object('kind','sequence','name',%L,'lastValue',last_value::text,
    'isCalled',is_called) FROM %I.%I;
  $query$, sequencename, schemaname, sequencename)
FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename COLLATE "C"
\gexec

WITH entries AS (
  SELECT 'columns' AS section, row_to_json(t)::text AS value FROM (
    SELECT table_name,column_name,ordinal_position,column_default,is_nullable,data_type,
      udt_schema,udt_name,character_maximum_length,numeric_precision,numeric_scale,
      is_identity,identity_generation,is_generated,generation_expression,collation_name,
      ARRAY(SELECT acl::text FROM unnest(a.attacl) acl ORDER BY acl::text COLLATE "C") AS acl
    FROM information_schema.columns c JOIN pg_attribute a
      ON a.attrelid=format('%I.%I',c.table_schema,c.table_name)::regclass AND a.attname=c.column_name
    WHERE table_schema='public') t
  UNION ALL
  SELECT 'indexes',row_to_json(t)::text FROM (
    SELECT c.relname,pg_get_indexdef(i.indexrelid) AS definition,i.indisvalid,i.indisready
    FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid
    WHERE c.relnamespace='public'::regnamespace) t
  UNION ALL
  SELECT 'constraints',row_to_json(t)::text FROM (
    SELECT conrelid::regclass::text AS relation,conname,pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE connamespace='public'::regnamespace) t
  UNION ALL
  SELECT 'functions',row_to_json(t)::text FROM (
    SELECT pg_get_functiondef(oid) AS definition,pg_get_userbyid(proowner) AS owner,prosecdef,proconfig,
      ARRAY(SELECT acl::text FROM unnest(proacl) acl ORDER BY acl::text COLLATE "C") AS acl
    FROM pg_proc WHERE pronamespace='public'::regnamespace AND prokind IN ('f','p')) t
  UNION ALL
  SELECT 'triggers',row_to_json(t)::text FROM (
    SELECT pg_get_triggerdef(t.oid) AS definition,t.tgenabled
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    WHERE c.relnamespace='public'::regnamespace AND NOT t.tgisinternal) t
  UNION ALL
  SELECT 'relations',row_to_json(t)::text FROM (
    SELECT relname,relkind,pg_get_userbyid(relowner) AS owner,
      ARRAY(SELECT acl::text FROM unnest(relacl) acl ORDER BY acl::text COLLATE "C") AS acl,
      relrowsecurity,relforcerowsecurity,reloptions,
      CASE WHEN relkind IN ('v','m') THEN pg_get_viewdef(oid) END AS view_definition
    FROM pg_class WHERE relnamespace='public'::regnamespace) t
  UNION ALL
  SELECT 'sequence_definitions',row_to_json(t)::text FROM (
    SELECT c.relname,format_type(s.seqtypid,NULL) AS type,
      s.seqstart::text,s.seqincrement::text,s.seqmin::text,s.seqmax::text,s.seqcache::text,s.seqcycle,
      n.nspname AS owned_schema,o.relname AS owned_table,a.attname AS owned_column,d.deptype
    FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid
    LEFT JOIN pg_depend d ON d.classid='pg_class'::regclass AND d.objid=s.seqrelid
      AND d.refclassid='pg_class'::regclass AND d.deptype IN ('a','i')
    LEFT JOIN pg_class o ON o.oid=d.refobjid
    LEFT JOIN pg_namespace n ON n.oid=o.relnamespace
    LEFT JOIN pg_attribute a ON a.attrelid=d.refobjid AND a.attnum=d.refobjsubid
    WHERE c.relnamespace='public'::regnamespace) t
  UNION ALL
  SELECT 'schema',row_to_json(t)::text FROM (
    SELECT nspname,pg_get_userbyid(nspowner) AS owner,
      ARRAY(SELECT acl::text FROM unnest(nspacl) acl ORDER BY acl::text COLLATE "C") AS acl
    FROM pg_namespace WHERE nspname='public') t
  UNION ALL
  SELECT 'roles',row_to_json(t)::text FROM (
    SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,
      rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil,rolconfig
    FROM pg_roles WHERE starts_with(rolname,'dm_')) t
  UNION ALL
  SELECT 'memberships',row_to_json(t)::text FROM (
    SELECT parent.rolname AS parent,member.rolname AS member,grantor.rolname AS grantor,
      m.admin_option,m.inherit_option,m.set_option
    FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid
    JOIN pg_roles member ON member.oid=m.member JOIN pg_roles grantor ON grantor.oid=m.grantor
    WHERE starts_with(parent.rolname,'dm_') OR starts_with(member.rolname,'dm_')) t
  UNION ALL
  SELECT 'defaults',row_to_json(t)::text FROM (
    SELECT pg_get_userbyid(defaclrole) AS owner,defaclobjtype,n.nspname AS schema,
      ARRAY(SELECT acl::text FROM unnest(defaclacl) acl ORDER BY acl::text COLLATE "C") AS acl
    FROM pg_default_acl LEFT JOIN pg_namespace n ON n.oid=defaclnamespace
    WHERE defaclnamespace IN (0,'public'::regnamespace)) t
  UNION ALL
  SELECT 'policies',row_to_json(t)::text FROM (
    SELECT tablename,policyname,permissive,cmd,qual,with_check,
      ARRAY(SELECT role::text FROM unnest(roles) role ORDER BY role::text COLLATE "C") AS roles
    FROM pg_policies WHERE schemaname='public') t
  UNION ALL
  SELECT 'role_settings',row_to_json(t)::text FROM (
    SELECT setdatabase<>0 AS database_specific,coalesce(r.rolname,'PUBLIC') AS role,
      ARRAY(SELECT setting FROM unnest(setconfig) setting ORDER BY setting COLLATE "C") AS settings
    FROM pg_db_role_setting s LEFT JOIN pg_roles r ON r.oid=s.setrole
    WHERE setdatabase IN (0,(SELECT oid FROM pg_database WHERE datname=current_database()))
      AND (setrole=0 OR starts_with(r.rolname,'dm_') OR r.rolname=current_user)) t
  UNION ALL
  SELECT 'database',row_to_json(t)::text FROM (
    SELECT pg_get_userbyid(datdba) AS owner,encoding,datlocprovider,datcollate,datctype,
      datlocale,datcollversion,
      ARRAY(SELECT acl::text FROM unnest(datacl) acl ORDER BY acl::text COLLATE "C") AS acl
    FROM pg_database WHERE datname=current_database()) t
), sections(section) AS (
  VALUES ('columns'),('indexes'),('constraints'),('functions'),('triggers'),('relations'),
    ('sequence_definitions'),('schema'),('roles'),('memberships'),('defaults'),('policies'),
    ('role_settings'),('database')
)
SELECT json_build_object('kind','catalog','name',section,'entries',count(value),
  'sha256',encode(sha256(convert_to(
    coalesce(string_agg(value,E'\n' ORDER BY value COLLATE "C"),''),'UTF8')),'hex'))
FROM sections LEFT JOIN entries USING (section) GROUP BY section ORDER BY section COLLATE "C";

SELECT json_build_object('kind','complete','format',3);
ROLLBACK;
