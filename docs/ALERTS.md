# Resource alerts and delivery check

On 7 November the production dashboard had 12 widgets and zero monitors. The Railway API exposes monitor reads but no monitor creation mutation in the available schema; browser access from the engineering session is unavailable. These remain pending UI actions, not enabled alerts.

Open [dragons-market](https://railway.com/project/489b02ad-fd74-4413-ab91-835da8b86542), select **production**, then **Observability**. On each named chart, open **... > Add monitor**. Use an above-threshold condition and the values below. These are absolute usage values, not a percentage of the whole Pro plan.

| Chart | Above | Meaning |
| --- | --- | --- |
| web CPU | 0.4 vCPU | 80% of 0.5 vCPU ceiling |
| web memory | 0.4 GB | 80% of 0.5 GB ceiling |
| server CPU | 0.8 vCPU | 80% of 1 vCPU ceiling |
| server memory | 0.4 GB | 80% of 0.5 GB ceiling |
| mcp CPU | 0.4 vCPU | 80% of 0.5 vCPU ceiling |
| mcp memory | 0.4 GB | 80% of 0.5 GB ceiling |
| Postgres CPU | 0.8 vCPU | 80% of 1 vCPU ceiling |
| Postgres memory | 0.8 GB | 80% of 1 GB ceiling |
| Postgres disk warning | 3.5 GB | 70% of 5 GB volume |
| Postgres disk urgent | 4.25 GB | 85% of 5 GB volume |

For CPU/memory, prefer a five-minute sustained window if the UI offers one; record the actual supported aggregation/window. For disk, use the shortest supported evaluation window. If one chart permits only one monitor, duplicate the disk widget for the second threshold. Do not put a raw `80` into a chart measured in vCPU or GB. Adjust the table when service ceilings or volume capacity change.

Select only the currently attached Postgres volume in the disk widgets. After the 7 November restore, the disk widget was narrowed to restored volume `d1e7bf1c-325c-4bc9-99d0-8342956f64f9`; the retained original is excluded. All 12 widget configurations were verified and monitor count remains zero. Recheck this filter after every restore. Record the selected volume ID, monitor IDs, condition, value, window and enabled state in the private incident record.

Railway sends monitor events through email and in-app notifications. Confirm the intended owner receives them and check notification preferences; do not assume all project members have identical delivery settings. If adding a webhook later, store its secret in Railway and authenticate requests at the receiver. [Railway monitor controls](https://docs.railway.com/observability#monitors).

## Delivery exercise without stressing production

1. Agree a short test period with the recipient. Record the original monitor settings.
2. Use a dedicated, clearly named temporary memory monitor with a threshold below the service's current steady usage. This tests the real threshold path without generating load, filling disk or crashing a service. Record the test monitor's ID and start time.
3. Wait through the configured evaluation window. Require an in-app event and the expected email. Record event time, receipt time, recipient confirmation and delivery delay. An API event is not proof of email receipt.
4. Disable or remove only the temporary test monitor. Confirm the production thresholds are unchanged and the temporary condition no longer alerts.
5. If no notification arrives, leave delivery status unverified, inspect notification settings and the monitor's alert history, and escalate the delivery issue. Do not repeatedly trigger alerts or reduce production thresholds indefinitely.

The test is complete only when an operator confirms receipt and the temporary monitor is cleaned up. Do not post webhook URLs, recipient addresses or notification contents in public CI logs.

## Separate application and backup coverage

Resource alerts do not prove that sessions, RPCs or database queries work. After the reviewed release, run **Production smoke** manually, confirm failed-workflow notification preferences, then enable `PRODUCTION_MONITOR_ENABLED=true`. Its scheduled checks use no deployment token. Keep the existing false value until the required MCP readiness route is deployed.

For an activated market, service health now reads the keeper's database status. `keeper_stale` means no current successful pass within 15 minutes (or a missing/future timestamp); `keeper_signing_disabled` distinguishes preparation/checking from signing; `keeper_failed` and `keeper_feed_stale` expose failed or lagging passes. The operator endpoint includes the detailed record, while the public endpoint only reports degraded. Prove the failure and recovery notification path after deploying the keeper; unit/database tests do not prove notification delivery. Production smoke defaults to the foundation profile. After the [activated release](ACTIVATED-RELEASE.md), set its public `SMOKE_DEPLOYMENT_JSON` repository variable from the successful job summary. It then requires the exact deployed browser commit/configuration, registered manifest and selected agent capability. Run it manually and prove delivery before resuming its schedule. No signing or deployment credential is needed for monitoring.

Run the protected **Backup audit** after backup changes and between releases. It is manual; neither resource alerts nor the HTTP smoke workflow detects a missing daily backup. Offsite backup freshness needs a separate receiver that expects a successful upload at least every 36 hours. Configure and exercise that receiver when the offsite job is enabled.
