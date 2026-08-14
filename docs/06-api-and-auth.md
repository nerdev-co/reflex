# 06 — API & Auth

## Auth model (simple on purpose)

```
users     id, email UNIQUE, password_hash (argon2id), created_at
sessions  id, user_id, token_hash UNIQUE, expires_at, created_at
```

- **Passwords**: argon2id. No plaintext anywhere, no credentials in logs.
- **Sessions**: server-side rows + httpOnly `SameSite=Lax` cookie. Not JWT — revocation is `DELETE FROM sessions`, no refresh-token dance, one server doesn't need statelessness.
- **Login hardening**: rate-limit `/auth/login` (5/min/IP) and `/auth/register`.
- **Scoping**: every query carries `WHERE user_id = <session.user_id>`. Client-supplied ids are never trusted.

## Endpoints

### Auth

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/auth/register` | `{ email, password }` | |
| POST | `/auth/login` | `{ email, password }` | sets cookie |
| POST | `/auth/logout` | | revokes session |
| GET | `/auth/me` | | |

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
| POST | `/hooks/wh_{uuid}` | webhook entry |
| GET | `/hooks/wh_{uuid}` | handshake/ping |
| POST | `/hooks/form_{uuid}` | form-submit entry |

### Registry & credentials

| Method | Path | Notes |
|---|---|---|
| GET | `/triggers` | `[{ key, noun, type, inputFields, sample }]` — drives the builder UI |
| GET | `/actions` | `[{ key, noun, inputFields, sample, idempotentSafe }]` |
| GET | `/credentials` | saved connections |
| POST | `/credentials` | `{ actionKey, config }` |
| DELETE | `/credentials/:id` | |

## The pieces worth a second look

### Dry run — `POST /workflows/:id/test`

The differentiator "test without touching live data," as one endpoint: runs the DAG but stops at the boundary. The trigger resolves against the definition's `sample`, interpolation runs, configs validate — and `perform` receives `{ dryRun: true }`, returning a *predicted* output from `sample` instead of calling the API. (This is what Zapier's "test" button does — ours is free and explicit.)

### Webhook signature — the interesting auth

No session; the secret *is* the credential.

- On enable, server generates `wh_{uuid}` + a 32-byte secret, shown once.
- Caller signs the **raw body**: `X-Reflex-Signature: sha256=<HMAC(body, secret)>`.
- Server compares with `crypto.timingSafeEqual`, then enqueues.
- **Sign the raw body string, not parsed JSON** — re-serialization is the classic signature-bypass bug.
- `wh_{uuid}` is unguessable, so the URL itself is half the defense.

### Credentials encryption

Action tokens (Slack/Discord webhooks, SMTP passwords) are AES-GCM encrypted at rest; decrypted only in the worker at execution time; never included in traces. Worth one line in an interview: "encrypted at rest, decrypted at execution, never in the trace."

## Error handling conventions

- Errors are `{ error: { code, message } }` with HTTP status mapping (400 validation, 401 auth, 403 scoping, 404, 409 version conflict).
- Validation on the API boundary (zod), matching the old `primary-backend` convention.
- Run-scoped failures are **not** API errors — they're data: check the run's status and trace.

## Related

- [data-model](03-data-model.md) — the tables behind these endpoints.
- [decisions](07-decisions.md) — why sessions over JWT.