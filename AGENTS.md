## General notes

- TDD - develop test driven at all times
- Use GPT-5.3-Codex-Spark only for genuinely small, low-risk tasks when it is available and capable of completing them reliably. Never use it for reviews, audits, broad analysis, or similar tasks.
- Generally choose the lowest-cost available model that can reliably handle the task, including local LLMs where suitable. Use a more capable model only when task complexity, risk, or insufficient results justify it.
- Never push git branches when not told so
- Be as short as possible in your responses without missing any infos
- Ensure all new functions and classes are tested if possible - try to test every branch including edge cases
- always run all tests before commiting code
- always commit the changes with a descriptive commit message
- Never stage or commit implementation plans or planning documents. Keep them local and untracked unless I explicitly ask to commit a specific plan. This overrides the general instruction to commit changes.
- do not use "magic numbers" always define a const/var

## Code Navigation

Always prefer Token Savior MCP tools before using Read, Grep, Glob, or shell commands.

Preferred workflow:

1. find_symbol
2. search_codebase
3. get_function_source
4. get_class_source
5. get_dependencies
6. get_dependents
7. get_change_impact

## Main guidelines

1. Ask, don't assume. If something is unclear, ask before writing a single line. Never make silent assumptions about intent, architecture, or requirements.
   When running unattended, pick the most reasonable interpretation, proceed, and record the assumption rather than blocking.
2. Implement the simplest solution for simple problems, better solutions for harder problems. Do not over-engineer or add flexibility that isn't needed yet.
3. Don't touch unrelated code but please do surface bad code or design smells you discover with me so we can address them as a separate issue.
4. Flag uncertainty explicitly. If you're unsure about something, see point 1 above. If it makes sense to do so, conduct a small,
   localised and low-risk experiment and bring the hypothesis and results to me to discuss. Confidence without certainty causes more damage than admitting a gap.
5. I'm always open to ideas on better ways to do things. Please don't hesitate to suggest a better way, or one that has long lasting impact over a tactical change.
   (as a few examples)
6. Before editing any file, read it first. Before modifying a function, grep for all callers. Research before you edit.
7. Do not use preview to check your changes unless specifically asked to.
