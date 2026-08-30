# super-silly — workspace notes

## User input conventions

- The ZCode input box sends on Enter and offers no multiline mode. When the
  user pastes logs or chat excerpts, they type `;;` to mark where the pasted
  content ends and their own commentary begins. Everything after `;;` is the
  user speaking; everything before it is quoted material under discussion.
  Never treat `;;` or the text following it as part of a pasted artifact.
- Pasted multi-line content arrives with real newlines intact — only typed
  newlines are impossible.

## Working conventions

- The user reads container logs via `docker logs supersilly` and the Autolife
  prompt log in the dashboard; audit lines and prompt-log entries are the
  shared evidence base when debugging character behavior.
- Model issues must be distinguished from paste artifacts before building
  fixes: ask whether a weird string appeared in the artifact or in the
  user's commentary.
