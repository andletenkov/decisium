# How it works

```text
page ──► list of elements ──► Jev picks one + an action ──► Playwright acts ──► page changed? repeat until done
```

1. **Read.** Decisium reads the page as text: its accessibility tree (roles, names, visible text, states).
2. **Pick.** Jev chooses from that list: which element, and how to use it (click, type, select, press a key…). It never
   writes code, selectors or values; a typed value always comes from the Step's quotes.
3. **Act.** Playwright performs the action, Decisium reads the new page, and the loop repeats until the Step's task is
   done. `I delete the campaign` may open a menu first, then click Delete.
4. **Check.** For a `Then` Step, Jev only picks the subject and the kind of check. Code compares the quoted value with
   the page.
5. **Refuse to guess.** When the pick is unclear (two "Save" buttons), the Step fails as `AMBIGUOUS` instead of
   clicking one.
6. **Record.** What each Step resolved to (role, name, container) goes into `<feature>.cassette.json`. The next run
   replays it without Jev; if that element is gone, the Step fails as `UI_CHANGED`.

Steps Decisium recognises on its own (`I press Escape`, `I go back`, `I go to "/settings"`) skip the model.
`decisium run -v` prints every page snapshot and answer.
