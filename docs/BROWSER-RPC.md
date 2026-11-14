# Browser chain reads

Set the web build's `NEXT_PUBLIC_RPC_URL` to `https://api.dragons.market/v1/rpc`.
Deploy the API before rebuilding the website. The API uses its existing `RPC_URL`
and `RPC_PRIMARY_BEARER_TOKEN` for the primary provider. Keep that token on the
API service; no browser variable contains a credential.

On mainnet, failed reads fall back to FastNEAR, dRPC, Intear, Shitzu and ZAN in
that order. Providers that time out, rate limit or return invalid responses are
skipped for 15 seconds. Concurrent identical reads share one request, with a
one-second view cache and a one-minute finalized transaction cache.

The route accepts finalized account and contract views, finalized blocks,
status, and transaction status only. Wallet signing and transaction submission
stay in the connected wallet. Requests require the configured `WEB_ORIGIN`;
body, response, concurrency and per-client limits are enforced separately from
the other API routes. A provider failure leaves a saved wallet request pending.
Reloading checks its exact transaction and complete receipt graph before
clearing the saved request, without sending another transaction.

This route does not depend on indexer catch-up. It does not enable agents,
the EVM relay, or keeper signing.
