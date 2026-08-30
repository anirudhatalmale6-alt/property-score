/* ===========================================================================
   Short-let scoring engine  —  the whole of the maths, in one place.

   Design rule for this file: it is PURE. No DOM, no network, no keys, no
   randomness. Same input in, same numbers out, in a browser or in node. That
   is what makes it testable — check.js runs it head-of-house with fixed
   fixtures and asserts the arithmetic, which you cannot do to a black box.

   Second design rule: every number this returns carries its own workings.
   AirDNA hands you "£38,400/yr" and you either believe it or you don't. Here
   each figure comes back with the line items that produced it, so an owner
   (or their lender) can argue with a specific step instead of the total.
   =========================================================================== */

(function (root) {
  'use strict';

  /* ---------- shaped reference data -------------------------------------
     These are the opinions of the model. They are set out as data, not
     buried in the code, precisely so they can be argued with and replaced
     when real market data is available. Every one of them is a default that
     a licensed data feed would override. */

  var MARKETS = {
    city:      { label: 'City centre',              occ: 63, peakShare: 0.30, note: 'Steady midweek business demand, shallow seasonality.' },
    coastal:   { label: 'Coastal / holiday',        occ: 50, peakShare: 0.48, note: 'Summer-loaded. Half the year can carry the other half — or fail to.' },
    rural:     { label: 'Rural / countryside',      occ: 45, peakShare: 0.42, note: 'Weekend-led. Midweek is the whole problem.' },
    events:    { label: 'Events / university town', occ: 52, peakShare: 0.40, note: 'Spiky. Graduation, festivals, fixtures do the heavy lifting.' },
    suburban:  { label: 'Suburban / commuter',      occ: 42, peakShare: 0.32, note: 'Thin leisure demand. Usually the weakest short-let case.' }
  };

  /* Amenity uplifts are applied to nightly rate, multiplicatively, and the
     stack is capped — because in the real world you cannot bolt on eight
     features and double your rate. */
  var AMENITIES = [
    { key: 'hottub',    label: 'Hot tub',                   adr: 0.12, occ: 3 },
    { key: 'view',      label: 'Sea / landmark view',       adr: 0.08, occ: 1 },
    { key: 'parking',   label: 'Off-street parking',        adr: 0.05, occ: 2 },
    { key: 'burner',    label: 'Log burner / fireplace',    adr: 0.04, occ: 1 },
    { key: 'outdoor',   label: 'Garden or usable outdoor',  adr: 0.04, occ: 1 },
    { key: 'aircon',    label: 'Air conditioning',          adr: 0.03, occ: 1 },
    { key: 'workspace', label: 'Fast wifi + real desk',     adr: 0.03, occ: 2 },
    { key: 'ev',        label: 'EV charger',                adr: 0.02, occ: 1 },
    { key: 'pets',      label: 'Pet friendly',              adr: 0.02, occ: 3 },
    { key: 'selfin',    label: 'Self check-in',             adr: 0.01, occ: 3 }
  ];
  var ADR_UPLIFT_CAP = 1.35;

  /* Regulation. This is the part a US-built tool gets wrong, and it is the
     usual reason a British short-let pro-forma turns out to be fiction. */
  var REGIONS = {
    london:   { label: 'London', flags: [
      { sev: 'hard', title: '90-night annual cap',
        body: 'Letting a whole home in Greater London for more than 90 nights a year needs planning permission for change of use (Deregulation Act 2015). Airbnb enforces the cap on its own platform. Any projection above 90 whole-home nights assumes either planning consent, a let-by-room model, or spilling onto other platforms.' },
      { sev: 'soft', title: 'Cap bites the projection directly',
        body: 'Where the cap applies, occupancy is not the constraint — 90 nights is. The engine flags this below.' } ] },
    scotland: { label: 'Scotland', flags: [
      { sev: 'hard', title: 'Short-term let licence is mandatory',
        body: 'Every short-term let in Scotland needs a licence from the council. Operating without one is an offence. Budget for the fee, the fire/gas/electrical certification and the processing time before the first booking.' },
      { sev: 'hard', title: 'Control areas need planning permission too',
        body: 'In a designated control area (Edinburgh, and others) changing a whole flat to short-let use also needs planning permission, which is frequently refused.' } ] },
    wales:    { label: 'Wales', flags: [
      { sev: 'hard', title: '182-day letting threshold',
        body: 'To be rated as a self-catering business rather than council tax, the property must be available 252 days and actually let 182 days a year. Miss it and you fall back to council tax — with a premium of up to 300% in some counties. That is a five-figure swing.' },
      { sev: 'soft', title: 'Statutory licensing scheme in train',
        body: 'Wales has legislated for a registration and licensing scheme. Assume compliance cost is coming.' } ] },
    england:  { label: 'England (outside London)', flags: [
      { sev: 'soft', title: 'Registration scheme legislated, not yet live',
        body: 'England has legislated for a short-term let registration scheme, and a separate planning use class for short lets has been consulted on. Neither is fully in force. Treat "no rules today" as a timing accident, not a permanent state.' } ] },
    ni:       { label: 'Northern Ireland', flags: [
      { sev: 'hard', title: 'Tourism NI certificate required',
        body: 'All tourist accommodation in Northern Ireland must be certified by Tourism NI before it can be advertised or let.' } ] },
    other:    { label: 'Outside the UK', flags: [
      { sev: 'soft', title: 'Local rules not modelled',
        body: 'This engine only carries UK rules. Check the city registration regime yourself before you rely on any number here.' } ] }
  };

  /* Flags for the rent-to-rent model, where you do not own the property and
     are subletting somebody else's. The risks are completely different to an
     owner's, and mostly they are not about the property at all. */
  var RENT_FLAGS = [
    { sev: 'hard', title: 'Written consent to sublet is the whole business',
      body: 'Almost every assured shorthold tenancy prohibits subletting. Without the landlord\'s written permission you are in breach from the first booking: the landlord can seek possession, keep the deposit, and sue for the profit you made. A verbal yes from a letting agent is not consent — the agent usually cannot give it, and it evaporates the moment the landlord finds out. Get a company let or a management agreement that names short lets in writing.' },
    { sev: 'hard', title: 'The rent is due whether or not anyone books',
      body: 'This is the difference between rent-to-rent and owning. An owner with an empty month loses profit; you lose cash. Twelve rent payments a year are certain, the bookings are not. Everything below turns on that one asymmetry.' },
    { sev: 'hard', title: 'The landlord\'s lease, mortgage and insurance bind you too',
      body: 'If the flat is leasehold, the head lease usually bars short lets — the freeholder can act against the landlord even if the landlord agreed with you. The landlord\'s buy-to-let mortgage almost certainly bars it as well, and their insurance will not cover paying guests. Ask to see the lease and get the consent in writing from whoever actually has the power to give it.' },
    { sev: 'soft', title: 'Rent-to-rent is where the fraud complaints are',
      body: 'The model itself is legal. The training industry around it is where Trading Standards, the Property Ombudsman and a good deal of litigation live, largely because operators sign a tenancy and sublet without telling anyone. Doing it properly is slower and much duller than the courses suggest.' },
    { sev: 'soft', title: 'Let by room and you may be running an HMO',
      body: 'Renting rooms separately to three or more unrelated people can make the property a house in multiple occupation, which needs a licence, fire doors and minimum room sizes. Whole-unit short lets do not, but the moment you split it you are in a different regime.' }
  ];

  /* Flags that apply wherever the property is — owner model. */
  var UNIVERSAL_FLAGS = [
    { sev: 'hard', title: 'Furnished Holiday Lettings regime is gone',
      body: 'The FHL tax regime was abolished from April 2025. Full mortgage-interest relief, capital allowances and the CGT reliefs that made holiday lets attractive no longer apply — short lets are now taxed broadly like any other property business. Any spreadsheet built before 2025 overstates the net.' },
    { sev: 'hard', title: 'Lease and mortgage consent',
      body: 'Most residential leases restrict use to a private residence, which the courts have read as excluding short lets. Most residential mortgages need consent or a specific product. Both are cheap to check and expensive to get wrong.' },
    { sev: 'soft', title: 'Insurance',
      body: 'Standard home and standard landlord policies generally exclude paying guests. You need a specific short-let policy.' }
  ];

  /* ---------- small helpers --------------------------------------------- */

  function num(v, d) { v = parseFloat(v); return isFinite(v) ? v : (d || 0); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function round(v, p) { var m = Math.pow(10, p || 0); return Math.round(v * m) / m; }

  function quantile(sorted, q) {
    if (!sorted.length) return 0;
    var pos = (sorted.length - 1) * q, base = Math.floor(pos), rest = pos - base;
    if (sorted[base + 1] !== undefined) return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
    return sorted[base];
  }

  /* A 3-bed does not earn three times a 1-bed. This curve is the single
     most load-bearing assumption when comps are a different size to the
     subject, so it is one line and it is visible:
       1 bed 1.00 · 2 bed 1.65 · 3 bed 2.21 · 4 bed 2.71 */
  function bedWeight(b) { return Math.pow(Math.max(0.5, num(b, 1)), 0.72); }

  /* ---------- the engine ------------------------------------------------ */

  function score(input) {
    var w = [];                       // workings: every step, in order
    function step(label, detail, value) { w.push({ label: label, detail: detail, value: value }); }

    var beds  = clamp(num(input.bedrooms, 1), 0.5, 12);
    var mkt   = MARKETS[input.market] || MARKETS.city;
    var cur   = input.currency || '£';

    /* Two completely different businesses share this engine.
         'own'  — you own it, the fixed monthly cost is a mortgage, and the
                  honest question is "versus letting it to a tenant".
         'rent' — you rent it from a landlord and sublet it (rent-to-rent /
                  arbitrage). There is no mortgage and no long-let
                  alternative, because it is not yours to let. The fixed cost
                  is rent, it is due twelve times a year regardless of
                  bookings, and the questions become: what occupancy just
                  covers the rent, how much headroom is there above that, and
                  what does the furnishing money earn?
       Everything above this line is identical for both. */
    var isRent = input.model === 'rent';
    var fixedMonthly = isRent ? num(input.monthlyRent, 0) : num(input.monthlyFinance, 0);

    /* --- 1. nightly rate from the comparables ---------------------------
       Normalise each comp to a per-bedroom-unit rate, take the MEDIAN (not
       the mean — one aspirational listing at £600 should not drag the whole
       set), then scale back up to the subject's size. */
    var comps = (input.comps || [])
      .map(function (c) { return { rate: num(c.rate, 0), beds: num(c.beds, 0) }; })
      .filter(function (c) { return c.rate > 0 && c.beds > 0; });

    var units = comps.map(function (c) { return c.rate / bedWeight(c.beds); }).sort(function (a, b) { return a - b; });
    var med   = quantile(units, 0.5);
    var p25   = quantile(units, 0.25);
    var p75   = quantile(units, 0.75);
    var spread = med > 0 ? (p75 - p25) / med : 1;

    var baseAdr = med * bedWeight(beds);
    step('Comparable nightly rates', comps.length + ' comps, median ' + cur + round(med, 0) + ' per bedroom-unit', baseAdr);

    /* --- 2. amenity uplift, capped --------------------------------------- */
    var chosen = AMENITIES.filter(function (a) { return !!(input.amenities || {})[a.key]; });
    var rawMult = chosen.reduce(function (m, a) { return m * (1 + a.adr); }, 1);
    var mult = Math.min(rawMult, ADR_UPLIFT_CAP);
    var capped = rawMult > ADR_UPLIFT_CAP;
    var adr = baseAdr * mult;
    step('Amenity uplift', chosen.length
      ? chosen.map(function (a) { return a.label; }).join(', ') + (capped ? ' (stack capped at +35%)' : '')
      : 'none selected', adr);

    /* --- 3. how far off the comp median is the asking rate? -------------
       If the owner already has a rate in mind, respect it — but let it move
       occupancy, because price and fill rate are the same lever pulled from
       two ends. */
    var priceStance = 0, ownRate = num(input.ownRate, 0);
    if (ownRate > 0 && adr > 0) {
      var delta = (ownRate - adr) / adr;
      if (delta > 0.15) priceStance = -8;
      else if (delta < -0.15) priceStance = 6;
      adr = ownRate;
      step('Your intended nightly rate', 'used instead of the modelled rate (' +
        (delta >= 0 ? '+' : '') + round(delta * 100, 0) + '% vs comps)', adr);
    }

    /* --- 4. occupancy ---------------------------------------------------- */
    var occ = mkt.occ, occLines = [{ label: mkt.label + ' baseline', pts: mkt.occ }];
    function occAdd(label, pts) { if (pts) { occ += pts; occLines.push({ label: label, pts: pts }); } }

    chosen.forEach(function (a) { occAdd(a.label, a.occ); });

    var minStay = clamp(num(input.minStay, 2), 1, 14);
    occAdd('Minimum stay ' + minStay + ' night' + (minStay > 1 ? 's' : ''),
      minStay <= 1 ? 3 : minStay === 2 ? 0 : minStay <= 4 ? -4 : -9);

    /* label the ABSENCE explicitly — "Dynamic pricing tool −4" reads as though
       the tool were a penalty, when it is not having one that costs you */
    occAdd('Instant book on', input.instantBook ? 3 : 0);
    occAdd(input.proPhotos ? 'Professional photography' : 'No professional photography',
      input.proPhotos ? 4 : -6);
    occAdd(input.dynamicPricing ? 'Dynamic pricing tool' : 'No dynamic pricing, fixed rates',
      input.dynamicPricing ? 4 : -4);
    occAdd('Managed / co-hosted', input.managed ? 3 : 0);
    occAdd(priceStance < 0 ? 'Priced above the comparables' : 'Priced below the comparables', priceStance);

    /* 82% is the believable ceiling for a very well run UK listing over a full
       year, not a stretch target. The old ceiling of 88 let a stack of good
       decisions produce an occupancy nobody actually achieves — which is
       exactly the arithmetic that gets people to sign a twelve-month rent. */
    var steadyOcc = clamp(occ, 15, 82);
    if (occ !== steadyOcc) occLines.push({ label: 'clamped to a believable range', pts: round(steadyOcc - occ, 1) });

    /* --- 5. the first-year ramp -----------------------------------------
       This is the number every optimistic spreadsheet leaves out. A listing
       with no reviews does not fill like an established one. Quarterly
       ramp 55 / 75 / 90 / 100 averages to 0.80 of steady state. */
    var RAMP = [0.55, 0.75, 0.90, 1.00];
    var rampFactor = RAMP.reduce(function (a, b) { return a + b; }, 0) / RAMP.length;
    var year1Occ = steadyOcc * rampFactor;

    /* --- 6. the London cap, applied to nights, not to occupancy ---------- */
    var region = REGIONS[input.region] || REGIONS.other;
    var capNights = (input.region === 'london' && input.wholeHome !== false && !input.planningConsent) ? 90 : null;

    function nightsFor(o) {
      var n = 365 * (o / 100);
      return capNights ? Math.min(n, capNights) : n;
    }

    var steadyNights = nightsFor(steadyOcc);
    var year1Nights  = nightsFor(year1Occ);

    step('Steady-state occupancy', occLines.map(function (l) {
      return l.label + ' ' + (l.pts > 0 ? '+' : '') + round(l.pts, 1);
    }).join(' · '), steadyOcc);
    step('Year one after the no-reviews ramp', 'quarters at 55/75/90/100% of steady state', round(year1Occ, 1));
    if (capNights) step('London 90-night cap', 'nights capped at 90 — this, not demand, is your ceiling', 90);

    /* --- 7. money -------------------------------------------------------- */
    var avgStay   = clamp(num(input.avgStay, Math.max(2, minStay)), 1, 30);
    var cleanFee  = num(input.cleaningFee, 0);
    var cleanCost = num(input.cleaningCost, 0);
    var platform  = num(input.platformFeePct, 3) / 100;
    var mgmt      = num(input.mgmtPct, 0) / 100;

    function money(nights) {
      var turns   = nights / avgStay;
      var gross   = adr * nights;
      var cleanIn = cleanFee * turns;
      var revenue = gross + cleanIn;
      var fees    = revenue * platform;
      var mgmtFee = (revenue - fees) * mgmt;
      var cleanOut = cleanCost * turns;
      var running = num(input.monthlyRunning, 0) * 12;   // utilities, insurance, council tax, service charge
      var finance = fixedMonthly * 12;                   // mortgage if you own it, rent if you do not
      var net = revenue - fees - mgmtFee - cleanOut - running - finance;
      return {
        nights: nights, turns: turns, gross: gross, cleaningIncome: cleanIn, revenue: revenue,
        platformFees: fees, mgmtFee: mgmtFee, cleaningCost: cleanOut,
        running: running, finance: finance, net: net,
        margin: revenue > 0 ? net / revenue : 0
      };
    }

    var steady = money(steadyNights);
    var year1  = money(year1Nights);

    /* --- 7b. break-even, and what the setup money earns -------------------
       For rent-to-rent this is the whole analysis, so it is computed
       properly rather than eyeballed off the annual total.

       Every let night contributes (rate + cleaning fee spread over the stay),
       less the platform cut, less the manager's cut, less the cleaner. The
       rent and the standing costs do not care how many nights you sell. So
       the break-even night count is simply fixed costs divided by the
       contribution one night makes, and the break-even OCCUPANCY that comes
       out of it is the single most useful number in the model: it is what
       you must fill before you have earned a penny.

       It is also the real answer to "which location is best". A good
       arbitrage location is not the one with the highest nightly rate — it
       is the one where the gap between break-even occupancy and achievable
       occupancy is widest. */
    var perNightRevenue = adr + (cleanFee / avgStay);
    var contribution    = perNightRevenue * (1 - platform) * (1 - mgmt) - (cleanCost / avgStay);
    var annualFixed     = (num(input.monthlyRunning, 0) + fixedMonthly) * 12;
    var maxNights       = capNights || 365;

    var breakEvenNights = contribution > 0 ? annualFixed / contribution : Infinity;
    var breakEvenOcc    = contribution > 0 ? breakEvenNights / 365 * 100 : Infinity;
    var reachable       = isFinite(breakEvenNights) && breakEvenNights <= maxNights;

    var setup = num(input.setupCapital, 0);
    var coc   = setup > 0 ? steady.net / setup : null;   // cash on cash, annual, once established

    /* Payback has to be paid back out of YEAR ONE money for the first twelve
       months, not out of steady state. Using the steady figure throughout
       said six months when the honest answer is ten — and it is the first
       year, the ramped one, that decides whether somebody runs out of cash. */
    var payback = null;
    if (setup > 0) {
      var y1Month = year1.net / 12;
      if (year1.net >= setup && y1Month > 0) {
        payback = setup / y1Month;
      } else if (steady.net > 0) {
        payback = 12 + (setup - year1.net) / (steady.net / 12);
      }
    }

    var arb = {
      perNightRevenue: perNightRevenue,
      contribution: contribution,
      annualFixed: annualFixed,
      breakEvenNights: breakEvenNights,
      breakEvenOcc: breakEvenOcc,
      /* Headroom is measured in NIGHTS, then expressed as points of the year.
         Occupancy minus break-even occupancy looks the same until a cap
         applies, and then it lies: in London this property models 82%
         occupancy and breaks even at 37%, which reads as comfortable — but
         it is only allowed 90 nights, and it needs 136. Nights notice that.
         Occupancy does not. */
      headroomNights: steadyNights - breakEvenNights,
      headroom: (steadyNights - breakEvenNights) / 365 * 100,
      reachable: reachable,
      maxNights: maxNights,
      monthlyFixed: num(input.monthlyRunning, 0) + fixedMonthly,
      setupCapital: setup,
      cashOnCash: coc,
      paybackMonths: payback,
      monthlyProfit: steady.net / 12,
      year1Profit: year1.net
    };

    if (isRent) {
      step('Every let night contributes',
        cur + round(perNightRevenue, 0) + ' of revenue less the platform, the manager and the cleaner',
        round(contribution, 2));
      step('Nights needed to cover rent and standing costs',
        cur + round(annualFixed, 0) + ' of fixed cost ÷ ' + cur + round(contribution, 2) + ' a night' +
        (reachable ? '' : ' — more nights than the year allows'),
        isFinite(breakEvenNights) ? round(breakEvenNights, 0) : 0);
      step('Break-even occupancy', 'you earn nothing at all below this',
        isFinite(breakEvenOcc) ? round(breakEvenOcc, 1) : 100);
    }

    /* --- 8. a range, not a point number ---------------------------------
       The width comes from how much the comps disagree with each other and
       how many there are. Two comps that differ by half should not produce
       a confident single figure, and a tool that shows one is lying. */
    var band = clamp(0.10 + spread * 0.45 + (comps.length < 3 ? 0.12 : comps.length < 5 ? 0.05 : 0), 0.10, 0.45);
    var range = {
      low:  steady.revenue * (1 - band),
      mid:  steady.revenue,
      high: steady.revenue * (1 + band),
      band: band
    };

    /* --- 9. the score ---------------------------------------------------- */
    var longLet = isRent ? 0 : num(input.longLetMonthly, 0);
    var yieldPts, yieldBasis, alt = null;
    if (isRent) {
      /* No long-let comparison exists here: the property is not yours to let
         to a tenant, so there is nothing to compare against. What replaces it
         is margin (does it clear the rent by enough to survive a bad quarter)
         and the return on the money you actually put in — the deposit and the
         furniture, which is the only capital at risk. */
      /* Scales chosen so the score keeps MOVING across the range a real deal
         sits in. An earlier pair saturated at 30% margin and 60% cash-on-cash,
         which made every rent from £700 to £1,700 a month score exactly 87 —
         a £12,000 difference in annual profit, invisible. Same failure as
         comparing after a shared cost: the number stops carrying information. */
      var headPts = clamp(arb.headroom / 60 * 30, 0, 30);
      var cocPts = setup > 0
        ? clamp((coc || 0) / 3.0 * 20, 0, 20)
        : clamp(steady.margin / 0.30 * 20, 0, 20);
      yieldPts = headPts + cocPts;
      /* Stated in nights whenever a cap applies, because that is the binding
         constraint and occupancy hides it. */
      yieldBasis = !isFinite(breakEvenNights)
        ? 'each night costs more to service than it earns, so no occupancy covers the rent'
        : capNights
          ? 'it needs ' + round(breakEvenNights, 0) + ' let nights to cover the rent and the cap allows ' + maxNights
          : 'it breaks even at ' + round(breakEvenOcc, 0) + '% occupancy against a modelled ' + round(steadyOcc, 0) + '%' +
            (setup > 0 ? ', and returns ' + round((coc || 0) * 100, 0) + '% a year on the ' + cur + round(setup, 0) + ' you put in' : '');
    } else if (longLet > 0) {
      /* Against the honest alternative: letting it to a tenant.
         Compare BEFORE finance. The mortgage is identical either way, so
         leaving it in both sides only shrinks the denominator — and when a
         long let barely covers its own mortgage that produces a ratio like
         "10x better", which is arithmetically true and completely
         misleading. Long lets carry roughly 10% of rent in costs. */
      var longBefore  = longLet * 12 * 0.90;
      var shortBefore = steady.net + steady.finance;
      var ratio = longBefore > 0 ? shortBefore / longBefore : 0;
      alt = {
        longBeforeFinance: longBefore,
        shortBeforeFinance: shortBefore,
        gap: shortBefore - longBefore,
        ratio: ratio,
        longNet: longBefore - steady.finance
      };
      /* 1.0x is break-even against a tenant and should NOT score well — the
         short let is far more work and more risk for the same money. */
      yieldPts = clamp((ratio - 0.5) / 2.5 * 50, 0, 50);
      yieldBasis = 'before the mortgage, which is the same either way, it earns ' +
        round(ratio, 2) + '× what it would let long term';
    } else {
      yieldPts = clamp(steady.margin / 0.40 * 50, 0, 50);
      yieldBasis = 'net margin of ' + round(steady.margin * 100, 0) + '% on revenue (no long-let comparison given)';
    }

    var demandPts = clamp((steadyOcc - 30) / 45 * 25, 0, 25);
    var confPts   = clamp((comps.length >= 5 ? 10 : comps.length * 2) + (1 - clamp(spread, 0, 1)) * 5, 0, 15);

    var risks = [], riskPts = 0;
    function risk(pts, text) { riskPts += pts; risks.push({ pts: pts, text: text }); }
    if (capNights)            risk(8, 'The 90-night London cap is doing the limiting, not the market.');

    /* Rent-to-rent specific. These sit above everything else because they are
       the ways this model actually fails, and none of them are about the
       property being nice. */
    if (isRent) {
      var consent = input.landlordConsent || 'none';
      if (consent === 'written') {
        /* no deduction — this is the correct state */
      } else if (consent === 'verbal') {
        risk(12, 'Only a verbal agreement to sublet. That is not consent. Get it in writing, from the landlord, naming short lets — an agent\'s nod will not survive the first complaint.');
      } else {
        risk(20, 'No permission to sublet. Without it there is no business here: the landlord can end the tenancy, keep the deposit and claim the profit. Every other number on this page is hypothetical until this is signed.');
      }

      if (!reachable) {
        risk(20, isFinite(breakEvenNights)
          ? 'It needs ' + round(breakEvenNights, 0) + ' let nights to cover the rent and you are only allowed ' + maxNights + '. It cannot break even.'
          : 'Each night costs more to service than it earns. No occupancy fixes that.');
      } else {
        /* headroom, graded. Break-even at 40% against a modelled 65% is a
           real business. Break-even at 62% against 65% is a job that pays
           nothing the first time a boiler goes. */
        var head = arb.headroom;
        var tight = Math.round(clamp((20 - head) / 20 * 14, 0, 14));
        if (tight >= 1) risk(tight, 'Break-even is ' + round(breakEvenOcc, 0) + '% occupancy against a modelled ' +
          round(steadyOcc, 0) + '% — only ' + round(head, 0) + ' points of headroom. The rent still arrives in February.');
      }

      if (mkt.peakShare > 0.45) risk(5, 'Seasonal market on a twelve-month rent. The quiet half of the year has to be paid for out of the busy half.');
      if (year1.net < 0)        risk(6, 'Year one loses ' + cur + round(Math.abs(year1.net), 0) + ' after the no-reviews ramp. That is cash you need in the bank before you sign.');
    }

    if (comps.length < 3)     risk(6, 'Fewer than three comparables — the range below is wide for a reason.');
    if (minStay >= 5)         risk(4, 'A five-night minimum removes most of the weekend market.');
    if (mkt.peakShare > 0.45) risk(4, 'Heavily seasonal: a bad summer is a bad year, with no second chance.');

    /* Absolute viability, separate from the long-let comparison above.
       The comparison deliberately ignores the mortgage because both options
       carry the same one — so something else has to notice when the mortgage
       is eating the whole return. Without this, a property clearing £2,600
       against a £30k mortgage scores the same as one clearing £22,400. */
    if (!isRent) {
      if (steady.net < 0) {
        risk(14, 'On these inputs it does not cover its own costs at steady state.');
      } else {
        /* graded, not a cliff — otherwise £7,499 and £3,899 of net score the same */
        var thin = Math.round(clamp((0.25 - steady.margin) / 0.25 * 10, 0, 10));
        if (thin >= 1) risk(thin, 'It clears its costs by only ' + round(steady.margin * 100, 0) +
          '% of revenue. One bad season, one boiler, and that is gone.');
      }
    }
    if (!input.proPhotos)     risk(3, 'No professional photography. It is the cheapest lever on this whole page.');

    var raw = yieldPts + demandPts + confPts - riskPts;
    var total = clamp(Math.round(raw), 0, 100);

    /* Permission to sublet is a CEILING, not a deduction.
       A deduction was wrong and I had it wrong first: a lovely flat with no
       consent scored 67 and read "Workable", when in fact there is no
       business at all until it is signed. This is the one place a hard cap
       is right, because the quantity is not continuous — you either have
       written permission or you do not, and no hot tub compensates.
       It caps rather than zeroes so that ordering is preserved within each
       state: a good deal awaiting signature still outranks a bad one. */
    var consentCap = null;
    if (isRent) {
      var c = input.landlordConsent || 'none';
      if (c === 'none') consentCap = 22;
      else if (c === 'verbal') consentCap = 48;
    }
    var consentCapped = consentCap !== null && total > consentCap;
    if (consentCapped) total = consentCap;

    var verdict = total >= 70 ? 'Strong' : total >= 50 ? 'Workable' : total >= 32 ? 'Marginal' : 'Weak';

    /* --- 10. what actually moves the number ------------------------------
       Recompute the whole thing with one thing changed at a time and rank
       by the difference. Owners want to know what to do, not what they are.
       Note the recursion is depth-1 only: every branch passes _nested. */
    var levers = [];
    if (!input._nested) {
      /* Structural improvements are only a lever if you own the place. You
         cannot install a hot tub or lay a driveway in a flat you rent, so
         offering it as advice to a rent-to-rent operator is noise dressed up
         as insight — and it was topping the list at £5,570. */
      var canAlter = !isRent;
      var trials = [
        ['Raise the nightly rate by ' + cur + '10', { ownRate: adr + 10 }],
        ['Drop the minimum stay to one night',       minStay > 1 ? { minStay: 1 } : null],
        ['Add a hot tub',                            canAlter && !(input.amenities || {}).hottub ? { amenities: Object.assign({}, input.amenities, { hottub: true }) } : null],
        ['Professional photography',                 !input.proPhotos ? { proPhotos: true } : null],
        ['Turn on dynamic pricing',                  !input.dynamicPricing ? { dynamicPricing: true } : null],
        ['Allow pets',                               !(input.amenities || {}).pets ? { amenities: Object.assign({}, input.amenities, { pets: true }) } : null],
        ['Self-manage instead of paying a manager',  num(input.mgmtPct, 0) > 0 ? { mgmtPct: 0 } : null],
        ['Add off-street parking',                   canAlter && !(input.amenities || {}).parking ? { amenities: Object.assign({}, input.amenities, { parking: true }) } : null],
        ['Add a proper desk and fast wifi',          isRent && !(input.amenities || {}).workspace ? { amenities: Object.assign({}, input.amenities, { workspace: true }) } : null],
        ['Fit a keysafe or smart lock for self check-in',
                                                     isRent && !(input.amenities || {}).selfin ? { amenities: Object.assign({}, input.amenities, { selfin: true }) } : null],
        /* The one lever that only exists in rent-to-rent, and the strongest
           one there is: it lands in full, every month, with no occupancy
           risk attached. Negotiating the rent beats almost any amount of
           listing optimisation. */
        ['Negotiate ' + cur + '100 a month off the rent',
                                                     isRent && fixedMonthly > 100 ? { monthlyRent: fixedMonthly - 100 } : null],
        ['Get a 2-month rent-free fitting-out period',
                                                     isRent && fixedMonthly > 0 ? { monthlyRent: fixedMonthly * 10 / 12 } : null]
      ];
      trials.forEach(function (t) {
        if (!t[1]) return;
        var alt = score(Object.assign({}, input, t[1], { _nested: true }));
        levers.push({ label: t[0], delta: alt.steady.net - steady.net });
      });
      levers.sort(function (a, b) { return b.delta - a.delta; });
    }

    /* --- 11. rules that apply to this property --------------------------- */
    var flags = region.flags.concat(isRent ? RENT_FLAGS : UNIVERSAL_FLAGS);

    return {
      currency: cur,
      adr: adr, baseAdr: baseAdr, amenityMultiplier: mult, amenityCapped: capped,
      comps: { count: comps.length, medianUnit: med, p25: p25, p75: p75, spread: spread },
      occupancy: { steady: steadyOcc, year1: year1Occ, lines: occLines, rampFactor: rampFactor },
      nights: { steady: steadyNights, year1: year1Nights, cap: capNights },
      steady: steady, year1: year1, range: range,
      model: isRent ? 'rent' : 'own', arb: arb,
      score: { total: total, verdict: verdict, yield: yieldPts, yieldBasis: yieldBasis,
               demand: demandPts, confidence: confPts, riskDeduction: riskPts, risks: risks,
               uncapped: clamp(Math.round(raw), 0, 100), consentCap: consentCap, consentCapped: consentCapped },
      alt: alt,
      levers: levers,
      market: mkt, region: region, flags: flags,
      workings: w
    };
  }

  var api = { score: score, MARKETS: MARKETS, AMENITIES: AMENITIES, REGIONS: REGIONS,
              RENT_FLAGS: RENT_FLAGS, UNIVERSAL_FLAGS: UNIVERSAL_FLAGS, bedWeight: bedWeight };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.STR = api;

})(typeof globalThis !== 'undefined' ? globalThis : this);
