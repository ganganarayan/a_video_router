// Per-recording state machine (design doc §3):
// discovered → downloading → uploading → uploaded → lms_pushed → (zoom only) deleting → deleted
// side states: error (retried next run), skipped_no_route, skipped_no_matching_view

export const STATES = {
  DISCOVERED: 'discovered',
  DOWNLOADING: 'downloading',
  UPLOADING: 'uploading',
  UPLOADED: 'uploaded',
  LMS_PUSHED: 'lms_pushed',
  DELETING: 'deleting',
  DELETED: 'deleted',
  ERROR: 'error',
  SKIPPED_NO_ROUTE: 'skipped_no_route',
  SKIPPED_NO_VIEW: 'skipped_no_matching_view',
};

// States needing no further work this run.
export const TERMINAL_STATES = new Set([STATES.DELETED]);

// A recording in one of these states has NOT been uploaded and is safe to (re)process
// from the top. Anything with a youtube_video_id must never re-enter the upload path.
export const RETRYABLE_STATES = new Set([
  STATES.DISCOVERED,
  STATES.DOWNLOADING,
  STATES.UPLOADING,
  STATES.ERROR,
  STATES.SKIPPED_NO_ROUTE,
  STATES.SKIPPED_NO_VIEW,
]);

// THE safety guard for the Zoom source: delete is allowed only when the mode
// permits it AND this exact row holds a verified YouTube video id AND the
// source hasn't already been deleted. Skip paths never reach this — but even
// if they did, the youtube_video_id gate holds.
export function canDeleteZoomSource(rec, mode) {
  const modeAllows = mode === 'trash' || mode === 'delete';
  return (
    modeAllows &&
    rec.source === 'zoom' &&
    Boolean(rec.youtube_video_id) &&
    !rec.source_deleted
  );
}
