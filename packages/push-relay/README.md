# phren push relay

Apple delivers notifications to the App Store build of phren only when they
are signed with the app developer's APNs key. This relay holds that key so
every user's Hook can notify their phone with nothing to set up.

It keeps no state and can't read notifications:

- A phone registers its APNs device token once (`POST /v1/register`) and gets
  a relay id and a send secret. The relay id is the token encrypted with the
  relay's own key; the secret is derived from the id. Nothing is stored.
- A Hook sends `POST /v1/send` with the headers `x-phren-relay`,
  `x-phren-timestamp` (Unix seconds) and `x-phren-signature`
  (base64url HMAC-SHA256 of `${timestamp}.${body}` under the secret) and the
  body `{"kind":"alert","ciphertext":"…","collapseId":"…","expiration":0}`.
- The ciphertext is encrypted by the Hook with a key only it and the phone
  share. Apple receives a generic "phren · New activity" alert plus the
  ciphertext, and the phone's notification extension decrypts it.
- Requests older than five minutes, replays, bad signatures and more than 60
  sends a minute per phone are refused. A `410` means Apple no longer knows
  the phone; the Hook stops and the phone registers again.

## Running it

```sh
pnpm --filter @phren/push-relay build
PHREN_RELAY_SECRET=$(openssl rand -hex 32) APNS_KEY_FILE=AuthKey_XXXXXXXXXX.p8 \
  APNS_KEY_ID=XXXXXXXXXX APNS_TEAM_ID=XXXXXXXXXX APNS_TOPIC=com.phren.ios \
  node dist/server.js
```

On Cloud Run: `deploy/cloud-run.sh <project> <AuthKey.p8> <key-id> <team-id>`
builds from the Dockerfile and deploys to two regions, each capped at one
instance, with the relay secret and the APNs key in Secret Manager. Set a
budget alert on the billing account.

On a host of your own it listens on 127.0.0.1:8787 behind a TLS proxy. `deploy/` has a systemd
unit, a Caddy site (Caddy fetches its own certificate) and an nginx block for
a host that already runs nginx. Point a DNS A record for the relay's name at
the host. Keep `PHREN_RELAY_SECRET` safe: it is the relay's only state, and a
new one means every phone registers again. Moving hosts is copying it and the
`.p8`, then changing the DNS record.
