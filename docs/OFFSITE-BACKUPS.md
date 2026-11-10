# Encrypted offsite recovery

Status: encrypted archive creation and local recovery are tested. Storage account, bucket, recovery custodians, upload credential and missing-backup notifications are not configured. No offsite backup has been uploaded. The proposed initial destination is a separate Backblaze B2 account; an existing independent S3 account is also suitable.

## Small initial deployment

Use one daily, exit-after-completion backup job with private access to Postgres. Do not put backup credentials in web, API, MCP or GitHub's unprotected scheduled workflows. It needs PostgreSQL 18 clients, `age`, the upload client and the reviewed backup script. No always-running backup server is required. Pin and scan the chosen job image before deployment; the current Distroless application images intentionally contain neither backup clients nor a shell.

Give the job a dedicated restricted login that belongs only to `dm_backup`, with no superuser, database/role creation, replication or row-security bypass. The role template grants read access to current and future public tables and sequences. Sequence access is `SELECT`, not `USAGE`: the backup can preserve counters but cannot advance them. The integration test now dumps using this restricted login and confirms writes and `nextval` are refused. Provision its credential only when the job is being enabled; the public services never receive it.

Start with one daily archive, 30 days of protected object retention and expiry after 35 days. These are proposed settings requiring owner selection, not current guarantees. If an encrypted archive is `B` GB, 35 daily copies require roughly `35 * B` GB before versioning overhead. Measure the actual encrypted size and include upload egress when estimating cost. Large databases need a revised retention and recovery-time plan; do not assume today's small foundation size persists.

## Separate encryption from storage access

Each approved recovery custodian generates a dedicated `age` identity on their secure workstation and keeps the private identity in their encrypted recovery storage. The backup job receives only public recipient keys. Any one listed recipient can decrypt; this is redundant recovery custody, not a two-person approval scheme. Test recovery using each custodian's key before relying on it. Never place private identities in Railway, Git, CI artifacts, chat or the upload account. [age recipient model](https://github.com/FiloSottile/age).

The uploader gets a bucket/prefix-scoped write credential. It must not read old backups, delete objects, bypass retention, change retention settings or administer the storage account. A separate recovery operator receives read access. Use MFA for the storage account owner and preserve recovery codes independently of Railway. Keep older private identities until every archive encrypted to them has expired; adding a new recipient does not make old archives decryptable by it.

For B2, create a private bucket with Object Lock and a default retention rule, then create an application key limited to that bucket and backup prefix with only the upload capabilities its client needs. Do not grant `deleteFiles`, retention-management or governance-bypass capabilities. The owner must verify that the chosen client's listing needs do not broaden data access. Test retention with a disposable object before uploading a database. [B2 Object Lock](https://www.backblaze.com/docs/cloud-storage-object-lock), [application-key capabilities](https://www.backblaze.com/docs/cloud-storage-application-key-capabilities).

For S3, use a separate account/bucket with public access blocked, versioning and default Object Lock retention. Allow upload only to the backup prefix and keep delete, retention changes and governance bypass outside the uploader's permissions. Governance retention protects against the restricted uploader; an authorized storage administrator can override it. Compliance retention is stronger but can prevent even an administrator from deleting data until expiry; choose that deliberately before enabling it. [S3 retention modes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html).

## Archive creation

After securely injecting the dedicated PostgreSQL connection and the approved public recipient file:

```sh
BACKUP_AGE_RECIPIENTS_FILE=/run/backup/recipients.txt \
  BACKUP_DIR=/run/backup/encrypted BACKUP_KEEP=2 \
  bash backend/scripts/backup.sh --encrypt
```

`PGHOST`, `PGPORT`, `PGDATABASE` and `PGUSER` are required. Use a protected PostgreSQL password file or the job's secret environment for authentication. Do not put a password in the command line. Use an absolute recipients path; the script runs from the backend directory.

The script streams `pg_dump` directly into `age`; plaintext is not staged on disk. It publishes a unique `.dump.age` file and a SHA-256 sidecar only when the pipeline succeeds. Both files are owner-only. A failed dump/encryption removes temporary output and does not prune older backups. Encrypted and plaintext archives have separate retention patterns; use a separate directory for this job. `--encrypt` fails if the recipient file is absent, rather than falling back to plaintext.

Upload the archive and checksum under a unique dated object key. Treat upload success, archive verification and retention verification as separate checks. The storage operator must verify the object exists with the intended protected-until date and that the uploader cannot remove a disposable protected object. A checksum beside a file detects accidental transfer damage; it is not an independent signature if the storage account itself is compromised. Encryption protects the archive contents, but does not certify that a compromised database exported correct data.

Send a success signal only after the upload has completed. A separate freshness check must alert the owner if no successful backup arrives within 36 hours. Exercise both upload failure and missing-success alerts, and record actual notification receipt. A cron job's exit status is not proof that anyone was notified.

## Recovery acceptance

1. From a clean, isolated recovery environment, retrieve a specific retained archive and checksum using the separate recovery identity. Confirm the snapshot timestamp meets the incident's allowed data-loss window.
2. Verify the ciphertext checksum. Decrypt using a custodian's private identity on encrypted storage. A wrong key or modified ciphertext must fail. An encrypted dump cannot be listed by `pg_restore` at the writer without a private key; the separate recovery exercise verifies its contents.
3. Restore into a fresh PostgreSQL 18 database. Apply the reviewed migration/role release to restore grants and new service passwords. Compare data/schema evidence and restricted access with the expected snapshot state, using the [restore procedure](RESTORE.md). Do not compare an old daily dump with the current live database and call the difference corruption.
4. Verify all required secrets separately. Database dumps do not contain the `AGENT_GRANT_KEY` needed to decrypt sealed agent grants, publisher/keeper signing keys, Railway/GitHub credentials or external API keys. Maintain encrypted recovery copies of irreplaceable keys under their own custody policy; rotate replaceable credentials after an incident. Do not enable agent recovery without resolving the matching grant key.
5. Record archive age, actual recovery time, data/permission checks and each custodian's successful recovery. Securely remove temporary plaintext and test credentials. Repeat after schema/client/encryption changes and periodically during operation.

CI uses synthetic PostgreSQL data and disposable identities. It verifies both intended recipients, wrong-key rejection, ciphertext-tamper rejection, restricted-role dumps and a full restore comparison. It performs no cloud upload and proves neither bucket retention nor remote delivery. Keep those production acceptance items pending until exercised.
