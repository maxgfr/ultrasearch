# Rate limiting

## TL;DR
Rate limiting caps how many requests a client may make to a service in a window of time, protecting the backend from overload and abuse [S1]. Common algorithms are the token bucket, leaky bucket, and fixed/sliding windows [S2], and an over-limit request is signalled with HTTP 429 plus a `Retry-After` header [S3].
