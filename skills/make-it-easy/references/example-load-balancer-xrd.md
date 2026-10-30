# Worked example: a load balancer XRD

Illustrative, from a real project's shape. Names and tag keys are invented. Read
it to calibrate how the phases connect, not to copy the answers.

## Goal

**Stated request:** create a Crossplane XRD that manages load balancers.
**True goal:** teams get a load balancer by declaring intent, without knowing
which network it lands in, and the platform can move networks without touching
every claim.

## Inputs (phase 2)

| Input | Consumer | Today's source | Producer | Problem | Recommended supply |
| --- | --- | --- | --- | --- | --- |
| Which VPC | LB composition | Would be hardcoded VPC ID | Network layer | Every claim and composition knows a network ID; a new VPC means editing both | Discover by tag |
| Which subnets | LB composition | Would be hardcoded subnet IDs | Network layer | Same, and per-AZ | Discover by tag |
| Internal or public | Claim author | Implicit | Claim | Choice is the consumer's | Claim field |
| Security policy | LB composition | Varies | Security team | Not in scope for this change | Open question |

The first two are the interesting ones. Hardcoding IDs is the baseline: fast and
coupled. Passing IDs in every claim pushes network knowledge onto every team.

**Chosen supply:** the consumer states a need ("subnets for public load
balancers in environment X"), and the network layer advertises capability by
tagging VPCs and subnets. The XRD's composition selects by tag.

**Contract sketch**
- Keys: `example.org/lb-placement` on VPCs (`environment` value) and on
  subnets (`public` or `internal`).
- Owner: the network layer writes them; the LB composition only reads.
- Absent: selection returns nothing, so the composition fails with a message
  naming the missing tag. No fallback to a default network.
- Evolution: new placement kinds are new values, and unknown values are ignored.
- Retrofit: tag the existing VPCs and subnets. That is a preparatory step.

Decoupling test: a new VPC joins by being tagged; the XRD does not change. The
composition can be tested with fixtures that carry the tags.

## Friction (phase 3)

| Friction | Blocks | Verdict |
| --- | --- | --- |
| VPCs and subnets are created by a module with no tagging hook | Tag contract | Fix first: add a tags input to the module |
| Subnets differ in naming between environments | Tag contract (cannot tag by name pattern) | Fix first: tag explicitly, ignore names |
| Two older compositions each hardcode a network ID | Nothing here | Leave. Note it. |
| No tests for composition selection logic | The change | Work around: fixtures for the new composition only |

## Options (phase 4)

- **A. Baseline:** hardcode network IDs in the composition. Smallest now. Every
  new network means editing the composition. Choose only for a throwaway
  environment.
- **B. Seam first (recommended):** add the tagging hook to the network module,
  define and apply the tag contract, then build the XRD against it. More
  work up front, and the XRD becomes the easy change.
- **C. Claim-supplied IDs:** claims pass VPC and subnet IDs. No contract to
  maintain, but every team learns network internals.

## Roadmap (phase 5, Option B)

**Make it easy**
1. Add a tags input to the network module. *Type:* tidy. *Eases:* 2. *Ships
   alone:* yes. *Rollback:* revert.
2. Define the placement contract in docs. *Type:* contract. *Eases:* 3 and 4.
3. Tag existing VPCs and subnets. *Type:* contract retrofit. *Ships alone:* yes.
   *Verification:* a query by tag returns the expected set per environment.

**The change**
4. Implement the XRD and composition selecting by tag. *Done when:* a claim in
   each environment gets a load balancer in the right subnets, and a missing tag
   produces the named error.

**Clean up**
5. Document the contract next to the network module and add a check that fails
   when a subnet lacks required tags.

Step 4 is small because steps 1-3 removed every question about where things live.
