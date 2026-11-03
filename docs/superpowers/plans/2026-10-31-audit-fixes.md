# Personal extension audit fixes

**Request:** Fix the eight reported defects and remove Course Backup.

Keep the existing personal DeepSeek integration and local features. Patch the packaged scripts in place without regenerating their obfuscated bootstrap. Use mock browser/network boundaries; do not run actions against real courses or the user's API account.

- [x] Content: bind answers and submission to the current attempt/questions; reconcile checkbox selections; click confirmation once and bound the outcome wait; reject visual questions whose images cannot be supplied reliably. Reproduce each defect before changing its implementation.
- [x] Background: delete the destructive tab timer and unrelated URL closing; persist and restore the Quiz queue across worker restarts, preserving cancellation and spacing; serialize Skip Video+ and stop on HTTP 429, reporting verified successes and failures.
- [x] Remove Backup UI, settings, bundled JSZip, manifest loading, download permission and documentation. Content dispatcher/archive removal is part of the content task. Preserve lecture metadata required by Skip Video+.
- [x] Review both implementations independently, run all local tests and syntax checks, and inspect the final integration. Check late responses, worker restarts during tab creation, cancellation, partial HTTP failures and missing submission outcomes.

Implementation runs in the existing checkout because it builds on the user's uncommitted personal adaptation. Agents own disjoint files. No commits, publishing or live service actions are required.

## Verification record

Final root verification: 109/109 Node tests passed in an OS sandbox without network access; all shipped JavaScript passed syntax checks. Actual popup rendering/action dispatch and settings saves passed mocked Chrome checks, and manifest resource paths and git whitespace checks passed. Independent review found and verified additional cancellation and pending-navigation fixes. No live Coursera/DeepSeek actions were executed; compatibility with current Coursera pages remains a browser verification step.
