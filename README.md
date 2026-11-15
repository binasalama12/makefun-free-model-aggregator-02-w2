# Failover-First Aggregator

One small Node server that puts every free OpenRouter model behind a
single endpoint and answers on both client wires: OpenAI Chat Completions
(`POST /v1/chat/completions`) and Anthropic Messages
(`POST /v1/messages`), in plain JSON and in server-sent events. A client
asks for model `auto`; the server picks the strongest free model that can
actually serve the request, dials it through the gateway, and — when the
provider refuses — moves on to the next model instead of giving the
prompt up.

## Why "failover-first"

Free models refuse often: rate limits, upstream 5xx, dropped
connections. The design treats a refusal as routing information, not as
an answer:

- **Rating-first routing.** Candidates are ordered by the brief's
  published `rating_milli`, highest first, filtered by what the request
  really needs: declared tools require a tools-capable model, a JSON
  `response_format` requires a JSON-capable model, image blocks require
  a vision-capable model. Rating ties go to the model dialled fewest
  times so far, then to the model id, so ordering is fully
  deterministic.
- **Fixed per-model cooldowns.** Every refusal (429, 5xx, network
  error, unparseable body) benches that model for a fixed span counted
  in client requests — never in wall-clock seconds — so later prompts
  stop paying calls to a model that just refused, and a replay of the
  same trial walks the exact same path. One deliberate exception: a
  successful call is proof of recovery, so it clears the model's
  benching at once instead of letting a stale refusal outlive the
  recovery. If every capable model is benched, the full capable list
  is used again as a last resort rather than stranding the request.
- **A visible trail.** When a prompt is served after one or more
  refusals, the final response carries an
  `x-makefun-upstream-failures` header: a JSON array (max 8) of
  `{"status", "code", "model"}` rows in the order the calls refused.
- **Honest model fields.** Every response and every streamed chunk
  names the model that was actually dialled, on both wires, in JSON
  and in SSE. Anthropic requests are translated to Chat Completions
  for the gateway and translated back, with usage and stop reasons
  carried through.

## Layout

- `main.ts` — the thin server: brief loading, `--list`, listening,
  registration with the trial env, the three routes, the failover
  dial loop, and the 100 ms `/work` poll that exits 0 when the trial
  is done.
- `lib/brief.ts` — parses the trial brief and builds the catalog from
  it. Nothing about the model list is hardcoded.
- `lib/router.ts` — reads a request's needs and produces the ordered
  candidate list.
- `lib/cooldown.ts` — the fixed-span cooldown ledger plus per-model
  dial counts.
- `lib/wire.ts` — both model-list shapes, Anthropic ↔ OpenAI
  translation, SSE relay and conversion, and the failover-trail
  error-code extraction.

## Running

The server runs on Node 22+ with the standard library only:

```
MAKEFUN_PROMPT_FILE=<brief> node main.ts --list   # print the catalog
MAKEFUN_PROMPT_FILE=<brief> MAKEFUN_ENV_URL=<env> \
  OPENAI_BASE_URL=<gateway> OPENAI_API_KEY=<trial key> node main.ts
```

`--list` prints exactly the catalog document the server registers with
the env (`POST $MAKEFUN_ENV_URL/register`), byte for byte: one
`openrouter` provider whose models are precisely the free models the
brief lists. The server listens on `0.0.0.0` at an OS-assigned port
(never 8080) and polls `GET $MAKEFUN_ENV_URL/work` every 100 ms,
exiting 0 as soon as the env reports the trial done.

## License

MIT — see `LICENSE`.
