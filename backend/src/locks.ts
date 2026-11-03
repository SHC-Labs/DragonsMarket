/** Advisory lock classes. Each is taken together with a hash of the deployment id (or the exporter's destination), so one lock never blocks another deployment. */
export const LOCK = { migrate: 704346941, ingest: 704346942, follow: 704346943, feed: 704346944, wallet: 704346945, agents: 704346946 } as const;
