# Product analytics

The server owns analytics delivery, the opt-in, and identity for every connected client. Clients never
load the PostHog browser SDK, PostHog person profiles stay disabled, and visiting hosted web without
an authenticated connection does not count as product use.

## Identity

- **Count installs with `installId`.** A stable hash of the random anonymous ID identifies the
  install. `distinct_id` and the OpenAI, Claude, and device owner IDs use HMAC with a key stored
  in that install's secret store. This changes the previous account-level `distinct_id` series.
- **Only T3 Connect hashes correlate across installs.** The server accepts only hashes from
  clients. It applies the install-local HMAC before any non-Connect identifier reaches ingest.

## Attribution boundaries

- Client dimensions (`surface`, etc.) belong to the event's WebSocket connection, never a
  server-global "current client". Keep client and server dimensions separate, and leave missing
  client metadata unknown rather than backfilling from server properties.
- Active-use reports count `client.turn.requested` (deduplicated by command ID), not connections
  (T3 Connect sessions renew hourly).

## Collection boundary and delivery

- Payloads stay strictly to product metadata, closed contract enums, and normalized measurements:
  never attach prompts, file paths, credentials, raw provider payloads, device names, conversation
  IDs, user-named provider instance IDs, or non-vendor/custom model names.
- For `agent.feedback`, automatic reports send structured metadata only. User-approved reports
  can include scrubbed text and bounded conversation traces shown in the approval card.
- Delivery attaches a UUID per event, limits retries, and drops both buffered events and failed
  batches when product usage data is switched off. The server defaults to off. Managed policy
  can forbid telemetry, and an explicit `T3CODE_TELEMETRY_ENABLED` overrides the server setting
  when policy permits it. Development and CI runs stay off unless explicitly enabled.
