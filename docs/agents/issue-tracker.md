# Issue tracker: GitHub

Issues and PRDs for this repository live as GitHub issues. Use the `gh` CLI for
operations and infer the repository from the Git remote.

## Conventions

- Create, read, comment on, label, and close issues with the corresponding
  `gh issue` commands.
- Fetch issue bodies, comments, and labels when a skill needs the full ticket.
- GitHub pull requests and issues share a number space; resolve ambiguous
  references by checking the pull request first.
- When a skill says "publish to the issue tracker," create a GitHub issue.
- When a skill says "fetch the relevant ticket," read the issue and its
  comments.

## Pull requests as a triage surface

External pull requests are a request surface. Include pull requests whose
author association is `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE`.
Exclude work from owners, members, and collaborators.

Use the corresponding `gh pr` commands to read pull requests and diffs, apply
labels, comment, or close them.

## Blocking relationships

Use GitHub's native issue dependencies where available. Otherwise, record
dependencies as `Blocked by: #<number>` in the ticket body. A ticket is ready
when every blocking issue is closed.
