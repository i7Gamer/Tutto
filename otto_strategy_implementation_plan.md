# Otto: classic Kniffel, endgame decisions, and consistent keeps

Status: implemented after Luna and local Gemma review. Base: `ffb6a83`.

## Intended behavior

1. Classic Kniffel considers every nonempty subset of the distinct missing
   numbers on the table. Otto maximizes completion probability; modernized
   Kniffel and Carl/Rita retain their existing selection rules.
2. When Otto is the last player in the round, he banks an available immediate
   win and avoids banking an immediate loss while a useful gamble is available.
   A tie does not end the game. Earlier seats retain the existing strategy.
3. Otto evaluates each keep with the action his decision policy would actually
   take. A keep must not win because of a bank he then declines to take.

This is a targeted correction, not a full multiplayer win-probability solver.
The expected-points dynamic program, trailing appetite cap, one-card classic
draw lookahead, and Kleeblatt's probability-only keep objective remain in place.
The previous constrained-deck and Kleeblatt fixes remain covered by regressions.

## Implementation

### Classic Kniffel

- Extend `turnValue.legalKeeps` to enumerate subsets of distinct uncollected
  faces under classic Kniffel. A face occurs at most once in a keep, and validity
  and progress come from `checkValidityAndScore`.
  Retain one actual die per chosen face; all other dice are rerolled.
- Restrict the Kniffel shortcut in `bestKeep` to modernized rules. Classic
  Kniffel, like Kleeblatt, ranks keeps by completion probability directly.
- This automatically corrects `completionProbability` and the value assigned
  to a Kniffel in a classic draw. Keep the human Select All behavior unchanged.
- Preserve deterministic ties (more dice, then stable face order).

### Endgame context and terminal rules

- Add optional endgame context to bot/coach standings: opponents' individual
  scores, present only for the last seat. Game derives it from the current
  roster and turn index; missing context preserves old callers' behavior.
- Pass pending classic Plus/Minus resolutions from DiceGame's current chain
  into the bot/coach context. On a completing Plus/Minus keep, include that
  card's pending deduction too. This prevents falsely declaring a bank a loss
  before the engine applies its opponent deductions.
  These deductions belong only to hypothetical bank settlement: drawing keeps
  them pending, and a later ordinary bust or Stop forfeits them. Never mutate
  the live standings or deduct them early when evaluating a continued chain.
- Add a small pure bank-outcome evaluator that follows the engine's scoring
  rules: own score plus the final bank, correct modernized/classic Plus/Minus
  deductions, unique leader, winning threshold, and ties. Verify it against
  `calculateNextTurn` using complete test fixtures. Share a score-only deduction
  helper with the engine if needed to avoid two divergent rule implementations.
  Apply deductions in engine order before checking the final unique leader;
  a resulting tie means play continues.
- Apply endgame priority before appetite: bank a certain win; when banking
  certainly loses, choose an offered roll/draw with a reachable non-losing
  settlement rather than that loss. Positive expected points alone are not
  sufficient. An empty deck or a certain Stop draw is not useful.
  Do not mistake a first Kleeblatt tutto for a bank or offer Stop on Feuerwerk.
- Implement a bounded reachability check, not another expected-value solver:
  ordinary cards can attain the all-ones score on the remaining dice plus their
  tutto bonus; fixed-award cards can complete for their award; Kleeblatt can win
  outright; Feuerwerk can accumulate any finite required total. Test the best
  attainable settlement with the same opponent deductions and tie rules.
  For a classic draw, examine only cards with positive next-card weight and
  retain the existing one-card lookahead. A current-card completion may use
  that next-card opportunity only if the draw capability and chain cap allow
  it. Exhausting this lookahead means no endgame override, not a claim that
  every longer possible chain is mathematically hopeless.
- While comparing keeps, an immediately winning bank outranks a gamble, and a
  useful gamble outranks a keep that can only end in a banked loss. Otherwise
  compare the value of the selected action. This also covers a choice between
  completing a losing tutto and keeping fewer dice to continue.

### Keep/action consistency

- Centralize the roll/draw-versus-bank comparison and endgame overrides so
  selection, `chooseBotAction`, and coach explanations use the same policy.
- For every legal keep, derive its legal actions using the existing turn
  controls, including actual draw availability and the classic chain cap.
- Resolve the action for that keep first; rank by its chosen action's value
  (bank, continuation, or draw), rather than `max(bank, continuation)` followed
  by a different risk-biased action. Keep comparisons use the existing
  objective continuation values; appetite still does not alter the DP.
- Avoid a selection/action call cycle: a helper takes an already evaluated
  keep; selection calls it for candidates, action calls it for the selected
  keep. Public wrappers remain available for existing callers.
- Add a decision reason for terminal overrides. Coach copy explains an
  immediate win or avoiding an immediate loss instead of showing a points
  comparison that contradicts the action. Add English and German strings.

## Tests before implementation

- Classic Kniffel: progress `[1,2]`, table `[3,4,4,4]` keeps one missing number;
  completion probability is 0.1547067901 rather than 0.1388888889. Fresh
  `[5,6,6,6,6,6]` also keeps one. Test duplicates, collected faces, empty keeps,
  complete straights, stable ties, both rulesets, and unchanged Carl/Rita.
- Independent oracle: enumerate ordered classic rolls and distinct missing
  face counts for each remaining-dice count; optimize over how many to retain.
  Compare all six probabilities against the production implementation.
- Guaranteed win: last seat, own 5900, opponent 5000, target 6000, fresh
  `[1,2,2,2,3,4]` on 200 banks instead of rolling. Cover classic draw as well.
- Avoid certain loss: last seat, own 4900, opponent 6100, target 6000, fresh
  `[1,1,1,1,2,3]` on 200 rolls instead of banking 1100 and losing. Also cover
  a legal one-die case: four kept worth 1050, table `[5,3]`.
- Cover earlier seats, tied leaders, no opponents, missing context, fixed
  awards, pending Plus/Minus chains, classic deduction floors, Kleeblatt and
  Feuerwerk controls, no drawable card, certain Stop, and the chain cap.
  Include a positive-points gamble that cannot catch the leader, and a
  completed Plus/Minus followed by a draw and then a Stop or ordinary card.
- Consistency: classic bank 500, table `[1,2,2,2,3,4]`, deficit 3000/6000,
  Stop-only remaining deck. Otto should keep the lone 1 and roll five rather
  than keep four for an 800 bank and then roll two. Verify selected action
  agrees with the candidate comparison across seeded reachable states.
- Verify Game -> DiceGame -> bot/coach context and truthful coach reasons.

## Delivery and validation

1. Obtain independent reviews from two different model subagents; record and
   resolve concrete objections in this file before implementation.
2. Add failing regressions, implement in bounded slices, and run focused tests
   after each change. No previews or changes to the running site's build.
3. Run lint, both TypeScript checks, and the full Vitest suite before committing.
   The sandbox previously blocks Windows userInfo in spawned test servers;
   run the authorized suite outside that restriction when necessary.
4. Browser E2E requires Playwright browsers, currently absent. If still absent,
   record that limitation; do not rebuild the live `dist/` just to discover it.
5. Review the diff and commit only the plan and implementation files with a
   descriptive message. Do not push.

## Review log

- Luna: changes required on the first draft. Replaced positive-points
  continuation as the endgame trigger with bounded non-losing reachability;
  explicitly separated pending Plus/Minus deductions from bank settlement.
- Luna: approved the revised plan; replay each stored pre-card score separately.
- Local Gemma: requested explicit win priority, settlement order for ties, and
  one die per retained face. Incorporated those clarifications. Its suggestion
  to seed production probabilities from the test oracle was rejected: doing so
  would remove the independent check. Tests compare all six production results
  against the oracle and exercise selection and draw values through that DP.
- Luna implementation review: approved; no remaining concrete blocker in
  settlement, reachability, or selection/action consistency.

## Implementation and validation record

- Added classic Kniffel subsets and an independent ordered-roll occupancy
  oracle; retained modernized Kniffel, Carl/Rita, and Kleeblatt behavior.
- Centralized each keep's action decision and added last-seat endgame context,
  bounded non-losing reachability, and shared engine Plus/Minus settlement.
- Wired pending chain deductions into restored/live bot and coach contexts;
  added English/German terminal explanations and integration coverage.
- Regression checks cover the reported cases, engine agreement, draw limits,
  ties, fixed awards, special-card controls, and seeded keep/action agreement.
- Final full suite: 183 files, 4,188 tests passed. Repository lint, production
  TypeScript build check, test TypeScript check, and diff whitespace check passed.
- Browser E2E unavailable: Chromium, Firefox, and WebKit executable paths all
  point to missing Playwright binaries. No preview or live build was used.
- Commit only this plan and the related source/tests; do not push.
