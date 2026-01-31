-- Add raw_response column to store AI response for debugging
ALTER TABLE ai_usage_logs
ADD COLUMN IF NOT EXISTS raw_response TEXT;
