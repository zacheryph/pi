# Phase 2: Inputs and contracts

Work backwards from the finished feature. Ask: for it to do its job, what does it
need to know or receive? Each answer is an input. The easiest implementation is
the one where every input arrives through a stable, narrow contract.

## Find the inputs

Walk the feature's life: create, run, change, observe, delete. At each point ask
what it must know. Common kinds:

- **Placement:** where it lives, what it attaches to, which environment or region.
- **Identity:** names, owners, labels, what it is called by others.
- **Configuration:** tunables and defaults, who may override them.
- **Dependencies:** other resources, services, or data it needs to exist first.
- **Policy:** security, compliance, naming, cost rules it must obey.
- **Data shape:** formats and schemas it reads or produces.
- **Lifecycle signals:** how it learns that something it depends on changed or went away.

## Describe each input

| Input | Consumer | Today's source | Producer / owner | Problem | Recommended supply |
| --- | --- | --- | --- | --- | --- |

"Today's source" is one of: hardcoded, copied in several places, implicit
convention, passed by the caller, discoverable, or missing. Use evidence.

## Design the supply

For each input list the realistic ways to provide it and pick one. Typical
ladder, from tightest to loosest coupling:

1. **Hardcode or embed the producer's identifier.** Fast. Consumer breaks when
   the producer changes. Acceptable only when both have one owner and change together.
2. **Caller passes it explicitly.** Simple and testable. Pushes knowledge to
   every caller. Good when callers legitimately know it.
3. **Consumer states a need; producer advertises capability.** The consumer
   asks for "subnets for role X in environment Y" and producers mark themselves
   as providing that, using tags, labels, annotations, a registry entry, or a
   well-known name. Neither side holds the other's identifiers. Costs: a
   contract to name, own, and document, and failures move to runtime.
4. **A dedicated interface or service.** A real API or abstraction. Justified
   when there are several producers or the lookup logic is itself complex.

Choose the lowest rung that keeps producer and consumer independent where they
need to be. Rung 3 is the usual answer when the producer lives in another
layer, team, or lifecycle than the consumer.

### Decoupling tests

- Can the producer be replaced (new network, new database, new region) without
  editing the consumer?
- Can the consumer be tested without the real producer?
- Can a new producer join by publishing the contract, with no consumer change?
- Does either side import the other's identifiers, paths, or internal structure?

### When you choose a discoverable contract

Define it before building either side:

- **Name and vocabulary:** keys and values, namespaced to avoid collisions.
- **Meaning:** what a producer promises by publishing it.
- **Ownership:** who may write it, who reads it, who reviews changes.
- **Absent or ambiguous:** fail loudly with a message that names the contract.
  Silent fallback hides misconfiguration.
- **Evolution:** how to add a value, rename a key, or retire it without a flag day.
- **Retrofit:** which existing producers need the contract added, and how to
  apply it safely. That retrofit is a preparatory step and goes in the roadmap.

Do not add a contract for a single producer, a single consumer, and a single
owner. Pass a parameter and note the trigger that would justify a contract later.

## Gate

Every input has a source, a producer or owner, a recommended supply with its
tradeoff, and, for discoverable supply, a contract sketch. Add the table to the
roadmap document. Surface inputs that nobody owns as open questions for the user.
