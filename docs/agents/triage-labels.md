# Triage labels

This repository uses the name of each of the five triage roles that the skills define as that role's label string, so every role maps to itself.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

All five labels exist on `assetcorp/uhttp`, where the maintainer renamed GitHub's default `question` label to `needs-info` because it means the same thing.

When the instructions of a skill mention a role, as in 'apply the AFK-ready triage label', use the label string from this table.

Edit the right-hand column where the tracker's vocabulary changes.
