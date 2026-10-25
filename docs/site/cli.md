# Command line

```text
decisium step "<step>" --url <url|file> [--headed] [--judged] [--strict] [-v] [--debug]
decisium run <file.feature[:line]>... [--url <url|file>] [--headed] [--judged] [--strict] [--record <mode>]
             [--parallel <n|auto>] [--format <name[:path]>] [--import <file>] [-p <profile>] [--no-agent-report] [-v] [--debug]
decisium doctor [<file.feature>...]
decisium lint <file.feature>...
```

## run

Runs features. `file.feature:line` runs only the scenario (or Examples row) at that line.

| Flag | |
|---|---|
| `--url <url\|file>` | Start URL; overrides `@url:` tags. |
| `--record new\|none\|all` | Cassette mode, see [Record and replay](record-replay.md). Default `new`. |
| `--parallel <n\|auto>` | Worker processes. Features run side by side, a feature's scenarios in order. Only for features that do not share app state. `auto`: min(CPUs, 4) with Jev, every CPU with `--record none`. |
| `--headed` | Show the browser. |
| `--judged` | Let Jev judge fuzzy checks. They report `JUDGED_PASSED` / `JUDGED_FAILED`, never `PASSED`. |
| `--strict` | A check that passed on a barely-confident answer (a "marginal pass") fails as `AMBIGUOUS`. |
| `--format <name[:path]>` | Any cucumber formatter, e.g. `junit:junit.xml`. Repeatable. |
| `--import <file>` | Your own step definitions or hooks. Repeatable. |
| `-p <profile>` | A cucumber profile. Repeatable. |
| `--no-agent-report` | Do not write `report.md`. |
| `-v` | Print every Observation and Jev answer (always saved to `log.txt`). |
| `--debug` | Show stack traces. |

## step

Runs one Step against a URL, without a feature file. Handy for trying a wording.

```sh
npx decisium step "I open the calendar" --url http://localhost:3000
```

## doctor

Checks Node, Chromium and `TYPESAFE_API_KEY`; given features, also opens every start URL.

## lint

No browser, no model. Per Step: its kind, the quoted values, keys, secret placeholders, and warnings for wordings the
[Cookbook](cookbook.md) shows failing.

## Exit codes

`0` passed, `1` a scenario failed, `2` configuration or infrastructure error.
