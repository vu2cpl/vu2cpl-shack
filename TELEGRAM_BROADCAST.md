# Telegram Alerts to Multiple Recipients

How to send shack alerts (lightning, UberSDR, power, etc.) to more than one
Telegram chat. Covers three routes: a Telegram group chat, Home Assistant, and a
Node-RED fan-out. The examples follow this repo's conventions.

**Status:** design and sample code only. Nothing is deployed or tested yet
(2026-11-15). Open item: HANDOVER #58.

This file merges and replaces three drafts written on 2026-11-15 outside the repo
(an HA-only draft, a Node-RED-only draft, and a combined "v2"). It also fixes these
problems in them:

- The drafts used `node-red-contrib-telegrambot` payloads. The shack does not use that
  package. It sends with `http request` nodes (see "Current state").
- The drafts stored subscribers in **flow** context. Flow context belongs to one tab,
  and the senders are on several tabs. This doc uses **global** context.
- The drafts added any chat that messaged the bot. This doc adds a chat only when it
  is on an allowlist.
- The drafts did not mention `telegram_bot.send_message` with several chat IDs, or the
  per-group rate limit.

This repo is public. Use placeholder chat IDs here. Real IDs and tokens go only in
`secrets.conf` on the Pi or in HA's `secrets.yaml`.

---

## Current state (from the 2026-11-07 Telegram audit)

The shack uses two bots. Each bot sends to one chat, Manoj's.

| Bot | Carries | Senders |
|---|---|---|
| **HA's Telegram** | Power only | HA's grid, battery, voltage and load-shedding automations; `mains_alert.py`; `wan_usage.py`; `stabiliser_watch.py` (cron off) |
| **Shack bot** | Ham alerts and infrastructure alerts | Node-RED Lightning (`tg_lightning_router`) and UberSDR (`ubersdr_tg_xition`); `openwebrx-watch` and `rx888-watch` on .109; `restic/restic-copy.sh` and `restic-maint.sh`; the `flows_guard.py` cron; the shack-health 07:15 summary |

The shack bot's Node-RED senders work like this:

- A function node reads `TELEGRAM_TOKEN` and `TELEGRAM_CHAT_ID` with `env.get()`. Lightning
  reads them through `flow.cfg_tg_token` and `flow.cfg_tg_chat_id`.
- The values come from `/etc/systemd/system/nodered.service.d/secrets.conf`.
- The function node sets `msg.url`, `msg.method`, `msg.headers` and
  `msg.payload = {chat_id, text, parse_mode: 'HTML', ...}`.
- An `http request` node with a **blank URL field** sends the request (CLAUDE.md,
  "Telegram HTTP request node").

**Decide this first:** which alerts should reach the other recipients? The other
people probably need lightning alerts, and maybe power alerts. They probably do not
need restic, `flows_guard`, or the health summary. Pick the route for each bot after
you decide this.

---

## Prerequisites (all routes)

1. **Each recipient presses Start on the bot.** A bot cannot start a chat with a user.
   There is no workaround. A group chat is the exception, because the bot is added to
   the group.
2. **Get each recipient's chat ID.** Ways to get it:
   - The recipient messages `@userinfobot`.
   - Use the Node-RED subscribe flow below. It logs the chat ID of each stranger who
     presses Start.
   - Call `https://api.telegram.org/bot<TOKEN>/getUpdates` and read the
     `"chat":{"id":...}` entries. This works only while nothing else polls the same bot.
     When something does poll the bot, the result is empty, or the polling process has
     already confirmed and removed the updates, or Telegram returns 409 Conflict.
3. **Group chat IDs are negative.** A supergroup ID looks like `-1001234567890`. Use the
   ID exactly as Telegram shows it.

---

## Route 1: one Telegram group chat (simplest)

1. Make a Telegram group with all the recipients.
2. Add the bot to the group.
3. Send one message in the group, then read the group's (negative) chat ID with
   `getUpdates`.
4. Use the group's ID wherever the shack now uses Manoj's chat ID.

For the **shack bot**, step 4 means one edit: change `TELEGRAM_CHAT_ID` in
`secrets.conf`, then run
`sudo systemctl daemon-reload && sudo systemctl restart nodered`. Change the env
files for the `.109` watch scripts, restic and shack-health the same way.

Every sender follows, with no code change. The cost is that **every** alert, including
infrastructure alerts, goes to the group. To keep infrastructure alerts private, leave
those scripts on Manoj's chat ID. Change only the Node-RED senders, for example with a
second env var (`TELEGRAM_GROUP_CHAT_ID`) that the Lightning and UberSDR nodes read.

Limits:
- Telegram allows about **20 messages per minute** from a bot to one group.
- `tg_lightning_router` already limits each event type to 5 per 60 s. But six types
  can fire in one storm, so a bad storm could reach that limit.
- Everyone in the group sees every message and can mute the group. Nobody can choose
  only some alert types.

---

## Route 2: Home Assistant (for power alerts on HA's bot)

**Check first how HA's Telegram is set up.** Recent HA releases move `telegram_bot`
and the legacy `notify: - platform: telegram` from YAML to a UI integration. If it is a
UI integration, skip the YAML below and use option 2a. If Check Configuration warns
about deprecation, also use 2a.

### 2a. One action, several chat IDs (preferred)

`telegram_bot.send_message` accepts a list of chat IDs. You do not need a notifier for
each recipient:

```yaml
actions:
  - action: telegram_bot.send_message
    data:
      chat_id:            # older releases call this field `target:`
        - 11111111        # VU2CPL (placeholder)
        - 22222222        # recipient 2 (placeholder)
      message: "Grid lost. On battery."
```

Before you edit automations, open **Developer Tools → Actions →
`telegram_bot.send_message`** to see the field name your release uses.

### 2b. Legacy YAML: one notifier per recipient, plus a group

Use this only if HA's Telegram is still set up in YAML. Edit `/config/configuration.yaml`.

```yaml
telegram_bot:
  - platform: polling
    api_key: !secret telegram_bot_token
    allowed_chat_ids:
      - 11111111   # VU2CPL (placeholder)
      - 22222222   # recipient 2 (placeholder)

notify:            # only ONE notify: key in the file
  - platform: telegram
    name: tg_manoj
    chat_id: 11111111
  - platform: telegram
    name: tg_r2
    chat_id: 22222222
  - platform: group
    name: tg_all
    services:
      - service: tg_manoj
      - service: tg_r2
```

- Put the token in `secrets.yaml` as `telegram_bot_token: "123456789:AA..."`. Never
  put it inline.
- HA does not send to a chat ID that is not in `allowed_chat_ids`.
- Apply the change: **Developer Tools → YAML → Check Configuration** must be green.
  Then do a **full restart**, because `telegram_bot` does not hot-reload.
- Test: **Developer Tools → Actions → `notify.tg_all`** with `message: "Test alert from HA"`.
- In automations, change `action: notify.<old single notifier>` to `action: notify.tg_all`.
  The older `- service:` form still works.
- To add a recipient later: add the chat ID to `allowed_chat_ids`, add a notifier, add
  the notifier to `tg_all`'s `services:`, then restart.

### Scripts that send through HA

`mains_alert.py` and `wan_usage.py` call an HA action. Check which action each one
calls. If it is a single `notify.*` notifier, point it at the new action as well.

---

## Route 3: Node-RED fan-out (for the shack bot's Node-RED alerts)

Use this route when recipients should get only the ham alerts, or when recipients
should add and remove themselves.

### Design

```
[Lightning router] ─ link out ┐
[UberSDR xition]   ─ link out ┼─► link in ─► Fan-out ─► delay (rate limit) ─► http request ─► Drop blocked chats
(other senders)    ─ link out ┘   (new "Telegram Broadcast" tab)               (URL blank)
```

- **Use link pairs.** The senders are on different tabs. Never wire across tabs
  directly. The editor strips such wires on Deploy, and `flows_guard` rejects them
  (CLAUDE.md rule 7). Use `link out` / `link in` pairs.
- **Existing routers keep their message code.** In each router, rewire only the output:
  send it to a `link out` instead of the router's own `http request`. The fan-out
  replaces `chat_id` for each recipient.
- **Update the guard constants.** The new nodes change the node count. Update the
  `flows_guard.py` and `flows_guard_middleware.js` constants in the same commit, then
  restart Node-RED before you deploy.
- **Rate limit.** Use a delay node in "Rate Limit" mode, all messages, 20 msg/s or
  slower. Telegram allows about 30 msg/s per bot overall and about 1 msg/s to one chat.
  With a few recipients this never matters, but the node keeps the design safe.

### Recipients

There are two lists. The fan-out sends to the union of them.

| List | Where | Who changes it |
|---|---|---|
| Fixed | `TELEGRAM_CHAT_IDS=111,222` in `secrets.conf`; falls back to `TELEGRAM_CHAT_ID` | Manoj; needs `daemon-reload` + Node-RED restart |
| Self-service (optional) | `global.telegramSubscribers` in the **`file`** context store | Recipients, with `/start`, `/subscribe` and `/unsubscribe`, if they are on `TELEGRAM_ALLOWED_IDS` |

The `file` store is already enabled on noderedpi4 (`enable_file_context.sh`). It is the
`localfilesystem` module, which writes to disk every **30 s** by default. A crash inside
that window can lose a subscription made just before it. The user can send `/subscribe`
again.

### Fan-out (function node)

```javascript
// Telegram broadcast fan-out: one sendMessage request per recipient.
// Input: msg.payload is a string (text, HTML) or a ready sendMessage
// payload from an existing router (its chat_id is replaced).
// Wire: link in -> this -> delay (rate limit) -> http request (URL blank)
const token = env.get('TELEGRAM_TOKEN');
const fixed = (env.get('TELEGRAM_CHAT_IDS') || env.get('TELEGRAM_CHAT_ID') || '')
    .split(',').map(s => s.trim()).filter(Boolean);
const subs = global.get('telegramSubscribers', 'file') || [];
const chatIds = [...new Set([...fixed, ...subs.map(String)])];
if (!token || chatIds.length === 0) {
    node.warn('Telegram broadcast: no token or no recipients');
    return null;
}

const base = (typeof msg.payload === 'string')
    ? { text: msg.payload, parse_mode: 'HTML', disable_web_page_preview: true }
    : Object.assign({}, msg.payload);
delete base.chat_id;

node.status({fill:'green', shape:'dot', text: chatIds.length + ' recipients'});
return [chatIds.map(id => ({
    url: 'https://api.telegram.org/bot' + token + '/sendMessage',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    payload: Object.assign({}, base, { chat_id: id }),
    tgChatId: id
}))];
```

When a function returns `[array]`, Node-RED sends each element of the array as a
separate message on output 1. You do not need a split node.

### Drop blocked chats (function node after the http request)

Set the `http request` node to **Return: a parsed JSON object**.

```javascript
// Telegram answers 403 "Forbidden: bot was blocked by the user" when a
// recipient blocked the bot. Remove that chat from the self-service list.
// A chat on the fixed env list must be removed by hand.
if (msg.statusCode === 403 && msg.tgChatId !== undefined) {
    const subs = global.get('telegramSubscribers', 'file') || [];
    const left = subs.filter(id => String(id) !== String(msg.tgChatId));
    if (left.length !== subs.length) {
        global.set('telegramSubscribers', left, 'file');
        node.warn('Removed blocked chat ' + msg.tgChatId);
    }
} else if (msg.statusCode !== 200) {
    node.warn('Telegram send failed ' + msg.statusCode + ' for ' + msg.tgChatId);
}
return msg;
```

### Optional: self-service subscribe

Node-RED has no Telegram receiver in this shack. To receive commands, Node-RED must poll
`getUpdates`. According to the 2026-11-07 audit, every shack-bot sender only sends.
On 2026-11-15, no file in this repo, `shack-health` or `ubersdr-box` called `getUpdates`.
Check again before you enable polling, in case a new sender was added.

After polling starts, Node-RED confirms and consumes the bot's updates. A manual
`getUpdates` call then shows nothing. Never poll HA's bot from Node-RED, because HA's
`polling` platform already polls it. Two pollers on one bot cause 409 errors.

Wire:

```
inject (every 10 s) → Build getUpdates → http request (URL blank, parsed JSON) → Handle updates → http request (URL blank)
```

Build getUpdates:

```javascript
const token = env.get('TELEGRAM_TOKEN');
const offset = flow.get('tgOffset') || 0;   // tab-local is fine here
msg.url = 'https://api.telegram.org/bot' + token + '/getUpdates'
        + '?timeout=0&offset=' + offset
        + '&allowed_updates=' + encodeURIComponent('["message"]');
msg.method = 'GET';
return msg;
```

Handle updates:

```javascript
// Allowlisted chats may subscribe. /start (sent when a user presses
// Start) counts as /subscribe. Strangers get no reply; their chat ID
// is logged so Manoj can add it to TELEGRAM_ALLOWED_IDS.
const res = msg.payload;
if (!res || !res.ok) { node.warn('getUpdates failed: ' + JSON.stringify(res)); return null; }
const token = env.get('TELEGRAM_TOKEN');
const allow = (env.get('TELEGRAM_ALLOWED_IDS') || '')
    .split(',').map(s => s.trim()).filter(Boolean);
let subs = (global.get('telegramSubscribers', 'file') || []).map(String);
const out = [];

for (const u of res.result) {
    flow.set('tgOffset', u.update_id + 1);
    const m = u.message;
    if (!m || typeof m.text !== 'string') continue;
    const id = String(m.chat.id);
    const cmd = m.text.trim().split(/[\s@]/)[0].toLowerCase();
    let reply = null;

    if (cmd === '/start' || cmd === '/subscribe') {
        if (!allow.includes(id)) {
            node.warn('Telegram: subscribe from non-allowlisted chat ' + id
                + ' (' + (m.from && m.from.username || '?') + ')');
            continue;
        }
        if (!subs.includes(id)) { subs.push(id); reply = 'Subscribed to VU2CPL shack alerts.'; }
        else reply = 'Already subscribed.';
    } else if (cmd === '/unsubscribe' || cmd === '/stop') {
        if (subs.includes(id)) { subs = subs.filter(s => s !== id); reply = 'Unsubscribed.'; }
    }

    if (reply) out.push({
        url: 'https://api.telegram.org/bot' + token + '/sendMessage',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        payload: { chat_id: id, text: reply }
    });
}
global.set('telegramSubscribers', subs, 'file');
return [out];
```

To trigger broadcasts from Telegram, keep a separate admin list
(`TELEGRAM_ADMIN_IDS`) and check the sender against it. Do not use the allowlist for
this, and do not trust any chat that merely reached the bot.

---

## Which route to use

| | Group chat | HA (`send_message` / `tg_all`) | Node-RED fan-out |
|---|---|---|---|
| Change needed | One env value per sender host | One action per automation | New tab and rewired senders |
| Add or remove a recipient | Telegram group membership | Config edit (+ restart if YAML) | Env edit + restart, or self-service |
| Per-recipient choice | No | Per automation | Per list, or per alert type with extra lists |
| Best for | Small fixed family list, all alerts | Power alerts (HA's bot) | Ham alerts to a changing audience |

Keep one source of truth for each bot. Do not let HA and Node-RED both keep lists for
the same alerts.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| One recipient gets nothing | They have not pressed Start on the bot, or their ID is not in the list (`allowed_chat_ids` for HA, `TELEGRAM_CHAT_IDS` or the allowlist for Node-RED). |
| `400 Bad Request: chat not found` | Wrong chat ID, or that user never started the bot. A group ID was entered without its minus sign. |
| `403 Forbidden: bot was blocked by the user` | The recipient blocked the bot. The "Drop blocked chats" node removes self-service subscribers. Remove fixed-list IDs by hand. |
| `429 Too Many Requests` | The rate limit was hit. Check the delay node, and the 20-per-minute limit for a group. |
| `getUpdates` is empty or returns 409 | Another process is polling the same bot. |
| Config check fails on `notify:` | There are two `notify:` keys in `configuration.yaml`. Merge them. |
| Nothing works after an HA restart | Check the `telegram_bot` indentation: 2 spaces per level, no tabs. |
| Self-service list is empty after a restart | The code used the default (memory) store. Pass `'file'` on every `get`/`set`. |
| Only some flows' alerts fan out | That sender still feeds its own `http request`. Rewire it to a `link out`. |
| Deploy rejected with a guard error | The node count changed. Update the `flows_guard` constants (CLAUDE.md rule 7). |
