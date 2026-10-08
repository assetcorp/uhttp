# Domain docs

Before you explore this repository, read the domain documents in the list below, and follow the instructions in each later section on how to use them.

The repository has a single context, so one `CONTEXT.md` and one `docs/adr/` folder at the root hold its domain documents.

## Read these before you explore

- Read `CONTEXT.md` at the repository root, where each term that this repository uses with a fixed meaning has its definition.
- Read every decision record in `docs/adr/` about the area that you're about to work in. Each record's file name is a short summary of its decision, so list the folder to find the records that apply.

If either of these doesn't exist yet, carry on without flagging its absence. The `/domain-modeling` skill, which both `/grill-with-docs` and `/improve-codebase-architecture` reach, creates them once somebody resolves a term or settles a decision.

## File structure

```text
/
├── CONTEXT.md        the glossary of domain terms
└── docs/adr/         one numbered file per decision record
```

## Use the glossary's vocabulary

When you name a domain concept in your output, whether in an issue title, a refactoring proposal, a hypothesis, or a test name, use the term from `CONTEXT.md` and keep to that one term throughout.

When the glossary lacks a concept that you need, one of two things is true. Either you're inventing a word that appears nowhere in this repository, so reconsider the word, or you've found a real gap, so note it for `/domain-modeling`.

## Flag a conflict with a decision record

When you propose a change against an existing decision record, say so explicitly, as in this example:

> _I'm proposing a change against ADR-0003, which [the decision that it records], and I'd reopen that decision because [your reason]._
