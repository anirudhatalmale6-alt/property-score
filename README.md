# PropertyScore — short-let potential scorer

A working demonstration of an AirDNA-style tool: enter a property and some
comparable listings, get a score, a revenue range, a full profit and loss, a
ranked list of what would improve it, and the UK rules that apply.

Open `index.html` in a browser. Nothing to install, no keys, no network calls.

## What is in here

| file | what it is |
|---|---|
| `engine.js` | All of the maths. Pure — no DOM, no network, no randomness. |
| `index.html` | The interface. Reads its dropdowns and checkboxes out of the engine so the two cannot drift apart. |
| `check.js` | 74 assertions on the engine. `node check.js` |
| `ui_check.py` | 40 assertions driving the real page in a browser. `python3 ui_check.py` |

Both suites must print `PROBLEMS: none`.

## Why the engine is a separate pure file

Because it makes the arithmetic testable. A scoring tool where the numbers
live inside the page is a tool nobody can check — including the person who
built it. Splitting it means `check.js` can pin down specific figures:
that four identical 2-bed comps reproduce the rate exactly, that the London
cap binds nights rather than occupancy, that the net ties back to its own
line items.

Several of those assertions exist because they caught something.

## The model, in short

1. **Nightly rate** — each comparable is normalised to a per-bedroom-unit
   rate using a sub-linear curve (a 3-bed is 2.21× a 1-bed, not 3×), the
   **median** is taken so one aspirational listing cannot drag the set, and
   it is scaled back up to the subject property.
2. **Amenities** lift the rate multiplicatively, capped at +35% in total.
3. **Occupancy** starts from a market-type baseline and is adjusted by
   minimum stay, instant book, photography, pricing strategy and management.
4. **Year one is ramped** — quarters at 55/75/90/100% of steady state,
   averaging 0.80. This is the line most projections leave out.
5. **The London 90-night cap binds nights, not occupancy.** Getting this
   wrong is the classic error in a tool built for the US market.
6. **The long-let comparison is made before finance**, because the mortgage
   is identical either way. Leaving it in both sides produces multiples like
   "10× better" that are arithmetically true and completely misleading.
7. **The output is a range.** Its width comes from how much the comparables
   disagree and how many there are.

## What it deliberately does not do

It has no market data of its own. Every figure is built from comparables the
user types in.

That is the honest position, not a shortcut. The expensive part of AirDNA is
not the maths — it is licensing or collecting millions of listings and their
booking calendars. This engine is the part that sits on top of that data. Feed
it a licensed market feed and the comparables fill themselves; nothing else in
the model changes.

It also does not know achieved rates, only asking rates, and it is not tax,
legal or lending advice.
