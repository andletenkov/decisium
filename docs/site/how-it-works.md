# How it works

```text
page ──► list of elements ──► Jev picks one + an action ──► Playwright acts ──► page changed? repeat until done
```

1. **Read.** Decisium reads the page as text: its accessibility tree (roles, names, visible text, states).
2. **Pick.** Jev chooses from that list: which element, and how to use it (click, type, select, press a key…). It never
   writes code, selectors or values; a typed value always comes from the Step's quotes.
3. **Act.** Playwright performs the action, Decisium reads the new page, and the loop repeats until the Step's task is
   done. `I delete the campaign` may open a menu first, then click Delete.
4. **Check.** For a `Then` Step, Jev only says what the check means, in one request: its kind, its subject or area, and whether it says "not". Code collects the
   page's evidence and compares; Jev is never asked whether the check passes (except `--judged`). Evidence that is
   missing (the area is not on the screen, the list is still loading) is waited for, then reported as `UNVERIFIABLE`,
   never as a pass.
5. **Refuse to guess.** When the pick is unclear (two "Save" buttons), the Step fails as `AMBIGUOUS` instead of
   clicking one.
6. **Record.** What each Step resolved to (role, name, container) goes into `<feature>.cassette.json`. The next run
   replays it without Jev. The cassette is a cache: if the recording no longer fits the page, or a replayed check does
   not pass, Jev is asked again and the cassette is updated. A heal is written only when the Step ends `DONE` or
   `PASSED`; an `AMBIGUOUS` answer is never recorded.

Steps Decisium recognises on its own (`I press Escape`, `I go back`, `I go to "/settings"`) skip the model.
`decisium run -v` prints every page snapshot and answer.
