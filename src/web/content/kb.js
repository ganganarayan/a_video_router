// Public Knowledge Base content — prospect/discovery oriented, one entry per
// pain point teachers & creators face after live sessions, and how AVideoRouter
// solves it. DISTINCT from the in-app Help center (which is step-by-step setup
// for logged-in users): there must be no content overlap between the two.
//
// Each topic renders as its own crawlable page at /knowledge-base/<slug>, so the
// titles/keywords below are chosen for how people (and AI search) actually phrase
// these problems.

export const KB_TOPICS = [
  {
    slug: 'automate-zoom-fathom-recording-downloads',
    title: 'Stop downloading Zoom and Fathom recordings by hand',
    teaser: 'Hours lost waiting on large video downloads — gone. Recordings are pulled straight from the source.',
    metaDescription: 'Tired of manually downloading large Zoom and Fathom recordings? AVideoRouter pulls recordings straight from the source automatically — no local downloads.',
    keywords: ['automatically download zoom recordings', 'export fathom recordings', 'bulk download zoom cloud recordings', 'zoom recording automation', 'move zoom recordings without downloading'],
    painHeading: 'The pain: tedious manual downloads',
    pain: `<p>After every live session you wait — sometimes for hours — while large video files
        crawl down from Zoom or Fathom to your computer. Only then can the real work begin. It ties
        up your machine, your bandwidth and your afternoon.</p>`,
    solutionHeading: 'How AVideoRouter solves it',
    solution: `<p>AVideoRouter pulls recordings <b>straight from Zoom and Fathom</b> in the cloud —
        you never download them locally first. New recordings are picked up automatically and moved
        on, so nothing sits waiting on your laptop.</p>`,
  },
  {
    slug: 'auto-upload-recordings-to-youtube',
    title: 'End repetitive YouTube uploads and metadata work',
    teaser: 'No more babysitting uploads or typing titles, descriptions and privacy settings one by one.',
    metaDescription: 'Stop babysitting YouTube uploads. AVideoRouter auto-uploads every recording to the right channel with your title, description and privacy defaults applied.',
    keywords: ['auto upload zoom to youtube', 'bulk upload videos to youtube', 'automate youtube titles and descriptions', 'schedule youtube uploads', 'zoom to youtube automatically'],
    painHeading: 'The pain: repetitive upload & metadata work',
    pain: `<p>Every recording means another round of babysitting an upload to YouTube, then setting
        the title, description and privacy — one video at a time. It is repetitive, easy to get wrong,
        and it never ends.</p>`,
    solutionHeading: 'How AVideoRouter solves it',
    solution: `<p>Set your rules <b>once</b>. Every new recording is automatically routed to its
        designated YouTube channel with the right title, description and privacy defaults already
        applied. You review results, not upload dialogs.</p>`,
  },
  {
    slug: 'auto-organize-videos-into-lms-courses',
    title: 'Automatically file videos into the right LMS courses and modules',
    teaser: 'Every recording lands in its correct course, module and playlist — without manual filing.',
    metaDescription: 'AVideoRouter routes each recording into the correct LMS course and module automatically, so you stop hand-filing videos across your learning platform.',
    keywords: ['add zoom recordings to lms', 'organize course videos automatically', 'zoom to lms integration', 'publish recordings to online course', 'lms video automation'],
    painHeading: 'The pain: complex file organization',
    pain: `<p>Once a video exists, it still has to be filed into the correct course, module and
        playlist inside your LMS. Do that across many sessions and platforms and it becomes a
        book-keeping job in its own right.</p>`,
    solutionHeading: 'How AVideoRouter solves it',
    solution: `<p>Your routing rules map each recording to its <b>designated LMS course</b>
        automatically. New session recordings show up where students expect them, correctly
        organized, with no manual sorting.</p>`,
  },
  {
    slug: 'stop-zoom-cloud-storage-filling-up',
    title: 'Never let Zoom cloud storage fill up again',
    teaser: 'Clear published recordings off Zoom with one click from your dashboard — no Zoom login.',
    metaDescription: 'Zoom cloud storage always full? Delete already-published recordings from Zoom with one click in the AVideoRouter dashboard — no signing into Zoom.',
    keywords: ['zoom cloud storage full', 'delete zoom recordings', 'free up zoom storage', 'manage zoom cloud recordings', 'automatically clear zoom recordings'],
    painHeading: 'The pain: storage limit bottlenecks',
    pain: `<p>Zoom cloud storage fills fast. So you keep logging back into Zoom to hunt down old,
        already-published recordings and delete them by hand — just to make room for the next batch.</p>`,
    solutionHeading: 'How AVideoRouter solves it',
    solution: `<p>Once a recording is safely published, a <b>Delete from Zoom</b> button appears right
        in your dashboard — clear it in one click, without ever signing into Zoom. Nothing is deleted
        automatically, so you stay in control.</p>`,
  },
  {
    slug: 'save-time-after-live-sessions',
    title: 'Reclaim the 15–30 minutes of admin grind per recording',
    teaser: 'Fast cloud transfers (1 GB in ~90s) plus set-and-forget scheduling do the whole cycle for you.',
    metaDescription: 'Stop losing 15–30 minutes of admin per recording. AVideoRouter runs the full download-publish cycle hands-free, moving a 1 GB video in about 90 seconds.',
    keywords: ['save time after live class', 'automate post-session video workflow', 'teacher video workflow automation', 'fast video transfer zoom to youtube', 'hands-free recording publishing'],
    painHeading: 'The pain: wasted time & administrative grind',
    pain: `<p>It looks small, but it adds up: 15 to 30 minutes of administrative babysitting per
        recording, just moving data from one place to another. Across a week of sessions, that is a
        whole afternoon spent on plumbing instead of teaching.</p>`,
    solutionHeading: 'How AVideoRouter solves it',
    solution: `<p>Transfers are <b>fast</b> — a full 1&nbsp;GB video moves in roughly 90 seconds (about
        60s to download, 30s to upload). And it is <b>set-and-forget</b>: run on a daily schedule or a
        single-click trigger, and the entire transfer-and-publish cycle happens hands-free.</p>`,
  },
  {
    slug: 'download-zoom-recordings-to-your-computer',
    title: 'Get a local copy of any Zoom recording — one click',
    teaser: 'Need the raw file to edit, archive or re-share? Download it straight to your computer, free.',
    metaDescription: 'Download any Zoom cloud recording straight to your computer in one click from AVideoRouter — no signing into Zoom, and it is free.',
    keywords: ['download zoom recording to computer', 'save zoom recording locally', 'get zoom mp4 file', 'export zoom cloud recording', 'zoom recording backup'],
    painHeading: 'The pain: getting the raw file out of Zoom',
    pain: `<p>Sometimes you just need the video file itself — to edit a clip, keep an archive, or hand it to
        someone. But pulling it out of Zoom means logging in, hunting through the cloud recordings and waiting
        on a fiddly download every time.</p>`,
    solutionHeading: 'How AVideoRouter solves it',
    solution: `<p>Every recording in your dashboard has a <b>Download</b> button that streams the file straight
        to your computer — no signing into Zoom, nothing to hunt for. It is <b>free</b> (not metered), so grab a
        local copy whenever you need one.</p>`,
  },
  {
    slug: 'upload-local-video-files-to-youtube-and-lms',
    title: 'Publish any video file — not just Zoom and Fathom',
    teaser: 'Got a pre-recorded or edited video on your computer? Send it straight to YouTube and your LMS course.',
    metaDescription: 'Upload a local video file to YouTube and your LMS course through AVideoRouter — the same automated route as a Zoom recording, streamed even for large files.',
    keywords: ['upload local video to youtube and lms', 'publish pre-recorded video to course', 'upload edited video to lms', 'bulk upload local files to youtube', 'add local video to online course'],
    painHeading: 'The pain: videos that did not come from Zoom or Fathom',
    pain: `<p>Not every video is a live-session recording. An edited cut, a pre-recorded lesson, a file a
        colleague sent you — those still have to be uploaded to YouTube and filed into the right course by hand,
        the very busywork you were trying to escape.</p>`,
    solutionHeading: 'How AVideoRouter solves it',
    solution: `<p>Upload a file straight from your computer in the dashboard. It streams to <b>YouTube</b>
        (large 2–4&nbsp;GB files included) and registers in your <b>LMS course</b> — the same automated,
        rule-driven route as a Zoom recording, billed by size. One place for every video, wherever it came from.</p>`,
  },
  {
    slug: 'pay-as-you-go-video-automation-pricing',
    title: 'No rigid subscriptions — pay only for what you transfer',
    teaser: 'Subscription-free, pay-as-you-go at ₹50 per unit (up to 1 GB), with GST invoices and free team access.',
    metaDescription: 'AVideoRouter is subscription-free: pay-as-you-go at ₹50 per unit of transfer (up to 1 GB), buy credits only as needed, with GST invoices and free team access.',
    keywords: ['pay as you go video tool', 'no subscription video automation', 'affordable zoom to youtube tool', 'video automation pricing india', 'gst invoice saas'],
    painHeading: 'The pain: rigid software subscriptions',
    pain: `<p>Most tools force you into an expensive monthly subscription — you pay the same whether you
        ran fifty sessions this month or five. When your usage fluctuates, a fixed lock-in feels like
        money down the drain.</p>`,
    solutionHeading: 'How AVideoRouter solves it',
    solution: `<p>AVideoRouter is <b>subscription-free and pay-as-you-go</b>: ₹50 per unit of transfer
        (one unit is up to 1&nbsp;GB per file). Buy credits only as you need them, they never expire
        until used, GST invoices are supported, and you can add your team with a ₹1,000+ top-up (or on Always-On). Your first upload is on us.</p>`,
  },
];
