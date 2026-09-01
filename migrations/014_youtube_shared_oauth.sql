-- Single platform-owned YouTube OAuth app: channels no longer need their own
-- OAuth client id/secret. Existing rows that DO carry per-channel creds keep
-- them (their refresh tokens are bound to that client_id); new channels leave
-- these NULL and fall back to the platform app (config: youtube_client_id /
-- youtube_client_secret).
ALTER TABLE youtube_channels ALTER COLUMN oauth_client_id     DROP NOT NULL;
ALTER TABLE youtube_channels ALTER COLUMN oauth_client_secret DROP NOT NULL;
