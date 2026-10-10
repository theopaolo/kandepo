# Tasks

This project tracks its tasks with [kandepo](https://github.com/theopaolo/kandepo).
Each task is one markdown file in `tasks/`. You create, update and close
tasks by editing those files. kandepo generates the board in `kanban.html`
from them. Do not edit `kanban.html`, and you do not need the board to work
on tasks.

## Before you start

Read `kandepo.config.json` at the project root if it exists:

- `dirs` lists the task folders, `./tasks` by default. New tasks go in the
  first one.
- `fields` lists the custom fields and their allowed values. The default is
  `priority` with `high`, `medium`, `low`.

`npx kandepo --help` prints the task template with this project's fields.

## Create a task

Name the file after the title: lowercase, accents removed, apostrophes
dropped, every other run of characters replaced by `-`, at most 100
characters. `Make column labels configurable` goes in
`tasks/make-column-labels-configurable.md`. If the file exists, the task
exists: update it instead.

```markdown
---
title: Make column labels configurable
status: not_started
priority: high
scope: [board]
type: [feature]
---

## Tasks

- [ ] Read `columns` from the config
- [ ] Document the key

## Notes

Context, decisions, open questions. Depends on [[Translate the board UI]].
```

Only `title` is required. Leave out a field you have no value for. Set
`assign` and `due` only when the user gives them.

| Field       | Values                                                    |
| ----------- | --------------------------------------------------------- |
| `title`     | text                                                      |
| `status`    | `not_started` (default), `in_progress`, `blocked`, `done` |
| `scope`     | list, `[api, pwa]`                                        |
| `type`      | list, `[bug]`, `[feature]`, `[chore]`                     |
| `assign`    | a name                                                    |
| `due`       | `YYYY-MM-DD`                                              |
| `issue_url` | http(s) URL                                               |

Custom fields from the config take one of their listed values. A field
with an empty list takes any value. Before adding a new `scope` or `type`
value, check the values the other tasks already use.

## Frontmatter format

kandepo reads the frontmatter with a small built-in parser, not a YAML
library. Stay within what it understands:

- `---` on the first line of the file, LF line endings.
- One `key: value` per line, with no quotes. Quotes stay in the value.
- Lists inline, `[a, b]`, or as `  - a` lines under `key:`. A comma inside
  an inline item splits it in two.
- No multi-line strings, no nested keys.
- A line starting with `#` is a comment. Tasks created from the board list
  the optional fields as comments. Uncomment a line to set the field.

## Work on a task

- When you start, set `status: in_progress`.
- Tick each step in `## Tasks` when it is done: `- [x]`, lowercase x. The
  card counts the boxes.
- Write decisions and findings under `## Notes`.
- If something blocks you, set `status: blocked` and write the reason in
  the notes.
- When the work is done, set `status: done`. Keep the file unless the user
  asks to delete it.

Change only the lines you mean to change. Keep the order of the keys and
the formatting of the body.

## Links between tasks

`[[file-name]]` or `[[Task title]]` in the body links to another task.
Matching ignores case. A link to a task that does not exist shows as plain
text, so check that the target file exists.

## Running kandepo

`npx kandepo` starts a server and keeps running. To rebuild the board and
exit, run `npx kandepo --no-serve`. Run `npx kandepo --sync` only when the
user asks: the connectors write to outside tools.
