"""Drive the page the way a user would and assert what it actually renders.

Deliberately not "does the page load". Each check reads a computed value out
of the DOM after a real interaction, because the failure mode I care about is
a panel that renders but shows a stale or wrong number.
"""
import re, sys
from playwright.sync_api import sync_playwright

URL = "https://anirudhatalmale6-alt.github.io/property-score/"
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

    ok("still no js errors after all that", not errs, errs)
    br.close()

print("checks: %d" % checks)
print("PROBLEMS: %s" % ("\n  - " + "\n  - ".join(problems) if problems else "none"))
sys.exit(1 if problems else 0)
