# Product Memo: Settlement Clarity

**Feature:** Structured recoup terms + full deal type support in the settlement engine

---

## The Slice

The Coastal Spell dispute ($720 loss, several hours of back-and-forth) happened because a single phrase in a deal email was genuinely ambiguous: "marketing recoup of $900 against gross." Mariana read it one way, Daniel read it another, and the system had no answer — the truth lived in Andrea's head and Mariana's inbox. Mariana's final note: *"there's no version of the truth in our system."*

I picked the settlement workflow as the slice because it's where the pain lands, but the fix starts upstream. The real problem is that deal terms aren't fully structured at entry time. I worked backward from the dispute to identify two failure modes happening simultaneously:

1. **The engine couldn't settle the deal at all.** Coastal Spell was a vs deal. The existing tool returned "use a spreadsheet" for vs, percentage-of-net, and door deals — ~75% of the deal mix by volume. Mariana literally could not run the settlement in-app.
2. **Recoup treatment wasn't captured.** Even if the engine had worked, there was no field for "is this recoup inside or outside the expense cap?" That ambiguity is the whole dispute. It's a boolean that didn't exist.

---

## Design Choices

`**insideExpenseCap` as the canonical field.** The entire $720 dispute and every future one like it reduces to this boolean. I added it to `DealRecoup` (deal-level terms) and `Recoup` (settlement-level actuals) so both surfaces can show treatment. The schema change is non-destructive — existing rows without the field degrade gracefully (no pill shown).

**Calculation order as communication.** The settlement worksheet doesn't just show the right number — it shows the path to that number in a way both Mariana and Daniel can follow. Recoups marked `insideExpenseCap: true` appear inside the expense deduction line with an explanatory note ("$1,600 other expenses + $900 recoup inside cap; cap $2,500"). Recoups marked `false` appear as a separate off-gross deduction before the cap is applied. This makes interpretation disputes impossible: the math is traceable to the exact term.

**Deal Terms card as the upstream anchor.** The amber "Recoups & off-the-tops" block on the show detail page is deliberately placed above the bonuses block in the Deal Terms card. The footer — *"Treatment locked at deal entry — no ambiguity at settlement"* — is the product's promise. If this field is filled in correctly when Mariana enters the deal, the downstream dispute can't happen.

**No new UI primitives.** Every component reuses the existing design system: `PlainBadge` for treatment pills, the bonuses block's amber-tinted pattern for the recoups block, the existing `Row` component's `note` prop for worksheet context lines, the existing rose disputed callout pattern for the dispute detail. No new abstractions were introduced.

---

## What I Cut

**Deal entry form.** The single most impactful missing piece is a form where Mariana enters deal terms at booking time — including a forced choice on recoup treatment. Without it, `dealRecoupsJson` can only be populated by engineers. I cut it because it requires designing a multi-step booking flow, which is a significant surface on its own. The current implementation proves the schema and the downstream rendering work; the entry form is the next natural sprint.

**Interactive dispute resolution.** The "Withdraw recoup" and "Revise & resubmit" buttons on the dispute detail block are presentational — no server action is wired. A real dispute resolution flow requires auth, role-based permissions (Mariana vs Marcus vs the agent's TM), email notifications, and a state machine that currently only exists in the schema. I kept the buttons to make the design intent clear without pretending the workflow is complete.

**Tier ratchet support.** The engine still logs tier ratchets as unsupported. They require vs-deal support to function (they modify the percentage structure), which is now in place, but implementing them correctly adds meaningful complexity. I left a clear comment in `applyBonuses`.

---

## How I'd Validate This

**Recoup treatment accuracy.** Run the Coastal Spell deal through both interpretations (`insideExpenseCap: true` and `false`) and verify the engine produces $12,285 and $11,565 respectively — the exact numbers from the email thread. This is a deterministic unit test, not a judgment call.

**Coverage across deal types.** Pull all 537 seeded shows and verify `calculateSettlement` returns `supported: true` for all of them. Before this change, ~75% returned `supported: false`. The reports page `inAppToolUsageRate` metric captures this.

**Edge cases for the cap.** Write unit tests for: (a) recoup alone exceeds the cap, (b) recoup + expenses together exceed the cap, (c) no recoup but expense cap still applies, (d) no cap at all. The `resolveRecoups` helper handles all four but they should be explicitly tested.

**Regression on flat/percentage-of-gross.** Confirm the two previously-supported deal types produce identical output before and after the refactor. The engine was rewritten; the flat and percentage-of-gross paths need snapshot tests against the old numbers.

**User test with Mariana's workflow.** Show a booker the Deal Terms card for a show with a structured recoup and ask: "What does this tell you about how the $900 will be handled at settlement?" If they answer correctly without reading the deal notes prose, the design is working. If they still reach for the free text, the treatment badge isn't communicating clearly enough.

---

## What I'd Ship Next

**Deal entry form with forced recoup treatment.** The form is the intervention point. When Mariana enters a vs deal with a marketing recoup, the UI should not let her save without selecting "inside expense cap" or "off gross, before cap." A radio button with a short example of each calculation is enough. This is the feature that actually prevents the Coastal Spell dispute from happening in the first place — everything else built here is the downstream benefit.

**Settlement statement PDF.** Mariana currently emails a statement to the agent's team. If that statement is generated from the same worksheet data now displayed in the UI — with the same recoup treatment labels, the same step-by-step math — there's no ambiguity gap between what Mariana sees and what Daniel receives. Format parity eliminates the most common dispute vector.

**Recoup dispute resolution flow.** Wire the "Withdraw recoup" and "Revise & resubmit" buttons to server actions. The state machine already exists in the schema (`disputed → revised → finalized`). The main design question is notification: does the agent get an email when Mariana responds, or is this pull-based? Given the email-thread nature of current disputes, a templated email on status change is the minimum viable handoff.