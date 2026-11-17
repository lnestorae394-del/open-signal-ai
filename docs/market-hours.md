# Forex / OTC market access

The signal API applies the current Pocket Option asset schedule in the broker's published fixed server clock (UTC+2):

- Most regular Forex pairs: Monday-Friday, 02:00-22:45.
- GBP/CAD and GBP/CHF: Monday-Friday, 04:10-22:45.
- Regular Forex: closed Saturday and Sunday.
- OTC: not subject to the Forex calendar; remains available 24/7.

The API blocks Forex signal creation when the pair is closed and when the selected expiry would cross that pair's session close. The API checks the same rule again when a signal is opened. The Mini App refreshes the schedule periodically, removes closed Forex instruments from the pair picker, and keeps OTC selectable.

The schedule is a broker timetable, not a live asset-status feed. Broker holiday changes, exceptional suspensions, or maintenance may differ from the published standard hours. The source of the timetable is Pocket Option's [Assets trading schedule](https://pocketoption.com/en/assets) and [OTC schedule](https://pocketoption.com/en/assets-otc/).
