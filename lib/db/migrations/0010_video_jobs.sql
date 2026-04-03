-- Create video_job_status enum
DO $$ BEGIN
  CREATE TYPE video_job_status AS ENUM ('pending', 'completed', 'failed');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Create video_jobs table
CREATE TABLE IF NOT EXISTS video_jobs (
  id SERIAL PRIMARY KEY,
  fact_id INTEGER NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  video_url TEXT,
  status video_job_status NOT NULL DEFAULT 'pending',
  ip_address VARCHAR(45) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS video_jobs_fact_id_idx ON video_jobs(fact_id);
CREATE INDEX IF NOT EXISTS video_jobs_ip_address_idx ON video_jobs(ip_address);
CREATE INDEX IF NOT EXISTS video_jobs_created_at_idx ON video_jobs(created_at);
