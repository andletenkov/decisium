# Network replay

`@replay-network:<glob>` records the browser's requests that match the glob and replays them on later runs. Use it to
make tests independent of a slow, costly or unstable backend, for example an app that calls an LLM.

```gherkin
@replay-network:**/api/**
Scenario: The assistant answers
  When I ask the assistant "What is my balance?"
  Then the answer should mention "balance"
```

It follows `--record`, like the [cassette](record-replay.md):

| `--record` | Network |
|---|---|
| `new` (default) | Replay the recording; record it if there is none. |
| `none` | Replay only. |
| `all` | Record again. |

The recording is `<feature>.network/<scenario>.har` next to the feature (response bodies in files beside it). Commit it
with the cassette.

**Matching:** a request is matched by method, URL and how many times that URL was called before, not by its body, so
requests with timestamps or ids in them still replay. A matching request that is not in the recording fails the Step
with "network not in recording" and is never sent to the real backend. Re-record with `--record all`.

**Limits:**
- A streamed response (server-sent events) replays in one piece, so streamed text appears at once.
- WebSockets are not recorded.
- Only the browser's requests are recorded; requests your backend makes to other services are not.
