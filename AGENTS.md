# Agent rules for this repository

## Proper fixes only, never patches

Before writing any change (feature, fix, refactor), name the root cause and fix it there. A change that only covers
one more case of a known class of failure is a patch, and patches are not accepted here.

A change is a patch if any of these holds:

- It adds a case to a list of known variations: one more volatile-text regex, one more role, one more wording, one
  more form of a value.
- It guesses what Jev or the user meant from the shape of the page or the Step (a heuristic), and a counterexample is
  easy to write.
- It behaves differently on record, replay and a run without a cassette.
- It fixes one caller while the shared code that produced the failure stays as it was.

Before you commit, answer these in the PR description:

1. Which class of failure does this belong to, and has it appeared before? Search the issues and `git log`.
2. What is the root cause of the whole class, not of this instance?
3. Why does this change remove that cause, and what earlier patches does it make obsolete? Delete them in the same
   change.
4. Which input would still break it? If one is easy to name, it is still a patch: go back to 2.

Re-recording cassettes is never a reason to choose a patch over the proper fix.
