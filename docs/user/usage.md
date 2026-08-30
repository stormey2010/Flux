# Review usage

The Usage page combines Codex, Claude Code, and Cursor activity from your connected environments.
Codex and Claude Code are read from local session history; Cursor is read from Cursor's dashboard
usage API using the signed-in Cursor app session on that machine. It shows API-equivalent token
cost, processed tokens, cache savings, provider shares, and model breakdowns. Subscription billing
is separate from the raw token cost shown here.

The sidebar **Usage** control opens a compact popup with current Cursor and Codex plan limits
(percent used / remaining and reset date when available). **Full usage** opens this page.

**Provider limits** at the top of the page show remaining subscription windows from connected
providers. They are separate from the raw token cost below. On web and desktop, **Settings →
General → Show usage in chat** puts the current thread's provider limits next to the chat box after
the first message. Providers without usable quota data hide the meter.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart, and refreshing rescans every connected environment.
