# Rate limiting — full

## Overview
Rate limiting controls how many requests a client may make to a service in a given window of time, protecting a backend from overload, abuse, and runaway costs, and keeping one noisy client from degrading service for everyone else [S1]. Without a limit, a single client can exhaust capacity, so limits are stated as requests per second, minute, or hour [S1].

## Algorithms
The token bucket refills tokens at a steady rate and spends one per request, allowing bursts up to the bucket size [S2]. The leaky bucket drains queued requests at a constant rate to smooth bursts [S2]. Fixed-window counting is the simplest scheme, and sliding windows reduce the boundary spike between windows [S2].

## Signalling over HTTP
When a client exceeds the limit the server responds with HTTP 429 Too Many Requests, and a `Retry-After` header tells the client how long to wait before retrying; well-behaved clients back off exponentially after a 429 [S3].

## Open questions / contradictions
> [model-hint] This dossier does not cover distributed rate limiting (coordinating limits across many servers) or concrete per-vendor limits. Enrich with primary sources before relying on those.

## Sources
See the appendix.
