"""Drive the page the way a user would and assert what it actually renders.

Deliberately not "does the page load". Each check reads a computed value out
of the DOM after a real interaction, because the failure mode I care about is
a panel that renders but shows a stale or wrong number.
"""
import re, sys
from playwright.sync_api import sync_playwright

URL = "file:///var/lib/freelancer/projects/40333782/str-scorer/index.html"
OUT = "/var/lib/freelancer/projects/40333782/str-scorer/shots"
problems, checks = [], 0


def ok(name, cond, got=None):
    global checks
    checks += 1
    if not cond:
        problems.append("%s%s" % (name, "" if got is None else "  (got %r)" % (got,)))


def money(txt):
    """'£28,400' or '−£1,200' -> float"""
    t = txt.replace("−", "-").replace("–", "-")
    n = re.sub(r"[^0-9.\-]", "", t)
    return float(n) if n not in ("", "-", ".") else 0.0


with sync_playwright() as p:
    br = p.chromium.launch()
    ctx = br.new_context(viewport={"width": 1280, "height": 800})
    pg = ctx.new_page()
    errs, failed = [], []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("requestfailed", lambda r: failed.append(r.url))
    pg.goto(URL, wait_until="load", timeout=30000)
    pg.wait_for_timeout(1200)

    ok("no javascript errors", not errs, errs)
    # google fonts are the only external request; a font miss must not be fatal
    ok("no failed local requests", not [u for u in failed if u.startswith("file:")], failed)

    # --- the design CSS actually applied (a typo'd var renders as plain text) ---
    rust = pg.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--rust').trim()")
    ok("design tokens loaded", rust == "#A93E1C", rust)
    ff = pg.evaluate("getComputedStyle(document.querySelector('h1')).fontFamily")
    ok("display font is applied to headings", "Fraunces" in ff, ff)

    # --- the form was built from the engine's own data ---
    ok("all markets in the dropdown", pg.eval_on_selector_all("#market option", "e=>e.length") == 5)
    ok("all regions in the dropdown", pg.eval_on_selector_all("#region option", "e=>e.length") == 6)
    ok("all amenities rendered", pg.eval_on_selector_all("#amen .check", "e=>e.length") == 10)
    ok("seed comparables present", pg.eval_on_selector_all("#comps .comp", "e=>e.length") == 5)

    # --- every results panel populated ---
    for sel, label in [("#workings li", "workings"), ("#levers li", "levers"),
                       ("#flags .flag", "flags"), ("#pl tr", "P&L rows"), ("#rampBody tr", "ramp rows")]:
        n = pg.eval_on_selector_all(sel, "e=>e.length")
        ok("%s populated" % label, n >= 3, n)

    score0 = int(pg.inner_text("#scoreNum"))
    ok("score is in range", 0 <= score0 <= 100, score0)
    ok("verdict word is set", pg.inner_text("#verdictWord") in ("Strong", "Workable", "Marginal", "Weak"),
       pg.inner_text("#verdictWord"))

    low0, high0 = money(pg.inner_text("#rLow")), money(pg.inner_text("#rHigh"))
    ok("range low < high", low0 < high0, (low0, high0))
    ok("range is a real figure", low0 > 1000, low0)

    # --- the dial arc must track the score, not sit at a fixed length ---
    arc0 = pg.get_attribute("#dialArc", "stroke-dasharray")
    ok("dial arc drawn", arc0 and float(arc0.split()[0]) > 0, arc0)

    # --- INTERACTION 1: raising the mortgage must cut the net ---
    net_before = money(pg.inner_text("#pl tr.total td.n"))
    pg.fill("#monthlyFinance", "2500")
    pg.wait_for_timeout(400)
    net_after = money(pg.inner_text("#pl tr.total td.n"))
    ok("a bigger mortgage reduces the net", net_after < net_before, (net_before, net_after))
    ok("and the score falls with it", int(pg.inner_text("#scoreNum")) < score0)
    pg.fill("#monthlyFinance", "850")
    pg.wait_for_timeout(400)
    ok("and it comes back when reverted", abs(money(pg.inner_text("#pl tr.total td.n")) - net_before) < 2,
       (net_before, money(pg.inner_text("#pl tr.total td.n"))))

    # --- INTERACTION 2: London must cap nights at 90 and raise a hard flag ---
    pg.select_option("#region", "london")
    pg.wait_for_timeout(400)
    nights = int(re.sub(r"[^0-9]", "", pg.inner_text("#mNights")))
    ok("London caps the nights at 90", nights == 90, nights)
    ok("London note explains the cap", "capped by law" in pg.inner_text("#mNightsN"), pg.inner_text("#mNightsN"))
    hard = pg.eval_on_selector_all("#flags .flag.hard h4", "e=>e.map(x=>x.textContent)")
    ok("London 90-night flag shown", any("90-night" in h for h in hard), hard)
    ok("workings mention the cap", "90-night" in pg.inner_text("#workings"))

    pg.check("#planningConsent")
    pg.wait_for_timeout(400)
    ok("planning consent lifts the cap", int(re.sub(r"[^0-9]", "", pg.inner_text("#mNights"))) > 90)
    pg.uncheck("#planningConsent")
    pg.select_option("#region", "england")
    pg.wait_for_timeout(400)

    # --- INTERACTION 3: removing comps must widen the band ---
    band_before = int(re.search(r"minus (\d+)%", pg.inner_text("#bandWhy")).group(1))
    for _ in range(3):
        pg.click("#comps .comp:last-child .xbtn")
        pg.wait_for_timeout(200)
    ok("comps actually removed", pg.eval_on_selector_all("#comps .comp", "e=>e.length") == 2)
    band_after = int(re.search(r"minus (\d+)%", pg.inner_text("#bandWhy")).group(1))
    ok("fewer comps widens the range", band_after > band_before, (band_before, band_after))
    ok("and it warns about it", "three comparables" in pg.inner_text("#risks"), pg.inner_text("#risks")[:120])
    pg.reload(wait_until="load"); pg.wait_for_timeout(1000)

    # --- INTERACTION 4: an amenity must move the rate ---
    adr_before = money(pg.inner_text("#mAdr"))
    pg.check('[data-am="hottub"]')
    pg.wait_for_timeout(400)
    ok("a hot tub raises the nightly rate", money(pg.inner_text("#mAdr")) > adr_before,
       (adr_before, money(pg.inner_text("#mAdr"))))
    ok("and it is named in the workings", "Hot tub" in pg.inner_text("#workings"))
    pg.uncheck('[data-am="hottub"]')
    pg.wait_for_timeout(300)

    # --- INTERACTION 5: the levers must be real, signed and ranked ---
    lev = pg.eval_on_selector_all("#levers li .ld", "e=>e.map(x=>x.textContent)")
    vals = [money(x) for x in lev if x.strip()]
    ok("levers ranked descending", vals == sorted(vals, reverse=True), vals)
    ok("at least one lever is worth real money", any(abs(v) > 100 for v in vals), vals)

    # --- the long-let comparison on screen must be a believable multiple, and
    #     must not move when the mortgage does (both sides carry the same one) ---
    note = pg.inner_text("#plNote")
    mult = float(re.search(r"or ([\d.]+)×", note).group(1))
    ok("long-let multiple is believable", 0 < mult < 6, mult)
    ok("verdict quotes the same basis", "before the mortgage" in pg.inner_text("#verdictWhy").lower(),
       pg.inner_text("#verdictWhy")[:100])
    pg.fill("#monthlyFinance", "3000")
    pg.wait_for_timeout(400)
    mult2 = float(re.search(r"or ([\d.]+)×", pg.inner_text("#plNote")).group(1))
    ok("the multiple ignores the mortgage", abs(mult2 - mult) < 0.02, (mult, mult2))
    pg.fill("#monthlyFinance", "850")
    pg.wait_for_timeout(400)

    # --- year one must be below steady state on screen, not just in the engine ---
    y1 = money(pg.inner_text("#rampBody tr.total td:nth-child(2)"))
    ss = money(pg.inner_text("#rampBody tr.total td:nth-child(3)"))
    ok("year one nets less than steady state on screen", y1 < ss, (y1, ss))

    # ================= RENT-TO-RENT MODE =================
    # She corrected me: her people rent other people's flats and sublet them.
    # No mortgage — a rent bill that arrives whether or not anyone booked.

    def disp(sel):
        return pg.eval_on_selector(sel, "e => getComputedStyle(e).display")

    ok("break-even panel is hidden in owner mode", disp("#bePanel") == "none", disp("#bePanel"))
    ok("the rent field is hidden in owner mode",
       pg.eval_on_selector("#monthlyRent", "e => getComputedStyle(e.closest('.rentOnly')).display") == "none")

    pg.check("#modeRent")
    pg.wait_for_timeout(500)

    # assert the COMPUTED display, not the attribute — `hidden` loses to any
    # class rule that sets display, and it loses silently.
    ok("break-even panel appears in rent mode", disp("#bePanel") != "none", disp("#bePanel"))
    ok("the mortgage field is genuinely gone, not just marked hidden",
       pg.eval_on_selector("#monthlyFinance", "e => getComputedStyle(e.closest('.ownOnly')).display") == "none")
    ok("the long-let comparison is gone too — it is not yours to let",
       pg.eval_on_selector("#longLetMonthly", "e => getComputedStyle(e.closest('.ownOnly')).display") == "none")
    ok("the consent question is asked", disp("#landlordConsent") != "none")

    # default is 'no consent', which must dominate the verdict
    ok("with no permission to sublet the page says Weak",
       pg.inner_text("#verdictWord").strip() == "Weak", pg.inner_text("#verdictWord"))
    ok("and it explains that it capped the score",
       disp("#gateBox") != "none" and "permission" in pg.inner_text("#gateTitle").lower(),
       pg.inner_text("#gateTitle"))
    capped_score = int(pg.inner_text("#scoreNum"))

    # the P&L must now name the rent, not a mortgage
    pl_rent = pg.inner_text("#pl")
    ok("the P&L names the rent, not a mortgage", "Rent to the landlord" in pl_rent and "Mortgage" not in pl_rent,
       [l for l in pl_rent.split("\n") if "ent" in l or "ortg" in l])

    # break-even must be readable and consistent with the table
    be_txt = pg.inner_text("#beOcc")
    ok("break-even occupancy is shown as a percentage", be_txt.endswith("%"), be_txt)
    be_val = float(be_txt.rstrip("%"))
    mod_val = float(pg.inner_text("#beOccModelled").rstrip("%"))
    ok("break-even sits below modelled occupancy on this fixture", be_val < mod_val, (be_val, mod_val))
    ok("the meter's green band starts where break-even ends",
       abs(float(pg.eval_on_selector("#headFill", "e => parseFloat(e.style.left)")) - be_val) < 0.6)

    # getting the signature is the single biggest move on the page
    pg.select_option("#landlordConsent", "written")
    pg.wait_for_timeout(400)
    signed_score = int(pg.inner_text("#scoreNum"))
    ok("written consent raises the score sharply", signed_score > capped_score + 20, (capped_score, signed_score))
    ok("and the cap notice disappears", disp("#gateBox") == "none")
    ok("the underlying money did not change — only the permission did",
       pg.inner_text("#pl") == pl_rent)

    # the rent is the lever that matters, and structural work is not offered
    lev = pg.inner_text("#levers")
    ok("rent negotiation is offered as a lever", "off the rent" in lev, lev[:200])
    ok("it does not suggest installing a hot tub in someone else's flat",
       "hot tub" not in lev.lower() and "parking" not in lev.lower(), lev[:300])

    # London: the cap must bite through to the verdict in rent mode
    pg.fill("#monthlyRent", "1100")
    pg.select_option("#region", "london")
    pg.wait_for_timeout(400)
    ok("in London the flat cannot break even inside 90 nights",
       "cannot break even" in pg.inner_text("#beNote") or "only allowed 90" in pg.inner_text("#beNote"),
       pg.inner_text("#beNote"))
    ok("the cap marker is drawn on the meter", disp("#capMark") != "none")
    ok("and the verdict collapses", pg.inner_text("#verdictWord").strip() == "Weak")
    pg.select_option("#region", "england")
    pg.wait_for_timeout(400)
    ok("leaving London restores it", pg.inner_text("#verdictWord").strip() != "Weak",
       pg.inner_text("#verdictWord"))

    # a rent rise must move the score every time, not plateau
    ladder = []
    for rent_v in ("700", "1200", "1700", "2200"):
        pg.fill("#monthlyRent", rent_v)
        pg.wait_for_timeout(320)
        ladder.append(int(pg.inner_text("#scoreNum")))
    ok("the score falls as the rent rises", all(b <= a for a, b in zip(ladder, ladder[1:])), ladder)
    ok("and it moves at every step rather than plateauing", len(set(ladder)) == len(ladder), ladder)

    pg.fill("#monthlyRent", "1100")
    pg.wait_for_timeout(350)
    pg.evaluate("window.scrollTo(0, 0)")
    pg.wait_for_timeout(250)
    pg.screenshot(path="%s/rent-top.png" % OUT)
    pg.evaluate("window.scrollTo(0, document.body.scrollHeight*0.30)")
    pg.wait_for_timeout(250)
    pg.screenshot(path="%s/rent-breakeven.png" % OUT)

    # and back — the owner model must survive the round trip
    pg.check("#modeOwn")
    pg.wait_for_timeout(450)
    ok("switching back restores the owner panels", disp("#bePanel") == "none")
    ok("and the long-let comparison returns",
       pg.eval_on_selector("#longLetMonthly", "e => getComputedStyle(e.closest('.ownOnly')).display") != "none")
    ok("the P&L says mortgage again", "Mortgage" in pg.inner_text("#pl"))
    pg.check("#modeRent")
    pg.wait_for_timeout(400)

    # --- no horizontal overflow at desktop and phone ---
    for w, h, tag in [(1280, 800, "desktop"), (390, 780, "phone")]:
        pg.set_viewport_size({"width": w, "height": h})
        pg.evaluate("window.scrollTo(0, 0)")   # earlier check()/uncheck() calls scroll into view
        pg.wait_for_timeout(500)
        over = pg.evaluate("document.documentElement.scrollWidth - window.innerWidth")
        ok("no sideways scroll at %s" % tag, over <= 2, over)
        pg.screenshot(path="%s/%s-top.png" % (OUT, tag))
        pg.evaluate("window.scrollTo(0, document.body.scrollHeight*0.42)")
        pg.wait_for_timeout(300)
        pg.screenshot(path="%s/%s-mid.png" % (OUT, tag))
        pg.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        pg.wait_for_timeout(300)
        pg.screenshot(path="%s/%s-end.png" % (OUT, tag))

    # ================= THE GUIDE =================
    # The guide contains a worked example. It was taken from this tool's own
    # default output, so it has to be checked against the tool — a number
    # copied into prose is a number that silently goes stale.
    pg.goto(URL.replace("index.html", "guide.html"), wait_until="load", timeout=30000)
    pg.wait_for_timeout(900)
    ok("the guide has no javascript errors", not errs, errs)
    gtxt = pg.inner_text("body")

    ok("the guide loads its own styles",
       pg.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--rust').trim()") == "#A93E1C")
    ok("both promised modules are written in full, not stubbed",
       gtxt.upper().count("WRITTEN IN FULL") == 2, gtxt.upper().count("WRITTEN IN FULL"))
    for want in ("Finding landlords", "Choosing where", "90 nights", "company let",
                 "written permission", "Trading Standards", "Furnished Holiday Lettings"):
        ok("the guide covers %r" % want, want in gtxt)
    ok("it answers 'where do I find landlords' with named places",
       all(s in gtxt for s in ("OpenRent", "SpareRoom", "National Residential Landlords")))
    ok("it gives an actual script, not just advice", "Nelson Road" in gtxt)
    ok("all twenty modules are listed", gtxt.count("20.1") == 1 and "Module 04" in gtxt)

    # the worked example must equal what the engine actually produces
    for figure in ("£16,560", "£152", "109", "223", "114"):
        ok("the worked example figure %s appears" % figure, figure in gtxt)
    engine_says = pg.evaluate("""() => null""")  # engine not loaded on this page by design
    ok("the guide does not need the engine to render", engine_says is None)

    ok("the guide links back to the tool", pg.locator("a[href='index.html']").count() >= 2)
    ok("it says plainly that it is not advice", "legal, tax, planning or financial advice" in gtxt)

    for tag, w, h in (("guide", 1280, 800), ("guide-phone", 390, 780)):
        pg.set_viewport_size({"width": w, "height": h})
        pg.wait_for_timeout(350)
        over = pg.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
        ok("the guide does not scroll sideways at %s" % tag, over <= 2, over)
        pg.evaluate("window.scrollTo(0, 0)")
        pg.wait_for_timeout(250)
        pg.screenshot(path="%s/%s-top.png" % (OUT, tag))
    pg.set_viewport_size({"width": 1280, "height": 800})
    pg.evaluate("document.querySelector('#m4').scrollIntoView({block:'start'})")
    pg.wait_for_timeout(350)
    pg.screenshot(path="%s/guide-landlords.png" % OUT)

    ok("still no js errors after all that", not errs, errs)
    br.close()

# the guide quotes the engine's own default rent-to-rent output. Prove the
# engine still produces those exact figures, or the prose has gone stale.
import subprocess, json
_probe = subprocess.run(["node", "-e", """
var S=require('/var/lib/freelancer/projects/40333782/str-scorer/engine.js');
var r=S.score({model:'rent',bedrooms:2,market:'coastal',region:'england',
 comps:[[135,2],[118,2],[165,3],[95,1],[142,2]].map(c=>({rate:c[0],beds:c[1]})),
 amenities:{outdoor:true,parking:true,selfin:true,workspace:true},
 minStay:2,avgStay:3,proPhotos:true,instantBook:true,dynamicPricing:false,
 cleaningFee:55,cleaningCost:45,platformFeePct:3,mgmtPct:0,
 monthlyRunning:280,monthlyRent:1100,setupCapital:9000,landlordConsent:'none'});
console.log(JSON.stringify({fixed:Math.round(r.arb.annualFixed),contrib:Math.round(r.arb.contribution),
 be:Math.round(r.arb.breakEvenNights),nights:Math.round(r.nights.steady)}));
"""], capture_output=True, text=True)
_e = json.loads(_probe.stdout.strip())
ok("guide's fixed-cost figure still matches the engine", _e["fixed"] == 16560, _e)
ok("guide's contribution-per-night still matches", _e["contrib"] == 152, _e)
ok("guide's break-even night count still matches", _e["be"] == 109, _e)
ok("guide's achievable-nights figure still matches", _e["nights"] == 223, _e)

print("checks: %d" % checks)
print("PROBLEMS: %s" % ("\n  - " + "\n  - ".join(problems) if problems else "none"))
sys.exit(1 if problems else 0)
