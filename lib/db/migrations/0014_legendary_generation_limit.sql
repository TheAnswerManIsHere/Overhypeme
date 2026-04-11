ALTER TABLE users ADD COLUMN IF NOT EXISTS monthly_generation_limit_override_usd numeric(10,4);

INSERT INTO admin_config (key, value, data_type, label, description, min_value, max_value, is_public) VALUES
  ('budget_limit_legend_usd', '10.00', 'float', 'Legendary Monthly Generation Budget (USD)',
   'Monthly AI generation spending cap (USD) for Legendary and Registered users. Applies globally unless a per-user override is set.',
   0, 10000, false)
ON CONFLICT (key) DO UPDATE
  SET label = EXCLUDED.label,
      description = EXCLUDED.description,
      data_type = EXCLUDED.data_type;
