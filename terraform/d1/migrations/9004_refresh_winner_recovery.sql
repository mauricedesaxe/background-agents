-- Fork-local: recover the exact winning pair after concurrent refresh rotation.
ALTER TABLE api_tokens ADD COLUMN refresh_winner_encrypted TEXT;
