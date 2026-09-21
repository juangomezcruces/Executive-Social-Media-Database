"""Registry for the two US presidents added in v1.3.0.

Source: ``trump_obama_tweets.csv``, an archive export covering four accounts.
Only two are imported, and the reasoning matters:

* ``realDonaldTrump`` -> Trump. ``POTUS45``, his official presidential
  account, is in the file but is deliberately not imported (see below).
* ``POTUS44`` -> Obama. His own presidential account: 352 tweets with a mean
  engagement around 73,000.

``ObamaWhiteHouse`` (27,347 tweets) is **not** imported. It is the
institutional White House account -- its first tweet is "Welcome to the
official Twitter page for the White House!" and it retweets federal agencies.
Its mean engagement is 713 against POTUS44's 73,136, a hundredfold gap.
Attributing it to Obama would make his record overwhelmingly staff-written and
destroy any engagement comparison, in exactly the way Modi's automated replies
did before ``is_reply`` separated them.

``POTUS45`` is excluded by the same kind of decision, though a closer one: it
overlaps ``realDonaldTrump`` by only 610 texts, so it would have added about
4,290 genuinely distinct official tweets. It is left out to keep Trump a
single-account record.

Note that ``@BarackObama``, Obama's main personal account, is absent from the
source entirely. It is the account that would be most comparable with the rest
of the dataset, and it is the obvious thing to add if an archive turns up.
"""

SOURCE_FILE = "trump_obama_tweets.csv"

US_LEADERS = [
    dict(handle_in_file="realDonaldTrump", leader_id="trump",
         name="Donald Trump", handle="realDonaldTrump",
         country="United States", iso3="USA", office="President"),
    dict(handle_in_file="POTUS44", leader_id="obama",
         name="Barack Obama", handle="POTUS",
         country="United States", iso3="USA", office="President"),
]

#: Present in the source file but intentionally not imported, with the reason.
SKIPPED_ACCOUNTS = {
    "ObamaWhiteHouse": "institutional White House account, not Obama's own voice",
    "POTUS45": "excluded to keep Trump a single-account record",
}

assert len({l["leader_id"] for l in US_LEADERS}) == len(US_LEADERS) == 2
