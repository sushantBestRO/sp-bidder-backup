RATE HINTS - "Last quote" and "FR8 guide" lines on the new-inquiry WhatsApp message
===================================================================================

What you get (each line is optional, shown only when it has something real to say):

    🚛 1 x 32 SXL 9T HQ . 9 MT
    💵 *Last quote* - ₹18,500 → we bid ₹19,800      <- your newest closed quote on this SAME lane + vehicle
    🏅 Rank 2 | 12/10/2026
    📊 *FR8 guide* - ₹18,200 (₹16,900–19,250)        <- FR8's published rate for the lane + truck type
    ⏰ close time ...

Display only. Neither line is ever used as the cost or to start bidding. Building the message reads one small
local file and never calls FR8, so FR8 being slow or down cannot delay a message.
Both lines are OFF until you switch them on in .env.

WHAT'S IN THIS ZIP (unzip it from the project root, e.g. /var/www/sp-bidder)
    src/notify/rateHints.js        the lookup (new file)
    scripts/fr8-rates.js           nightly FR8 refresher + coverage report (new file)
    scripts/test-rate-hints.js     50 checks, joins your normal test suite (new file)
    apply_rate_hints_patch.js      adds {{13}} to the ask template + 6 lines to notifier.js (backups made)

STEPS
 1. cd /var/www/sp-bidder && unzip -o rate-hints.zip
 2. node apply_rate_hints_patch.js
    node --check src/notify/waTemplates.js && node --check src/notify/notifier.js     (prints nothing = good)
 3. node scripts/test-rate-hints.js            -> must print:  50/50 checks passed
 4. CHECK THE PARSER ON THE REAL SITE (this is the important one - see "Not verified" below):
        node scripts/fr8-rates.js page delhi jaipur
    You should see a table of 4 rows (32ft MXL, 32ft SXL, 20/22/24ft container, 19ft open) with rates like 20850.
    If it prints "No rate rows parsed", send me that output - do NOT go further.
 5. See how many of your inquiries would actually get the FR8 line (about 6 minutes, ~250 polite requests):
        node scripts/fr8-rates.js coverage
    The last number, "messages that would carry the FR8 line", is the honest answer.
 6. Nightly refresh (3:20 am). Replace the node path with the output of: which node
        crontab -e
        20 3 * * * cd /var/www/sp-bidder && /usr/bin/node scripts/fr8-rates.js refresh >> data/logs/fr8-refresh.log 2>&1
 7. Turn it on - add to .env, then: pm2 restart bid-command
        RATE_LINE_LAST_QUOTE=1
        RATE_LINE_FR8=1
        FR8_CONTACT=<an email or phone, goes in the User-Agent so FR8 can reach you>
    (You can switch on just one of the two lines.)

TURN OFF / UNDO
    Remove the two RATE_LINE_* lines from .env and restart: the message is exactly what it was.
    Full undo: restore src/notify/waTemplates.js and notifier.js from their .bak-<number> files.

HOW MATCHING WORKS (so the lines can be trusted)
  Last quote : reuses the bidder's own history lookup - closed auctions only, same lane, same vehicle,
               same portal, never the load itself. Shows the newest one.
  FR8 guide  : shown only when ALL of these hold, otherwise the line is simply left out
               - both ends are exactly an FR8 hub city (Delhi, Jaipur, Kanpur, ...). A nearby town is NOT matched.
               - the vehicle is clearly one of: 32ft MXL container, 32ft SXL container, 20/22/24ft container, 19ft open.
                 (9 Ton Open, trailers, 40ft, "Any Vehicle", 32ft open body ... get no line.)
               - FR8 has a page for that exact direction (Delhi->Jaipur is not Jaipur->Delhi)
               - the saved rate is under 72 hours old (FR8_MAX_AGE_HOURS to change)
               - the load is not priced per tonne and has a single truck type
  Aurangabad is deliberately never matched (two cities, and the lane carries no state).

NOT VERIFIED - please read
  * I could not reach fr8.in from where I built this. The parser was written from the page content I could see
    (columns: Truck Type | Payload | Rate | Range) and is tested against several table markups, but it has not
    been run on FR8's real HTML. Step 4 is that test.
  * The page address pattern (/transport-service/<from>-transport-service/<from>-to-<to>/) is taken from FR8's own
    links. Many pairs will have no page; they are remembered for 14 days and skipped.
  * FR8's published figures are indicative: their homepage and a route page showed different numbers for the same
    route. Treat the line as a guide, never as a quote. Please also check fr8.in's terms allow automated reading.
  * The refresher is polite (one request at a time, 1.5 s apart, 15 s timeout, stops after 5 failures in a row).
