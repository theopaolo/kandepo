# kandepo

One markdown file per task, committed next to the code. kandepo turns the
folder into a kanban board in a single HTML file, serves it locally, and
writes back to the files when you create a task or move a card. It needs
Node 18 or newer and has no dependencies. The name is kanban plus dépôt,
French for repository.

## Install

```bash
npm install --save-dev kandepo
mkdir tasks
npx kandepo
```

Open http://localhost:7878. Add `kanban.html` to `.gitignore`, kandepo
rebuilds it on every run.

```
your-project/
├── tasks/                one .md per task
├── kandepo.config.json   optional
└── kanban.html           generated
```

## Task file

```markdown
---
title: Make column labels configurable
status: not_started
priority: high
scope: [board]
type: [feature]
assign: Ana
due: 2026-10-01
---

## Tasks

- [ ] Read `columns` from the config
- [x] Document the key

## Notes

Free markdown. [[Translate the board UI]] links to another task.
```

Only `title` is required. Name the file after the title in kebab case.

| Field       | Values                                                    | Used for                     |
| ----------- | --------------------------------------------------------- | ---------------------------- |
| `title`     | text                                                      | required                     |
| `status`    | `not_started` (default), `in_progress`, `blocked`, `done` | column                       |
| `priority`  | `high`, `medium`, `low`                                   | filter, sort, tag            |
| `scope`     | list, `[api, pwa]`                                        | filter and tags              |
| `type`      | list, `[bug]`                                             | tags                         |
| `assign`    | text                                                      | filter and tag               |
| `due`       | `YYYY-MM-DD`                                              | tag                          |
| `issue_url` | http(s) URL                                               | "Issue" link in the dialog   |

`priority` is the default custom field. Replace it or add your own in the
config, see [Custom fields](#custom-fields).

The dialog renders the body: headings, lists, checkboxes, code blocks. A
body with more than one checkbox shows `done/total` on the card.

`[[file-name]]` or `[[Task title]]` links to another task. The dialog makes
the link clickable and lists the tasks that point back. The Graph button
swaps the board for the link graph.

The `+` in a column header creates a task file with that status and opens
it in your editor. The optional fields come as YAML comments, uncomment the
ones you fill. Dragging a card to another column rewrites its `status:`
line. The task dialog edits the status, the custom fields, `assign`,
`due`, `scope` and `type`, and ticks the checkboxes of the body. Each
change rewrites one line of the file. The rest of the body stays in your
editor, behind "Open in editor".

The board reloads when a task file changes, whether you edit it, an agent
edits it or a `git pull` brings it. Filters, sort and the open task are
stored in the URL, so a bookmark or a shared link keeps them.

## AI agents

An agent can manage tasks by editing the files, without the board.
[`AGENTS.md`](AGENTS.md) tells it the file format, the parser limits and
how to move a task. Copy it to your project root, or append it to your own
`AGENTS.md` or `CLAUDE.md`. It ships in the package:

```bash
cat node_modules/kandepo/AGENTS.md >> AGENTS.md
```

## Configuration

Put `kandepo.config.json` at the root of the project. Every key is
optional.

```json
{
  "title": "My project",
  "dirs": ["./tasks"],
  "output": "./kanban.html",
  "port": 7878,
  "editor": "code",
  "columns": { "not_started": "Backlog", "done": "Shipped" },
  "fields": {
    "priority": ["high", "medium", "low"],
    "energy": ["1", "2", "3", "5", "8"],
    "context": []
  }
}
```

| Key       | Default                     | Role                                                         |
| --------- | --------------------------- | ------------------------------------------------------------ |
| `title`   | `Kanban`                    | Tab and header title                                         |
| `dirs`    | `["./tasks"]`               | Task folders. New tasks go to the first one                  |
| `output`  | `./kanban.html`             | Generated file                                               |
| `port`    | `7878`                      | Server port                                                  |
| `editor`  | `$EDITOR`, else `code`      | Command run with the file path. Falls back to `open -t` on macOS |
| `columns` | To do, In progress, Blocked, Done | Column labels by status, partial overrides allowed     |
| `fields`  | `{ "priority": ["high", "medium", "low"] }` | Custom fields, see below                     |

With two folders in `dirs`, the folder name shows as a tag and a filter.
One folder plus tags covers most needs.

### Custom fields

Each entry in `fields` is a frontmatter key with its allowed values. Every
field gets a filter in the header and a tag on the card. A field with values
is also a sort option, in the order of the list: with
`["high", "medium", "low"]`, high comes first. Tasks without the field go to
the bottom of the column. An empty list accepts any value, and the filter
lists the values found in the tasks.

`fields` replaces the default. To keep `priority` next to your own fields,
list it too. To have no custom field, set `"fields": {}`.

### Command line

```bash
npx kandepo [tasks-dir] [html-file] [--no-serve] [--watch] [--sync[=name]] [--dry-run] [--help]
```

Positional arguments win over the config: `npx kandepo todo board.html`
reads `./todo` and writes `./board.html`.

| Flag         | Effect                                                              |
| ------------ | ------------------------------------------------------------------- |
| `--no-serve` | Generate and exit, for CI or a build. The file opens over `file://`, read-only |
| `--watch`    | With `--no-serve`: rebuild on changes without the server            |
| `--sync`     | Run every connector, `--sync=name` runs one, see below              |
| `--dry-run`  | With `--sync`: passed to the connectors, no rebuild                 |
| `--help`     | Print the usage and the task fields, custom fields included         |

### Connectors

A connector syncs the task files with another tool, such as Plane, Vikunja
or GitHub issues. The package includes none. A connector is a module
you list in the config with `use`, a path or a package name resolved from
the project. The other keys are its options. Without a `package.json`,
`npx -p kandepo -p <connector-package> kandepo --sync` finds a connector
installed next to kandepo.

```json
{
  "connectors": {
    "tracker": { "use": "./connectors/tracker.cjs", "project": "web", "tokenEnv": "TRACKER_TOKEN" }
  }
}
```

The module exports one async function:

```js
exports.sync = async ({ options, tasks, dirs, dryRun, log, statuses, slugify, setField, parseFrontmatter }) => {
  // options: { project: 'web', tokenEnv: 'TRACKER_TOKEN' }
  // tasks:   the parsed tasks, with filename, _path and every frontmatter key
  // dirs:    the task folders, write new files to dirs[0]
  // dryRun:  true with --dry-run, write nothing
};
```

The connector reads and writes the files itself. `setField(content, key,
value)` sets one frontmatter key and keeps the rest of the file.
`slugify(title)` gives the file name kandepo uses. `npx kandepo --sync`
runs the connectors in config order, then rebuilds the board. Keep API
tokens in environment variables and put only their names in the config.

## How it works

`kanban.cjs` reads every `.md` in the task folders and parses the YAML
frontmatter with a small built-in parser: scalars, inline lists, block
lists. It resolves the `[[wikilinks]]`, then injects the tasks as JSON,
`src/board.css` and `src/board.js` into `src/board.html`. The output is one
HTML file with no external asset.

The server listens on `127.0.0.1` and takes four JSON writes from the
board: `POST /new` creates a task, `POST /field` sets one frontmatter key,
`POST /check` ticks or unticks a checkbox, `POST /open` opens a file in
your editor. It refuses requests from another
origin and paths outside the task folders. `/field` accepts the editable
keys only and rejects values the parser would misread, such as a newline
or a comma inside a list item. The server watches the folders and rebuilds
the HTML on every change. When the HTML changes, it sends an event on
`GET /events` and open boards reload. A board waits while you type in a
field.

The board uses Atkinson Hyperlegible Next, inlined as a Latin subset
(54 KB). The font is under the SIL Open Font License, see
`src/fonts/OFL.txt`.

## Development

```bash
git clone https://github.com/theopaolo/kandepo
cd kandepo
node kanban.cjs
npm test
```

The tasks in `tasks/` are the roadmap of kandepo itself and use a custom
`size` field from `kandepo.config.json`. `npm test` covers the parser, the
config, the generated HTML, the server routes and the watcher.

## License

AGPL-3.0. Use it, change it, share it. A modified version you distribute or
host must publish its source under the same terms.
