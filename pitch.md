# Why I Built Sentinel

I did not build Sentinel because I wanted another CLI project on my resume.  
I built it because I got tired of pretending line diffs were enough.

If you have ever changed a production config file at 2 AM, you know the feeling.  
The PR looks small. The diff looks harmless. Then something breaks, and everyone is scanning raw YAML trying to answer one simple question:

**What actually changed?**

Not "which line moved."  
Not "which key got reordered."  
Not "why the formatting plugin touched 40 lines."

Just: what changed in behavior.

---

## The Problem Was Never Just Noise

Config drives real systems: databases, feature flags, auth, TLS, retry logic, secrets, and failover behavior.  
But the way we review config is still mostly text-based.

That means we miss things:

- `pool_size` doubled quietly and overloaded downstream systems.
- `debug` was enabled in the wrong environment.
- a token changed and nobody noticed until deployments failed.
- `.env` edits looked random and got ignored because they were "just environment stuff."

These are not hypothetical. These are the kind of mistakes that cost teams time, trust, and sleep.

I wanted a tool that treats config changes like what they are: **operational decisions**.

---

## What Sentinel Does Differently

Sentinel watches config files and reports semantic changes in plain English:

- `database.pool_size: 5 -> 20`
- `feature_flags.dark_mode: false -> true`
- `deprecated.old_key removed`

It supports JSON, YAML, TOML, and ENV files because real teams do not live in one format.

It can run in live watch mode for local development, and in CI mode for merge gates.  
It can trigger shell commands and webhooks so changes can flow into automation pipelines.  
It can apply simple policy checks so risky toggles and secret-like changes are harder to miss.

The goal is not to be clever.  
The goal is to reduce ambiguity.

---

## Why This Matters To Me

I care about tools that remove friction from real engineering work.

The best tooling is often boring in the right way:

- clear output
- predictable behavior
- graceful failure modes
- useful defaults
- easy integration with existing workflows

Sentinel is my attempt at building exactly that kind of product.

I did not want to ship a toy.  
I wanted to ship something a team could actually adopt and depend on.

---

## What I Believe

I believe infrastructure and platform tools should feel human.

Developers should not need to mentally compile a noisy diff into intent.  
Ops teams should not have to discover dangerous config changes after impact.  
Reviewers should not have to guess risk from formatting-heavy patches.

We can do better.  
And we can do it without forcing teams to change their stack.

---

## Where Sentinel Is Going

This is version one, not the finish line.

I am exploring:

- deeper policy packs by environment
- richer CI annotations
- team-level baselines and historical drift views
- plugin hooks for custom rule engines

If you have ever been burned by "small" config changes, I would love your feedback.

---

## Share This With The Internet

If this resonates, share it.

Share it with the teammate who has cleaned up a postmortem caused by a config typo.  
Share it with platform engineers trying to make operational risk visible.  
Share it with teams that know good tooling is not about hype, it is about clarity.

I built Sentinel for people who have to keep systems stable in the real world.

And if that is you, this is for you.
