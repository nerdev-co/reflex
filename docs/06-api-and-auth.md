# 06 — API & Auth

## Auth model

```
users           id, email UNIQUE, password_hash (argon2id), name, verified_at,
                otp_hash, otp_expires_at (10 min)     — email OTP forgot flow
sessions        id, user_id, token_hash UNIQUE, expires_at (30 d) — cookie fallback
refresh_tokens  id, user_id, token_hash UNIQUE, expires_at (7 d), revoked_at
```

- **Passwords**: argon2id. No plaintext anywhere, no credentials in logs.
- **Access tokens** (bearer-first): stateless HMAC-SHA256 envelopes (`payload.hmac`,
  base64url parts, 15 min, purpose claim `access`). Zero-dependency — no JWT lib.
  Verification is constant-time: signature, purpose, *and* expiry.
- **Refresh tokens**: random, DB stores only a sha256 hash, **single-use with
  rotation** — every `/auth/refresh` revokes the old token and issues a new pair,
  so a leaked token is one-shot and rotation is observable. Password reset and
  logout revoke every outstanding refresh token and session.
- **Sessions**: httpOnly `SameSite=Lax` cookie retained as the browser fallback —
  the web app never touches localStorage, and bearer + cookie both resolve
  (`Bearer` header wins).
- **Email OTP** (forgot password): 6-digit code, hashed at rest, 10-min window,
  single-use (cleared on success). Rate-limit `/auth/login` (5/min/IP) and
  `/auth/register`.
- **Scoping**: every query carries `WHERE user_id = <resolved user>`. Client-supplied
  ids are never trusted.

## Endpoints

### Auth

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/auth/register` | `{ email, password, name? }` | sets cookie **and** returns `tokens` |
| POST | `/auth/login` | `{ email, password }` | sets cookie + returns `tokens` |
| POST | `/auth/logout` | `{ refreshToken? }` | revokes session + refresh tokens |
| POST | `/auth/refresh` | `{ refreshToken }` | **rotation** — old token dies |
| GET | `/auth/me` | | bearer-first, cookie fallback |
| POST | `/auth/forgot` | `{ email }` | mails a 6-digit OTP; never leaks whether the email is registered; returns `devOtp` on the log driver outside production (the e2e seam) |
| POST | `/auth/validate` | `{ email, code }` | exchanges the OTP for a 10-min `resetToken` |
| POST | `/auth/reset` | `{ resetToken, password }` | new hash + revokes every session/refresh token |

`tokens = { accessToken, refreshToken, accessTokenExpiresIn }`.

### Workflows

| Method | Path | Notes |
|---|---|---|
| GET | `/workflows` | list + run counts + status |
| POST | `/workflows` | `{ name, trigger, steps[] }` |
| GET | `/workflows/:id` | |
| PATCH | `/workflows/:id` | edit → **bumps version** |
| DELETE | `/workflows/:id` | |
| POST | `/workflows/:id/enable` · `/disable` | enable → generate `wh_{uuid}` + secret |
| POST | `/workflows/:id/test` | **dry run** — see below |

### Runs

| Method | Path | Notes |
|---|---|---|
| GET | `/runs` | `?workflow=&status=&page=` paginated list |
| GET | `/runs/:id` | the full trace contract (see [observability](05-observability-and-replay.md)) |
| POST | `/runs/:id/replay` | full replay |
| POST | `/runs/:id/replay-from-step` | `{ stepId }` |

### Hooks (public — authenticated by signature, not session)

| Method | Path | Notes |
|---|---|---|
| POST | `/hooks/wh_{uuid}` | webhook entry — HMAC-signed (`x-reflex-signature`) |
| GET | `/hooks/wh_{uuid}` | handshake/ping |
| POST | `/hooks/form_{uuid}` | form-submit entry — `application/x-www-form-urlencoded` parsed into a flat fields payload; **no HMAC** (HTML forms can't sign — the unguessable path is the credential) |
| GET | `/hooks/form_{uuid}` | renders a sample HTML form for manual testing |

### Registry & credentials

| Method | Path | Notes |
|---|---|---|
| GET | `/triggers` | `[{ key, noun, type, inputFields, sample }]` — drives the builder UI |
| GET | `/actions` | `[{ key, noun, inputFields, sample, idempotentSafe, credentialField }]` |
| GET | `/credentials` | saved connections — **never returns config or the encrypted blob** |
| POST | `/credentials` | `{ actionKey, label, config }` — config is AES-GCM encrypted at rest |
| DELETE | `/credentials/:id` | |

## The pieces worth a second look

### Dry run — `POST /workflows/:id/test`

The differentiator "test without touching live data," as one endpoint: runs the DAG but stops at the boundary. The trigger resolves against the definition's `sample`, interpolation runs, configs validate — and `perform` receives `{ dryRun: true }`, returning a *predicted* output from `sample` instead of calling the API. (This is what Zapier's "test" button does — ours is free and explicit.)

### Webhook signature — the interesting auth

No session; the secret *is* the credential.

- On enable, server generates `wh_{uuid}` + a 32-byte secret, shown once.
- Caller signs the **raw body**: `X-Reflex-Signature: sha256=<HMAC(body, secret)>`.
- Server compares with `crypto.timingSafeEqual`, then creates the run + outbox
  row in ONE transaction (the poller delivers it to the queue — docs/02).
- **Sign the raw body string, not parsed JSON** — re-serialization is the classic signature-bypass bug.
- `wh_{uuid}` is unguessable, so the URL itself is half the defense.

### Credentials vault

Action tokens (Slack webhooks, SMTP passwords) are AES-GCM encrypted at rest (`packages/credentials`, key from `CREDENTIALS_KEY`). The API stores the encrypted blob and never decrypts; the worker decrypts at execution time and hands the plaintext to the action as `auth` (scoped to the run's workflow owner). The trace shows the `credentialId` (linkage) but never the plaintext.

The builder renders a credential picker via `FieldType: "credential"` + the action's `credentialField`; `email.send` and `slack.message` are the first credential-backed actions. Missing/unknown credentials fail honestly: `validation` classification, no retry, one attempt, visible in the trace.

### Mailer

`packages/mailer` is one seam, two drivers: **smtp** (nodemailer — env config for OTP, per-credential config for `email.send`) and **log** (default: appends JSON lines to `MAIL_LOG_PATH`). On the log driver outside production, `/auth/forgot` echoes the code as `devOtp` — the seam the e2e suite proves the whole flow through. SMTP never echoes.

## Error handling conventions

- Errors are `{ error: { code, message } }` with HTTP status mapping (400 validation, 401 auth, 403 scoping, 404, 409 version conflict).
- Validation on the API boundary (zod), matching the old `primary-backend` convention.
- Run-scoped failures are **not** API errors — they're data: check the run's status and trace.

## Related

- [data-model](03-data-model.md) — the tables behind these endpoints.
- [decisions](07-decisions.md) — why sessions over JWT.