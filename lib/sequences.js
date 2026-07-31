// ── Sequence definitions ───────────────────────────────────────────
// A sequence is an ordered list of steps. `dayOffset` is measured from the
// moment the lead was enrolled (not from the previous send), so the cadence
// is predictable. Each step renders a plain-text email from the lead's fields.
//
// Add or edit sequences here — no schema change needed. The `id` is what you
// store on the enrollment (POST /api/enroll { sequenceId }).
//
// Links: leave them as plain https://fahcel.co/... URLs. Turn ON "Click tracking"
// in Resend → the links get wrapped automatically and clicks arrive at the
// events webhook. Don't hand-roll redirect links.

// ⚙️ CONFIG — confirm these two before going live (site domain + reply address).
const SITE = 'https://fahcel.co';
const CONTACT = 'sales@fahcel.co';

// Build the one-line opt-out footer. `unsubBase` is your deployed backend URL.
function footer(lead, unsubBase) {
  // Edge-safe base64url (no Node Buffer).
  const token = btoa(unescape(encodeURIComponent(lead.email)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const url = `${unsubBase}/api/unsubscribe?t=${token}`;
  return `\n\n—\nFahCel · Tamper-evident cold-chain compliance\nNot relevant? Unsubscribe: ${url}`;
}

const first = (name) => (name || '').trim().split(/\s+/)[0] || 'there';

export const SEQUENCES = {
  'founding-outreach': {
    id: 'founding-outreach',
    label: 'Cold-chain outreach · 4 steps',
    steps: [
      {
        id: 'intro',
        dayOffset: 0,
        subject: (l) => `${l.org ? l.org + ' — ' : ''}proving your cold chain held, per shipment`,
        body: (l, base) =>
`Hi ${first(l.name)},

I'm with FahCel. We turn every temperature-logger reading into a tamper-evident record the moment it's ingested — so you can prove your cold chain held from the dock to the shelf, not reconstruct it after a dispute.

For an operation like ${l.org || 'yours'}, that means a retail audit or a lost-cold claim is settled with a verifiable chain, not a spreadsheet nobody trusts.

Worth a short look? Here's the live tracking demo: ${SITE}/demo` + footer(l, base),
      },
      {
        id: 'casestudy',
        dayOffset: 3,
        subject: (l) => `How Nordkjøl proved their chain end to end`,
        body: (l, base) =>
`Hi ${first(l.name)},

Following up with a concrete example — here's the Nordkjøl case study: ${SITE}/case-study/nordkjol

Short version: frozen-seafood exports, a retail audit, and every pallet's cold chain verifiable on demand — no more he-said-she-said with the carrier. Happy to walk through what it'd look like for ${l.org || 'your routes'}.` + footer(l, base),
      },
      {
        id: 'roi',
        dayOffset: 7,
        subject: (l) => `What a single lost-cold dispute costs ${l.org || 'you'}`,
        body: (l, base) =>
`Hi ${first(l.name)},

Most operators we talk to have eaten at least one rejected shipment they couldn't contest. Here's a sample of the inspection-ready record FahCel produces — the kind that ends the argument: ${SITE}/sample-inspection-report.pdf

If it looks useful, the next step is a short walkthrough on one of your real routes so you can see a chain get verified yourself.` + footer(l, base),
      },
      {
        id: 'breakup',
        dayOffset: 14,
        subject: (l) => `Should I close the file?`,
        body: (l, base) =>
`Hi ${first(l.name)},

I don't want to crowd your inbox — this is my last note for now. If proving cold-chain integrity is worth a 15-minute call this quarter, just reply and I'll set it up. Otherwise I'll leave you to it.

Either way, thanks for reading.

The FahCel team
${CONTACT}` + footer(l, base),
      },
    ],
  },

  // ── FahCel playbook nurture ───────────────────────────────────────
  // For INBOUND leads who downloaded the Cold-Chain Excursion Playbook.
  // Warm, not cold — deliberately SEPARATE copy from founding-outreach so
  // playbook leads never get the Dr Fry-style cold pitch. Delivers the
  // guide, then nurtures toward a demo.
  'playbook-nurture': {
    id: 'playbook-nurture',
    label: 'Playbook nurture · 3 steps',
    steps: [
      {
        id: 'deliver',
        dayOffset: 0,
        subject: (l) => `Your Cold-Chain Excursion Playbook is inside`,
        body: (l, base) =>
`Hi ${first(l.name)},

Thanks for grabbing the Cold-Chain Excursion Playbook — here it is if you'd like it again: ${SITE}/playbook

It's a 9-minute read. If you only take one thing from it, make it the first move: freeze the record the instant the alarm fires, before you touch the pallet. Almost every avoidable write-off traces back to the silent hours after a breach, not the breach itself.

I'll follow up in a few days with the move most teams skip. Reply anytime if a question comes up.` + footer(l, base),
      },
      {
        id: 'onemove',
        dayOffset: 3,
        subject: (l) => `The move most cold-chain teams skip`,
        body: (l, base) =>
`Hi ${first(l.name)},

Quick follow-up on the playbook. The move teams skip isn't a fancy one — it's pulling the FULL temperature history, not just the peak, before making a call.

Duration and cumulative exposure decide product stability far more than a single spike. A 20-minute logging gap during a breach is worst-case until proven otherwise. Decide on the record, on the shift — a documented same-day disposition beats a perfect analysis that lands three days late.

Page 3 of the guide has the pre-departure checklist that prevents most of these in the first place: ${SITE}/playbook` + footer(l, base),
      },
      {
        id: 'demo',
        dayOffset: 7,
        subject: (l) => `Want the six moves to run themselves, ${first(l.name)}?`,
        body: (l, base) =>
`Hi ${first(l.name)},

Last note on the playbook. Everything in it is the manual version — FahCel runs the same six moves automatically: a sealed, tamper-evident temperature record from load to handoff, so the disposition and the evidence that backs it are always in one place.

If you'd like to see it on one of ${l.org ? l.org + "'s" : 'your'} real lanes, it's a 20-minute walkthrough with your own shipment data: ${SITE}/demo

Either way, hope the guide was useful.

The FahCel team
${CONTACT}` + footer(l, base),
      },
    ],
  },
};

export function getSequence(id) {
  return SEQUENCES[id] || null;
}

const DAY_MS = 86_400_000;

// When should a given step fire, relative to enrollment start?
export function dueAtForStep(enrolledAt, seq, stepIndex) {
  const step = seq.steps[stepIndex];
  return new Date(new Date(enrolledAt).getTime() + step.dayOffset * DAY_MS);
}

// Render a step into { subject, text } for a lead.
export function renderStep(seq, stepIndex, lead, backendBase) {
  const step = seq.steps[stepIndex];
  return { stepId: step.id, subject: step.subject(lead), text: step.body(lead, backendBase) };
}
