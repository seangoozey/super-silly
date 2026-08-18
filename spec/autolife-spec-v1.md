# Autolife — Autonomous Character Card Extension, Version 1.0

Status: **Draft v1.0** (implementation target for super-silly v0.1)
Base: [Character Card Spec V3](https://github.com/kwaroran/character-card-spec-v3) (`spec: "chara_card_v3"`, `spec_version: "3.0"`)

## 1. Overview

Autolife is a card **extension**, not a fork. An Autolife card is a fully valid
Character Card V3 (or V2) whose `data.extensions` object carries an `autolife`
namespace describing a character that:

- has a **schedule** (weekly rhythm: work, sleep, hobbies) in its own timezone;
- **does not always reply** — replies can be instant, delayed, or occasionally
  missed, depending on what the character is currently doing;
- can **initiate** conversations on its own;
- keeps an engine-maintained **journal** and a **relationship** score that grow
  across conversations, making it behave like a person texting you between the
  events of their day — a *texting simulator*, not a turn-based chatbot.

Conforming Autolife data lives in exactly one place:

```jsonc
{
    "spec": "chara_card_v3",
    "spec_version": "3.0",
    "data": {
        // ...all normal CCv3 fields, unchanged...
        "extensions": {
            "autolife": {
                // everything below
            }
        }
    }
}
```

Per the V2/V3 specs' namespacing rule, applications MUST NOT destroy the
`autolife` key on import/export, and applications that don't understand
Autolife MUST still be able to use the card as a normal character card.
Nothing in the base card is reinterpreted: `description`, `personality`,
`scenario`, `first_mes`, and `system_prompt` keep their CCv3 meanings and are
what the Autolife engine uses to prompt the model.

## 2. Runtime split: card vs. state

The card carries **identity and parameters only**. Everything the character
"experiences" (pending replies, initiative cooldowns, relationship score,
journal contents) is **runtime state owned by the engine** and stored outside
the card. Cards are therefore shareable: two people importing the same card
start with the same person, who then lives differently for each of them.

| Lives in the card (`data.extensions.autolife`) | Lives in engine state |
|---|---|
| schedule, behavior, initiative, relationship *initial value*, journal *on/off* | current availability snapshot, pending reply jobs, initiative counters, relationship *current* score, journal entries, transport bindings |

## 3. The `autolife` object

All fields are optional unless marked **required**. Unknown fields inside
`autolife` MUST be preserved by editors (same forward-compatibility rule as
the base spec).

```jsonc
{
    // Required. "1.0". Readers MUST NOT reject higher minor versions.
    "version": "1.0",

    // IANA timezone the character lives in (e.g. "America/New_York").
    // The schedule is evaluated in this zone regardless of server timezone.
    // Default: "UTC".
    "timezone": "America/New_York",

    // Weekly schedule. Array of blocks, evaluated in order, FIRST MATCH WINS.
    // Times outside every block are the character's free time.
    // Default: [] (always free).
    "schedule": [
        {
            // Days of week the block starts on. 0=Sunday .. 6=Saturday.
            // Default: [0,1,2,3,4,5,6].
            "days": [1,2,3,4,5],

            // Local start time "HH:MM" (24h). Required.
            "start": "09:00",

            // Local end time "HH:MM" (24h). Required.
            // end < start means the block wraps past midnight
            // (e.g. 22:00→06:00); `days` names the START day.
            // start == end means the block covers the whole day.
            "end": "17:00",

            // What the character is doing, as a short natural phrase.
            // Fed verbatim to the model ("You are currently at work").
            // Default: "busy".
            "activity": "at her studio job",

            // 0..1 — how available they are to text during this block.
            //   1.0  phone in hand, replies fast
            //   0.3  can text, but distracted; replies slow and short
            //   0.05 effectively unreachable (driving, asleep)
            // Drives reply probability, delay scaling, and initiative.
            // Default: 0.5.
            "availability": 0.25,

            // Optional mood during this block, fed to the model
            // ("feeling focused"). Default: null (no mood cue).
            "mood": "focused"
        }
    ],

    // How the character handles inbound messages. See §5.
    "behavior": { ... },

    // Proactive messaging. See §6.
    "initiative": { ... },

    // Relationship model. See §7.
    "relationship": { ... },

    // Engine-maintained life journal. See §8.
    "journal": { ... }
}
```

### 3.1 Schedule evaluation

Given a moment in time, the engine resolves the character's local weekday and
minutes-since-midnight, then walks `schedule` in order:

1. A block matches if its start-day is today and the time is inside
   `[start, end)`; for wrapping blocks (`end < start`) the early-morning
   remainder also matches blocks that *started yesterday*.
2. The first matching block wins; later blocks do not override it.
3. If nothing matches, the character is **free**: `activity: "free with spare
   time"`, `availability: 0.8`.

`activity`, `availability`, and `mood` from the winning block (or the free-time
defaults) form the character's **life context** and are injected into every
prompt, so the same card answers differently at 2pm on a workday and 2am on a
Sunday.

## 4. Texting conventions

Autolife prompts instruct the model to write like real text messages: short,
casual, 1–3 sentences, no novel-length replies, no narrated actions unless the
conversation has established that style. `behavior.avg_message_length`
("short" | "medium" | "long") tunes this. The greeting (`first_mes`) and
`mes_example` remain the strongest style anchors — card authors are encouraged
to write them as texts, not as prose scene openers.

## 5. `behavior` — inbound response model

```jsonc
{
    // Probability the character replies quickly when free-ish.
    // Actual quick-probability = quick_reply_chance × clamp(availability, 0.05, 1).
    // Range 0..1. Default: 0.5.
    "quick_reply_chance": 0.5,

    // When not quick, the reply is delayed by a uniform sample of
    // [delay_minutes_min, delay_minutes_max] minutes.
    // Defaults: 5 and 90.
    "delay_minutes_min": 5,
    "delay_minutes_max": 90,

    // Multiplier applied to the sampled delay while the character is busy
    // (availability < 0.35). Default: 3.0.
    "busy_delay_multiplier": 3.0,

    // Baseline probability the character never replies to a given message
    // (missed it, forgot). Scaled up ~2–3× while busy. Default: 0.05.
    "ignore_chance": 0.05,

    // If a message was ignored, the character may later send an unprompted
    // "sorry, was slammed" catch-up message once it's free again.
    // Default: true.
    "catch_up": true,

    // "short" (default) | "medium" | "long".
    "avg_message_length": "short"
}
```

Additional user messages arriving while a reply is already pending do not
stack new decisions: the engine keeps the earliest due time and the reply is
generated against the full recent chat tail, so the character naturally
answers the latest thing said. While a reply is pending, inbound messages do
NOT re-roll `ignore_chance`.

## 6. `initiative` — proactive messaging

```jsonc
{
    // Master switch for unprompted messages. Default: false.
    "enabled": true,

    // Minimum minutes between initiative messages. Also used as the
    // expectation window: the per-tick probability is derived so an
    // available character initiates roughly once per this window.
    // Default: 120.
    "min_gap_minutes": 120,

    // Hard cap on initiative messages per character-day (their local
    // midnight). Default: 4.
    "max_per_day": 4,

    // If the character sent the last message and the user never replied,
    // after this many hours the character may double-text once.
    // 0 disables. Default: 6.
    "followup_on_unread_hours": 6
}
```

Initiative never fires while the character is effectively unreachable
(availability < 0.05, e.g. asleep), while a reply is pending, or within
20 minutes of the character's own last message. Initiative prompts receive
the character's journal and life context, so an unprompted text should feel
caused by their day ("just got out of the gym, you were right about that
class...").

## 7. `relationship` — affinity model

```jsonc
{
    // Starting score 0..100. Default: 20 ("friendly acquaintance").
    "initial": 20
}
```

The engine evolves the score at runtime (small gains from contact and replies,
slow decay without contact) and maps it to descriptors fed to the model:
`0–19 distant`, `20–39 friendly`, `40–59 close`, `60–79 very close`,
`80+ deeply bonded`. v1 movement rules are engine defaults (not card fields):
+1 per user message (max +5/day), +2 when the user replies to an initiative
message, −1 per full day without contact, clamped to [0, 100]. Future spec
versions may expose per-card tuning.

## 8. `journal` — the character's inner log

```jsonc
{
    // Engine periodically generates 1–2 sentence private notes about what
    // the character has been doing/thinking, kept in runtime state (capped,
    // oldest pruned). When true these notes are injected into initiative and
    // reply prompts as private context. Default: true.
    "enabled": true
}
```

The journal is never shown to the user directly (a future spec version may
add a consent flag for surfacing it); it exists so proactive messages have
material beyond the chat history.

## 9. Validation rules (summary)

A `autolife` object is valid when:

- `version` is the string `"1.0"` or `"1.x"` (x ≥ 0);
- `timezone`, if present, is a valid IANA zone name;
- every schedule block has `start`/`end` matching `^([01]?\d|2[0-3]):[0-5]\d$`,
  `days` ⊆ {0..6} (unique), `availability` ∈ [0,1];
- all `behavior` probabilities are in [0,1] and
  `0 ≤ delay_minutes_min ≤ delay_minutes_max ≤ 1440`;
- `initiative.min_gap_minutes` ≥ 1, `max_per_day` ≥ 0,
  `followup_on_unread_hours` ≥ 0;
- `relationship.initial` ∈ [0,100];
- no unknown *type* collisions (unknown keys are preserved but ignored).

Validators MUST return all problems at once (not fail-fast) so card tools can
report everything in one pass. `tools/card-tools.mjs validate` implements this
list; the plugin uses the same module.

## 10. What engines MUST / SHOULD do

- MUST evaluate the schedule in the card's `timezone`.
- MUST NOT write runtime state back into the card.
- MUST keep the card usable as a plain CCv3 card (no required reinterpretation
  of base fields).
- SHOULD expose the character's current activity/availability to the user
  surface (e.g. Telegram `/status`, SillyTavern panel) — the "life" should be
  observable, not just felt.
- SHOULD surface delayed replies as "typing" where the transport supports it,
  and SHOULD deliver delayed replies out-of-band (push) rather than only when
  the user opens the app.
- SHOULD rate-limit outbound messages to transport limits.

## 11. Changelog

- **1.0** — initial spec: schedule, behavior, initiative, relationship.initial,
  journal.enabled.
