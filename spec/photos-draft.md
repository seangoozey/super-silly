# Autolife Photos — DRAFT (brainstorm capture, not scheduled)

Status: design capture only. Do not implement until the core system is stable
and boring. This document exists so the design survives the chat it was born
in (2026-08-24) and so decisions are already made when work starts.

## The fiction

Characters take phone pictures of their life — selfies mid-activity, objects,
places — and send them at believable moments, as if photographed just now.
A photo is the strongest possible evidence of the autolife fiction: she said
she was at soccer practice, and here is the muddy cleat. This is the Phase 2
"media messages" concept from the original plan.

## Constraints that shape everything

- **VRAM**: the chat model (22B Q5, ~15.5 GB) and krea 2 (~13 GB) cannot
  coexist on the P40. Generation must happen while the chat model is
  unloaded. Middle-of-the-night idle GPU is the free resource.
- **krea 2 is text-to-image only.** There is no good i2i for it today; an
  i2i-capable variant would change the identity approach (see below) the day
  it ships. The generation backend is therefore an abstract interface, not a
  hard dependency: ComfyUI container today, whatever is best later.
- **Temporal honesty**: a photo generated at 3am must arrive as if taken
  moments ago. Either it is generated *for a future activity window* and
  held until that window is live, or it is picked from a standing pool that
  matches the current context.

## The two strategies

**A. Scheduled synthesis** — the character invents a premise for a specific
upcoming activity window ("latte selfie at the café, Tuesday 2pm, annoyed at
the foam art"), the image is generated overnight, and it becomes sendable
only while that window is live (± ~90 min). Delivered via her normal
initiative/reply flow with a caption she wrote at premise time.

- Pros: photos are specific to her actual day; caption and image are
  coherent; premise can draw on journal/mood/relationship.
- Cons: cannot respond to spontaneous requests ("send me a pic") — the image
  for *this* moment doesn't exist yet.

**B. Tagged pool** — generate a library of tagged photos (activity, place,
mood, shot type: `cafe,selfie,daytime`, `soccer,field,dusk` …). At send
time the engine picks a photo whose tags match her current schedule state,
journal mood, or an explicit user request, and sends it immediately.

- Pros: temporally immediate — "send me a pic" gets a photo seconds later;
  pool is generated in bulk during the same nightly window.
- Cons: less reliable matching (tags approximate the moment); pool depletion
  and reuse need used-once semantics and retirement; the photo is plausible
  rather than purpose-taken.

**Recommendation: hybrid.** Strategy A for narrative moments (the scheduled
café selfie arrives at 2:04pm), Strategy B as the instant-response layer for
explicit requests. Both write into the same pool with the same metadata, so
delivery logic is one mechanism.

## Identity consistency — the open problem

Every photo must plausibly be the same person. The option ladder, cheapest
to best:

1. **Locked appearance descriptor + seed family**: a fixed, detailed
   appearance block baked into every premise prompt plus stable seeds.
   Imperfect; works best with identity-forgiving compositions.
2. **Reference-guided** (ip-adapter / face reference / i2i): her card avatar
   as the identity source. Blocked today — krea 2 has no good i2i — but this
   unlocks for free if an i2i variant ships. Watch for it.
3. **Per-character LoRA**: trained on a handful of reference images.
   Best consistency; genuinely hard to train well. Under investigation.

Whatever the method, composition guidance should bias toward shots that
hide identity drift: close-crop selfies, objects, mirror shots, scenes
without people. Never hands doing things, never group photos, never text in
image.

## Aesthetic: amateur phone photo, not AI glamour

The style template is part of the product. Imperfect lighting, slightly-off
framing, phone-camera grain, occasional motion blur — glossy AI perfection
is an instant tell. The premise prompt template must enforce this.

## Nightly pipeline choreography

1. Quiet hours begin → engine pauses generations (already holds replies).
2. `manager.stop()` — chat llama-server dies, VRAM frees.
3. ComfyUI container runs the batch: per character, N premises for tomorrow
   (strategy A) + pool top-up (strategy B). ~1–2 min/image on the P40;
   3–5 images per character per night is realistic.
4. ComfyUI container down (container kill guarantees VRAM is freed).
5. Morning: first chat request cold-loads the chat model (~1–2 min, already
   normal behavior after any model swap).
6. Failure handling: a failed night is a shrug — the pool carries over;
   no photo is better than a bad photo.

## Storage & metadata

`data/<user>/autolife/photos/<character>/<id>.png` plus `<id>.json`:

```
{ id, premise, tags[], caption, strategy: 'scheduled'|'pool',
  windowStart, windowEnd, created, usedAt: null, retired: false }
```

Pool semantics: `usedAt` set on first send (used-once by default), scheduled
photos expire at window end, retirement flags images the user rejected.

## Delivery

- Telegram: `sendPhoto` with her caption (transport already exists; photo
  send is a new method).
- Web UI: attachment on the mirrored chat message.
- Attach rules: initiative may attach when a scheduled window is live or a
  pool tag matches her current activity; a reply attaches when the user's
  message requests a pic (intent detection can be naive — explicit phrases
  first). A photo is never sent without a caption she wrote.

## Quality gate (unresolved)

What rejects a bad image before she sends it? Options: nightly panel review
queue (human approves each morning — safe, adds a chore), automated checks
(neither of us trusts these for hands/faces), or a per-photo audit trail so
the user can retire bad ones and the premise/prompt pair is preserved for
tuning. Start human-in-the-loop; automate only what proves annoying.

## Staging (deliberate order)

1. **Manual pool ingestion** — you put pre-made images + captions into the
   pool; build delivery only. Validates timing, attachment, caption UX with
   zero model risk. The delivery pipeline is the part worth building first.
2. **Premise generation** — chat model writes premises/captions into the
   pool for a future window; still no generation backend.
3. **Generation backend** — ComfyUI container, nightly batch, the swap
   choreography.
4. **Pool tagging + instant requests** — strategy B.

Each stage works standalone; the riskiest component (image quality) comes
last and stays replaceable.

## Open questions

- Identity: LoRA effort vs waiting for an i2i-capable krea variant.
- Pool size per character before repetition becomes noticeable.
- Should she ever *reference* a photo she sent days ago (memory integration),
  and does that require storing image descriptions in the memory index?
