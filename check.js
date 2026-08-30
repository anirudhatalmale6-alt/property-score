/* Assertions against the engine. Run: node check.js
   These are not "does it return something" tests — each one pins down a
   number I would otherwise be taking on trust, and several of them are here
   because they caught something. */

var STR = require('./engine.js');
var fails = [], checks = 0;

function ok(name, cond, got) {
  checks++;
  if (!cond) fails.push(name + (got !== undefined ? '  (got ' + JSON.stringify(got) + ')' : ''));
}
function near(name, got, want, tol) {
  checks++;
  if (!(Math.abs(got - want) <= tol)) fails.push(name + '  expected ~' + want + ' got ' + got);
}

/* A base case I can reason about by hand: four 2-bed comps all at £120,
   subject is also 2-bed, so the modelled rate must come back to £120. */
var base = {
  bedrooms: 2, market: 'city', region: 'england', currency: '£',
  comps: [{ rate: 120, beds: 2 }, { rate: 120, beds: 2 }, { rate: 120, beds: 2 }, { rate: 120, beds: 2 }],
  amenities: {}, minStay: 2, avgStay: 3,
  cleaningFee: 45, cleaningCost: 40, platformFeePct: 3, mgmtPct: 0,
  monthlyRunning: 250, monthlyFinance: 700
};

var r = STR.score(base);

near('identical 2-bed comps reproduce the rate exactly', r.baseAdr, 120, 0.01);
near('no amenities means no uplift', r.amenityMultiplier, 1, 0.0001);
near('city baseline occupancy carries through', r.occupancy.steady, 68 + 0 + 0 - 6 - 4, 0.01);

/* the ramp is the number people leave out — pin it */
near('year-one ramp factor is 0.80', r.occupancy.rampFactor, 0.80, 0.001);
near('year one occupancy is 80% of steady', r.occupancy.year1, r.occupancy.steady * 0.8, 0.01);
ok('year one earns less than steady state', r.year1.net < r.steady.net, [r.year1.net, r.steady.net]);

/* the bedroom curve: a 3-bed must not be 3x a 1-bed */
near('bedWeight 1', STR.bedWeight(1), 1.00, 0.001);
near('bedWeight 2', STR.bedWeight(2), 1.647, 0.01);
near('bedWeight 3', STR.bedWeight(3), 2.206, 0.005);
near('bedWeight 4', STR.bedWeight(4), 2.713, 0.005);
ok('3-bed is well under 3x a 1-bed', STR.bedWeight(3) < 2.4, STR.bedWeight(3));

/* comps of a DIFFERENT size to the subject must be scaled, not averaged raw.
   Four 1-bed comps at £100 -> a 2-bed subject should land near £165, not £100. */
var diff = STR.score(Object.assign({}, base, {
  bedrooms: 2, comps: [{ rate: 100, beds: 1 }, { rate: 100, beds: 1 }, { rate: 100, beds: 1 }, { rate: 100, beds: 1 }]
}));
near('1-bed comps scale up to a 2-bed subject', diff.baseAdr, 164.7, 1.0);

/* the median must ignore one silly outlier */
var out = STR.score(Object.assign({}, base, {
  comps: [{ rate: 120, beds: 2 }, { rate: 120, beds: 2 }, { rate: 120, beds: 2 }, { rate: 600, beds: 2 }]
}));
near('one £600 fantasy listing does not move the median', out.baseAdr, 120, 0.01);
ok('but it does widen the range', out.range.band > r.range.band, [out.range.band, r.range.band]);

/* amenity stack is capped */
var all = {};
STR.AMENITIES.forEach(function (a) { all[a.key] = true; });
var maxed = STR.score(Object.assign({}, base, { amenities: all }));
ok('amenity stack is capped at +35%', maxed.amenityMultiplier <= 1.3501, maxed.amenityMultiplier);
ok('and it reports that it capped', maxed.amenityCapped === true);

/* London: the cap must bind NIGHTS, not occupancy — this is the whole point */
var lon = STR.score(Object.assign({}, base, { region: 'london' }));
near('London whole-home is capped at 90 nights', lon.nights.steady, 90, 0.01);
ok('the uncapped equivalent would have been higher', r.nights.steady > 90, r.nights.steady);
ok('London raises a hard flag', lon.flags.some(function (f) { return f.sev === 'hard' && /90-night/.test(f.title); }));

var lonOk = STR.score(Object.assign({}, base, { region: 'london', planningConsent: true }));
ok('with planning consent the cap lifts', lonOk.nights.steady > 90, lonOk.nights.steady);

/* Scotland and Wales each carry their own hard flag */
ok('Scotland flags the licence', STR.score(Object.assign({}, base, { region: 'scotland' }))
  .flags.some(function (f) { return /licence/i.test(f.title); }));
ok('Wales flags the 182-day threshold', STR.score(Object.assign({}, base, { region: 'wales' }))
  .flags.some(function (f) { return /182/.test(f.title); }));
ok('the FHL abolition is flagged everywhere', r.flags.some(function (f) { return /Furnished Holiday/i.test(f.title); }));

/* money arithmetic — recompute the net by hand from the parts */
var s = r.steady;
near('revenue = rate x nights + cleaning income',
  s.revenue, r.adr * s.nights + base.cleaningFee * s.turns, 0.01);
near('net ties back to its own line items',
  s.net, s.revenue - s.platformFees - s.mgmtFee - s.cleaningCost - s.running - s.finance, 0.01);
near('platform fee is 3% of revenue', s.platformFees, s.revenue * 0.03, 0.01);
near('running costs are the monthly figure x12', s.running, 250 * 12, 0.01);
near('finance is the monthly figure x12', s.finance, 700 * 12, 0.01);
near('turns = nights / average stay', s.turns, s.nights / 3, 0.001);

/* a management fee must reduce the net, and by roughly the right amount */
var mg = STR.score(Object.assign({}, base, { mgmtPct: 20 }));
ok('a 20% manager cuts the net', mg.steady.net < s.net, [mg.steady.net, s.net]);
near('and the fee is 20% of revenue after platform fees',
  mg.steady.mgmtFee, (mg.steady.revenue - mg.steady.platformFees) * 0.20, 0.01);

/* the range must be a real range, and wider when the comps disagree */
ok('low < mid < high', r.range.low < r.range.mid && r.range.mid < r.range.high);
var thin = STR.score(Object.assign({}, base, { comps: [{ rate: 120, beds: 2 }] }));
ok('one comp gives a wider band than four', thin.range.band > r.range.band, [thin.range.band, r.range.band]);
ok('one comp costs confidence points', thin.score.confidence < r.score.confidence);
ok('one comp raises a risk', thin.score.risks.some(function (x) { return /three comparables/.test(x.text); }));

/* The long-let comparison must be made BEFORE finance, or a property whose
   rent barely covers its mortgage produces an absurd multiple. This is the
   exact bug this block exists to stop coming back. */
var thin_margin = STR.score(Object.assign({}, base, { longLetMonthly: 1150, monthlyFinance: 850 }));
near('long-let side is rent x12 less 10% costs', thin_margin.alt.longBeforeFinance, 1150 * 12 * 0.9, 0.01);
near('short-let side adds the mortgage back', thin_margin.alt.shortBeforeFinance,
  thin_margin.steady.net + thin_margin.steady.finance, 0.01);
ok('the multiple stays believable', thin_margin.alt.ratio < 6, thin_margin.alt.ratio);
near('gap ties to the two sides', thin_margin.alt.gap,
  thin_margin.alt.shortBeforeFinance - thin_margin.alt.longBeforeFinance, 0.01);

/* and it must be INSENSITIVE to the mortgage, since both sides carry it */
var big_mortgage = STR.score(Object.assign({}, base, { longLetMonthly: 1150, monthlyFinance: 3000 }));
near('the ratio does not move when the mortgage does',
  big_mortgage.alt.ratio, thin_margin.alt.ratio, 0.001);
ok('but the actual net does move', big_mortgage.steady.net < thin_margin.steady.net);

/* breaking even against a tenant must not score as a win */
var breakeven = STR.score(Object.assign({}, base, {
  longLetMonthly: Math.round((r.steady.net + r.steady.finance) / 12 / 0.9), monthlyFinance: 700 }));
near('break-even is 1.0x', breakeven.alt.ratio, 1.0, 0.02);
ok('and 1.0x earns well under half the yield points', breakeven.score.yield < 20, breakeven.score.yield);

ok('no long-let figure means no comparison object', r.alt === null);

/* ...but the SCORE must still notice the mortgage, via absolute viability
   rather than via the comparison. This pairs with the check above: the ratio
   is insensitive to finance on purpose, so something else has to care. */
function atFinance(f) { return STR.score(Object.assign({}, base, { longLetMonthly: 1150, monthlyFinance: f })); }
var thinPos = atFinance(1600);   // measured: net +£2,699, margin 9.4%
var loss    = atFinance(2500);   // measured: net −£8,101

ok('the thin fixture really is thin but positive', thinPos.steady.net > 0 && thinPos.steady.margin < 0.10,
  [thinPos.steady.net, thinPos.steady.margin]);
ok('a thin margin lowers the score', thinPos.score.total < thin_margin.score.total,
  [thin_margin.score.total, thinPos.score.total]);
ok('and it says why', thinPos.score.risks.some(function (x) { return /clears its costs by only/.test(x.text); }),
  thinPos.score.risks.map(function (x) { return x.text; }));
ok('a thin but positive margin is not reported as a loss',
  !thinPos.score.risks.some(function (x) { return /does not cover/.test(x.text); }));
ok('an actual loss is reported as a loss',
  loss.score.risks.some(function (x) { return /does not cover/.test(x.text); }));
ok('a loss scores below a thin margin', loss.score.total < thinPos.score.total,
  [thinPos.score.total, loss.score.total]);
ok('a healthy margin raises neither viability risk',
  !thin_margin.score.risks.some(function (x) { return /clears its costs|does not cover/.test(x.text); }));

/* the deduction must be graded, not a cliff: every step up in mortgage
   should weakly lower the score, and at least one middle step must differ */
var ladder = [700, 1200, 1400, 1500, 1600, 1800, 2200, 2500].map(function (f) { return atFinance(f).score.total; });
ok('score never rises as the mortgage rises',
  ladder.every(function (v, i) { return i === 0 || v <= ladder[i - 1]; }), ladder);
ok('the response is graded, not one cliff',
  new Set(ladder).size >= 4, ladder);

/* score behaves monotonically where it should */
ok('score is 0-100', r.score.total >= 0 && r.score.total <= 100, r.score.total);
var rich = STR.score(Object.assign({}, base, {
  monthlyFinance: 0, monthlyRunning: 100, proPhotos: true, dynamicPricing: true, instantBook: true,
  amenities: { hottub: true, parking: true, outdoor: true }
}));
ok('a better property scores higher', rich.score.total > r.score.total, [rich.score.total, r.score.total]);
ok('a strong case is labelled', ['Strong', 'Workable'].indexOf(rich.score.verdict) >= 0, rich.score.verdict);

var awful = STR.score(Object.assign({}, base, { monthlyFinance: 4000, minStay: 7, comps: [{ rate: 60, beds: 2 }] }));
ok('a loss-making property scores low', awful.score.total < 32, awful.score.total);
ok('and says so in the risks', awful.score.risks.some(function (x) { return /own costs/.test(x.text); }));

/* the levers must be real recomputations, ranked, and must not recurse forever */
ok('levers are produced', r.levers.length >= 4, r.levers.length);
ok('levers are sorted by impact', r.levers.every(function (l, i) {
  return i === 0 || r.levers[i - 1].delta >= l.delta; }));
ok('nested runs do not produce levers (no infinite recursion)',
  STR.score(Object.assign({}, base, { _nested: true })).levers.length === 0);
var photoLever = r.levers.filter(function (l) { return /photograph/i.test(l.label); })[0];
ok('professional photography shows as a positive lever', photoLever && photoLever.delta > 0,
  photoLever && photoLever.delta);
ok('an already-true option is not offered as a lever',
  !rich.levers.some(function (l) { return /dynamic pricing/i.test(l.label); }));

/* asking above the comps must cost occupancy, not be free money */
var greedy = STR.score(Object.assign({}, base, { ownRate: 200 }));
ok('pricing 66% above comps costs occupancy', greedy.occupancy.steady < r.occupancy.steady,
  [greedy.occupancy.steady, r.occupancy.steady]);
near('but the rate used is the one you asked for', greedy.adr, 200, 0.01);

/* purity: the same input twice must give the same answer */
ok('engine is deterministic',
  JSON.stringify(STR.score(base)) === JSON.stringify(STR.score(base)));

/* no comps at all must not explode */
var empty = STR.score(Object.assign({}, base, { comps: [] }));
ok('no comps does not throw and returns zero rate', empty.adr === 0, empty.adr);

/* workings must be present and populated — the transparency IS the feature */
/* a negative occupancy line must name the ABSENCE, not the thing itself —
   "Dynamic pricing tool -4" reads as if the tool were the penalty */
function occLabels(x) { return x.occupancy.lines.filter(function (l) { return l.pts < 0; })
  .map(function (l) { return l.label; }); }
ok('missing photos is labelled as missing', occLabels(r).some(function (l) { return /^No professional/.test(l); }), occLabels(r));
ok('missing dynamic pricing is labelled as missing', occLabels(r).some(function (l) { return /^No dynamic pricing/.test(l); }), occLabels(r));
var withBoth = STR.score(Object.assign({}, base, { proPhotos: true, dynamicPricing: true }));
ok('when present, the same lines are positive and plainly named',
  withBoth.occupancy.lines.some(function (l) { return l.label === 'Professional photography' && l.pts > 0; }) &&
  withBoth.occupancy.lines.some(function (l) { return l.label === 'Dynamic pricing tool' && l.pts > 0; }),
  withBoth.occupancy.lines);
ok('no occupancy line is a bare negative of a feature name',
  !occLabels(withBoth).some(function (l) { return /^(Professional photography|Dynamic pricing tool)$/.test(l); }));
ok('over-pricing is named as over-pricing',
  occLabels(greedy).some(function (l) { return /Priced above/.test(l); }), occLabels(greedy));

ok('workings are returned', r.workings.length >= 3, r.workings.length);
ok('every working has a label and a detail',
  r.workings.every(function (x) { return x.label && x.detail; }));

console.log('checks: ' + checks);
console.log('PROBLEMS: ' + (fails.length ? '\n  - ' + fails.join('\n  - ') : 'none'));
process.exit(fails.length ? 1 : 0);
