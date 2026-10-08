# Issue tracker: GitHub

Issues and specs for this repository are GitHub issues on `assetcorp/uhttp`, so every operation goes through the `gh` CLI, which reads the repository from `git remote -v` when you call it inside this clone.

## Conventions

- Create an issue with `gh issue create --title "..." --body "..."`, with a heredoc for a body of several lines, and apply the developer's writing guidelines fully to the body where they are available.
- Read an issue with `gh issue view <number> --comments`, and fetch its labels in the same call.
- List issues with `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`, and narrow the list with `--label` and `--state` where the task needs it.
- Comment on an issue with `gh issue comment <number> --body "..."`.
- Add or remove a label with `gh issue edit <number> --add-label "..."` or `gh issue edit <number> --remove-label "..."`.
- Close an issue with `gh issue close <number> --comment "..."`.

## Pull requests as a triage surface

This repository treats no outside pull request as a feature request, so `/triage` reads issues alone. Change the line below to `yes` to put pull requests into the triage queue.

PRs as a request surface: no

When that line says `yes`, a pull request goes through the same labels and states as an issue through the `gh pr` commands. Read one with `gh pr view <number> --comments` and `gh pr diff <number>`, and list the open ones with `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`, of which the triage keeps those whose `authorAssociation` is `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE`. Comment, label, and close with `gh pr comment`, `gh pr edit --add-label`, `gh pr edit --remove-label`, and `gh pr close`. GitHub numbers issues and pull requests from one sequence, so resolve a bare `#42` with `gh pr view 42` first and `gh issue view 42` second.

## Project board

Every issue also appears on the user project 'uhttp' at `https://github.com/users/assetcorp/projects/6`, where each item has four fields. Set all four when you create the issue, set the type label on the issue itself, and move Status as the work moves. Read the project id, the field ids, and the option ids with `gh project field-list 6 --owner assetcorp --format json`, and read an item's id with `gh project item-list 6 --owner assetcorp --format json`. Add an issue to the board with `gh project item-add 6 --owner assetcorp --url <issue-url>`.

Status is a project field with five options. Backlog holds an issue that nobody has specified yet, or a specified issue with an open blocker. Ready holds a specified issue whose every blocker is closed. In progress holds an issue with an assignee and a branch. In review holds an issue with an open pull request. Done holds the closed issue. Set it with `gh project item-edit --project-id <project-id> --id <item-id> --field-id <status-field-id> --single-select-option-id <option-id>`.

Type is one of three labels on the issue. `bug` is behaviour that contradicts a promise that the code or the documentation makes. `enhancement` is new behaviour that a caller can see. `task` is everything else, such as a refactor, a dependency update, or a document.

Priority is a project field with three options. P0 loses data, breaks the server for every caller, or blocks the next release. P1 must close before the next release. P2 can wait for the next free window.

Size is a project field that measures the change's reach. XS is one file. S is one directory. M is several directories with their tests. L crosses the boundary between two parts of the package, such as the router and the body reader. XL changes a public type or an interface that several parts share.

Estimate is a project number field from 0 to 5 that measures how many things must be true at once, independent of size. 0 is a document only. 1 closes in one fresh window. 2 needs tests against the built package or a live server. 3 needs several windows. 4 changes several parts that must release together. 5 needs a design ruling before it starts.

The labels stay separate. The triage labels say who does the work, the type label says what kind of work it is, and Status says where the work is.

## When a skill says 'publish to the issue tracker'

Create a GitHub issue, set its type label, add it to the project board, and set its Status, Priority, Size, and Estimate there.

## When a skill says 'fetch the relevant ticket'

Run `gh issue view <number> --comments`.

## Wayfinding operations

The `/wayfinder` skill keeps a map, which is one issue, with child issues as its tickets.

- The map is one issue that has the `wayfinder:map` label, which you create with `gh issue create --label wayfinder:map`, and whose body holds the notes, the decisions so far, and the fog.
- A child ticket is an issue that you link to the map as a GitHub sub-issue through `gh api` on the sub-issues endpoint, that has one of the labels `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`, and that the driving developer takes as assignee once that developer claims it. Where sub-issues are unavailable, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body.
- A blocking edge is one of GitHub's native issue dependencies, which the web interface shows. Add one with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric database id from `gh api repos/<owner>/<repo>/issues/<n> --jq .id`, and neither the `#number` nor the `node_id`. GitHub reports `issue_dependencies_summary.blocked_by`, which counts open blockers only, so that count is the live gate. Where dependencies are unavailable, put a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- The frontier query lists the map's open children with `gh issue list --state open`, which you scope to the map's sub-issues or task list, drops every child with an open blocker or an assignee, and takes the first in map order.
- A claim is `gh issue edit <n> --add-assignee @me`, which is the session's first write.
- A resolution is `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then a context pointer, which is a gist and its link, which you append to the decisions so far in the map.
