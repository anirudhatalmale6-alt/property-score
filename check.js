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
near('city baseline occupancy carries through', r.occupancy.steady, 63 + 0 + 0 - 6 - 4, 0.01);
/* 82, not 88. A stack of good decisions should not add up to an occupancy
   nobody sustains over a full year — that arithmetic is how people talk
   themselves into a twelve-month rent liability. */
ok('the occupancy ceiling is believable', STR.score(Object.assign({}, base, {
  market: 'city', proPhotos: true, dynamicPricing: true, instantBook: true, managed: true,
  amenities: { hottub: true, view: true, parking: true, selfin: true, pets: true, workspace: true }
})).occupancy.steady <= 82);

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

/* =======================================================================
   RENT-TO-RENT.  A different business sharing the same engine: you do not
   own the property, there is no mortgage, and the rent is due twelve times
   a year whether or not anybody books.
   Fixtures below are MEASURED off a probe run, not guessed — guessing them
   is what cost two rounds last time.
   ======================================================================= */

var rentBase = {
  model: 'rent', bedrooms: 2, market: 'city', region: 'england',
  comps: [{ rate: 110, beds: 2 }, { rate: 125, beds: 2 }, { rate: 95, beds: 1 }, { rate: 140, beds: 3 }],
  amenities: { workspace: true, selfin: true },
  minStay: 2, avgStay: 3, instantBook: true, proPhotos: true, dynamicPricing: true,
  cleaningFee: 45, cleaningCost: 40, platformFeePct: 3, mgmtPct: 0,
  monthlyRunning: 260, monthlyRent: 1100, setupCapital: 9000,
  landlordConsent: 'written'
};
function rent(o) { return STR.score(Object.assign({}, rentBase, o)); }
var rr = rent({});

ok('rent mode is reported as such', rr.model === 'rent', rr.model);

/* --- the rent replaces the mortgage as the fixed cost ------------------- */
near('the rent lands in the P&L as the fixed annual cost', rr.steady.finance, 1100 * 12, 0.01);
ok('a mortgage figure is ignored in rent mode',
  rent({ monthlyFinance: 4000 }).steady.net === rr.steady.net);
ok('there is no long-let comparison, because it is not yours to let',
  rr.alt === null);
ok('and supplying one anyway changes nothing',
  rent({ longLetMonthly: 1400 }).score.total === rr.score.total);

/* --- break-even: the number the whole model turns on -------------------- */
ok('break-even occupancy is below the modelled occupancy here',
  rr.arb.breakEvenOcc < rr.occupancy.steady, [rr.arb.breakEvenOcc, rr.occupancy.steady]);
/* the definition itself: at exactly break-even nights, net must be zero */
var beNights = rr.arb.breakEvenNights;
var atBE = rr.arb.perNightRevenue * (1 - 0.03) * beNights - (40 / 3) * beNights - rr.arb.annualFixed;
near('at break-even nights the profit is exactly zero', atBE, 0, 1);
ok('more rent pushes break-even up', rent({ monthlyRent: 1600 }).arb.breakEvenOcc > rr.arb.breakEvenOcc);
ok('a higher nightly rate pulls break-even down', rent({ ownRate: 200 }).arb.breakEvenOcc < rr.arb.breakEvenOcc);

/* --- headroom must be measured in NIGHTS, or the London cap escapes it --
   This is the bug worth a test: in London the flat still models 79%
   occupancy and still breaks even at 37%, which looks comfortable. It is
   allowed 90 nights and needs 136. Occupancy cannot see that. */
var lon = rent({ region: 'london' });
near('the cap does not move break-even occupancy at all', lon.arb.breakEvenOcc, rr.arb.breakEvenOcc, 0.01);
ok('but it does make it unreachable', lon.arb.reachable === false && rr.arb.reachable === true);
ok('headroom goes negative under the cap', lon.arb.headroom < 0, lon.arb.headroom);
ok('the London flat is judged Weak', lon.score.verdict === 'Weak', [lon.score.total, lon.score.verdict]);
ok('and the reason names the nights, not the occupancy',
  lon.score.risks.some(function (x) { return /90/.test(x.text) && /night/.test(x.text); }),
  lon.score.risks.map(function (x) { return x.text; }));
ok('planning consent lifts the cap and the verdict with it',
  rent({ region: 'london', planningConsent: true }).arb.reachable === true);

/* --- consent to sublet is a CEILING, not a deduction -------------------
   A flat with no permission scored 67 and read "Workable" before this. */
var written = rr, verbal = rent({ landlordConsent: 'verbal' }), none = rent({ landlordConsent: 'none' });
ok('the underlying deal is identical in all three', written.steady.net === none.steady.net);
ok('written consent scores best', written.score.total > verbal.score.total);
ok('verbal beats nothing, and both are capped', verbal.score.total > none.score.total);
ok('no consent can never read better than Weak', none.score.verdict === 'Weak', none.score.total);
ok('verbal can never read better than Marginal',
  ['Weak', 'Marginal'].indexOf(verbal.score.verdict) >= 0, verbal.score.verdict);
ok('the cap is recorded so the page can explain itself', none.score.consentCapped === true);
ok('the uncapped score is kept, so the cap is visible as a cap',
  none.score.uncapped > none.score.total, [none.score.uncapped, none.score.total]);
/* no amount of property quality buys its way past a missing signature */
ok('a perfect property with no consent still cannot pass',
  rent({ landlordConsent: 'none', monthlyRent: 400, setupCapital: 2000,
         amenities: { workspace: true, selfin: true, pets: true } }).score.verdict === 'Weak');
/* but ordering INSIDE a consent state is preserved — it caps, it does not flatten */
ok('a good deal still outranks a bad one at the same consent level',
  rent({ landlordConsent: 'none', monthlyRent: 700 }).score.total >=
  rent({ landlordConsent: 'none', monthlyRent: 2400 }).score.total);
ok('owner mode is untouched by any of this',
  STR.score(Object.assign({}, base, { landlordConsent: 'none' })).score.total === r.score.total);

/* --- the score must keep MOVING with the rent --------------------------
   The first pair of scales saturated, so every rent from £700 to £1,700
   scored exactly 87 — a £12,000 swing in annual profit, invisible. Same
   failure as comparing after a shared cost: the number stops informing. */
var ladder = [700, 900, 1100, 1300, 1500, 1700, 1900, 2100, 2400]
  .map(function (m) { return rent({ monthlyRent: m }).score.total; });
ok('score never rises as the rent rises',
  ladder.every(function (v, i) { return i === 0 || v <= ladder[i - 1]; }), ladder);
ok('and it is strictly graded, not a plateau', new Set(ladder).size >= 7, ladder);
ok('the profit ladder falls with it too',
  [700, 1500, 2400].map(function (m) { return rent({ monthlyRent: m }).steady.net; })
    .every(function (v, i, a) { return i === 0 || v < a[i - 1]; }));

/* --- cash on cash and payback ------------------------------------------ */
near('cash on cash is net over the money actually put in',
  rr.arb.cashOnCash, rr.steady.net / 9000, 0.0001);
/* Payback comes out of YEAR ONE money first. Charging it against steady-state
   profit answered "six months" where the truth was ten, and year one is
   precisely the year in which people run out of cash. */
near('payback is repaid out of year-one profit while year one is running',
  rr.arb.paybackMonths, 9000 / (rr.year1.net / 12), 0.01);
ok('and that is slower than the steady-state answer would have been',
  rr.arb.paybackMonths > 9000 / (rr.steady.net / 12),
  [rr.arb.paybackMonths, 9000 / (rr.steady.net / 12)]);
/* when year one cannot cover it, the remainder spills into year two */
var slow = rent({ setupCapital: 30000 });
ok('a setup cost year one cannot cover spills past twelve months',
  slow.arb.paybackMonths > 12, slow.arb.paybackMonths);
near('and the spill is the shortfall at the steady-state rate',
  slow.arb.paybackMonths, 12 + (30000 - slow.year1.net) / (slow.steady.net / 12), 0.01);
ok('no setup capital means no invented return', rent({ setupCapital: 0 }).arb.cashOnCash === null);
ok('a loss-making deal has no payback period',
  rent({ monthlyRent: 4000 }).arb.paybackMonths === null);

/* --- advice you cannot act on is not advice ---------------------------- */
function leverLabels(x) { return x.levers.map(function (l) { return l.label; }); }
ok('rent mode never suggests installing a hot tub in someone else\'s flat',
  !leverLabels(rr).some(function (l) { return /hot tub|parking/i.test(l); }), leverLabels(rr));
ok('owner mode still can', leverLabels(r).some(function (l) { return /hot tub/i.test(l); }));
ok('rent mode offers the rent negotiation, which is the real lever',
  leverLabels(rr).some(function (l) { return /off the rent/.test(l); }), leverLabels(rr));
ok('levers are still ranked by money',
  rr.levers.every(function (l, i) { return i === 0 || l.delta <= rr.levers[i - 1].delta; }));
ok('the rent-free period is worth roughly two months of rent',
  Math.abs(rr.levers.filter(function (l) { return /rent-free/.test(l.label); })[0].delta - 2200) < 1);

/* --- the flags are the rent-to-rent ones, not the owner ones ----------- */
var titles = rr.flags.map(function (f) { return f.title; }).join(' | ');
ok('subletting consent is flagged first among the rent flags', /consent to sublet/i.test(titles), titles);
ok('the twelve-month rent liability is flagged', /rent is due whether/i.test(titles));
ok('the landlord\'s own lease and mortgage are flagged', /lease, mortgage/i.test(titles));
ok('the abolished FHL regime is NOT shown to a rent-to-rent operator',
  !/Furnished Holiday/i.test(titles), titles);
ok('but the owner still sees it', /Furnished Holiday/i.test(r.flags.map(function (f) { return f.title; }).join(' | ')));
ok('the regional rules still apply to both',
  rent({ region: 'scotland' }).flags.some(function (f) { return /licence/i.test(f.title); }));

ok('rent mode is deterministic too', JSON.stringify(rent({})) === JSON.stringify(rent({})));

console.log('checks: ' + checks);
console.log('PROBLEMS: ' + (fails.length ? '\n  - ' + fails.join('\n  - ') : 'none'));
process.exit(fails.length ? 1 : 0);
