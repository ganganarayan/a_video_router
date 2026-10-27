// Public tool comparisons — one crawlable page per alternative at /compare/<slug>,
// linked from the landing page and listed in the Knowledge Base.
//
// Keep these HONEST. Every entry states plainly where the other tool is the better
// choice: a comparison that never concedes anything reads as marketing and converts
// worse than one that does. Pricing is marked as at-the-time-of-writing because
// theirs changes without notice — never present it as current.
//
// Row verdicts: 'yes' | 'partial' | 'no'.

export const COMPARISONS = [
  {
    slug: 'zapier',
    name: 'Zapier',
    kind: 'General automation platform',
    teaser: 'Connects thousands of apps, but moves files by URL — which is exactly where 2–4 GB recordings break.',
    title: 'AVideoRouter vs Zapier for Zoom and Fathom recordings',
    metaDescription: 'A row-by-row comparison of AVideoRouter and Zapier for moving Zoom and Fathom recordings to YouTube and your LMS, including where Zapier is the better choice.',
    keywords: ['zapier zoom to youtube', 'zapier alternative for video', 'zapier large file upload limit',
      'zoom youtube automation zapier', 'zapier lms integration'],
    summary: `<p>Zapier is the broadest automation platform there is, and if your workflow touches
      many different apps it is hard to beat. For <b>this one job</b> — moving large meeting
      recordings to YouTube and filing them in a course — it runs into a structural limit: Zapier
      passes files between steps by URL and enforces per-plan file size ceilings, so multi-gigabyte
      recordings are the case most likely to fail.</p>`,
    theirStrengths: `<p>Pick Zapier when the recording is a small part of a wider chain — notify a
      Slack channel, add a row to a sheet, create a CRM task, email the attendees. Nothing here
      matches its breadth of connectors, and if your files are small it will do the job.</p>`,
    verdict: `<p>If you want one tool for everything and your recordings are modest, Zapier. If the
      recordings <i>are</i> the point, and they are large, AVideoRouter: it streams the file rather
      than handing round a link, and it already knows what an LMS course and module are.</p>`,
    rows: [
      { cap: 'Zoom to YouTube', us: 'yes', them: 'yes',
        detail: 'Both do this. Zapier needs a Zap built and maintained; here it is a routing rule.' },
      { cap: 'Fathom recordings', us: 'yes', them: 'no',
        detail: 'Fathom is not a source you can pull a recording file from this way, so this leg has no clean path.' },
      { cap: 'Files into your LMS course and module', us: 'yes', them: 'no',
        detail: 'Zapier has no concept of a course or a module. Even where an LMS connector exists, placing a lesson in the right module is not something it models.' },
      { cap: 'Reliable 2–4 GB recordings', us: 'yes', them: 'no',
        detail: 'AVideoRouter streams the file straight through at roughly 90 seconds per GB, never holding it in memory. Zapier moves files by URL under per-plan size limits, which is where long sessions fail.' },
      { cap: 'Delete from Zoom after publishing', us: 'yes', them: 'no',
        detail: 'Deletion here is manual and only unlocks once the recording has a YouTube link, so you cannot destroy the only copy.' },
      { cap: 'Preview and download the original', us: 'yes', them: 'no',
        detail: 'Play any Zoom or Fathom recording in the dashboard, pick the view, download the original free.' },
      { cap: 'Daily scheduler, hands-free', us: 'yes', them: 'partial',
        detail: 'Zapier can be scheduled, but it is extra setup on top of the Zap rather than a built-in run window.' },
      { cap: 'No building, no maintenance', us: 'yes', them: 'partial',
        detail: 'A Zap is something you build, test and repair when an API changes. Routing rules here are configuration.' },
      { cap: 'Price', us: 'yes', them: 'no',
        detail: 'AVideoRouter is pay-as-you-go at ₹50/GB with the first GB free and no subscription. Zapier is a monthly subscription starting around $19.99/mo at the time of writing, with task limits — check their pricing page for current figures.' },
      { cap: 'Indian ₹ pricing and GST invoice', us: 'yes', them: 'no',
        detail: 'Billed in rupees with a GST invoice. Zapier bills in dollars.' },
    ],
  },
  {
    slug: 'make',
    name: 'Make',
    kind: 'General automation platform',
    teaser: 'Cheaper and more flexible than Zapier, at the cost of building and owning the scenario yourself.',
    title: 'AVideoRouter vs Make (Integromat) for Zoom and Fathom recordings',
    metaDescription: 'A row-by-row comparison of AVideoRouter and Make for moving Zoom and Fathom recordings to YouTube and an LMS, including where Make is the better choice.',
    keywords: ['make.com zoom to youtube', 'integromat zoom recording', 'make alternative video automation',
      'make scenario large file', 'make lms upload'],
    summary: `<p>Make gives you more control than Zapier for less money, and its visual scenario
      builder genuinely handles branching logic well. The trade is that you are building and owning
      a pipeline: the modules, the error handling, the retries, and the repairs when an API shifts
      under you. For large recordings it shares Zapier's basic problem — files move by URL, under
      size ceilings.</p>`,
    theirStrengths: `<p>Pick Make when the logic matters more than the payload: complex branching,
      many conditional paths, data transformation between a dozen services, and someone on hand who
      enjoys building it. It is the better tool for genuinely bespoke workflows.</p>`,
    verdict: `<p>Make is the right answer if you want a general-purpose engine and are happy to be
      its maintainer. AVideoRouter is the right answer if you want this specific job done on a
      schedule without owning a pipeline.</p>`,
    rows: [
      { cap: 'Zoom to YouTube', us: 'yes', them: 'yes',
        detail: 'Both do this. In Make you assemble and maintain the scenario.' },
      { cap: 'Fathom recordings', us: 'yes', them: 'no',
        detail: 'No clean path to pull the recording file from Fathom.' },
      { cap: 'Files into your LMS course and module', us: 'yes', them: 'partial',
        detail: 'Possible with heavy DIY against your LMS API, and then it is yours to maintain. Here it is a routing rule with a course and module picker.' },
      { cap: 'Reliable 2–4 GB recordings', us: 'yes', them: 'no',
        detail: 'Streaming end to end, versus URL-based transfer under per-plan size limits.' },
      { cap: 'Delete from Zoom after publishing', us: 'yes', them: 'no',
        detail: 'Build it yourself, including the safety check that a YouTube link exists first.' },
      { cap: 'Preview and download the original', us: 'yes', them: 'no',
        detail: 'Not something a scenario builder offers; there is no dashboard of your recordings.' },
      { cap: 'Daily scheduler, hands-free', us: 'yes', them: 'partial',
        detail: 'Make schedules scenarios, but the run window is one more thing to configure and watch.' },
      { cap: 'No building, no maintenance', us: 'yes', them: 'no',
        detail: 'Complex scenarios are real engineering. That is the point of Make, and the cost of it.' },
      { cap: 'Price', us: 'yes', them: 'no',
        detail: 'Pay-as-you-go at ₹50/GB, first GB free. Make is a monthly subscription from around $9/mo at the time of writing, priced by operations — check their pricing page for current figures.' },
      { cap: 'Indian ₹ pricing and GST invoice', us: 'yes', them: 'no',
        detail: 'Billed in rupees with a GST invoice.' },
    ],
  },
  {
    slug: 'n8n',
    name: 'n8n',
    kind: 'Self-hosted automation',
    teaser: 'The most capable option here, and the cheapest at volume — if you are willing to run and maintain a server.',
    title: 'AVideoRouter vs n8n for Zoom and Fathom recordings',
    metaDescription: 'A row-by-row comparison of AVideoRouter and self-hosted n8n for moving Zoom and Fathom recordings to YouTube and an LMS, including where n8n is the better choice.',
    keywords: ['n8n zoom to youtube', 'n8n self hosted video workflow', 'n8n alternative',
      'n8n large file handling', 'self hosted zoom automation'],
    summary: `<p>n8n is genuinely the most capable option on this list. Self-hosted, it has no task
      metering, it can stream large files if you build it that way, and there is nothing it cannot
      be made to do — every "build it" below is achievable. The question is whether you want to be
      the person who builds it, hosts it, monitors it, and fixes it at the moment a term starts.</p>`,
    theirStrengths: `<p>Pick n8n when you have technical capacity in-house and volume high enough
      that per-GB pricing stops making sense, or when data residency means the file must never touch
      a third party. At sufficient scale, self-hosting wins on cost and control. It is the honest
      choice for a team with an engineer to spare.</p>`,
    verdict: `<p>n8n is the better tool if your constraint is control and you have the engineering
      time. AVideoRouter is the better tool if your constraint is time, and you would rather the
      pipeline simply be somebody else's problem.</p>`,
    rows: [
      { cap: 'Zoom to YouTube', us: 'yes', them: 'partial',
        detail: 'Entirely achievable, as a workflow you build and own.' },
      { cap: 'Fathom recordings', us: 'yes', them: 'partial',
        detail: 'Build it against the API yourself.' },
      { cap: 'Files into your LMS course and module', us: 'yes', them: 'partial',
        detail: 'Heavy DIY against your LMS API, then yours to maintain.' },
      { cap: 'Reliable 2–4 GB recordings', us: 'yes', them: 'partial',
        detail: 'n8n can stream if you build it to, and your server sets the ceiling. It will not fail for the reasons Zapier and Make do, but it is on you to get right.' },
      { cap: 'Delete from Zoom after publishing', us: 'yes', them: 'partial',
        detail: 'Build it, including the guard that stops you deleting the only copy.' },
      { cap: 'Preview and download the original', us: 'yes', them: 'partial',
        detail: 'You would be building a dashboard at this point.' },
      { cap: 'Daily scheduler, hands-free', us: 'yes', them: 'partial',
        detail: 'Scheduling is built in; keeping the host alive and the workflow healthy is not.' },
      { cap: 'No building, no maintenance', us: 'yes', them: 'no',
        detail: 'Self-hosting means a server, upgrades, credentials, backups and monitoring.' },
      { cap: 'Price', us: 'yes', them: 'partial',
        detail: '₹50/GB with no subscription, versus a server bill plus your time. Past a certain volume n8n is cheaper in cash and dearer in hours.' },
      { cap: 'Indian ₹ pricing and GST invoice', us: 'yes', them: 'no',
        detail: 'Billed in rupees with a GST invoice.' },
    ],
  },
  {
    slug: 'single-purpose-uploaders',
    name: 'Single-purpose uploaders',
    kind: 'One-job apps',
    teaser: 'Good at the one hop they were built for. The LMS leg, Fathom, and what happens next are where they stop.',
    title: 'AVideoRouter vs single-purpose Zoom to YouTube uploaders',
    metaDescription: 'A row-by-row comparison of AVideoRouter and single-purpose Zoom-to-YouTube uploader apps, including when a one-job tool is the better choice.',
    keywords: ['zoom to youtube uploader', 'automatically publish zoom recordings', 'zoom youtube app',
      'single purpose video uploader', 'zoom recording to youtube tool'],
    summary: `<p>Several small apps do exactly one hop — Zoom to YouTube — and do it well. If that is
      the whole of your workflow, one of them may be all you need. The gap opens when the recording
      has somewhere to go <b>after</b> YouTube: into a specific course and module in your LMS, where
      your students actually look for it.</p>`,
    theirStrengths: `<p>Pick a single-purpose uploader when YouTube is the final destination, you do
      not use Fathom, and you do not teach from a course platform. Fewer moving parts is a real
      virtue, and a tool that does one thing is usually simpler to set up.</p>`,
    verdict: `<p>If the journey ends at YouTube, a one-job app is a reasonable choice. If it ends in
      a course, AVideoRouter covers the whole route in one pass and then clears the recording off
      Zoom so your cloud storage stops filling up.</p>`,
    rows: [
      { cap: 'Zoom to YouTube', us: 'yes', them: 'yes',
        detail: 'This is precisely what they are for, and they are good at it.' },
      { cap: 'Fathom recordings', us: 'yes', them: 'no',
        detail: 'Zoom-only, as a rule.' },
      { cap: 'Files into your LMS course and module', us: 'yes', them: 'no',
        detail: 'The hop that one-job uploaders do not make, and the reason the manual work comes back.' },
      { cap: 'Reliable 2–4 GB recordings', us: 'yes', them: 'yes',
        detail: 'Purpose-built uploaders generally handle large files properly, since this is their core job.' },
      { cap: 'Delete from Zoom after publishing', us: 'yes', them: 'partial',
        detail: 'Some offer it, some do not, and the safety guard varies.' },
      { cap: 'Preview and download the original', us: 'yes', them: 'partial',
        detail: 'Varies by tool; often there is no dashboard of past recordings at all.' },
      { cap: 'Daily scheduler, hands-free', us: 'yes', them: 'partial',
        detail: 'Varies. Some are trigger-based only.' },
      { cap: 'No building, no maintenance', us: 'yes', them: 'yes',
        detail: 'Both are configuration, not engineering. This is the main thing one-job tools get right.' },
      { cap: 'Price', us: 'yes', them: 'no',
        detail: '₹50/GB with no subscription, versus a monthly fee you pay in a quiet month too.' },
      { cap: 'Indian ₹ pricing and GST invoice', us: 'yes', them: 'partial',
        detail: 'Varies by vendor; most bill in dollars.' },
    ],
  },
];
