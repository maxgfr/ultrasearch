# Rate limiting

## TL;DR
Rate limiting controls request volume per client over time to protect a service [S1].

## What it is
Rate limiting restricts how many requests a client may make in a given window, so one noisy client (or a bug or an attack) cannot exhaust a service's capacity [S1].

## How it works / key concepts
Limits are expressed as a request count per second, minute, or hour [S1]. The most common enforcement is the token bucket, which refills tokens at a steady rate and lets a client burst up to the bucket size [S2]. The leaky bucket instead drains queued requests at a constant rate, smoothing bursts into a steady stream [S2]. Fixed-window counters are simplest, while sliding windows smooth the boundary effect [S2].

## Current state (today)
Over HTTP, an exceeded limit returns status 429 Too Many Requests, usually with a `Retry-After` header telling the client how long to wait; well-behaved clients then back off exponentially [S3].

> [model-hint] In practice the token bucket is the most common choice in production API gateways, though the sources in this dossier do not rank the algorithms by adoption.

## Open questions / contradictions
> [model-hint] This dossier does not cover distributed rate limiting (coordinating limits across many servers) or concrete per-vendor limits. Enrich with primary sources before relying on those.

## Sources
See the appendix.
